import { useState } from "react";

import type {
  ChosenResolution,
  Outcome,
  PendingAction,
} from "../../shared/protocol";
import { Field } from "./Field";
import { ResolutionQuestion } from "./ResolutionQuestion";

type EndStatus = "completed" | "abandoned";

interface ReportResultProps {
  pending: PendingAction | null;
  onReport: (outcome: Outcome, reasoning: string, evidence: string) => void;
  onEnd: (
    status: EndStatus,
    outcome: Outcome | null,
    resolution: ChosenResolution,
  ) => void;
}

const OUTCOMES: { value: Outcome; label: string; hint: string }[] = [
  {
    value: "resolved",
    label: "It works now",
    hint: "You found it and the code does what you expected.",
  },
  {
    value: "still_stuck",
    label: "Still stuck",
    hint: "You tried something; the same problem is still there.",
  },
  {
    value: "different_error",
    label: "Different error now",
    hint: "Something changed — a new error, or new wrong output.",
  },
];

/** "Report Result": what happened when the developer reran their own code. */
export function ReportResult({ pending, onReport, onEnd }: ReportResultProps) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [reasoning, setReasoning] = useState("");
  const [evidence, setEvidence] = useState("");
  const [ending, setEnding] = useState<EndStatus | null>(null);

  const busy = pending !== null;
  const ready = outcome !== null && reasoning.trim() !== "";
  const resolved = outcome === "resolved";

  function submit(): void {
    if (outcome === null) {
      return;
    }

    onReport(outcome, reasoning, evidence);
    setReasoning("");
    setEvidence("");
    setOutcome(null);
  }

  if (ending !== null) {
    return (
      <ResolutionQuestion
        busy={busy}
        onAnswer={(resolution) => onEnd(ending, outcome, resolution)}
        onBack={() => setEnding(null)}
      />
    );
  }

  return (
    <section className="step">
      <h2 className="step__title">Report result</h2>
      <p className="step__hint">
        Edit and rerun your code yourself, then tell Socrates' Duck what
        happened. When you report, your attached code is read again, so the
        next hint sees your changes.
      </p>

      <div className="outcomes">
        {OUTCOMES.map((option) => (
          <label className="outcome" key={option.value}>
            <input
              type="radio"
              name="outcome"
              checked={outcome === option.value}
              onChange={() => setOutcome(option.value)}
            />
            <span className="outcome__label">{option.label}</span>
            <span className="outcome__hint">{option.hint}</span>
          </label>
        ))}
      </div>

      {resolved ? (
        <>
          <p className="notice">
            Nice work — you fixed it yourself. Finish the session when you are
            ready.
          </p>

          <div className="step__actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => onEnd("completed", "resolved", "yes")}
            >
              Finish session
            </button>
          </div>
        </>
      ) : (
        <>
          <Field
            label="What did you try, and what happened?"
            hint="This is what the next hint builds on."
            value={reasoning}
            rows={3}
            onChange={setReasoning}
          />

          <Field
            label="What printed, or a new error (optional)"
            placeholder="Paste anything you printed or saw that seems useful."
            value={evidence}
            rows={3}
            onChange={setEvidence}
          />

          <div className="step__actions">
            <button
              type="button"
              className="button"
              disabled={!ready || busy}
              onClick={submit}
            >
              {pending === "report" ? "Sending…" : "Report and get next hint"}
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => setEnding("completed")}
            >
              Finish session
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={() => setEnding("abandoned")}
            >
              Give up on this one
            </button>
          </div>
        </>
      )}
    </section>
  );
}
