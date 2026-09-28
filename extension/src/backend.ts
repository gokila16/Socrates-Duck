/** The only place the extension talks to the local backend. */

import { HINT_STEPS } from "../shared/protocol";
import type {
  AnswerView,
  CodeContext,
  HintKind,
  HintStep,
  HintView,
  Outcome,
  SessionView,
} from "../shared/protocol";

/** Where the backend listens unless the developer says otherwise. */
export const DEFAULT_BACKEND_URL = "http://127.0.0.1:8000";

/** Calls that do not wait for a model. */
const QUICK_TIMEOUT_MS = 15_000;

/** A hint can take one analysis call, one generation call, a judge call, and up to two rewrites with a judge call each. */
const HINT_TIMEOUT_MS = 240_000;

export interface SessionPayload {
  problem: string;
  evidence: string | undefined;
  codeContexts: CodeContext[];
}

export interface AttemptPayload {
  reasoning: string;
  evidence: string | undefined;
  outcome: Outcome;
  codeContexts: CodeContext[] | undefined;
}

/** A session as the host holds it: the view the panel gets, plus the id. */
export interface StartedSession {
  id: string;
  session: SessionView;
}

/** A failure with a message that is safe, and useful, to show the developer. */
export class BackendError extends Error {}

/** Forces the configured URL back to this machine: the setting can come from a repository. */
export function resolveBackendUrl(configured: string | undefined): string {
  const raw = configured?.trim();

  if (raw === undefined || raw === "") {
    return DEFAULT_BACKEND_URL;
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    return DEFAULT_BACKEND_URL;
  }

  if (!isLoopback(parsed.hostname) || !isHttp(parsed.protocol)) {
    return DEFAULT_BACKEND_URL;
  }

  return parsed.origin;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function isHttp(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

export async function createSession(
  baseUrl: string,
  payload: SessionPayload,
): Promise<StartedSession> {
  const body = await send(baseUrl, "/v1/sessions", payload, QUICK_TIMEOUT_MS);

  if (!isSessionResponse(body) || typeof body["id"] !== "string") {
    throw new BackendError(unexpectedShape);
  }

  return { id: body["id"], session: toSessionView(body) };
}

/** Asks for a hint, reporting each step of the backend's work as it starts. */
export async function requestHint(
  baseUrl: string,
  sessionId: string,
  kind: HintKind,
  onStep: (step: HintStep) => void = () => {},
): Promise<HintView> {
  const response = await open(
    baseUrl,
    `/v1/sessions/${encodeURIComponent(sessionId)}/hints`,
    { kind },
    HINT_TIMEOUT_MS,
    "text/event-stream, application/json",
  );

  const body = response.headers.get("Content-Type")?.startsWith("text/event-stream")
    ? await readEventStream(response, "hint", onStep)
    : await readJson(response);

  if (!isHintResponse(body)) {
    throw new BackendError(unexpectedShape);
  }

  return {
    level: body["level"],
    nextAction: body["nextAction"],
    question: nullableString(body["question"]),
    concept: nullableString(body["concept"]),
    evidence: nullableString(body["evidence"]),
  };
}

/** Asks about one hint. */
export async function askQuestion(
  baseUrl: string,
  sessionId: string,
  hintNumber: number,
  question: string,
  onStep: (step: HintStep) => void = () => {},
): Promise<AnswerView> {
  const response = await open(
    baseUrl,
    `/v1/sessions/${encodeURIComponent(sessionId)}/questions`,
    { hintNumber, question },
    HINT_TIMEOUT_MS,
    "text/event-stream, application/json",
  );

  const body = response.headers.get("Content-Type")?.startsWith("text/event-stream")
    ? await readEventStream(response, "answer", onStep)
    : await readJson(response);

  const answer = body["answer"];
  const nextAction = body["nextAction"];

  if (
    typeof answer !== "string" ||
    answer.trim() === "" ||
    typeof nextAction !== "string" ||
    nextAction.trim() === ""
  ) {
    throw new BackendError(unexpectedShape);
  }

  return { hintNumber, question, answer, nextAction };
}

export async function recordAttempt(
  baseUrl: string,
  sessionId: string,
  payload: AttemptPayload,
): Promise<SessionView> {
  const body = await send(
    baseUrl,
    `/v1/sessions/${encodeURIComponent(sessionId)}/attempts`,
    payload,
    QUICK_TIMEOUT_MS,
  );

  if (!isSessionResponse(body)) {
    throw new BackendError(unexpectedShape);
  }

  return toSessionView(body);
}

export async function completeSession(
  baseUrl: string,
  sessionId: string,
  status: "completed" | "abandoned",
  outcome: Outcome | null,
): Promise<SessionView> {
  const body = await send(
    baseUrl,
    `/v1/sessions/${encodeURIComponent(sessionId)}/complete`,
    { status, outcome },
    QUICK_TIMEOUT_MS,
  );

  if (!isSessionResponse(body)) {
    throw new BackendError(unexpectedShape);
  }

  return toSessionView(body);
}

const unexpectedShape =
  "The backend replied with something Socrates' Duck did not understand. Check that socratesDuck.backendUrl points at the Socrates' Duck backend.";

/** One request, with every failure turned into a readable sentence. */
async function send(
  baseUrl: string,
  path: string,
  payload: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return readJson(await open(baseUrl, path, payload, timeoutMs, "application/json"));
}

/** Sends the request and checks the status; the body is left to the caller. */
async function open(
  baseUrl: string,
  path: string,
  payload: unknown,
  timeoutMs: number,
  accept: string,
): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: accept },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new BackendError(describeTransportFailure(error, baseUrl));
  }

  if (!response.ok) {
    throw new BackendError(await describeHttpFailure(response));
  }

  return response;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new BackendError(unexpectedShape);
  }
}

