import { useEffect, useReducer, useState } from "react";

import {
  attachmentKey,
  MAX_ATTACHMENTS,
  type CodeContext,
  type FileCandidate,
  type HintKind,
  type HostToWebview,
  type Outcome,
} from "../shared/protocol";
import { Attachments } from "./components/Attachments";
import { ErrorEvidence } from "./components/ErrorEvidence";
import { Field } from "./components/Field";
import { Hints } from "./components/Hints";
import { ReportResult } from "./components/ReportResult";
import {
  conversationReducer,
  highestLevel,
  missingForStart,
  restoreConversation,
  type Conversation,
} from "./session";
import { vscodeApi } from "./vscodeApi";

/** What the developer has typed and attached so far. */
interface Draft {
  problem: string;
  errorText: string;
  attachments: CodeContext[];
}

/** Everything that has to survive the webview being destroyed and rebuilt. */
interface StoredState {
  draft: Draft;
  conversation: Conversation;
}

const EMPTY_DRAFT: Draft = {
  problem: "",
  errorText: "",
  attachments: [],
};

function storedState(): Partial<StoredState> {
  const stored = vscodeApi.getState();

  return typeof stored === "object" && stored !== null ? stored : {};
}

function loadDraft(): Draft {
  const stored = storedState().draft;

  if (typeof stored !== "object" || stored === null) {
    return EMPTY_DRAFT;
  }

  const draft = stored as Partial<Draft>;

  return {
    problem: typeof draft.problem === "string" ? draft.problem : "",
    errorText: typeof draft.errorText === "string" ? draft.errorText : "",
    attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
  };
}

