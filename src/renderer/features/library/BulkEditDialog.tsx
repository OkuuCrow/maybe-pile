/** §16.4 Bulk edit with a before/after preview, per-item exceptions, one transaction and one Undo. */
import { useEffect, useState } from 'react';
import { STATUSES, type Status } from '../../../shared/enums';
import type { BulkPreviewView } from '../../../shared/views-21';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { statusLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { batchAction } from '../../app/undo';
import { Dialog } from '../../components/Dialog';
import { SelectField, TextField } from '../../components/Fields';

export function BulkEditDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const lists = useAsync(() => call(getApi().lists.list()), []);
  const [status, setStatus] = useState<Status | ''>('');
  const [rating, setRating] = useState<string>('');
  const [tagMode, setTagMode] = useState<'' | 'add' | 'remove' | 'replace'>('');
  const [tags, setTags] = useState('');
  const [listMode, setListMode] = useState<'' | 'add' | 'remove'>('');
  const [listId, setListId] = useState('');
  const [platform, setPlatform] = useState('');
  const [preview, setPreview] = useState<BulkPreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const change = {
    status: status || null,
    rating: rating === '' ? null : rating === 'clear' ? ('clear' as const) : Number(rating),
    tags: tagMode
      ? {
          mode: tagMode,
          values: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        }
      : null,
    moods: null,
    list: listMode && listId ? { mode: listMode, listId } : null,
    platform: platform.trim() || null,
  };
  const key = JSON.stringify(change);
  useEffect(() => {
    let alive = true;
    void call(getApi().bulkEdit.preview({ ids, change }))
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setPreview(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await call(getApi().bulkEdit.apply({ ids, change }));
      app.bumpData();
      toast.show(
        {
          kind: 'success',
          message: `Updated ${r.changed} item(s)${r.exceptions.length ? `; ${r.exceptions.length} skipped` : ''}.`,
          action: batchAction(r.batchId, () => app.bumpData()),
        },
        15_000,
      );
      onClose();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  const anyChange = preview ? preview.changes.length > 0 : false;
  return (
    <Dialog
      title={`Edit ${ids.length} item(s)`}
      onClose={onClose}
      size="large"
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void apply()}
            disabled={busy || !anyChange}
          >
            {busy ? 'Saving…' : 'Apply changes'}
          </button>
        </>
      }
    >
      <div className="field-row">
        <SelectField
          label="Status"
          value={status}
          onChange={(v) => setStatus(v)}
          options={[
            { value: '', label: 'Keep as is' },
            ...STATUSES.map((st) => ({ value: st, label: statusLabel(st) })),
          ]}
        />
        <SelectField
          label="Rating"
          value={rating}
          onChange={setRating}
          options={[
            { value: '', label: 'Keep as is' },
            { value: 'clear', label: 'Clear rating' },
            ...Array.from({ length: 10 }, (_, i) => ({
              value: String(i + 1),
              label: `${(i + 1) / 2} stars`,
            })),
          ]}
        />
      </div>
      <div className="field-row">
        <SelectField
          label="Tags"
          value={tagMode}
          onChange={setTagMode}
          options={[
            { value: '', label: 'Keep as is' },
            { value: 'add', label: 'Add tags' },
            { value: 'remove', label: 'Remove tags' },
            { value: 'replace', label: 'Replace all tags' },
          ]}
        />
        {tagMode && <TextField label="Tags (comma separated)" value={tags} onChange={setTags} />}
      </div>
      <div className="field-row">
        <SelectField
          label="List"
          value={listMode}
          onChange={setListMode}
          options={[
            { value: '', label: 'Keep as is' },
            { value: 'add', label: 'Add to list' },
            { value: 'remove', label: 'Remove from list' },
          ]}
        />
        {listMode && (
          <SelectField
            label="Which list"
            value={listId}
            onChange={setListId}
            options={[
              { value: '', label: 'Choose…' },
              ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
        )}
      </div>
      <TextField label="Add platform (games)" value={platform} onChange={setPlatform} maxLength={80} />
      <section aria-labelledby="bulk-preview" className="bulk-preview" aria-live="polite">
        <h3 id="bulk-preview">Preview</h3>
        {!preview ? (
          <p className="muted">Choose a change.</p>
        ) : (
          <>
            <ul>
              {preview.changes.map((c) => (
                <li key={c.field}>
                  {c.label}: <strong>{c.count}</strong> item(s) will change
                </li>
              ))}
              {preview.unchanged > 0 && <li>{preview.unchanged} item(s) already match</li>}
            </ul>
            {preview.exceptions.length > 0 && (
              <>
                <p>
                  <strong>{preview.exceptions.length} item(s) will be skipped:</strong>
                </p>
                <ul>
                  {preview.exceptions.slice(0, 20).map((e) => (
                    <li key={e.itemId}>
                      {e.title} — {e.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>
    </Dialog>
  );
}
