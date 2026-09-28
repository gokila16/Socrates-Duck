/** The panel's conversation state, as a pure function. */

import type {
  AnswerView,
  HintStep,
  HintView,
  PendingAction,
  SessionView,
} from "../shared/protocol";

/** draft nothing sent yet; the developer is filling the form active the backend has a session; hints can be asked for finished completed or abandoned; nothing further can be asked */
export type Phase = "draft" | "active" | "finished";

export interface Conversation {
  phase: Phase;
  hints: HintView[];
  answers: AnswerView[];
  session: SessionView | null;
  pending: PendingAction | null;
  error: string | null;
  step: HintStep | null;
}

export const NEW_CONVERSATION: Conversation = {
  phase: "draft",
  hints: [],
  answers: [],
  session: null,
  pending: null,
  error: null,
  step: null,
};

/** Rebuilds the conversation after VS Code has thrown the webview away. */
export function restoreConversation(stored: unknown): Conversation {
  if (typeof stored !== "object" || stored === null) {
    return NEW_CONVERSATION;
  }

  const saved = stored as Partial<Conversation>;

  if (saved.phase !== "active" && saved.phase !== "finished") {
    return NEW_CONVERSATION;
  }

  return {
    phase: saved.phase,
    hints: Array.isArray(saved.hints) ? saved.hints : [],
    answers: Array.isArray(saved.answers) ? saved.answers : [],
    session: typeof saved.session === "object" ? saved.session : null,
    pending: null,
    error: null,
    step: null,
  };
}

export type ConversationEvent =
  | { type: "requested"; action: PendingAction }
  | { type: "sessionStarted"; session: SessionView }
  | { type: "hintReceived"; hint: HintView }
  | { type: "hintProgress"; step: HintStep }
  | { type: "answerReceived"; answer: AnswerView }
  | { type: "attemptRecorded"; session: SessionView; hintFollows: boolean }
  | { type: "sessionEnded"; session: SessionView }
  | { type: "requestFailed"; reason: string }
  | { type: "reset" };

export function conversationReducer(
  state: Conversation,
  event: ConversationEvent,
): Conversation {
  switch (event.type) {
    case "requested":
      return { ...state, pending: event.action, error: null, step: null };

    case "sessionStarted":
      return { ...state, phase: "active", session: event.session };

    case "hintReceived":
      return {
        ...state,
        phase: "active",
        hints: [...state.hints, event.hint],
        pending: null,
        step: null,
      };

    case "answerReceived":
      return {
        ...state,
        answers: [...state.answers, event.answer],
        pending: null,
        step: null,
      };

    case "hintProgress":
      return state.pending === null ? state : { ...state, step: event.step };

    case "attemptRecorded":
      return {
        ...state,
        session: event.session,
        pending: event.hintFollows ? "hint" : null,
      };

    case "sessionEnded":
      return {
        ...state,
        phase: "finished",
        session: event.session,
        pending: null,
      };

    case "requestFailed":
      return { ...state, pending: null, error: event.reason, step: null };

    case "reset":
      return NEW_CONVERSATION;
  }
}

/** The highest rung reached so far, or 0 before the first hint. */
export function highestLevel(hints: HintView[]): number {
  return hints.reduce((highest, hint) => Math.max(highest, hint.level), 0);
}

/** Whether the developer has given the backend enough to work with. */
export function missingForStart(draft: {
  problem: string;
  attachments: unknown[];
}): string | null {
  if (draft.problem.trim() === "") {
    return "Describe what is going wrong first.";
  }

  if (draft.attachments.length === 0) {
    return "Attach at least one piece of code.";
  }

  return null;
}
