/**
 * Quick Capture (Ctrl/Cmd+Shift+N, optional global shortcut): Title + Type →
 * a Planned item, immediately, through the same validated create path as the
 * Add dialog. Never waits on the network; metadata search is an optional
 * follow-up from the item page.
 */
import { useId, useState } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import type { DuplicateMatch } from '../../../shared/types';
import { call, errorOf, getApi } from '../../app/api';
import { useApp } from '../../app/context';
import { typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Dialog } from '../../components/Dialog';

/** Gentle type hint from the title text (never overrides the user's choice). */
export function guessType(title: string): MediaType | null {
  const t = title.toLowerCase();
  if (/\b(season|s\d{1,2}e\d{1,2}|series|tv)\b/.test(t)) return 'tv';
  if (/\b(novel|book|vol\.?|volume|isbn)\b/.test(t)) return 'book';
  if (/\b(game|goty|remastered|edition|dlc)\b/.test(t)) return 'game';
  if (/\b(film|movie)\b/.test(t)) return 'movie';
  return null;
}

export function QuickCapture({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const uid = useId();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<MediaType>('movie');
  const [touchedType, setTouchedType] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dupes, setDupes] = useState<DuplicateMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const hint = touchedType ? null : guessType(title);

  const save = async (allowDuplicate: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await call(getApi().items.quickCapture({ title, type, allowDuplicate }));
      if (r.kind === 'duplicates') {
        setDupes(r.matches);
        return;
      }
      app.bumpData();
      onClose();
      toast.show({
        kind: 'success',
        message: `Added “${r.item.meta.title}” as Planned.`,
        action: { label: 'Open & search details', run: () => app.navigate({ name: 'item', id: r.item.id }) },
      });
    } catch (e) {
      const err = errorOf(e);
      setError(err.fieldErrors?.['title'] ?? err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Quick Capture"
      onClose={onClose}
      size="small"
      initialFocusId={`${uid}-title`}
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          {dupes ? (
            <button
              type="button"
              className="button button-primary"
              onClick={() => void save(true)}
              disabled={busy}
            >
              Add anyway
            </button>
          ) : (
            <button type="submit" form={`${uid}-form`} className="button button-primary" disabled={busy}>
              Add to pile
            </button>
          )}
        </>
      }
    >
      <form
        id={`${uid}-form`}
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <div className={`field ${error ? 'field-invalid' : ''}`}>
          <label htmlFor={`${uid}-title`}>
            Title<span aria-hidden="true"> *</span>
            <span className="visually-hidden"> (required)</span>
          </label>
          <input
            id={`${uid}-title`}
            className="input"
            value={title}
            onChange={(e) => (setTitle(e.target.value), setDupes(null))}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${uid}-err` : undefined}
            autoComplete="off"
          />
          {error && (
            <p className="field-error" id={`${uid}-err`}>
              <span aria-hidden="true">⚠ </span>
              {error}
            </p>
          )}
        </div>
        <fieldset className="radio-row">
          <legend>Type</legend>
          {MEDIA_TYPES.map((t) => (
            <label key={t} className="radio-pill">
              <input
                type="radio"
                name={`${uid}-type`}
                value={t}
                checked={type === t}
                onChange={() => (setType(t), setTouchedType(true))}
              />{' '}
              {typeLabel(t)}
            </label>
          ))}
        </fieldset>
        {hint && hint !== type && (
          <p className="field-hint">
            Looks like a {typeLabel(hint).toLowerCase()}.{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => (setType(hint), setTouchedType(true))}
            >
              Use {typeLabel(hint)}
            </button>
          </p>
        )}
      </form>
      <div aria-live="polite">
        {dupes && (
          <div className="notice notice-warning">
            <p>You may already have this:</p>
            <ul>
              {dupes.map((d) => (
                <li key={d.id}>
                  <a href={`#/item/${d.id}`} onClick={onClose}>
                    {d.title}
                    {d.year ? ` (${d.year})` : ''}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
