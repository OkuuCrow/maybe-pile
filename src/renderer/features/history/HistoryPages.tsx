/** §16.1 Recently deleted (core) and Recent changes (Full). */
import { useState } from 'react';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtDateTime, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ConfirmDialog } from '../../components/Dialog';
import { EmptyState, ErrorBox, Loading } from '../../components/Bits';
import type { MediaType } from '../../../shared/enums';

export function TrashPage() {
  const app = useApp();
  const toast = useToast();
  const list = useAsync(() => call(getApi().trash.list()), [app.dataVersion]);
  const [confirm, setConfirm] = useState<{ ids: string[]; all: boolean } | null>(null);
  const days = app.settings?.trash.retentionDays ?? 30;
  const restore = async (ids: string[]) => {
    try {
      const r = await call(getApi().trash.restore({ ids }));
      toast.success(`Restored ${r.count} item(s) with all their history.`);
      app.bumpData();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const rows = list.data ?? [];
  return (
    <div className="page">
      <div className="page-header">
        <h1>Recently deleted</h1>
      </div>
      <p className="muted">
        Deleted items are kept for {days} days, then removed for good. Restoring brings back everything:
        history, lists, artwork, checklists and loans.
      </p>
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.data && rows.length === 0 && (
        <EmptyState title="Nothing here">Items you delete appear here for {days} days.</EmptyState>
      )}
      {rows.length > 0 && (
        <>
          <table className="table">
            <caption className="visually-hidden">Recently deleted items</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Deleted</th>
                <th scope="col">Removed for good on</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.title} <span className="muted">· {typeLabel(r.type as MediaType)}</span>
                  </td>
                  <td>{fmtDateTime(r.deletedAt)}</td>
                  <td>{r.purgeOn}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="button button-small button-primary"
                      onClick={() => void restore([r.id])}
                      aria-label={`Restore ${r.title}`}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => setConfirm({ ids: [r.id], all: false })}
                      aria-label={`Delete ${r.title} permanently`}
                    >
                      Delete permanently
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="button-row">
            <button type="button" className="button" onClick={() => void restore(rows.map((r) => r.id))}>
              Restore all
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => setConfirm({ ids: rows.map((r) => r.id), all: true })}
            >
              Empty Recently deleted
            </button>
          </div>
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title={
            confirm.all
              ? `Permanently delete ${confirm.ids.length} item(s)?`
              : 'Permanently delete this item?'
          }
          message={`${confirm.ids.length} item(s) and all their history will be removed for good. This cannot be undone.`}
          confirmLabel={`Delete ${confirm.ids.length} permanently`}
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            const p = c.all
              ? call(getApi().trash.empty({ confirmCount: c.ids.length }))
              : call(getApi().trash.purge({ ids: c.ids }));
            void p
              .then((r) => {
                toast.success(`Permanently deleted ${r.count} item(s).`);
                app.bumpData();
              })
              .catch((e: unknown) => toast.error(errorOf(e)));
          }}
        />
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  user: 'You',
  bulk: 'Bulk edit',
  rule: 'Automatic rule',
  triage: 'Triage',
  restore: 'Restore',
  trash: 'Delete',
};

export function ChangesPage() {
  const app = useApp();
  const toast = useToast();
  const list = useAsync(() => call(getApi().changes.list({ limit: 500 })), [app.dataVersion]);
  const [confirm, setConfirm] = useState(false);
  const undo = async (id: number) => {
    try {
      await call(getApi().changes.undo({ id }));
      toast.success('Change undone.');
      app.bumpData();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <div className="page">
      <div className="page-header">
        <h1>Recent changes</h1>
      </div>
      <p className="muted">
        Edits on this computer, newest first. Notes are only recorded as “notes edited”, never their text.
      </p>
      {!app.settings?.changeLog.enabled && (
        <p className="muted">The change log is turned off in Settings → Advanced.</p>
      )}
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && <EmptyState title="No changes recorded yet" />}
      {(list.data ?? []).length > 0 && (
        <table className="table">
          <caption className="visually-hidden">Recent changes</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Item</th>
              <th scope="col">Change</th>
              <th scope="col">By</th>
              <th scope="col">
                <span className="visually-hidden">Undo</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((c) => (
              <tr key={c.id}>
                <td>{fmtDateTime(c.at)}</td>
                <td>
                  <a href={`#/item/${c.itemId}`}>{c.itemTitle}</a>
                </td>
                <td>
                  {c.fieldLabel}:{' '}
                  {c.field === 'notes' ? 'notes edited' : `${c.oldValue ?? '—'} → ${c.newValue ?? '—'}`}
                  {c.undone && <span className="muted"> (undone)</span>}
                </td>
                <td>{SOURCE_LABEL[c.source] ?? c.source}</td>
                <td>
                  {c.undoable ? (
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => void undo(c.id)}
                      aria-label={`Undo ${c.fieldLabel} change for ${c.itemTitle}`}
                    >
                      Undo
                    </button>
                  ) : (
                    <span className="muted">{c.whyNotUndoable}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="button" onClick={() => setConfirm(true)}>
        Clear log
      </button>
      {confirm && (
        <ConfirmDialog
          title="Clear the change log?"
          message="The list of recent changes is deleted. Your items are not changed, but these changes can no longer be undone here."
          confirmLabel="Clear log"
          destructive
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void call(getApi().changes.clear()).then(() => list.reload());
          }}
        />
      )}
    </div>
  );
}
