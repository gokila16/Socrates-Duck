/** The host's backend client: what it sends, and what it does with failures. */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  askQuestion,
  BackendError,
  completeSession,
  createSession,
  DEFAULT_BACKEND_URL,
  parseEvents,
  recordAttempt,
  requestHint,
  resolveBackendUrl,
} from "../src/backend";
import type { CodeContext } from "../shared/protocol";

const BASE = "http://127.0.0.1:8000";

const CONTEXT: CodeContext = {
  label: "stats.py",
  languageId: "python",
  source: "file",
  startLine: 1,
  endLine: 2,
  lineCount: 2,
  code: "def average(values):\n    return sum(values) / len(values)",
  truncated: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(response: Response | (() => never)): ReturnType<typeof vi.fn> {
  const fake = vi.fn(() =>
    typeof response === "function" ? response() : Promise.resolve(response),
  );

  vi.stubGlobal("fetch", fake);

  return fake;
}

function lastBody(fake: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fake.mock.calls[0] as [string, RequestInit];

  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveBackendUrl", () => {
  it("keeps a loopback address, including a different port", () => {
    expect(resolveBackendUrl("http://127.0.0.1:9001")).toBe("http://127.0.0.1:9001");
    expect(resolveBackendUrl("http://localhost:8000")).toBe("http://localhost:8000");
  });

  it.each([
    "https://hints.example.com",
    "http://192.168.1.50:8000",
    "http://127.0.0.1.evil.example.com",
    "not a url",
    "ftp://127.0.0.1",
  ])("refuses to send code off this machine: %s", (configured) => {
    expect(resolveBackendUrl(configured)).toBe(DEFAULT_BACKEND_URL);
  });

  it.each([undefined, "", "   "])("falls back when unset: %s", (configured) => {
    expect(resolveBackendUrl(configured)).toBe(DEFAULT_BACKEND_URL);
  });

  it("drops a trailing path so appended paths do not double up", () => {
    expect(resolveBackendUrl("http://127.0.0.1:8000/")).toBe(DEFAULT_BACKEND_URL);
  });
});

describe("createSession", () => {
  it("sends the developer's material and keeps the id in the host", async () => {
    const fake = stubFetch(
      jsonResponse({
        id: "abc123",
        status: "active",
        hintCount: 0,
        highestHintLevel: 0,
      }),
    );

    const started = await createSession(BASE, {
      problem: "It crashes. I think average() is broken.",
      evidence: "ZeroDivisionError",
      codeContexts: [CONTEXT],
    });

    expect(fake.mock.calls[0]?.[0]).toBe(`${BASE}/v1/sessions`);
    expect(lastBody(fake)).toMatchObject({
      problem: "It crashes. I think average() is broken.",
      codeContexts: [{ label: "stats.py", lineCount: 2 }],
    });
    expect(lastBody(fake)).not.toHaveProperty("reasoning");
    expect(started.id).toBe("abc123");
    expect(started.session).not.toHaveProperty("id");
  });

  it("rejects a reply that is not a session", async () => {
    stubFetch(jsonResponse({ hello: "world" }));

    await expect(
      createSession(BASE, {
        problem: "p",
        evidence: undefined,
        codeContexts: [CONTEXT],
      }),
    ).rejects.toThrow(BackendError);
  });
});

describe("requestHint", () => {
  it("returns the hint and normalises absent fields to null", async () => {
    const fake = stubFetch(
      jsonResponse({
        level: 3,
        nextAction: "Print the list before the call.",
        question: "What is in it?",
        concept: null,
        evidence: "   ",
      }),
    );

    const hint = await requestHint(BASE, "abc123", "stronger");

    expect(fake.mock.calls[0]?.[0]).toBe(`${BASE}/v1/sessions/abc123/hints`);
    expect(lastBody(fake)).toEqual({ kind: "stronger" });
    expect(hint.question).toBe("What is in it?");
    expect(hint.concept).toBeNull();
    expect(hint.evidence).toBeNull();
  });

  it("refuses a hint with no next action", async () => {
    stubFetch(jsonResponse({ level: 3, nextAction: "  " }));

    await expect(requestHint(BASE, "abc123", "normal")).rejects.toThrow(BackendError);
  });
});

/** A Server-Sent Events response, delivered in the given chunks. */
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const HINT_EVENT =
  'event: hint\ndata: {"level": 1, "nextAction": "Print n.", "question": null}\n\n';

describe("requestHint, streamed", () => {
  it("asks for a stream and reports each step before the hint", async () => {
    const fake = stubFetch(
      streamResponse([
        'event: step\ndata: {"step": "reading"}\n\n',
        'event: step\ndata: {"step": "writing"}\n\n',
        HINT_EVENT,
      ]),
    );
    const steps: string[] = [];

    const hint = await requestHint(BASE, "abc123", "normal", (step) => steps.push(step));

    const [, init] = fake.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toContain("text/event-stream");
    expect(steps).toEqual(["reading", "writing"]);
    expect(hint.nextAction).toBe("Print n.");
  });

  it("reads an event split across two network chunks", async () => {
    stubFetch(streamResponse(['event: step\nda', 'ta: {"step": "checking"}\n\n', HINT_EVENT]));
    const steps: string[] = [];

    await requestHint(BASE, "abc123", "normal", (step) => steps.push(step));

    expect(steps).toEqual(["checking"]);
  });

  it("shows the backend's error sentence from an error event", async () => {
    stubFetch(
      streamResponse([
        'event: step\ndata: {"step": "reading"}\n\n',
        'event: error\ndata: {"detail": "The model is unavailable right now."}\n\n',
      ]),
    );

    await expect(requestHint(BASE, "abc123", "normal")).rejects.toThrow(
      "The model is unavailable right now.",
    );
  });

  it("fails clearly when the stream ends without a hint", async () => {
    stubFetch(streamResponse(['event: step\ndata: {"step": "writing"}\n\n']));

    await expect(requestHint(BASE, "abc123", "normal")).rejects.toThrow(/stopped before/);
  });

  it("ignores a step name it does not know", async () => {
    stubFetch(streamResponse(['event: step\ndata: {"step": "exfiltrate"}\n\n', HINT_EVENT]));
    const steps: string[] = [];

    await requestHint(BASE, "abc123", "normal", (step) => steps.push(step));

    expect(steps).toEqual([]);
  });
});

