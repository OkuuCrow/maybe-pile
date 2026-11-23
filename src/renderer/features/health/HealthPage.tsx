/**
 * Pile Health: gentle nudges about stale items, with reversible triage
 * (Keep, Snooze, On Hold, Drop, Open). Drop and bulk actions confirm first.
 * Never sends OS notifications. Can be turned off in Settings → Features.
 */
import { useId, useState } from 'react';
import { MEDIA_TYPES } from '../../../shared/enums';
import type { HealthItemView, HealthOverview } from '../../../shared/types';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtPartialDate, todayLocal, typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { BarChart } from '../../components/Charts';
import { EmptyState, ErrorBox, Loading } from '../../components/Bits';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { TypeIcon } from '../../components/Icons';

function addDaysLocal(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function HealthPage() {
  const app = useApp();
  const q = useAsync(() => call(getApi().health.overview()), [app.dataVersion]);
  return (
    <div className="page">
      <div className="page-header">
        <h1>Pile Health</h1>
        <a className="button" href="#/settings/features">
          Thresholds &amp; settings
        </a>
      </div>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && !q.data.enabled && (
        <EmptyState
          title="Pile Health is turned off"
          action={
            <a className="button" href="#/settings/features">
              Turn it on
            </a>
          }
        >
          No nudges are shown while it is off.
        </EmptyState>
      )}
      {q.data?.enabled && <HealthBody data={q.data} onChange={(d) => q.setData(d)} full />}
    </div>
  );
}

export function HealthWidget({ headingId }: { headingId: string }) {
  const app = useApp();
  const q = useAsync(() => call(getApi().health.overview()), [app.dataVersion]);
  return (
    <>
      <h2 id={headingId}>Pile Health</h2>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && !q.data.enabled && <p className="muted">Pile Health is off (Settings → Features).</p>}
      {q.data?.enabled && <HealthBody data={q.data} onChange={(d) => q.setData(d)} full={false} />}
    </>
  );
}

