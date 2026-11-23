/**
 * Pick for Me: constraint form, the pick with "why it matched", actions and a
 * short history. The result region is a polite live region so screen readers
 * announce each pick. No animation.
 */
import { useEffect, useId, useState } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import type { ListSummaryView, PickHistoryView, PickResultView } from '../../../shared/types';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtDateTime, typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Cover, StatusBadge, TypeBadge } from '../../components/Bits';
import { ConfirmDialog } from '../../components/Dialog';
import { Checkbox } from '../../components/Fields';
import { TypeIcon } from '../../components/Icons';

interface Constraints {
  types: MediaType[];
  genres: string[];
  tags: string[];
  listIds: string[];
  onlyUpNext: boolean;
  includeInProgress: boolean;
  includeOnHold: boolean;
  availableMinutes: number | null;
  ratingFloor: number | null;
  excludeSkipped: boolean;
}

const TIME_OPTIONS = [
  { v: '', label: 'Any length' },
  { v: '30', label: '30 minutes' },
  { v: '60', label: '1 hour' },
  { v: '90', label: '90 minutes' },
  { v: '120', label: '2 hours' },
  { v: '180', label: '3 hours' },
];

const OUTCOME_LABEL: Record<PickHistoryView['outcome'], string> = {
  shown: 'Shown',
  started: 'Started',
  skipped: 'Not now',
  queued: 'Added to Up Next',
};

export function PickPage() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Pick for Me</h1>
      </div>
      <p className="muted">
        A fair, weighted random pick from your pile. Preferences (older/newer, partway-through) are in
        Settings → Features.
      </p>
      <PickPanel compact={false} />
    </div>
  );
}