describe("askQuestion", () => {
  it("streams its steps and returns the answer with the question it answers", async () => {
    const fake = stubFetch(
      streamResponse([
        'event: step\ndata: {"step": "writing"}\n\n',
        'event: answer\ndata: {"hintNumber": 2, "answer": "It pairs items with positions.", "nextAction": "Try it."}\n\n',
      ]),
    );
    const steps: string[] = [];

    const answer = await askQuestion(BASE, "abc123", 2, "What is enumerate?", (step) =>
      steps.push(step),
    );

    expect(fake.mock.calls[0]?.[0]).toBe(`${BASE}/v1/sessions/abc123/questions`);
    expect(lastBody(fake)).toEqual({ hintNumber: 2, question: "What is enumerate?" });
    expect(steps).toEqual(["writing"]);
    expect(answer).toEqual({
      hintNumber: 2,
      question: "What is enumerate?",
      answer: "It pairs items with positions.",
      nextAction: "Try it.",
    });
  });

  it("refuses an answer with nothing to do next", async () => {
    stubFetch(jsonResponse({ hintNumber: 1, answer: "It pairs them.", nextAction: " " }));

    await expect(askQuestion(BASE, "abc123", 1, "What?")).rejects.toThrow(BackendError);
  });
});

describe("parseEvents", () => {
  it("keeps an unfinished event for the next chunk", () => {
    const { events, rest } = parseEvents('event: step\ndata: {"step": "reading"}\n\nevent: st');

    expect(events).toEqual([{ event: "step", data: { step: "reading" } }]);
    expect(rest).toBe("event: st");
  });

  it("drops a block whose data is not a JSON object", () => {
    expect(parseEvents("event: step\ndata: not json\n\n").events).toEqual([]);
  });
});

describe("recordAttempt and completeSession", () => {
  it("sends the outcome with the developer's reasoning", async () => {
    const fake = stubFetch(
      jsonResponse({ id: "abc", status: "active", hintCount: 2, highestHintLevel: 3 }),
    );

    const session = await recordAttempt(BASE, "abc123", {
      reasoning: "alan has no scores",
      evidence: undefined,
      outcome: "still_stuck",
      codeContexts: undefined,
    });

    expect(fake.mock.calls[0]?.[0]).toBe(`${BASE}/v1/sessions/abc123/attempts`);
    expect(lastBody(fake)).toMatchObject({ outcome: "still_stuck" });
    expect(lastBody(fake)).not.toHaveProperty("codeContexts");
    expect(session.hintCount).toBe(2);
  });

  it("sends the code read again with the report", async () => {
    const fake = stubFetch(
      jsonResponse({ id: "abc", status: "active", hintCount: 1, highestHintLevel: 1 }),
    );

    await recordAttempt(BASE, "abc123", {
      reasoning: "I changed average().",
      evidence: undefined,
      outcome: "still_stuck",
      codeContexts: [CONTEXT],
    });

    expect(lastBody(fake)).toMatchObject({
      codeContexts: [{ label: "stats.py", lineCount: 2 }],
    });
  });

  it("sends the final status", async () => {
    const fake = stubFetch(
      jsonResponse({ id: "abc", status: "completed", hintCount: 4, highestHintLevel: 5 }),
    );

    const session = await completeSession(BASE, "abc123", "completed", "resolved");

    expect(lastBody(fake)).toEqual({ status: "completed", outcome: "resolved" });
    expect(session.status).toBe("completed");
  });
});

describe("failures", () => {
  it("says the backend is not running when it cannot be reached", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    await expect(requestHint(BASE, "abc", "normal")).rejects.toThrow(
      /Could not reach the Socrates' Duck backend/,
    );
  });

  it("says so when the backend takes too long", async () => {
    stubFetch(() => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });

    await expect(requestHint(BASE, "abc", "normal")).rejects.toThrow(/too long/);
  });

  it("passes a 503 through, because the backend wrote it for the developer", async () => {
    stubFetch(
      jsonResponse(
        { detail: "No model is configured. Set OPENAI_API_KEY and restart the backend." },
        503,
      ),
    );

    await expect(requestHint(BASE, "abc", "normal")).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it.each([
    [404, /no longer available/],
    [409, /already finished/],
    [422, /described the problem/],
    [500, /unexpected error \(500\)/],
  ])("turns %i into advice", async (status, expected) => {
    stubFetch(jsonResponse({ detail: "ignored" }, status));

    await expect(requestHint(BASE, "abc", "normal")).rejects.toThrow(expected);
  });

  it("does not repeat back what a failing backend said", async () => {
    stubFetch(jsonResponse({ detail: [{ loc: ["body", "problem"], msg: "too long" }] }, 422));

    await expect(requestHint(BASE, "abc", "normal")).rejects.not.toThrow(/too long/);
  });
});