function HealthBody({
  data,
  onChange,
  full,
}: {
  data: HealthOverview;
  onChange: (d: HealthOverview) => void;
  full: boolean;
}) {
  const app = useApp();
  const toast = useToast();
  const uid = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [snoozeFor, setSnoozeFor] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<{ action: 'drop' | 'on_hold'; ids: string[] } | null>(null);
  const shown = full ? data.stale : data.stale.slice(0, 5);
  const titleOf = (id: string) => data.stale.find((s) => s.id === id)?.title ?? 'item';

  const run = async (fn: () => Promise<HealthOverview>, msg: string) => {
    try {
      onChange(await fn());
      setSelected(new Set());
      app.bumpData();
      toast.success(msg);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const setStatus = async (ids: string[], status: 'on_hold' | 'dropped') => {
    try {
      await call(getApi().items.bulk({ action: 'setStatus', ids, status }));
      onChange(await call(getApi().health.overview()));
      setSelected(new Set());
      app.bumpData();
      toast.success(`${ids.length} item(s) moved to ${status === 'dropped' ? 'Dropped' : 'On Hold'}.`);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };

  const s = data.stats;
  return (
    <>
      {data.stale.length === 0 ? (
        <p className="muted">
          Nothing looks stale. (Planned for over {data.thresholds.plannedStaleMonths} months, or no progress
          in {data.thresholds.inProgressStaleDays} days.)
        </p>
      ) : (
        <>
          <p>
            {data.staleTotal} item(s) could use a look.{' '}
            {!full && data.staleTotal > shown.length && <a href="#/health">See all</a>}
          </p>
          {full && selected.size > 0 && (
            <div className="bulk-bar" role="region" aria-label="Bulk actions for selected items">
              <span>{selected.size} selected</span>
              <button
                type="button"
                className="button button-small"
                onClick={() =>
                  void run(
                    () => call(getApi().health.keep({ ids: [...selected] })),
                    'Kept. No more nudges for a while.',
                  )
                }
              >
                Keep
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => setSnoozeFor([...selected])}
              >
                Snooze…
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => setConfirm({ action: 'on_hold', ids: [...selected] })}
              >
                Move to On Hold
              </button>
              <button
                type="button"
                className="button button-small button-danger"
                onClick={() => setConfirm({ action: 'drop', ids: [...selected] })}
              >
                Drop
              </button>
            </div>
          )}
          <ul className="health-list">
            {shown.map((i: HealthItemView) => (
              <li key={i.id} className="health-item">
                {full && (
                  <input
                    type="checkbox"
                    id={`${uid}-${i.id}`}
                    checked={selected.has(i.id)}
                    aria-label={`Select ${i.title}`}
                    onChange={(e) => {
                      const n = new Set(selected);
                      if (e.target.checked) n.add(i.id);
                      else n.delete(i.id);
                      setSelected(n);
                    }}
                  />
                )}
                <span className="health-text">
                  <a href={`#/item/${i.id}`}>
                    <TypeIcon type={i.type} /> {i.title}
                  </a>
                  <span className="muted"> · {i.reason}</span>
                </span>
                <span className="health-actions" role="group" aria-label={`Actions for ${i.title}`}>
                  <button
                    type="button"
                    className="button button-tiny"
                    onClick={() =>
                      void run(() => call(getApi().health.keep({ ids: [i.id] })), `Keeping “${i.title}”.`)
                    }
                  >
                    Keep
                  </button>
                  <button type="button" className="button button-tiny" onClick={() => setSnoozeFor([i.id])}>
                    Snooze…
                  </button>
                  {i.status !== 'on_hold' && (
                    <button
                      type="button"
                      className="button button-tiny"
                      onClick={() => void setStatus([i.id], 'on_hold')}
                    >
                      On Hold
                    </button>
                  )}
                  <button
                    type="button"
                    className="button button-tiny"
                    onClick={() => setConfirm({ action: 'drop', ids: [i.id] })}
                  >
                    Drop…
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {full && (
        <>
          <h2>Pile stats</h2>
          <dl className="year-stats">
            {MEDIA_TYPES.map((t) => (
              <div key={t}>
                <dt>{typeLabelPlural(t)} on the pile</dt>
                <dd>{s.sizeByType[t]}</dd>
              </div>
            ))}
            <div>
              <dt>Median age of Planned items</dt>
              <dd>
                {s.medianPlannedAgeDays === null
                  ? 'No Planned items'
                  : `${s.medianPlannedAgeDays} day(s)${s.plannedCount < 5 ? ` (only ${s.plannedCount} item${s.plannedCount === 1 ? '' : 's'})` : ''}`}
              </dd>
            </div>
            {s.windows.map((w) => (
              <div key={w.days}>
                <dt>Last {w.days} days</dt>
                <dd>
                  {w.added} added · {w.completed} completed
                </dd>
              </div>
            ))}
          </dl>
          {s.smallSample ? (
            <p className="muted">The pile trend appears once you have at least 5 items.</p>
          ) : (
            <BarChart
              title="Pile size at the end of each month"
              summary={`Pile size over the last 12 months, from ${s.trend[0]?.size ?? 0} to ${s.trend[s.trend.length - 1]?.size ?? 0} items.`}
              data={s.trend.map((t) => ({ label: t.month, values: { size: t.size } }))}
              series={[{ key: 'size', label: 'Items on the pile' }]}
              headingLevel={3}
            />
          )}
          <h2>Snoozed</h2>
          {data.snoozed.length === 0 ? (
            <p className="muted">Nothing is snoozed.</p>
          ) : (
            <ul className="mini-list">
              {data.snoozed.map((z) => (
                <li key={z.id}>
                  <a href={`#/item/${z.id}`}>
                    <TypeIcon type={z.type} />
                    <span className="mini-title">{z.title}</span>
                  </a>
                  <span className="badge badge-snoozed">Snoozed until {fmtPartialDate(z.snoozedUntil)}</span>
                  <button
                    type="button"
                    className="button button-tiny"
                    onClick={() =>
                      void run(() => call(getApi().health.unsnooze({ ids: [z.id] })), `“${z.title}” is back.`)
                    }
                  >
                    Wake now
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {snoozeFor && (
        <SnoozeDialog
          count={snoozeFor.length}
          title={snoozeFor.length === 1 ? titleOf(snoozeFor[0] ?? '') : null}
          onCancel={() => setSnoozeFor(null)}
          onSnooze={(until) => {
            const ids = snoozeFor;
            setSnoozeFor(null);
            void run(
              () => call(getApi().health.snooze({ ids, until })),
              `Snoozed ${ids.length} item(s) until ${fmtPartialDate(until)}.`,
            );
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.action === 'drop' ? 'Drop these items?' : 'Move to On Hold?'}
          message={
            <p>
              {confirm.ids.length === 1
                ? `“${titleOf(confirm.ids[0] ?? '')}”`
                : `${confirm.ids.length} items`}{' '}
              will be marked {confirm.action === 'drop' ? 'Dropped' : 'On Hold'}. History is kept and you can
              change the status back any time.
            </p>
          }
          confirmLabel={confirm.action === 'drop' ? 'Drop' : 'Move to On Hold'}
          destructive={confirm.action === 'drop'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void setStatus(c.ids, c.action === 'drop' ? 'dropped' : 'on_hold');
          }}
        />
      )}
    </>
  );
}

export function SnoozeDialog({
  count,
  title,
  onCancel,
  onSnooze,
}: {
  count: number;
  title: string | null;
  onCancel: () => void;
  onSnooze: (until: string) => void;
}) {
  const uid = useId();
  const [choice, setChoice] = useState('30');
  const [date, setDate] = useState(addDaysLocal(14));
  const err =
    choice === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayLocal())
      ? 'Choose a date from today onward.'
      : null;
  return (
    <Dialog
      title={title ? `Snooze “${title}”` : `Snooze ${count} item(s)`}
      onClose={onCancel}
      size="small"
      footer={
        <>
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={Boolean(err)}
            onClick={() => onSnooze(choice === 'date' ? date : addDaysLocal(Number(choice)))}
          >
            Snooze
          </button>
        </>
      }
    >
      <p>Snoozed items are hidden from Pile Health nudges and from Pick for Me until the date.</p>
      <fieldset className="radio-row">
        <legend>For how long?</legend>
        {[
          ['30', '30 days'],
          ['90', '90 days'],
          ['180', '180 days'],
          ['date', 'Until a date'],
        ].map(([v, l]) => (
          <label key={v} className="radio-pill">
            <input
              type="radio"
              name={`${uid}-len`}
              value={v}
              checked={choice === v}
              onChange={() => setChoice(v ?? '30')}
            />{' '}
            {l}
          </label>
        ))}
      </fieldset>
      {choice === 'date' && (
        <div className={`field ${err ? 'field-invalid' : ''}`}>
          <label htmlFor={`${uid}-date`}>Snooze until</label>
          <input
            id={`${uid}-date`}
            type="date"
            className="input"
            value={date}
            min={todayLocal()}
            onChange={(e) => setDate(e.target.value)}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${uid}-err` : undefined}
          />
          {err && (
            <p className="field-error" id={`${uid}-err`}>
              <span aria-hidden="true">⚠ </span>
              {err}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
