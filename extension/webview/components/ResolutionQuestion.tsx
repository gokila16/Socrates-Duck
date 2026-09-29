import type { ChosenResolution } from "../../shared/protocol";

interface ResolutionQuestionProps {
  busy: boolean;
  onAnswer: (resolution: ChosenResolution) => void;
  onBack: () => void;
}

const ANSWERS: { value: ChosenResolution; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "partially", label: "Partially" },
  { value: "no", label: "No" },
  { value: "skipped", label: "Skip" },
];

/** Asked before a session ends, so the profile never assumes it was solved. */
export function ResolutionQuestion({ busy, onAnswer, onBack }: ResolutionQuestionProps) {
  return (
    <section className="step">
      <h2 className="step__title">Did you resolve the problem?</h2>
      <p className="step__hint">
        Your answer stays in your profile on this machine.
      </p>

      <div className="step__actions">
        {ANSWERS.map((answer) => (
          <button
            type="button"
            className="button button--secondary"
            key={answer.value}
            disabled={busy}
            onClick={() => onAnswer(answer.value)}
          >
            {answer.label}
          </button>
        ))}
        <button
          type="button"
          className="button button--ghost"
          disabled={busy}
          onClick={onBack}
        >
          Back
        </button>
      </div>
    </section>
  );
}
