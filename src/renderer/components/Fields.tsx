/**
 * Form primitives with programmatic labels, hints and errors.
 * Errors set aria-invalid and are linked through aria-describedby.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconClose } from './Icons';

interface BaseProps {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean;
  id?: string;
  className?: string;
}

function describedBy(hintId: string, errId: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? hintId : null, error ? errId : null].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

function FieldShell({
  label,
  hint,
  error,
  required,
  inputId,
  hintId,
  errId,
  children,
  className,
}: BaseProps & { inputId: string; hintId: string; errId: string; children: ReactNode }) {
  return (
    <div className={`field ${error ? 'field-invalid' : ''} ${className ?? ''}`}>
      <label htmlFor={inputId}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
        {required && <span className="visually-hidden"> (required)</span>}
      </label>
      {children}
      {hint && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={errId}>
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField(
  props: BaseProps & {
    value: string;
    onChange: (v: string) => void;
    type?: string;
    placeholder?: string;
    maxLength?: number;
    autoFocus?: boolean;
    inputMode?: 'numeric' | 'decimal' | 'text';
  },
) {
  const gen = useId();
  const id = props.id ?? gen;
  return (
    <FieldShell {...props} inputId={id} hintId={`${id}-hint`} errId={`${id}-err`}>
      <input
        id={id}
        className="input"
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        inputMode={props.inputMode}
        required={props.required}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(`${id}-hint`, `${id}-err`, props.hint, props.error)}
        onChange={(e) => props.onChange(e.target.value)}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={props.autoFocus}
      />
    </FieldShell>
  );
}

export function TextArea(
  props: BaseProps & { value: string; onChange: (v: string) => void; rows?: number; maxLength?: number },
) {
  const gen = useId();
  const id = props.id ?? gen;
  return (
    <FieldShell {...props} inputId={id} hintId={`${id}-hint`} errId={`${id}-err`}>
      <textarea
        id={id}
        className="input"
        rows={props.rows ?? 4}
        value={props.value}
        maxLength={props.maxLength}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(`${id}-hint`, `${id}-err`, props.hint, props.error)}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </FieldShell>
  );
}

export function NumberField(
  props: BaseProps & {
    value: number | null;
    onChange: (v: number | null) => void;
    min?: number;
    max?: number;
    step?: number;
  },
) {
  const gen = useId();
  const id = props.id ?? gen;
  const [raw, setRaw] = useState(props.value === null ? '' : String(props.value));
  const [lastProp, setLastProp] = useState(props.value);
  if (props.value !== lastProp) {
    setLastProp(props.value);
    setRaw(props.value === null ? '' : String(props.value));
  }
  return (
    <FieldShell {...props} inputId={id} hintId={`${id}-hint`} errId={`${id}-err`}>
      <input
        id={id}
        className="input"
        type="number"
        inputMode="decimal"
        value={raw}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(`${id}-hint`, `${id}-err`, props.hint, props.error)}
        onChange={(e) => {
          setRaw(e.target.value);
          const n = e.target.value === '' ? null : Number(e.target.value);
          props.onChange(n === null || Number.isFinite(n) ? n : null);
        }}
      />
    </FieldShell>
  );
}

export function SelectField<T extends string>(
  props: BaseProps & { value: T; onChange: (v: T) => void; options: readonly { value: T; label: string }[] },
) {
  const gen = useId();
  const id = props.id ?? gen;
  return (
    <FieldShell {...props} inputId={id} hintId={`${id}-hint`} errId={`${id}-err`}>
      <select
        id={id}
        className="input"
        value={props.value}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(`${id}-hint`, `${id}-err`, props.hint, props.error)}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  hint,
  id: given,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  id?: string;
}) {
  const gen = useId();
  const id = given ?? gen;
  return (
    <div className="checkbox">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** Editable list of short strings (tags, genres, alternate titles). */
export function ListInput({
  label,
  values,
  onChange,
  placeholder,
  hint,
  error,
  max = 100,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  hint?: string;
  error?: string | undefined;
  max?: number;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft
      .split(/[,;\n]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const lower = new Set(values.map((v) => v.toLowerCase()));
    onChange([...values, ...parts.filter((p) => !lower.has(p.toLowerCase()))].slice(0, max));
    setDraft('');
  };
  return (
    <div className={`field ${error ? 'field-invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {values.length > 0 && (
        <ul className="chip-list" aria-label={`${label} added`}>
          {values.map((v, i) => (
            <li key={`${v}-${i}`} className="chip">
              <span>{v}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${v}`}
                onClick={() => onChange(values.filter((_, j) => j !== i))}
              >
                <IconClose size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <input
          id={id}
          className="input"
          value={draft}
          placeholder={placeholder}
          aria-describedby={hint || error ? `${id}-desc` : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="button" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {(hint || error) && (
        <p className={error ? 'field-error' : 'field-hint'} id={`${id}-desc`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

/**
 * Error summary. It receives focus once per submit attempt (`focusKey`), so
 * screen readers announce it, without stealing focus while the user types.
 * Links move focus to the offending field.
 */
export function ErrorSummary({
  errors,
  focusKey,
  title = 'Please fix the following',
}: {
  errors: { fieldId?: string; message: string }[];
  focusKey: number;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [focusKey]);
  if (errors.length === 0) return null;
  return (
    <div className="error-summary" role="alert" tabIndex={-1} ref={ref}>
      <h3>{title}</h3>
      <ul>
        {errors.map((e, i) => (
          <li key={i}>
            {e.fieldId ? (
              <a
                href={`#${e.fieldId}`}
                onClick={(ev) => {
                  ev.preventDefault();
                  document.getElementById(e.fieldId ?? '')?.focus();
                }}
              >
                {e.message}
              </a>
            ) : (
              e.message
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
