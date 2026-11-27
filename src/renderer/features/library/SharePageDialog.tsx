/** §14.8 Share page: choose fields, preview (counts + table), save a self-contained HTML file. */
import { useEffect, useState } from 'react';
import { call, errorOf, getApi } from '../../app/api';
import { fmtBytes } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Dialog } from '../../components/Dialog';
import { Checkbox, TextField } from '../../components/Fields';

type Source = { kind: 'items'; ids: string[] } | { kind: 'list'; id: string } | { kind: 'view'; id: string };
const FIELDS = [
  ['type', 'Type'],
  ['year', 'Year'],
  ['status', 'Status'],
  ['rating', 'Rating'],
  ['cover', 'Cover (your own images only unless allowed below)'],
] as const;

export function SharePageDialog({
  source,
  onClose,
  defaultTitle = 'My pile',
}: {
  source: Source;
  onClose: () => void;
  defaultTitle?: string;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(defaultTitle);
  const [fields, setFields] = useState<string[]>(['type', 'status', 'rating']);
  const [adult, setAdult] = useState(false);
  const [providerArt, setProviderArt] = useState(false);
  const [preview, setPreview] = useState<{ rows: number; bytes: number } | null>(null);
  const input = {
    title: title.trim() || 'My pile',
    source,
    fields: fields as ('type' | 'status' | 'rating' | 'year' | 'cover')[],
    includeAdult: adult,
    includeProviderArt: providerArt,
  };
  const key = JSON.stringify(input);
  useEffect(() => {
    let alive = true;
    void call(getApi().sharePage.preview(input))
      .then((r) => alive && setPreview({ rows: r.rows, bytes: r.bytes }))
      .catch(() => alive && setPreview(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const save = async () => {
    try {
      const r = await call(getApi().sharePage.save(input));
      if (r) {
        toast.success(`Saved ${r.fileLabel}.`);
        onClose();
      }
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <Dialog
      title="Share page"
      onClose={onClose}
      size="medium"
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button-primary" onClick={() => void save()}>
            Save HTML file…
          </button>
        </>
      }
    >
      <p className="muted">
        A single web page you can email or upload anywhere. It has no scripts, loads nothing from the
        internet, and never includes notes, prices, loans or people.
      </p>
      <TextField label="Page title" value={title} onChange={setTitle} maxLength={120} />
      <fieldset className="field">
        <legend>Show</legend>
        <p className="field-hint">Title is always shown.</p>
        {FIELDS.map(([f, label]) => (
          <Checkbox
            key={f}
            label={label}
            checked={fields.includes(f)}
            onChange={(v) => setFields((x) => (v ? [...x, f] : x.filter((y) => y !== f)))}
          />
        ))}
      </fieldset>
      <Checkbox label="Include adult-flagged items" checked={adult} onChange={setAdult} />
      {fields.includes('cover') && (
        <Checkbox
          label="Include artwork from online sources"
          hint="That artwork belongs to its owners; only share it where you are allowed to."
          checked={providerArt}
          onChange={setProviderArt}
        />
      )}
      <p role="status" aria-live="polite">
        {preview ? `Preview: ${preview.rows} item(s), ${fmtBytes(preview.bytes)}.` : 'Preparing preview…'}
      </p>
    </Dialog>
  );
}
