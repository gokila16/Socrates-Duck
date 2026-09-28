/** The panel's conversation rules. */

import { describe, expect, it } from "vitest";

import type { HintView, SessionView } from "../shared/protocol";
import {
  conversationReducer,
  highestLevel,
  missingForStart,
  NEW_CONVERSATION,
  restoreConversation,
  type Conversation,
  type ConversationEvent,
} from "../webview/session";

const SESSION: SessionView = {
  status: "active",
  hintCount: 0,
  highestHintLevel: 0,
};

function hint(level: number): HintView {
  return {
    level,
    nextAction: "Print the list before the call.",
    question: "What is in it?",
    concept: null,
    evidence: null,
  };
}

/** Replays a sequence, the way the panel receives one. */
function replay(...events: ConversationEvent[]): Conversation {
  return events.reduce(conversationReducer, NEW_CONVERSATION);
}

describe("starting a session", () => {
  it("stays busy between the session and its first hint", () => {
    const state = replay(
      { type: "requested", action: "start" },
      { type: "sessionStarted", session: SESSION },
    );

    expect(state.phase).toBe("active");
    expect(state.pending).toBe("start");
  });

  it("is idle once the first hint arrives", () => {
    const state = replay(
      { type: "requested", action: "start" },
      { type: "sessionStarted", session: SESSION },
      { type: "hintReceived", hint: hint(1) },
    );

    expect(state.pending).toBeNull();
    expect(state.hints).toHaveLength(1);
  });

  it("keeps the session when only the first hint failed", () => {
    const state = replay(
      { type: "requested", action: "start" },
      { type: "sessionStarted", session: SESSION },
      { type: "requestFailed", reason: "The backend took too long to answer." },
    );

    expect(state.phase).toBe("active");
    expect(state.pending).toBeNull();
    expect(state.error).toBe("The backend took too long to answer.");
  });

  it("stays on the form when the session itself failed", () => {
    const state = replay(
      { type: "requested", action: "start" },
      { type: "requestFailed", reason: "Could not reach the backend." },
    );

    expect(state.phase).toBe("draft");
    expect(state.error).toBe("Could not reach the backend.");
  });
});

describe("during a session", () => {
  const started = replay(
    { type: "requested", action: "start" },
    { type: "sessionStarted", session: SESSION },
    { type: "hintReceived", hint: hint(1) },
  );

  it("appends hints in the order they arrive", () => {
    const state = [
      { type: "requested", action: "hint" } as const,
      { type: "hintReceived", hint: hint(2) } as const,
      { type: "requested", action: "hint" } as const,
      { type: "hintReceived", hint: hint(3) } as const,
    ].reduce(conversationReducer, started);

    expect(state.hints.map((each) => each.level)).toEqual([1, 2, 3]);
    expect(highestLevel(state.hints)).toBe(3);
  });

  it("clears the last error when a new action starts", () => {
    const failed = conversationReducer(started, {
      type: "requestFailed",
      reason: "Could not reach the backend.",
    });
    const retried = conversationReducer(failed, {
      type: "requested",
      action: "hint",
    });

    expect(retried.error).toBeNull();
  });

  it("keeps the hints when an attempt is recorded", () => {
    const state = conversationReducer(started, {
      type: "attemptRecorded",
      session: { status: "active", hintCount: 1, highestHintLevel: 1 },
      hintFollows: false,
    });

    expect(state.hints).toHaveLength(1);
    expect(state.session?.hintCount).toBe(1);
    expect(state.pending).toBeNull();
  });

  it("stays busy while the next hint follows a report", () => {
    const state = replay(
      { type: "requested", action: "start" },
      { type: "sessionStarted", session: SESSION },
      { type: "hintReceived", hint: hint(1) },
      { type: "requested", action: "report" },
      {
        type: "attemptRecorded",
        session: { status: "active", hintCount: 1, highestHintLevel: 1 },
        hintFollows: true,
      },
    );

    expect(state.pending).toBe("hint");

    const after = conversationReducer(state, { type: "hintReceived", hint: hint(2) });

    expect(after.hints).toHaveLength(2);
    expect(after.pending).toBeNull();
  });
});

describe("ending a session", () => {
  it("keeps the hints readable after it finishes", () => {
    const state = replay(
      { type: "requested", action: "start" },
      { type: "sessionStarted", session: SESSION },
      { type: "hintReceived", hint: hint(1) },
      { type: "requested", action: "end" },
      {
        type: "sessionEnded",
        session: { status: "completed", hintCount: 1, highestHintLevel: 1 },
      },
    );

    expect(state.phase).toBe("finished");
    expect(state.hints).toHaveLength(1);
    expect(state.pending).toBeNull();
  });

  it("distinguishes giving up from finishing", () => {
    const state = replay({
      type: "sessionEnded",
      session: { status: "abandoned", hintCount: 2, highestHintLevel: 4 },
    });

    expect(state.session?.status).toBe("abandoned");
  });

  it("goes back to an empty form on reset", () => {
    const state = replay(
      { type: "sessionEnded", session: { status: "completed", hintCount: 1, highestHintLevel: 1 } },
      { type: "reset" },
    );

    expect(state).toEqual(NEW_CONVERSATION);
  });
});