export function PickPanel({ compact }: { compact: boolean }) {
  const app = useApp();
  const toast = useToast();
  const uid = useId();
  const defaults = app.settings?.pick;
  const [c, setC] = useState<Constraints>({
    types: [],
    genres: [],
    tags: [],
    listIds: [],
    onlyUpNext: false,
    includeInProgress: defaults?.includeInProgress ?? false,
    includeOnHold: defaults?.includeOnHold ?? false,
    availableMinutes: null,
    ratingFloor: null,
    excludeSkipped: true,
  });
  const [tagText, setTagText] = useState('');
  const [result, setResult] = useState<PickResultView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [history, setHistory] = useState<PickHistoryView[]>([]);
  const lists = useAsync<ListSummaryView[]>(() => call(getApi().lists.list()), [app.dataVersion]);

  useEffect(() => {
    if (compact) return;
    void call(getApi().pick.history())
      .then(setHistory)
      .catch(() => undefined);
  }, [compact]);

  const roll = async (override?: Partial<Constraints>) => {
    setBusy(true);
    const constraints = {
      ...c,
      ...override,
      tags: tagText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20),
    };
    if (override) setC((x) => ({ ...x, ...override }));
    try {
      const r = await call(
        getApi().pick.roll({ constraints, avoid: result?.pick ? [result.pick.id] : [], seed: null }),
      );
      setResult(r);
      if (!compact) setHistory(await call(getApi().pick.history()));
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };

  const respond = async (outcome: 'started' | 'skipped' | 'queued') => {
    if (!result?.historyId || !result.pick) return;
    const title = result.pick.title;
    try {
      const h = await call(getApi().pick.respond({ historyId: result.historyId, outcome }));
      setHistory(h);
      app.bumpData();
      if (outcome === 'started') toast.success(`Started “${title}”. Enjoy!`);
      if (outcome === 'queued') toast.success(`Added “${title}” to Up Next.`);
      if (outcome === 'skipped')
        toast.success(`“${title}” won't be picked for ${app.settings?.pick.skipDays ?? 7} days.`);
      setResult(null);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };

  const loosen = () => {
    const key = result?.emptiedBy;
    const fix: Partial<Constraints> =
      key === 'status'
        ? { includeInProgress: true, includeOnHold: true }
        : key === 'types'
          ? { types: [] }
          : key === 'availableMinutes'
            ? { availableMinutes: null }
            : key === 'ratingFloor'
              ? { ratingFloor: null }
              : key === 'onlyUpNext'
                ? { onlyUpNext: false }
                : key === 'listIds'
                  ? { listIds: [] }
                  : key === 'skipped'
                    ? { excludeSkipped: false }
                    : key === 'genres'
                      ? { genres: [] }
                      : {};
    if (key === 'tags') setTagText('');
    void roll(key === 'tags' ? { ...fix } : fix);
  };

  const H = compact ? 'h3' : 'h2';
  return (
    <div className={compact ? 'pick-panel compact' : 'pick-panel'}>
      <fieldset className="pick-constraints">
        <legend className={compact ? 'visually-hidden' : undefined}>Constraints (all optional)</legend>
        <div className="row wrap">
          <div className="field field-inline">
            <label htmlFor={`${uid}-type`}>Type</label>
            <select
              id={`${uid}-type`}
              className="input input-inline"
              value={c.types[0] ?? ''}
              onChange={(e) => setC({ ...c, types: e.target.value ? [e.target.value as MediaType] : [] })}
            >
              <option value="">Anything</option>
              {MEDIA_TYPES.map((t) => (
                <option key={t} value={t}>
                  {typeLabelPlural(t)}
                </option>
              ))}
            </select>
          </div>
          <div className="field field-inline">
            <label htmlFor={`${uid}-time`}>Time tonight</label>
            <select
              id={`${uid}-time`}
              className="input input-inline"
              value={c.availableMinutes === null ? '' : String(c.availableMinutes)}
              onChange={(e) =>
                setC({ ...c, availableMinutes: e.target.value ? Number(e.target.value) : null })
              }
            >
              {TIME_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {!compact && (
            <>
              <div className="field field-inline">
                <label htmlFor={`${uid}-list`}>List</label>
                <select
                  id={`${uid}-list`}
                  className="input input-inline"
                  value={c.listIds[0] ?? ''}
                  onChange={(e) => setC({ ...c, listIds: e.target.value ? [e.target.value] : [] })}
                >
                  <option value="">Any list</option>
                  {(lists.data ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field field-inline">
                <label htmlFor={`${uid}-rating`}>Rated at least</label>
                <select
                  id={`${uid}-rating`}
                  className="input input-inline"
                  value={c.ratingFloor === null ? '' : String(c.ratingFloor)}
                  onChange={(e) =>
                    setC({ ...c, ratingFloor: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">No minimum</option>
                  {[2, 4, 6, 8].map((r) => (
                    <option key={r} value={r}>
                      {r / 2} stars
                    </option>
                  ))}
                </select>
              </div>
              <div className="field field-inline">
                <label htmlFor={`${uid}-tags`}>Tags (comma-separated)</label>
                <input
                  id={`${uid}-tags`}
                  className="input input-inline"
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                />
              </div>
            </>
          )}
        </div>
        {!compact && (
          <div className="row wrap">
            <Checkbox
              label="Only Up Next"
              checked={c.onlyUpNext}
              onChange={(v) => setC({ ...c, onlyUpNext: v })}
            />
            <Checkbox
              label="Include In Progress"
              checked={c.includeInProgress}
              onChange={(v) => setC({ ...c, includeInProgress: v })}
            />
            <Checkbox
              label="Include On Hold"
              checked={c.includeOnHold}
              onChange={(v) => setC({ ...c, includeOnHold: v })}
            />
            <Checkbox
              label="Skip things I said “Not now” to"
              checked={c.excludeSkipped}
              onChange={(v) => setC({ ...c, excludeSkipped: v })}
            />
          </div>
        )}
        <div className="row wrap">
          <button type="button" className="button button-primary" onClick={() => void roll()} disabled={busy}>
            {result?.pick ? 'Re-roll' : 'Pick for me'}
          </button>
          {!compact && (
            <button
              type="button"
              className="button"
              onClick={() =>
                void roll({ ...c, types: [], availableMinutes: null, listIds: [], ratingFloor: null })
              }
              disabled={busy}
            >
              Surprise me (no filters)
            </button>
          )}
        </div>
      </fieldset>

      <div aria-live="polite" aria-atomic="true" className="pick-result">
        {result && !result.pick && (
          <div className="notice notice-info">
            <p>
              Nothing matches.{' '}
              {result.emptiedByLabel ? (
                <>
                  The <strong>{result.emptiedByLabel}</strong> filter removed the last candidates.
                </>
              ) : (
                'Add a few things to your pile first.'
              )}
            </p>
            {result.emptiedBy && (
              <button type="button" className="button button-small" onClick={loosen}>
                Loosen that filter and try again
              </button>
            )}
          </div>
        )}
        {result?.pick && (
          <div className="pick-card">
            <Cover
              url={result.pick.thumbUrl}
              title={result.pick.title}
              type={result.pick.type}
              size={compact ? 'small' : 'medium'}
            />
            <div className="pick-text">
              <H className="pick-title">
                {result.pick.title}
                {result.pick.year ? ` (${result.pick.year})` : ''}
              </H>
              <span className="item-meta">
                <TypeBadge type={result.pick.type} />
                <StatusBadge status={result.pick.status} />
              </span>
              <p className="muted">Why: {result.reasons.join(' · ')}</p>
              <p className="muted visually-hidden">{result.eligibleCount} item(s) matched.</p>
              <div className="row wrap">
                {result.pick.status !== 'in_progress' && (
                  <button
                    type="button"
                    className="button button-small button-primary"
                    onClick={() => setConfirmStart(true)}
                  >
                    Start it
                  </button>
                )}
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => void roll()}
                  disabled={busy}
                >
                  Re-roll
                </button>
                <button type="button" className="button button-small" onClick={() => void respond('skipped')}>
                  Not now
                </button>
                <button type="button" className="button button-small" onClick={() => void respond('queued')}>
                  Add to Up Next
                </button>
                <a className="button button-small" href={`#/item/${result.pick.id}`}>
                  Open details
                </a>
              </div>
            </div>
          </div>
        )}
      </div>

      {!compact && history.length > 0 && (
        <section aria-labelledby={`${uid}-hist`} className="subsection">
          <h2 id={`${uid}-hist`}>Recent picks</h2>
          <ul className="mini-list">
            {history.map((h) => (
              <li key={h.id}>
                <a href={`#/item/${h.itemId}`}>
                  <TypeIcon type={h.type} />
                  <span className="mini-title">{h.title}</span>
                </a>
                <span className="muted">
                  {OUTCOME_LABEL[h.outcome]}
                  {h.skipUntil ? ` until ${h.skipUntil}` : ''} · {fmtDateTime(h.pickedAt)}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              void call(getApi().pick.clearSkips()).then((r) =>
                toast.success(`Cleared ${r.cleared} “Not now” skip(s).`),
              )
            }
          >
            Clear “Not now” skips
          </button>
        </section>
      )}

      {confirmStart && result?.pick && (
        <ConfirmDialog
          title="Start this now?"
          message={
            <p>
              “{result.pick.title}” will be marked In Progress (with today as the start date if it has none).
            </p>
          }
          confirmLabel="Start it"
          onCancel={() => setConfirmStart(false)}
          onConfirm={() => {
            setConfirmStart(false);
            void respond('started');
          }}
        />
      )}
    </div>
  );
}
