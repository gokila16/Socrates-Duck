import { attachmentKey, type CodeContext } from "../../shared/protocol";

interface AttachmentsProps {
  attachments: CodeContext[];
  atCapacity: boolean;
  onRemove: (key: string) => void;
  onCaptureSelection: () => void;
  onCaptureFile: () => void;
}

const SOURCE_LABEL: Record<CodeContext["source"], string> = {
  selection: "your selection",
  file: "whole file",
  traceback: "named by the error",
};

export function Attachments({
  attachments,
  atCapacity,
  onRemove,
  onCaptureSelection,
  onCaptureFile,
}: AttachmentsProps) {
  return (
    <section className="step">
      <h2 className="step__title">Attached code</h2>
      <p className="step__hint">
        Everything Socrates' Duck will look at. Nothing is read from your editor
        until you ask for it.
      </p>

      <div className="step__actions">
        <button
          type="button"
          className="button"
          disabled={atCapacity}
          onClick={onCaptureSelection}
        >
          Use selection
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={atCapacity}
          onClick={onCaptureFile}
        >
          Use active file
        </button>
      </div>

      {atCapacity && (
        <p className="notice notice--warn">
          Maximum attachments reached. Remove one to attach something else.
        </p>
      )}

      {attachments.length === 0 ? (
        <p className="step__hint">Nothing attached yet.</p>
      ) : (
        attachments.map((context) => (
          <article className="attached" key={attachmentKey(context)}>
            <div className="attached__meta">
              <span className="attached__label">{context.label}</span>
              <span className="attached__detail">
                {SOURCE_LABEL[context.source]} · lines {context.startLine}–
                {context.endLine} · {context.languageId}
              </span>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => onRemove(attachmentKey(context))}
              >
                Remove
              </button>
            </div>

            {context.truncated && (
              <p className="notice notice--warn">
                Only {context.lineCount} lines were attached — this file is
                longer than the limit.
              </p>
            )}

            <pre className="attached__code">
              <code>{context.code}</code>
            </pre>
          </article>
        ))
      )}
    </section>
  );
}
