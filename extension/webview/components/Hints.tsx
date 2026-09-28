import { useState } from "react";

import {
  MAX_QUESTION_CHARS,
  type AnswerView,
  type HintKind,
  type HintStep,
  type HintView,
  type PendingAction,
} from "../../shared/protocol";
import { Field } from "./Field";

interface HintsProps {
  hints: HintView[];
  answers: AnswerView[];
  pending: PendingAction | null;
  step: HintStep | null;
  finished: boolean;
  onRequest: (kind: HintKind) => void;
  onAsk: (hintNumber: number, question: string) => void;
}

/** The top of the ladder. */
const TOP_LEVEL = 8;

/** Plain words for each step. */
const STEP_LABELS: Record<HintStep, string> = {
  reading: "Reading your code…",
  writing: "Writing a hint…",
  checking: "Checking it doesn't give the answer away…",
  rewording: "Rewording it so it doesn't give too much away…",
};

/** The hints so far, and the three ways to ask for another. */
export function Hints({
  hints,
  answers,
  pending,
  step,
  finished,
  onRequest,
  onAsk,
}: HintsProps) {
  const busy = pending !== null;
  const [askingAbout, setAskingAbout] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const trimmed = question.trim();

  function submitQuestion(hintNumber: number): void {
    onAsk(hintNumber, trimmed);
    setQuestion("");
    setAskingAbout(null);
  }
  const highest = hints.reduce((top, hint) => Math.max(top, hint.level), 0);

  return (
    <section className="step">
      <h2 className="step__title">Hints</h2>

      {hints.map((hint, index) => (
        <article className="hint" key={`${index}-${hint.level}`}>
          <header className="hint__header">
            <span className="hint__level">
              Hint {index + 1} · level {hint.level} of {TOP_LEVEL}
            </span>
          </header>

          {/* Model output: rendered as text, never as HTML. */}
          {hint.question !== null && <p className="hint__question">{hint.question}</p>}
          {hint.concept !== null && <p className="hint__concept">{hint.concept}</p>}
          {hint.evidence !== null && <p className="hint__evidence">{hint.evidence}</p>}

          <p className="hint__action">
            <strong>Try this:</strong> {hint.nextAction}
          </p>

          {answers
            .filter((answer) => answer.hintNumber === index + 1)
            .map((answer, answerIndex) => (
              <div className="hint__qa" key={answerIndex}>
                <p className="hint__asked">
                  <strong>You asked:</strong> {answer.question}
                </p>
                <p className="hint__answer">{answer.answer}</p>
                <p className="hint__action">
                  <strong>Try this:</strong> {answer.nextAction}
                </p>
              </div>
            ))}

          {!finished &&
            (askingAbout === index + 1 ? (
              <div className="hint__ask">
                <Field
                  label="What is unclear about this hint?"
                  hint="Ask about a word, a function, or a step. This does not use up a hint."
                  placeholder="For example: what does enumerate() do?"
                  value={question}
                  rows={2}
                  onChange={setQuestion}
                />
                <div className="step__actions">
                  <button
                    type="button"
                    className="button"
                    disabled={
                      busy || trimmed === "" || trimmed.length > MAX_QUESTION_CHARS
                    }
                    onClick={() => submitQuestion(index + 1)}
                  >
                    Ask
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setAskingAbout(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="button button--ghost hint__ask-open"
                disabled={busy}
                onClick={() => setAskingAbout(index + 1)}
              >
                Ask about this hint
              </button>
            ))}
        </article>
      ))}

      {(pending === "hint" || pending === "start" || pending === "ask") && (
        <p className="notice" aria-live="polite">
          {step === null ? "Thinking…" : STEP_LABELS[step]}
        </p>
      )}

      {!finished && (
        <>
          <div className="step__actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => onRequest("normal")}
            >
              Another hint
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => onRequest("stronger")}
            >
              Stronger hint
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => onRequest("stuck")}
            >
              I feel stuck
            </button>
          </div>

          {highest >= TOP_LEVEL && (
            <p className="step__hint">
              This is the strongest hint Socrates' Duck gives. The last step is
              yours.
            </p>
          )}
        </>
      )}
    </section>
  );
}