describe("missingForStart", () => {
  const complete = {
    problem: "It crashes. I think average() is broken.",
    attachments: [{}],
  };

  it("accepts a filled-in form", () => {
    expect(missingForStart(complete)).toBeNull();
  });

  it.each([
    ["problem", { ...complete, problem: "   " }, /Describe what is going wrong/],
    ["attachments", { ...complete, attachments: [] }, /Attach at least one/],
  ])("explains what is missing: %s", (_name, draft, expected) => {
    expect(missingForStart(draft)).toMatch(expected);
  });
});

describe("questions about a hint", () => {
  const withHint = replay(
    { type: "requested", action: "start" },
    { type: "sessionStarted", session: SESSION },
    { type: "hintReceived", hint: hint(2) },
  );
  const answer = {
    hintNumber: 1,
    question: "What does enumerate() do?",
    answer: "It gives each item with its position.",
    nextAction: "Try list(enumerate(['a'])) and look at the pair.",
  };

  it("adds the answer without touching the hints", () => {
    const state = replay(
      { type: "requested", action: "start" },
      { type: "sessionStarted", session: SESSION },
      { type: "hintReceived", hint: hint(2) },
      { type: "requested", action: "ask" },
      { type: "answerReceived", answer },
    );

    expect(state.answers).toEqual([answer]);
    expect(state.hints).toEqual(withHint.hints);
    expect(state.pending).toBeNull();
  });

  it("stays busy, with progress, while the answer is on its way", () => {
    const asking = conversationReducer(withHint, { type: "requested", action: "ask" });
    const writing = conversationReducer(asking, { type: "hintProgress", step: "writing" });

    expect(writing.pending).toBe("ask");
    expect(writing.step).toBe("writing");
  });

  it("brings the answers back when the panel is rebuilt", () => {
    const state = conversationReducer(withHint, { type: "answerReceived", answer });

    expect(restoreConversation(JSON.parse(JSON.stringify(state))).answers).toEqual([answer]);
  });
});

describe("hint progress", () => {
  const waiting = replay(
    { type: "requested", action: "start" },
    { type: "sessionStarted", session: SESSION },
  );

  it("shows each step while the hint is on its way, then clears", () => {
    const reading = conversationReducer(waiting, { type: "hintProgress", step: "reading" });
    const checking = conversationReducer(reading, { type: "hintProgress", step: "checking" });

    expect(reading.step).toBe("reading");
    expect(checking.step).toBe("checking");

    const done = conversationReducer(checking, { type: "hintReceived", hint: hint(1) });

    expect(done.step).toBeNull();
  });

  it("clears the step when the hint fails", () => {
    const state = replay(
      { type: "requested", action: "start" },
      { type: "sessionStarted", session: SESSION },
      { type: "hintProgress", step: "writing" },
      { type: "requestFailed", reason: "The backend could not produce a hint." },
    );

    expect(state.step).toBeNull();
  });

  it("ignores a step that arrives when nothing is in flight", () => {
    const idle = conversationReducer(waiting, { type: "hintReceived", hint: hint(1) });

    expect(conversationReducer(idle, { type: "hintProgress", step: "writing" }).step).toBeNull();
  });
});

describe("restoreConversation", () => {
  const live: Conversation = {
    phase: "active",
    hints: [hint(3)],
    answers: [],
    session: SESSION,
    pending: "hint",
    error: "Could not reach the backend.",
    step: "checking",
  };

  it("brings back a session the panel was hiding", () => {
    const restored = restoreConversation(JSON.parse(JSON.stringify(live)));

    expect(restored.phase).toBe("active");
    expect(restored.hints).toHaveLength(1);
  });

  it("comes back idle, not waiting on a reply that is not coming", () => {
    const restored = restoreConversation(JSON.parse(JSON.stringify(live)));

    expect(restored.pending).toBeNull();
    expect(restored.error).toBeNull();
  });

  it("keeps a finished session finished", () => {
    const restored = restoreConversation({ ...live, phase: "finished", pending: null });

    expect(restored.phase).toBe("finished");
  });

  it.each([
    ["nothing stored", undefined],
    ["a draft-phase state", { phase: "draft", hints: [] }],
    ["a shape from an older version", { hints: [hint(1)] }],
    ["not an object", "active"],
  ])("falls back to a fresh conversation: %s", (_name, stored) => {
    expect(restoreConversation(stored)).toEqual(NEW_CONVERSATION);
  });

  it("survives hints that are missing from stored state", () => {
    expect(restoreConversation({ phase: "active" }).hints).toEqual([]);
  });
});
