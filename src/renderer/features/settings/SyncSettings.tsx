/**
 * Settings → Data → Sync folder. The folder is chosen with the OS dialog in
 * main (the renderer never sends a path). Sync always shows a dry-run preview
 * first; conflicts are reviewed one by one.
 */
import { useState } from 'react';
import type { SyncPreviewView } from '../../../shared/types';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { useToast } from '../../app/toast';
import { ErrorBox, Loading } from '../../components/Bits';
import { TextField } from '../../components/Fields';

const FIELD_LABELS: Record<string, string> = {
  status: 'Status',
  rating: 'Rating (half-stars)',
  notes: 'Notes',
  dateStarted: 'Date started',
  dateCompleted: 'Date completed',
  tags: 'Tags',
  deleted: 'Deleted',
};

export function SyncSettings() {
  const app = useApp();
  const toast = useToast();
  const status = useAsync(() => call(getApi().sync.status()), [app.dataVersion]);
  const conflicts = useAsync(() => call(getApi().sync.conflicts()), [app.dataVersion]);
  const [preview, setPreview] = useState<SyncPreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      toast.error(errorOf(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  if (status.error) return <ErrorBox error={status.error} onRetry={status.reload} />;
  if (!status.data) return <Loading />;
  const s = status.data;
  return (
    <section className="subsection" aria-labelledby="sync-h">
      <h3 id="sync-h">Sync folder</h3>
      <p className="field-hint">
        Keep two computers in step through a folder you already sync (OneDrive, Dropbox, Syncthing, a USB
        stick…). Item status, rating, notes, dates, tags and additions/removals are synced; metadata is
        refreshed on each computer. Each computer only writes its own file, and every sync shows a preview
        first.
      </p>
      <p>
        <strong>Status:</strong> {s.enabled ? `On — ${s.folderLabel ?? ''}` : 'Off'}
      </p>
      <div className="row wrap">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() =>
            void run(() => call(getApi().sync.chooseFolder())).then(
              (r) => r && (status.setData(r), setPreview(null)),
            )
          }
        >
          {s.enabled ? 'Change folder…' : 'Choose sync folder…'}
        </button>
        {s.enabled && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void run(() => call(getApi().sync.disable())).then(
                (r) => r && (status.setData(r), setPreview(null)),
              )
            }
          >
            Turn sync off
          </button>
        )}
      </div>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (name !== null)
            void run(() => call(getApi().sync.setDeviceName({ name }))).then(
              (r) => r && (status.setData(r), setName(null)),
            );
        }}
      >
        <TextField label="This computer's name" value={name ?? s.deviceName} onChange={setName} />
        <button type="submit" className="button button-small" disabled={busy || name === null}>
          Save name
        </button>
      </form>
      {s.otherDevices.length > 0 && (
        <ul className="plain-list" aria-label="Other computers in this folder">
          {s.otherDevices.map((d) => (
            <li key={d.deviceId}>
              {d.deviceName}: {d.lastSeq} change set(s), {d.lastSeq - d.readSeq} not yet applied here
            </li>
          ))}
        </ul>
      )}
      {s.enabled && (
        <div className="row wrap">
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => void run(() => call(getApi().sync.preview())).then((r) => r && setPreview(r))}
          >
            Check for changes (preview)
          </button>
        </div>
      )}
      {preview && (
        <div className="notice notice-info" role="status">
          <div className="notice-content">
            <p>
              To send: {preview.outgoing} item(s). To receive: {preview.incoming.apply} change(s),{' '}
              {preview.incoming.creates} new item(s), {preview.incoming.deletes} removal(s). Conflicts:{' '}
              {preview.conflicts.length}.
            </p>
            {preview.conflicts.length > 0 && (
              <p>Conflicts are not applied; you choose for each one after syncing.</p>
            )}
            {preview.warnings.length > 0 && (
              <ul>
                {preview.warnings.slice(0, 5).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            className="button button-primary button-small"
            disabled={busy}
            onClick={() =>
              void run(() => call(getApi().sync.apply())).then((r) => {
                if (!r) return;
                toast.success(
                  `Synced: sent ${r.sent}, applied ${r.applied}, added ${r.created}${r.conflicts ? `, ${r.conflicts} conflict(s) to review` : ''}. A safety snapshot was saved first.`,
                );
                setPreview(null);
                app.bumpData();
              })
            }
          >
            Sync now
          </button>
        </div>
      )}
      {(conflicts.data ?? []).length > 0 && (
        <table className="table">
          <caption>Conflicts to review</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Field</th>
              <th scope="col">This computer</th>
              <th scope="col">Other computer</th>
              <th scope="col">Choose</th>
            </tr>
          </thead>
          <tbody>
            {(conflicts.data ?? []).map((c) => (
              <tr key={c.id}>
                <th scope="row">{c.itemTitle}</th>
                <td>{FIELD_LABELS[c.field] ?? c.field}</td>
                <td>{c.local}</td>
                <td>{c.remote}</td>
                <td>
                  <span className="row-inline">
                    <button
                      type="button"
                      className="button button-small"
                      aria-label={`Keep this computer's ${FIELD_LABELS[c.field] ?? c.field} for ${c.itemTitle}`}
                      onClick={() =>
                        void run(() => call(getApi().sync.resolve({ id: c.id, choice: 'mine' }))).then(
                          (r) => r && (conflicts.setData(r), app.bumpData()),
                        )
                      }
                    >
                      Keep mine
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      aria-label={`Take the other computer's ${FIELD_LABELS[c.field] ?? c.field} for ${c.itemTitle}`}
                      onClick={() =>
                        void run(() => call(getApi().sync.resolve({ id: c.id, choice: 'theirs' }))).then(
                          (r) => r && (conflicts.setData(r), app.bumpData()),
                        )
                      }
                    >
                      Take theirs
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
