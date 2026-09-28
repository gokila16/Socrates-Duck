/** The message contract between the extension host and the webview. */

/** Where a piece of attached code came from. */
export type CaptureSource = "selection" | "file" | "traceback";

/** The two sources a developer can pick directly. */
export type DirectCaptureSource = Extract<CaptureSource, "selection" | "file">;

/** A piece of the developer's code, captured with their explicit consent. */
export interface CodeContext {
  label: string;
  languageId: string;
  source: CaptureSource;
  startLine: number;
  endLine: number;
  lineCount: number;
  code: string;
  truncated: boolean;
}

/** A file that the pasted error evidence points at, offered to the developer for approval. */
export interface FileCandidate {
  id: string;
  label: string;
  sizeBytes: number;
  referencedLines: number[];
}

/** Most pieces of code one session may carry. */
export const MAX_ATTACHMENTS = 8;

/** Identifies one attachment. */
export function attachmentKey(context: CodeContext): string {
  return `${context.source}:${context.label}:${context.startLine}-${context.endLine}`;
}

/** Which button the developer pressed. */
export type HintKind = "normal" | "stronger" | "stuck";

/** What the developer reports after rerunning their own code. */
export type Outcome = "resolved" | "still_stuck" | "different_error";

/** One hint, exactly as the backend is allowed to return it. */
export interface HintView {
  level: number;
  nextAction: string;
  question: string | null;
  concept: string | null;
  evidence: string | null;
}

/** A question the developer asked about one hint, and the answer. */
export interface AnswerView {
  hintNumber: number;
  question: string;
  answer: string;
  nextAction: string;
}

/** Mirrors MAX_QUESTION_CHARS in backend/api/schemas.py. */
export const MAX_QUESTION_CHARS = 1_000;

/** Session state as the panel needs it. */
export interface SessionView {
  status: "active" | "completed" | "abandoned";
  hintCount: number;
  highestHintLevel: number;
}

/** What the panel is waiting for. */
export type PendingAction = "start" | "hint" | "ask" | "report" | "end";

/** What the backend is doing while a hint is on its way. */
export type HintStep = "reading" | "writing" | "checking" | "rewording";

export const HINT_STEPS: readonly HintStep[] = [
  "reading",
  "writing",
  "checking",
  "rewording",
];

/** Webview → extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "capture"; source: DirectCaptureSource }
  | { type: "analyzeError"; text: string }
  | { type: "attachFiles"; ids: string[] }
  | {
      type: "startSession";
      problem: string;
      evidence: string;
      contexts: CodeContext[];
    }
  | { type: "requestHint"; kind: HintKind }
  | { type: "askQuestion"; hintNumber: number; question: string }
  | {
      type: "reportOutcome";
      outcome: Outcome;
      reasoning: string;
      evidence: string;
    }
  | { type: "endSession"; status: "completed" | "abandoned"; outcome: Outcome | null };

/** Extension host → webview. */
export type HostToWebview =
  | { type: "captured"; context: CodeContext }
  | { type: "captureFailed"; reason: string }
  | { type: "errorAnalyzed"; candidates: FileCandidate[]; exception: string | undefined }
  | { type: "sessionStarted"; session: SessionView }
  | { type: "hintReceived"; hint: HintView }
  | { type: "hintProgress"; step: HintStep }
  | { type: "answerReceived"; answer: AnswerView }
  | { type: "attemptRecorded"; session: SessionView; hintFollows: boolean }
  | { type: "sessionEnded"; session: SessionView }
  | { type: "requestFailed"; action: PendingAction; reason: string };

/** Validates a message arriving from the webview before we act on it. */
export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  switch (message["type"]) {
    case "ready":
      return true;
    case "capture":
      return message["source"] === "selection" || message["source"] === "file";
    case "analyzeError":
      return typeof message["text"] === "string";
    case "attachFiles":
      return (
        Array.isArray(message["ids"]) &&
        message["ids"].every((id) => typeof id === "string")
      );
    case "startSession":
      return (
        typeof message["problem"] === "string" &&
        typeof message["evidence"] === "string" &&
        Array.isArray(message["contexts"]) &&
        message["contexts"].every(isCodeContext)
      );
    case "requestHint":
      return isHintKind(message["kind"]);
    case "askQuestion":
      return (
        typeof message["hintNumber"] === "number" &&
        Number.isInteger(message["hintNumber"]) &&
        message["hintNumber"] >= 1 &&
        typeof message["question"] === "string" &&
        message["question"].trim() !== "" &&
        message["question"].length <= MAX_QUESTION_CHARS
      );
    case "reportOutcome":
      return (
        isOutcome(message["outcome"]) &&
        typeof message["reasoning"] === "string" &&
        typeof message["evidence"] === "string"
      );
    case "endSession":
      return (
        (message["status"] === "completed" || message["status"] === "abandoned") &&
        (message["outcome"] === null || isOutcome(message["outcome"]))
      );
    default:
      return false;
  }
}

function isHintKind(value: unknown): value is HintKind {
  return value === "normal" || value === "stronger" || value === "stuck";
}

function isOutcome(value: unknown): value is Outcome {
  return (
    value === "resolved" || value === "still_stuck" || value === "different_error"
  );
}

/** Checks one attachment coming back from the webview. */
function isCodeContext(value: unknown): value is CodeContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const context = value as Record<string, unknown>;

  return (
    typeof context["label"] === "string" &&
    typeof context["languageId"] === "string" &&
    (context["source"] === "selection" ||
      context["source"] === "file" ||
      context["source"] === "traceback") &&
    typeof context["startLine"] === "number" &&
    typeof context["endLine"] === "number" &&
    typeof context["lineCount"] === "number" &&
    typeof context["code"] === "string" &&
    typeof context["truncated"] === "boolean"
  );
}
