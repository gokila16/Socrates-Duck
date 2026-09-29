import { useState } from "react";

import {
  MAX_OBSERVATION_CHARS,
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
  onObserve: (observation: string) => void;
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
  onObserve,
}: HintsProps) {
  const busy = pending !== null;
  const [askingAbout, setAskingAbout] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const trimmed = question.trim();

  const [observing, setObserving] = useState(false);
  const [observation, setObservation] = useState("");
  const observed = observation.trim();

  function submitQuestion(hintNumber: number): void {
    onAsk(hintNumber, trimmed);
    setQuestion("");
    setAskingAbout(null);
  }

  function submitObservation(): void {
    onObserve(observed);
    setObservation("");
    setObserving(false);
  }

  const highest = hints.reduce((top, hint) => Math.max(top, hint.level), 0);
  const current = hints.at(-1)?.level ?? 0;

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

          {!finished &&
            index === hints.length - 1 &&
            (observing ? (
              <div className="hint__ask">
                <Field
                  label="What did you see when you tried it?"
                  hint="The next hint starts from what you found. Your code is not read again."
                  placeholder="For example: the list printed as [] for the second student."
                  value={observation}
                  rows={2}
                  onChange={setObservation}
                />
                <div className="step__actions">
                  <button
                    type="button"
                    className="button"
                    disabled={
                      busy ||
                      observed === "" ||
                      observation.length > MAX_OBSERVATION_CHARS
                    }
                    onClick={submitObservation}
                  >
                    {pending === "observe" ? "Sending…" : "Send and get next hint"}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setObserving(false)}
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
                onClick={() => setObserving(true)}
              >
                I tried it — here's what I saw
              </button>
            ))}
        </article>
      ))}

      {(pending === "hint" ||
        pending === "start" ||
        pending === "ask" ||
        pending === "observe") && (
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

          {highest >= TOP_LEVEL ? (
            <p className="step__hint">
              This is the strongest hint Socrates' Duck gives. The last step is
              yours.
            </p>
          ) : (
            current > 0 && (
              <p className="step__hint">
                You're on level {current} of {TOP_LEVEL}.{" "}
                <strong>Another hint</strong> gives one more at this level, then
                moves up. <strong>Stronger hint</strong> moves up now.
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}
