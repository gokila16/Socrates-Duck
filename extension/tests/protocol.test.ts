import { describe, expect, it } from "vitest";

import {
  attachmentKey,
  isWebviewToHost,
  MAX_OBSERVATION_CHARS,
  MAX_QUESTION_CHARS,
  type CodeContext,
} from "../shared/protocol";

function context(overrides: Partial<CodeContext> = {}): CodeContext {
  return {
    label: "app.py",
    languageId: "python",
    source: "selection",
    startLine: 10,
    endLine: 20,
    lineCount: 11,
    code: "pass",
    truncated: false,
    ...overrides,
  };
}

describe("attachmentKey", () => {
  it("treats two ranges of the same file as different attachments", () => {
    expect(attachmentKey(context({ startLine: 10, endLine: 20 }))).not.toBe(
      attachmentKey(context({ startLine: 40, endLine: 50 })),
    );
  });

  it("treats the same range from different sources as different", () => {
    expect(attachmentKey(context({ source: "selection" }))).not.toBe(
      attachmentKey(context({ source: "traceback" })),
    );
  });

  it("treats a re-capture of the same range as the same attachment", () => {
    expect(attachmentKey(context({ code: "old" }))).toBe(
      attachmentKey(context({ code: "new" })),
    );
  });

  it("separates identically named files in different folders", () => {
    expect(attachmentKey(context({ label: "a/utils.py" }))).not.toBe(
      attachmentKey(context({ label: "b/utils.py" })),
    );
  });
});

describe("isWebviewToHost, for the messages that reach the backend", () => {
  const startSession = {
    type: "startSession",
    problem: "It crashes. I think average() is broken.",
    evidence: "",
    contexts: [context()],
  };

  it("accepts a well-formed startSession", () => {
    expect(isWebviewToHost(startSession)).toBe(true);
  });

  it("accepts an empty attachment list, leaving the 422 to the backend", () => {
    expect(isWebviewToHost({ ...startSession, contexts: [] })).toBe(true);
  });

  it.each([
    ["a missing field", { ...startSession, evidence: undefined }],
    ["a non-string problem", { ...startSession, problem: 42 }],
    ["contexts that are not attachments", { ...startSession, contexts: ["stats.py"] }],
    [
      "an attachment missing its code",
      { ...startSession, contexts: [{ ...context(), code: undefined }] },
    ],
  ])("rejects %s", (_name, message) => {
    expect(isWebviewToHost(message)).toBe(false);
  });

  it.each(["normal", "stronger", "stuck"])("accepts the %s hint kind", (kind) => {
    expect(isWebviewToHost({ type: "requestHint", kind })).toBe(true);
  });

  it.each(["just_tell_me", "", undefined])("rejects the hint kind %s", (kind) => {
    expect(isWebviewToHost({ type: "requestHint", kind })).toBe(false);
  });

  it.each(["resolved", "still_stuck", "different_error"])(
    "accepts the %s outcome",
    (outcome) => {
      expect(
        isWebviewToHost({ type: "reportOutcome", outcome, reasoning: "tried it", evidence: "" }),
      ).toBe(true);
    },
  );

  it("rejects an outcome the backend does not define", () => {
    expect(
      isWebviewToHost({ type: "reportOutcome", outcome: "fixed_it", reasoning: "x", evidence: "" }),
    ).toBe(false);
  });

  it("accepts both ways a session can end", () => {
    expect(
      isWebviewToHost({
        type: "endSession",
        status: "completed",
        outcome: "resolved",
        resolution: "yes",
      }),
    ).toBe(true);
    expect(
      isWebviewToHost({
        type: "endSession",
        status: "abandoned",
        outcome: null,
        resolution: "skipped",
      }),
    ).toBe(true);
  });

  it("rejects an unknown end status", () => {
    expect(
      isWebviewToHost({ type: "endSession", status: "paused", outcome: null, resolution: "no" }),
    ).toBe(false);
  });

  it.each(["not_asked", "maybe", undefined])(
    "rejects the resolution %s, which the developer cannot pick",
    (resolution) => {
      expect(
        isWebviewToHost({ type: "endSession", status: "completed", outcome: null, resolution }),
      ).toBe(false);
    },
  );

  it("accepts a request to show the profile", () => {
    expect(isWebviewToHost({ type: "showProfile" })).toBe(true);
  });
});

describe("isWebviewToHost, for a question about a hint", () => {
  it("accepts a question about a numbered hint", () => {
    expect(
      isWebviewToHost({ type: "askQuestion", hintNumber: 1, question: "What is enumerate?" }),
    ).toBe(true);
  });

  it.each([
    ["hint number 0", { hintNumber: 0, question: "What?" }],
    ["a fractional hint number", { hintNumber: 1.5, question: "What?" }],
    ["a blank question", { hintNumber: 1, question: "   " }],
    ["an overlong question", { hintNumber: 1, question: "x".repeat(MAX_QUESTION_CHARS + 1) }],
  ])("rejects %s", (_name, fields) => {
    expect(isWebviewToHost({ type: "askQuestion", ...fields })).toBe(false);
  });
});

describe("isWebviewToHost, for a note on what the developer saw", () => {
  it("accepts a note", () => {
    expect(
      isWebviewToHost({ type: "shareObservation", observation: "It printed []." }),
    ).toBe(true);
  });

  it.each([
    ["a blank note", "   "],
    ["an overlong note", "x".repeat(MAX_OBSERVATION_CHARS + 1)],
    ["a non-string note", 42],
  ])("rejects %s", (_name, observation) => {
    expect(isWebviewToHost({ type: "shareObservation", observation })).toBe(false);
  });
});
