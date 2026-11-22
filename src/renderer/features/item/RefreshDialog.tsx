/**
 * Metadata refresh: side-by-side comparison with a per-field choice.
 * Conflicting user-edited fields default to "Keep my edit". Personal data
 * (status, rating, notes, dates, tags, progress) is never part of a refresh.
 */
import { useState } from 'react';
import type { ItemDetail, RefreshPreview } from '../../../shared/types';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { fmtDateTime } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Dialog } from '../../components/Dialog';
import { ErrorBox, Loading } from '../../components/Bits';

export function RefreshDialog({
  item,
  onClose,
  onApplied,
}: {
  item: ItemDetail;
  onClose: () => void;
  onApplied: (i: ItemDetail) => void;
}) {
  const toast = useToast();
  const q = useAsync(() => call(getApi().providers.refreshPreview({ itemId: item.id })), [item.id]);
  const [choices, setChoices] = useState<Record<string, 'keep' | 'update'>>({});
  const [busy, setBusy] = useState(false);
  const p: RefreshPreview | null = q.data;
  const choiceFor = (field: string, def: 'keep' | 'update') => choices[field] ?? def;
  const nothing = p && p.rows.length === 0 && p.newEpisodes === 0 && p.updatedEpisodes === 0;

  const apply = async () => {
    if (!p) return;
    setBusy(true);
    try {
      const all = Object.fromEntries(p.rows.map((r) => [r.field, choiceFor(r.field, r.defaultChoice)]));
      const updated = await call(getApi().providers.refreshApply({ token: p.token, choices: all }));
      onApplied(updated);
      toast.success('Metadata refreshed.');
      onClose();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Refresh metadata${p ? ` from ${p.providerName}` : ''}`}
      onClose={onClose}
      size="large"
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {p && !nothing && (
            <button
              type="button"
              className="button button-primary"
              onClick={() => void apply()}
              disabled={busy}
            >
              {busy ? 'Applying…' : 'Apply selected changes'}
            </button>
          )}
        </>
      }
    >
      {q.loading && <Loading label="Fetching the latest details…" />}
      {q.error && (
        <>
          <ErrorBox error={q.error} onRetry={q.reload} />
          <p>Your item has not been changed.</p>
        </>
      )}
      {p && nothing && <p>Everything is already up to date. Nothing will change.</p>}
      {p && !nothing && (
        <>
          <p>
            Choose what to keep for each field that differs. Fields you edited default to{' '}
            <strong>Keep mine</strong>. Your status, rating, notes, dates, tags and progress are never changed
            by a refresh.
          </p>
          {p.rows.length > 0 && (
            <table className="table compare-table">
              <caption className="visually-hidden">Field-by-field comparison</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Current</th>
                  <th scope="col">From {p.providerName}</th>
                  <th scope="col">Keep</th>
                </tr>
              </thead>
              <tbody>
                {p.rows.map((r) => {
                  const c = choiceFor(r.field, r.defaultChoice);
                  const name = `refresh-${r.field}`;
                  return (
                    <tr key={r.field} className={r.userEdited ? 'row-edited' : undefined}>
                      <th scope="row">
                        {r.label}
                        <span className="muted block">
                          {r.userEdited
                            ? 'Edited by you'
                            : r.origin === 'provider'
                              ? 'From provider, unchanged'
                              : 'Entered by you'}
                          {r.lastEdited ? ` · ${fmtDateTime(r.lastEdited)}` : ''}
                        </span>
                      </th>
                      <td>{r.current}</td>
                      <td>{r.incoming}</td>
                      <td>
                        <fieldset className="choice">
                          <legend className="visually-hidden">Choice for {r.label}</legend>
                          <label>
                            <input
                              type="radio"
                              name={name}
                              checked={c === 'keep'}
                              onChange={() => setChoices((s) => ({ ...s, [r.field]: 'keep' }))}
                            />{' '}
                            Keep mine
                          </label>
                          <label>
                            <input
                              type="radio"
                              name={name}
                              checked={c === 'update'}
                              onChange={() => setChoices((s) => ({ ...s, [r.field]: 'update' }))}
                            />{' '}
                            Use new
                          </label>
                        </fieldset>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="muted">
            {p.unchangedCount} field(s) already match.
            {p.newEpisodes > 0 && ` ${p.newEpisodes} new episode(s) will be added.`}
            {p.updatedEpisodes > 0 && ` ${p.updatedEpisodes} episode title/date update(s).`}
            {(p.newEpisodes > 0 || p.updatedEpisodes > 0) &&
              ' Watched checkmarks and episodes you edited are never changed.'}
          </p>
        </>
      )}
    </Dialog>
  );
}