/** Reads a hint or answer stream to its end, passing each step on as it arrives. */
async function readEventStream(
  response: Response,
  result: "hint" | "answer",
  onStep: (step: HintStep) => void,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();

  if (reader === undefined) {
    throw new BackendError(unexpectedShape);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array };

    try {
      chunk = await reader.read();
    } catch (error) {
      throw new BackendError(
        error instanceof Error && error.name === "TimeoutError"
          ? describeTransportFailure(error, "")
          : "The connection to the backend dropped before the hint arrived. Please try again.",
      );
    }

    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const { events, rest } = parseEvents(buffer);
    buffer = rest;

    for (const { event, data } of events) {
      if (event === "step" && isHintStep(data["step"])) {
        onStep(data["step"]);
      } else if (event === result) {
        return data;
      } else if (event === "error") {
        throw new BackendError(
          typeof data["detail"] === "string"
            ? data["detail"]
            : "The backend could not produce a hint. Please try again.",
        );
      }
    }

    if (chunk.done) {
      throw new BackendError(
        "The backend stopped before the hint arrived. Please try again.",
      );
    }
  }
}

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Splits complete Server-Sent Events off the front of `buffer`. */
export function parseEvents(buffer: string): { events: StreamEvent[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, "\n");
  const blocks = normalised.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: StreamEvent[] = [];

  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice("data:".length).trimStart());
      }
    }

    try {
      const parsed: unknown = JSON.parse(data.join("\n"));

      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        events.push({ event, data: parsed as Record<string, unknown> });
      }
    } catch {
      // Not a JSON object: skip the event.
    }
  }

  return { events, rest };
}

function isHintStep(value: unknown): value is HintStep {
  return typeof value === "string" && (HINT_STEPS as readonly string[]).includes(value);
}

function describeTransportFailure(error: unknown, baseUrl: string): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "The backend took too long to answer. It may still be waiting on the model — try again in a moment.";
  }

  return `Could not reach the Socrates' Duck backend at ${baseUrl}. Start it, then try again.`;
}

/** Turns a status into advice. */
async function describeHttpFailure(response: Response): Promise<string> {
  if (response.status === 503) {
    const detail = await readDetail(response);

    return detail ?? "The backend has no model available right now.";
  }

  switch (response.status) {
    case 404:
      return "That session is no longer available — the backend may have restarted. Start a new session.";
    case 409:
      return "This session has already finished. Start a new one to keep going.";
    case 422:
      return "The backend rejected this request. Check that you have described the problem and attached at least one piece of code.";
    default:
      return `The backend returned an unexpected error (${response.status}).`;
  }
}

async function readDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const detail = body["detail"];

    return typeof detail === "string" ? detail : undefined;
  } catch {
    return undefined;
  }
}

function isSessionResponse(body: Record<string, unknown>): boolean {
  return (
    (body["status"] === "active" ||
      body["status"] === "completed" ||
      body["status"] === "abandoned") &&
    typeof body["hintCount"] === "number" &&
    typeof body["highestHintLevel"] === "number"
  );
}

function isHintResponse(
  body: Record<string, unknown>,
): body is { level: number; nextAction: string } & Record<string, unknown> {
  return (
    typeof body["level"] === "number" &&
    typeof body["nextAction"] === "string" &&
    body["nextAction"].trim() !== ""
  );
}

function toSessionView(body: Record<string, unknown>): SessionView {
  return {
    status: body["status"] as SessionView["status"],
    hintCount: body["hintCount"] as number,
    highestHintLevel: body["highestHintLevel"] as number,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