export function App() {
  const [draft, setDraft] = useState<Draft>(loadDraft);

  const [conversation, dispatch] = useReducer(
    conversationReducer,
    undefined,
    () => restoreConversation(storedState().conversation),
  );

  const [candidates, setCandidates] = useState<FileCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [exception, setException] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<string[]>([]);

  const [analyzedText, setAnalyzedText] = useState<string | null>(null);

  const candidatesAreStale =
    analyzedText !== null && analyzedText !== draft.errorText;
  const atCapacity = draft.attachments.length >= MAX_ATTACHMENTS;

  useEffect(() => {
    vscodeApi.setState({ draft, conversation } satisfies StoredState);
  }, [draft, conversation]);

  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>): void {
      const message = event.data as HostToWebview | undefined;

      if (typeof message !== "object" || message === null) {
        return;
      }

      switch (message.type) {
        case "captured":
          setDraft((current) => {
            const key = attachmentKey(message.context);
            const others = current.attachments.filter(
              (attachment) => attachmentKey(attachment) !== key,
            );

            if (others.length >= MAX_ATTACHMENTS) {
              return current;
            }

            return { ...current, attachments: [...others, message.context] };
          });
          return;

        case "captureFailed":
          setErrors((current) =>
            current.includes(message.reason) ? current : [...current, message.reason],
          );
          return;

        case "sessionStarted":
          dispatch({ type: "sessionStarted", session: message.session });
          return;

        case "hintReceived":
          dispatch({ type: "hintReceived", hint: message.hint });
          return;

        case "hintProgress":
          dispatch({ type: "hintProgress", step: message.step });
          return;

        case "answerReceived":
          dispatch({ type: "answerReceived", answer: message.answer });
          return;

        case "attemptRecorded":
          dispatch({
            type: "attemptRecorded",
            session: message.session,
            hintFollows: message.hintFollows,
          });
          return;

        case "sessionEnded":
          dispatch({ type: "sessionEnded", session: message.session });
          return;

        case "requestFailed":
          dispatch({ type: "requestFailed", reason: message.reason });
          return;

        case "errorAnalyzed":
          setCandidates(message.candidates);
          setSelectedIds(message.candidates.map((candidate) => candidate.id));
          setException(message.exception);
          return;
      }
    }

    window.addEventListener("message", onMessage);

    vscodeApi.postMessage({ type: "ready" });

    return () => window.removeEventListener("message", onMessage);
  }, []);

  function beginAction(): void {
    setErrors([]);
  }

  function requestCapture(source: "selection" | "file"): void {
    beginAction();
    vscodeApi.postMessage({ type: "capture", source });
  }

  function analyzeError(): void {
    beginAction();
    setCandidates([]);
    setSelectedIds([]);
    setException(undefined);
    setAnalyzedText(draft.errorText);
    vscodeApi.postMessage({ type: "analyzeError", text: draft.errorText });
  }

  function attachSelected(): void {
    beginAction();
    vscodeApi.postMessage({ type: "attachFiles", ids: selectedIds });
  }

  function startSession(): void {
    beginAction();
    dispatch({ type: "requested", action: "start" });
    vscodeApi.postMessage({
      type: "startSession",
      problem: draft.problem,
      evidence: draft.errorText,
      contexts: draft.attachments,
    });
  }

  function requestHint(kind: HintKind): void {
    dispatch({ type: "requested", action: "hint" });
    vscodeApi.postMessage({ type: "requestHint", kind });
  }

  function askQuestion(hintNumber: number, question: string): void {
    beginAction();
    dispatch({ type: "requested", action: "ask" });
    vscodeApi.postMessage({ type: "askQuestion", hintNumber, question });
  }

  function reportOutcome(
    outcome: Outcome,
    reasoning: string,
    evidence: string,
  ): void {
    dispatch({ type: "requested", action: "report" });
    vscodeApi.postMessage({ type: "reportOutcome", outcome, reasoning, evidence });
  }

  function endSession(
    status: "completed" | "abandoned",
    outcome: Outcome | null,
  ): void {
    dispatch({ type: "requested", action: "end" });
    vscodeApi.postMessage({ type: "endSession", status, outcome });
  }

  function toggleCandidate(id: string): void {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((selected) => selected !== id)
        : [...current, id],
    );
  }

  const blocker = missingForStart(draft);
  const busy = conversation.pending !== null;
  const finished = conversation.phase === "finished";

  return (
    <main className="panel">
      <header className="panel__header">
        <h1 className="panel__title">Socrates' Duck</h1>
        <p className="panel__tagline">
          Progressive hints that leave the reasoning to you.
        </p>
      </header>

      {errors.map((message) => (
        <p className="notice notice--error" role="alert" key={message}>
          {message}
        </p>
      ))}

      {conversation.error !== null && (
        <p className="notice notice--error" role="alert">
          {conversation.error}
        </p>
      )}

      {conversation.phase === "draft" ? (
        <>
          <section className="step">
            <Field
              label="What's going wrong?"
              hint="Say what happens and, if you have one, your guess why. A rough guess is fine."
              value={draft.problem}
              onChange={(problem) =>
                setDraft((current) => ({ ...current, problem }))
              }
            />
          </section>

          <ErrorEvidence
            value={draft.errorText}
            onChange={(errorText) =>
              setDraft((current) => ({ ...current, errorText }))
            }
            onAnalyze={analyzeError}
            analyzed={analyzedText !== null}
            stale={candidatesAreStale}
            exception={exception}
            candidates={candidates}
            selectedIds={selectedIds}
            onToggle={toggleCandidate}
            onAttach={attachSelected}
            atCapacity={atCapacity}
          />

          <Attachments
            attachments={draft.attachments}
            atCapacity={atCapacity}
            onRemove={(key) =>
              setDraft((current) => ({
                ...current,
                attachments: current.attachments.filter(
                  (attachment) => attachmentKey(attachment) !== key,
                ),
              }))
            }
            onCaptureSelection={() => requestCapture("selection")}
            onCaptureFile={() => requestCapture("file")}
          />

          <section className="step">
            <div className="step__actions">
              <button
                type="button"
                className="button"
                disabled={blocker !== null || busy}
                onClick={startSession}
              >
                {busy ? "Working…" : "Get my first hint"}
              </button>
            </div>

            {blocker !== null && <p className="step__hint">{blocker}</p>}
          </section>
        </>
      ) : (
        <>
          <Hints
            hints={conversation.hints}
            answers={conversation.answers}
            pending={conversation.pending}
            step={conversation.step}
            finished={finished}
            onRequest={requestHint}
            onAsk={askQuestion}
          />

          {finished ? (
            <section className="step">
              <h2 className="step__title">
                {conversation.session?.status === "completed"
                  ? "Session complete"
                  : "Session ended"}
              </h2>
              <p className="step__hint">
                {conversation.hints.length}{" "}
                {conversation.hints.length === 1 ? "hint" : "hints"}, highest
                level {highestLevel(conversation.hints)} of 8.
              </p>

              <div className="step__actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => dispatch({ type: "reset" })}
                >
                  Start another session
                </button>
              </div>
            </section>
          ) : (
            <ReportResult
              pending={conversation.pending}
              onReport={reportOutcome}
              onEnd={endSession}
            />
          )}
        </>
      )}

      <footer className="panel__footer">
        Your code goes only to the Socrates' Duck backend running on this
        machine, and only when you press a button.
      </footer>
    </main>
  );
}
