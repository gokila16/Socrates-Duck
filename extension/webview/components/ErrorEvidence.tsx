import type { FileCandidate } from "../../shared/protocol";
import { Field } from "./Field";

interface ErrorEvidenceProps {
  value: string;
  onChange: (value: string) => void;
  onAnalyze: () => void;
  analyzed: boolean;
  stale: boolean;
  exception: string | undefined;
  candidates: FileCandidate[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onAttach: () => void;
  atCapacity: boolean;
}

/** The error box, and the file candidates it turns into. */
export function ErrorEvidence({
  value,
  onChange,
  onAnalyze,
  analyzed,
  stale,
  exception,
  candidates,
  selectedIds,
  onToggle,
  onAttach,
  atCapacity,
}: ErrorEvidenceProps) {
  const hasText = value.trim() !== "";

  return (
    <section className="step">
      <Field
        label="Error, traceback, or unexpected output"
        hint="Paste it exactly as it appeared. Any toolchain is fine."
        placeholder={'Traceback (most recent call last):\n  File "app.py", line 12, in <module>'}
        value={value}
        rows={6}
        onChange={onChange}
      />

      <div className="step__actions">
        <button
          type="button"
          className="button"
          disabled={!hasText}
          onClick={onAnalyze}
        >
          Find the files this mentions
        </button>
      </div>

      {stale && (
        <p className="notice notice--warn">
          The error text changed since these files were found. Run{" "}
          <strong>Find the files this mentions</strong> again.
        </p>
      )}

      {analyzed && !stale && exception !== undefined && (
        <p className="evidence__summary">{exception}</p>
      )}

      {analyzed && !stale && candidates.length === 0 && (
        <p className="notice notice--warn">
          No files from this workspace were named in that text. You can still
          attach code yourself below.
        </p>
      )}

      {!stale && candidates.length > 0 && (
        <>
          <p className="step__hint">
            This error mentions {candidates.length}{" "}
            {candidates.length === 1 ? "file" : "files"}. Choose what to
            include — nothing is read until you do.
          </p>

          <ul className="candidates">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <label className="candidate">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(candidate.id)}
                    onChange={() => onToggle(candidate.id)}
                  />
                  <span className="candidate__label">{candidate.label}</span>
                  <span className="candidate__detail">
                    {formatSize(candidate.sizeBytes)} · mentioned at{" "}
                    {formatLines(candidate.referencedLines)}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {atCapacity && (
            <p className="notice notice--warn">
              You have attached the maximum number of files. Remove one below to
              add another.
            </p>
          )}

          <div className="step__actions">
            <button
              type="button"
              className="button"
              disabled={selectedIds.length === 0 || atCapacity}
              onClick={onAttach}
            >
              Attach selected
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Sizes, not line counts: counting lines would mean reading the file. */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatLines(lines: number[]): string {
  const label = lines.length === 1 ? "line" : "lines";

  return `${label} ${lines.join(", ")}`;
}
