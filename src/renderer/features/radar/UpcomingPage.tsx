/**
 * Release Radar: upcoming releases for Planned (optionally On Hold) items, with
 * date precision and source/age stated in text, a provenance-respecting
 * date refresh shown as a diff, and `.ics` export.
 */
import { useState } from 'react';
import type { RadarRefreshView, UpcomingItemView } from '../../../shared/types';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtDateTime, fmtPartialDate } from '../../app/strings';
import { useToast } from '../../app/toast';
import { EmptyState, ErrorBox, Loading } from '../../components/Bits';
import { Dialog } from '../../components/Dialog';
import { TypeIcon } from '../../components/Icons';

const PRECISION: Record<UpcomingItemView['precision'], string> = {
  day: 'exact date',
  month: 'month only',
  year: 'year only',
};

function Row({ u, compact }: { u: UpcomingItemView; compact: boolean }) {
  return (
    <li className="upcoming-item">
      <a href={`#/item/${u.id}`}>
        <TypeIcon type={u.type} /> <span className="mini-title">{u.title}</span>
      </a>
      <span>
        <strong>{fmtPartialDate(u.releaseDate)}</strong> <span className="muted">({u.relative})</span>
      </span>
      {!compact && (
        <span className="muted">
          {PRECISION[u.precision]} · source: {u.dateSource}
          {u.userEdited ? ' (edited by you)' : ''}
          {u.fetchedAt ? ` · checked ${fmtDateTime(u.fetchedAt)}` : ''}
        </span>
      )}
    </li>
  );
}

export function UpcomingPage() {
  const app = useApp();
  const toast = useToast();
  const q = useAsync(() => call(getApi().radar.upcoming()), [app.dataVersion]);
  const [refreshing, setRefreshing] = useState(false);
  const [diff, setDiff] = useState<RadarRefreshView | null>(null);
  const refresh = async () => {
    setRefreshing(true);
    try {
      setDiff(await call(getApi().radar.refreshPreview()));
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setRefreshing(false);
    }
  };
  const exportIcs = async () => {
    try {
      const r = await call(getApi().radar.exportIcs());
      if (r)
        toast.success(
          `Saved ${r.fileLabel} with ${r.included} release(s).${r.skipped ? ` ${r.skipped} without an exact date were left out.` : ''}`,
        );
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <div className="page">
      <div className="page-header">
        <h1>Upcoming releases</h1>
        <div className="row wrap">
          <button
            type="button"
            className="button"
            onClick={() => void refresh()}
            disabled={refreshing || !q.data?.length}
          >
            {refreshing ? 'Checking…' : 'Refresh dates'}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void exportIcs()}
            disabled={!q.data?.length}
          >
            Export calendar (.ics)
          </button>
        </div>
      </div>
      <p className="muted" aria-live="polite">
        {refreshing
          ? 'Checking release dates with your metadata providers (rate limits apply)…'
          : 'Dates come from your providers or your own edits. Refreshing never changes a date you edited unless you choose to.'}
      </p>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && (
        <EmptyState title="Nothing upcoming">
          Planned items with a future release date show up here.
        </EmptyState>
      )}
      {q.data && q.data.length > 0 && (
        <ol className="plain-list upcoming-list">
          {q.data.map((u) => (
            <Row key={u.id} u={u} compact={false} />
          ))}
        </ol>
      )}
      {diff && (
        <RadarDiffDialog
          diff={diff}
          onClose={() => setDiff(null)}
          onApplied={(n) => {
            setDiff(null);
            app.bumpData();
            toast.success(n === 0 ? 'No dates were changed.' : `Updated ${n} release date(s).`);
          }}
        />
      )}
    </div>
  );
}

function RadarDiffDialog({
  diff,
  onClose,
  onApplied,
}: {
  diff: RadarRefreshView;
  onClose: () => void;
  onApplied: (n: number) => void;
}) {
  const toast = useToast();
  const [choices, setChoices] = useState<Record<string, 'keep' | 'update'>>(
    Object.fromEntries(diff.rows.map((r) => [r.itemId, r.defaultChoice])),
  );
  const apply = async () => {
    try {
      const r = await call(getApi().radar.refreshApply({ token: diff.token, choices }));
      onApplied(r.updated);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <Dialog
      title="Release date changes"
      onClose={onClose}
      size="large"
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void apply()}
            disabled={diff.rows.length === 0}
          >
            Apply chosen changes
          </button>
        </>
      }
    >
      <p>
        Checked {diff.checked} item(s).{' '}
        {diff.skippedNoSource > 0 &&
          `${diff.skippedNoSource} item(s) were added by hand and have no online source to check.`}
      </p>
      {diff.failures.length > 0 && (
        <div className="notice notice-warning">
          <p>Some items could not be checked:</p>
          <ul>
            {diff.failures.map((f) => (
              <li key={f.itemId}>
                {f.title}: {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {diff.rows.length === 0 ? (
        <p>No release dates changed.</p>
      ) : (
        <table className="table compare-table">
          <caption className="visually-hidden">Release date changes</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Current</th>
              <th scope="col">From provider</th>
              <th scope="col">Choice</th>
            </tr>
          </thead>
          <tbody>
            {diff.rows.map((r) => (
              <tr key={r.itemId} className={r.userEdited ? 'row-edited' : undefined}>
                <th scope="row">{r.title}</th>
                <td>
                  {fmtPartialDate(r.current)}
                  {r.userEdited && <span className="badge"> edited by you</span>}
                </td>
                <td>{fmtPartialDate(r.incoming)}</td>
                <td>
                  <fieldset className="radio-row">
                    <legend className="visually-hidden">Release date for {r.title}</legend>
                    {(['keep', 'update'] as const).map((c) => (
                      <label key={c} className="radio-pill">
                        <input
                          type="radio"
                          name={`rd-${r.itemId}`}
                          checked={choices[r.itemId] === c}
                          onChange={() => setChoices({ ...choices, [r.itemId]: c })}
                        />{' '}
                        {c === 'keep' ? 'Keep mine' : 'Use new'}
                      </label>
                    ))}
                  </fieldset>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

export function UpcomingWidget({ headingId }: { headingId: string }) {
  const app = useApp();
  const q = useAsync(() => call(getApi().radar.upcoming()), [app.dataVersion]);
  return (
    <>
      <h2 id={headingId}>Upcoming</h2>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && <p className="muted">No upcoming releases on your pile.</p>}
      {q.data && q.data.length > 0 && (
        <>
          <ol className="plain-list upcoming-list">
            {q.data.slice(0, 6).map((u) => (
              <Row key={u.id} u={u} compact />
            ))}
          </ol>
          <a href="#/upcoming">All upcoming releases</a>
        </>
      )}
    </>
  );
}
