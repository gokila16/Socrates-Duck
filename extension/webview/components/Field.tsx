import { useId } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  rows?: number;
  onChange: (value: string) => void;
}

/** A labelled textarea. */
export function Field({
  label,
  hint,
  placeholder,
  value,
  rows = 4,
  onChange,
}: FieldProps) {
  const id = useId();

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>

      {hint !== undefined && <p className="field__hint">{hint}</p>}

      <textarea
        id={id}
        className="field__input"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
