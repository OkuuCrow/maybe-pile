/**
 * "Your Pile" overview (Expansion Pack 2): Pile Time, What fits tonight (time
 * + moods), recommendations with reasons, Leaving Soon, Pile Value and
 * duplicate merge. Everything is computed locally from the user's library.
 */
import { useId, useState } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import type { DuplicatePair, MergePreview, PileTimeRow, Recommendation } from '../../../shared/types';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtPartialDate, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { formatMoney } from '../../../domain/value';
import { Dialog } from '../../components/Dialog';
import { NumberField, SelectField } from '../../components/Fields';
import { ErrorBox, Loading } from '../../components/Bits';
import { fmtMinutes } from '../item/Pack2Panels';

export function PilePage() {
  return (
    <div className="page">
      <h1>Your pile</h1>
      <div className="grid-2">
        <PileTimeCard />
        <WhatFitsCard />
        <RecommendationsCard />
        <LeavingSoonCard />
        <ValueCard />
        <DuplicatesCard />
      </div>
    </div>
  );
}

function PileTimeCard() {
  const app = useApp();
  const q = useAsync(() => call(getApi().pileTime.totals()), [app.dataVersion]);
  return (
    <section className="card" aria-labelledby="pile-time">
      <h2 id="pile-time">Pile Time</h2>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!q.data && !q.error && <Loading />}
      {q.data && (
        <>
          <p className="big-number">{fmtMinutes(q.data.remainingMinutes)}</p>
          <p className="muted">
            to finish {q.data.itemsWithEstimate} unfinished item(s).{' '}
            {q.data.itemsWithout > 0 &&
              `${q.data.itemsWithout} item(s) have no estimate yet and aren't counted.`}
          </p>
          <table className="table">
            <caption className="visually-hidden">Pile Time by type</caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Time left</th>
                <th scope="col">Items</th>
                <th scope="col">No estimate</th>
              </tr>
            </thead>
            <tbody>
              {MEDIA_TYPES.map((t) => {
                const row = q.data?.byType[t];
                return (
                  <tr key={t}>
                    <th scope="row">{typeLabel(t)}</th>
                    <td>{fmtMinutes(row?.minutes ?? 0)}</td>
                    <td>{row?.items ?? 0}</td>
                    <td>{row?.missing ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small">
            Confidence: high {fmtMinutes(q.data.byConfidence.high)} · medium{' '}
            {fmtMinutes(q.data.byConfidence.medium)} · low {fmtMinutes(q.data.byConfidence.low)}.
            Low-confidence figures use assumed reading pace or episode lengths.
          </p>
        </>
      )}
    </section>
  );
}

function WhatFitsCard() {
  const app = useApp();
  const [hours, setHours] = useState<number | null>(2);
  const [type, setType] = useState<MediaType | 'all'>('all');
  const [mood, setMood] = useState('');
  const moods = useAsync(() => call(getApi().moods.list()), [app.dataVersion]);
  const minutes = Math.max(5, Math.round((hours ?? 2) * 60));
  const q = useAsync(
    () =>
      call(
        getApi().pileTime.fits({
          budgetMinutes: minutes,
          types: type === 'all' ? null : [type],
          moodIds: mood ? [mood] : [],
        }),
      ),
    [minutes, type, mood, app.dataVersion],
  );
  const rows: PileTimeRow[] = q.data ?? [];
  return (
    <section className="card" aria-labelledby="pile-fits">
      <h2 id="pile-fits">What fits?</h2>
      <div className="row wrap">
        <NumberField label="Time I have (hours)" value={hours} onChange={setHours} min={0.25} step={0.25} />
        <SelectField
          label="Type"
          value={type}
          onChange={setType}
          options={[
            { value: 'all' as const, label: 'Any type' },
            ...MEDIA_TYPES.map((t) => ({ value: t, label: typeLabel(t) })),
          ]}
        />
        <SelectField
          label="Mood"
          value={mood}
          onChange={setMood}
          options={[
            { value: '', label: 'Any mood' },
            ...(moods.data ?? []).filter((m) => !m.hidden).map((m) => ({ value: m.id, label: m.name })),
          ]}
        />
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && rows.length === 0 && (
        <p className="muted">Nothing on your pile fits in {fmtMinutes(minutes)} with an estimate.</p>
      )}
      {rows.length > 0 && (
        <ul className="plain-list" aria-live="polite">
          {rows.slice(0, 15).map((r) => (
            <li key={r.id}>
              <a href={`#/item/${r.id}`}>{r.title}</a>{' '}
              <span className="muted">
                · {typeLabel(r.type)} · {fmtMinutes(r.estimate.remainingMinutes)} left
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecommendationsCard() {
  const app = useApp();
  const toast = useToast();
  const q = useAsync(() => call(getApi().recs.list({ limit: 8, types: null })), [app.dataVersion]);
  const feedback = (r: Recommendation, kind: 'dismissed' | 'not_interested') =>
    void call(getApi().recs.feedback({ itemId: r.itemId, kind }))
      .then(
        () => (
          q.reload(),
          toast.success(kind === 'dismissed' ? 'Hidden for 30 days.' : 'Won’t be suggested again.')
        ),
      )
      .catch((e: unknown) => toast.error(errorOf(e)));
  return (
    <section className="card" aria-labelledby="pile-recs">
      <h2 id="pile-recs">From your pile</h2>
      <p className="muted small">
        Suggestions use only your own library and ratings; nothing leaves this computer.
      </p>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data?.length === 0 && (
        <p className="muted">Rate a few finished items 4★ or higher to get suggestions.</p>
      )}
      <ol className="plain-list">
        {(q.data ?? []).map((r) => (
          <li key={r.itemId} className="rec">
            <a href={`#/item/${r.itemId}`}>{r.title}</a> <span className="muted">· {typeLabel(r.type)}</span>
            <ul className="rec-reasons" aria-label={`Why ${r.title}`}>
              {r.reasons.map((x) => (
                <li key={x.kind + x.text}>{x.text}</li>
              ))}
            </ul>
            <span className="row-inline">
              <button type="button" className="button button-small" onClick={() => feedback(r, 'dismissed')}>
                Not now
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => feedback(r, 'not_interested')}
              >
                Not interested
              </button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LeavingSoonCard() {
  const app = useApp();
  const q = useAsync(() => call(getApi().availability.leavingSoon()), [app.dataVersion]);
  return (
    <section className="card" aria-labelledby="pile-leaving">
      <h2 id="pile-leaving">Leaving soon</h2>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data?.length === 0 && (
        <p className="muted">Nothing you noted is about to leave a service or loan.</p>
      )}
      <ul className="plain-list">
        {(q.data ?? []).map((e) => (
          <li key={e.id}>
            <a href={`#/item/${e.itemId}`}>{e.itemTitle}</a>{' '}
            <span className="muted">
              · {e.serviceName ?? e.kind.replace('_', ' ')} · until {fmtPartialDate(e.availableUntil)} (
              {e.daysLeft === 0 ? 'today' : `${e.daysLeft} day(s)`})
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ValueCard() {
  const app = useApp();
  const q = useAsync(() => call(getApi().value.summary()), [app.dataVersion]);
  return (
    <section className="card" aria-labelledby="pile-value">
      <h2 id="pile-value">Pile Value</h2>
      <p className="muted small">Totals are per currency; Maybe Pile never converts currencies.</p>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data?.length === 0 && (
        <p className="muted">Record what you paid on an item’s page to see totals here.</p>
      )}
      {q.data && q.data.length > 0 && (
        <table className="table">
          <caption className="visually-hidden">Spending by currency</caption>
          <thead>
            <tr>
              <th scope="col">Currency</th>
              <th scope="col">Spent</th>
              <th scope="col">Unfinished</th>
              <th scope="col">Never started</th>
              <th scope="col">Per hour played</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((t) => (
              <tr key={t.currency}>
                <th scope="row">{t.currency}</th>
                <td>{formatMoney(t.spentMinor, t.currency)}</td>
                <td>{formatMoney(t.unfinishedMinor, t.currency)}</td>
                <td>{formatMoney(t.untouchedMinor, t.currency)}</td>
                <td>{t.costPerHourMinor === null ? '—' : formatMoney(t.costPerHourMinor, t.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DuplicatesCard() {
  const app = useApp();
  const toast = useToast();
  const q = useAsync(() => call(getApi().merge.pairs()), [app.dataVersion]);
  const last = useAsync(() => call(getApi().merge.lastUndoable()), [app.dataVersion]);
  const [merging, setMerging] = useState<DuplicatePair | null>(null);
  return (
    <section className="card" aria-labelledby="pile-dupes">
      <h2 id="pile-dupes">Possible duplicates</h2>
      {last.data && (
        <div className="notice notice-info">
          <p className="notice-content">
            Last merge: “{last.data.removedTitle}” into “{last.data.keptTitle}”.
          </p>
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              last.data &&
              void call(getApi().merge.undo({ id: last.data.snapshotId }))
                .then(() => (app.bumpData(), toast.success('Merge undone.')))
                .catch((e: unknown) => toast.error(errorOf(e)))
            }
          >
            Undo merge
          </button>
        </div>
      )}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data?.length === 0 && <p className="muted">No likely duplicates found.</p>}
      <ul className="plain-list">
        {(q.data ?? []).slice(0, 20).map((p) => (
          <li key={`${p.a.id}|${p.b.id}`}>
            <a href={`#/item/${p.a.id}`}>{p.a.title}</a>
            {p.a.year ? ` (${p.a.year})` : ''} and <a href={`#/item/${p.b.id}`}>{p.b.title}</a>
            {p.b.year ? ` (${p.b.year})` : ''}{' '}
            <span className="muted">
              · {typeLabel(p.a.type)} · {p.reason}
            </span>{' '}
            <span className="row-inline">
              <button type="button" className="button button-small" onClick={() => setMerging(p)}>
                Merge…
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() =>
                  void call(getApi().merge.dismiss({ keepId: p.a.id, removeId: p.b.id }))
                    .then((r) => q.setData(r))
                    .catch((e: unknown) => toast.error(errorOf(e)))
                }
              >
                Not duplicates
              </button>
            </span>
          </li>
        ))}
      </ul>
      {merging && (
        <MergeDialog
          pair={merging}
          onClose={() => setMerging(null)}
          onDone={() => (setMerging(null), app.bumpData())}
        />
      )}
    </section>
  );
}

function MergeDialog({
  pair,
  onClose,
  onDone,
}: {
  pair: DuplicatePair;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [keepA, setKeepA] = useState(true);
  const keep = keepA ? pair.a : pair.b;
  const remove = keepA ? pair.b : pair.a;
  const q = useAsync<MergePreview>(
    () => call(getApi().merge.preview({ keepId: keep.id, removeId: remove.id })),
    [keep.id, remove.id],
  );
  const [choices, setChoices] = useState<Record<string, 'a' | 'b' | 'both'>>({});
  const [busy, setBusy] = useState(false);
  const gid = useId();
  const apply = async () => {
    setBusy(true);
    try {
      await call(getApi().merge.apply({ keepId: keep.id, removeId: remove.id, fields: choices }));
      toast.success(
        `Merged. “${remove.title}” was folded into “${keep.title}”. You can undo this on the Pile page.`,
      );
      onDone();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Merge duplicates"
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
            disabled={busy || !q.data}
            onClick={() => void apply()}
          >
            Merge into “{keep.title}”
          </button>
        </>
      }
    >
      <fieldset>
        <legend>Keep which item?</legend>
        <label className="radio">
          <input
            type="radio"
            name={`${gid}-keep`}
            checked={keepA}
            onChange={() => (setKeepA(true), setChoices({}))}
          />{' '}
          {pair.a.title}
          {pair.a.year ? ` (${pair.a.year})` : ''}
        </label>
        <label className="radio">
          <input
            type="radio"
            name={`${gid}-keep`}
            checked={!keepA}
            onChange={() => (setKeepA(false), setChoices({}))}
          />{' '}
          {pair.b.title}
          {pair.b.year ? ` (${pair.b.year})` : ''}
        </label>
      </fieldset>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!q.data && !q.error && <Loading />}
      {q.data && (
        <>
          {q.data.rows.length === 0 ? (
            <p>The two items have the same details.</p>
          ) : (
            <table className="table">
              <caption>Fields that differ — choose which value to keep</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">{keep.title} (kept)</th>
                  <th scope="col">{remove.title}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={r.field}>
                    <th scope="row">{r.label}</th>
                    <td>
                      <label className="radio">
                        <input
                          type="radio"
                          name={`${gid}-${r.field}`}
                          checked={(choices[r.field] ?? 'a') === 'a'}
                          onChange={() => setChoices((c) => ({ ...c, [r.field]: 'a' }))}
                        />{' '}
                        {r.a ?? <span className="muted">empty</span>}
                      </label>
                    </td>
                    <td>
                      <label className="radio">
                        <input
                          type="radio"
                          name={`${gid}-${r.field}`}
                          checked={choices[r.field] === 'b'}
                          onChange={() => setChoices((c) => ({ ...c, [r.field]: 'b' }))}
                        />{' '}
                        {r.b ?? <span className="muted">empty</span>}
                      </label>
                      {r.field === 'notes' && (
                        <label className="radio">
                          <input
                            type="radio"
                            name={`${gid}-${r.field}`}
                            checked={choices[r.field] === 'both'}
                            onChange={() => setChoices((c) => ({ ...c, notes: 'both' }))}
                          />{' '}
                          Keep both
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ul>
            {q.data.moves.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
