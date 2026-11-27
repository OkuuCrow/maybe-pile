/** Type-specific progress controls. Every action records a history entry in main. */
import { useSpoilerShield } from './Pack2Panels';
import { useId, useState, type FormEvent } from 'react';
import { GAME_SCHEMES, type GameScheme } from '../../../shared/enums';
import type { ProgressEntryInput } from '../../../shared/schemas';
import type { ItemDetail, MutationOutcome, SeasonView } from '../../../shared/types';
import { episodeCode, formatMinutes, tvTotals } from '../../../domain/progress';
import { call, errorOf, getApi } from '../../app/api';
import { localInputToIso } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Dialog } from '../../components/Dialog';
import { ListInput, NumberField, SelectField, TextField } from '../../components/Fields';
import { IconTrash } from '../../components/Icons';

interface PanelProps {
  item: ItemDetail;
  readOnly: boolean;
  onOutcome: (o: MutationOutcome) => void;
}

function useRunner(onOutcome: (o: MutationOutcome) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<MutationOutcome>, ok?: string): Promise<boolean> => {
    setBusy(true);
    try {
      onOutcome(await fn());
      if (ok) toast.success(ok);
      return true;
    } catch (e) {
      toast.error(errorOf(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function ProgressPanel(p: PanelProps) {
  switch (p.item.type) {
    case 'movie':
      return <MoviePanel {...p} />;
    case 'tv':
    case 'anime':
      return <TvPanel {...p} />;
    case 'game':
      return <GamePanel {...p} />;
    case 'book':
      return <BookPanel {...p} />;
  }
}

/** Optional "when" + note inputs shared by entry forms. */
function WhenAndNote({
  when,
  setWhen,
  note,
  setNote,
}: {
  when: string;
  setWhen: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
}) {
  return (
    <div className="form-grid">
      <TextField
        type="datetime-local"
        label="When (optional)"
        hint="Leave empty for now."
        value={when}
        onChange={setWhen}
      />
      <TextField label="Note (optional)" value={note} onChange={setNote} maxLength={2000} />
    </div>
  );
}

/* ------------------------------------------------------------------ movie */

function MoviePanel({ item, readOnly, onOutcome }: PanelProps) {
  const { busy, run } = useRunner(onOutcome);
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await run(
        () =>
          call(
            getApi().progress.addViewing({
              itemId: item.id,
              watchedAt: localInputToIso(when),
              note: note || null,
            }),
          ),
        'Viewing logged.',
      )
    ) {
      setWhen('');
      setNote('');
    }
  };
  if (readOnly) return <p>{item.progress.label}</p>;
  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Log a viewing">
      <p>{item.progress.label}. You can log as many viewings as you like; the date is optional.</p>
      <WhenAndNote when={when} setWhen={setWhen} note={note} setNote={setNote} />
      <button type="submit" className="button button-primary" disabled={busy}>
        Mark watched
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ TV */

function TvPanel({ item, readOnly, onOutcome }: PanelProps) {
  const { busy, run } = useRunner(onOutcome);
  const [seasonEdit, setSeasonEdit] = useState<SeasonView | 'new' | null>(null);
  const [episodeEdit, setEpisodeEdit] = useState<{
    season: SeasonView;
    episode: SeasonView['episodes'][number] | null;
  } | null>(null);
  const totals = tvTotals(item.seasons);
  // Spoiler Shield: episodes after the next unwatched one hide their titles.
  const shield = useSpoilerShield();
  const ordered = item.seasons
    .filter((x) => x.number > 0)
    .sort((a, b) => a.number - b.number)
    .flatMap((x) =>
      [...x.episodes]
        .sort((a, b) => a.number - b.number)
        .map((ep) => ({ s: x.number, n: ep.number, w: ep.watched })),
    );
  const absIndex = (sn: number, en: number) => ordered.findIndex((o) => o.s === sn && o.n === en) + 1;
  const firstUnwatched = ordered.findIndex((o) => !o.w);
  const nextAbs = firstUnwatched === -1 ? Number.POSITIVE_INFINITY : firstUnwatched + 1;
  // Optimistic checkmarks: a ticked box shows immediately and reverts if the save fails.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  /** §16.8 Skipped (filler/recap): counts toward “caught up”, never as watched or watch time. */
  const skip = async (ids: string[], skipped: boolean) => {
    if (ids.length === 0) return;
    await run(async () => {
      await call(getApi().extras.skipEpisodes({ itemId: item.id, episodeIds: ids, skipped }));
      return call(getApi().items.get({ id: item.id })).then((it) => ({
        item: it,
        suggestions: [],
        applied: [],
      }));
    });
  };
  const toggle = async (ids: string[], watched: boolean, scope: 'episode' | 'season' | 'upTo') => {
    setPending((p) => ({ ...p, ...Object.fromEntries(ids.map((id) => [id, watched])) }));
    try {
      await run(() =>
        call(getApi().progress.toggleEpisodes({ itemId: item.id, episodeIds: ids, watched, scope })),
      );
    } finally {
      setPending((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !ids.includes(id))));
    }
  };

  const upTo = (season: SeasonView, epNumber: number) => {
    const ids: string[] = [];
    for (const s of item.seasons) {
      if (s.number === 0 || s.number > season.number) continue;
      for (const e of s.episodes)
        if (!e.watched && (s.number < season.number || e.number <= epNumber)) ids.push(e.id);
    }
    if (ids.length > 0) void toggle(ids, true, 'upTo');
  };

  return (
    <div>
      <p>
        <strong>{item.progress.label}</strong>
        {totals.specialsWatched > 0 && ` · ${totals.specialsWatched} special(s) watched`}
      </p>
      {item.progress.nextAction && <p>{item.progress.nextAction}</p>}
      {item.seasons.length === 0 && (
        <p className="muted">
          No seasons yet.{' '}
          {readOnly ? '' : 'Add seasons and episodes manually, or refresh from an online source.'}
        </p>
      )}
      <div className="seasons">
        {item.seasons.map((s) => {
          const listed = s.episodes.length;
          const total = Math.max(listed, s.episodeCountKnown ?? 0);
          const label = s.number === 0 ? 'Specials' : `Season ${s.number}`;
          return (
            <details key={s.id} className="season" open={item.seasons.length <= 2}>
              <summary>
                <span className="season-title">
                  {label}
                  {s.title ? ` — ${s.title}` : ''}
                </span>
                <span className="muted">
                  {s.watchedCount} of {total > 0 ? total : 'unknown'} watched
                  {s.episodeCountKnown === null && listed === 0 ? ' · total unknown' : ''}
                </span>
              </summary>
              {!readOnly && (
                <div className="row wrap season-actions">
                  <button
                    type="button"
                    className="button button-small"
                    disabled={busy || listed === 0 || s.watchedCount === listed}
                    onClick={() =>
                      void toggle(
                        s.episodes.filter((e) => !e.watched).map((e) => e.id),
                        true,
                        'season',
                      )
                    }
                  >
                    Mark season watched
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    disabled={busy || s.watchedCount === 0}
                    onClick={() =>
                      void toggle(
                        s.episodes.filter((e) => e.watched).map((e) => e.id),
                        false,
                        'season',
                      )
                    }
                  >
                    Mark season unwatched
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    disabled={busy || listed === 0}
                    onClick={() =>
                      void skip(
                        s.episodes.filter((e) => !e.watched && !e.skipped).map((e) => e.id),
                        true,
                      )
                    }
                  >
                    Mark unwatched as skipped
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setEpisodeEdit({ season: s, episode: null })}
                  >
                    Add episode
                  </button>
                  <button type="button" className="button button-small" onClick={() => setSeasonEdit(s)}>
                    Edit season
                  </button>
                </div>
              )}
              {listed === 0 ? (
                <p className="muted">No episodes listed.</p>
              ) : (
                <ul className="episodes">
                  {s.episodes.map((e) => {
                    const code = episodeCode(s.number, e.number);
                    return (
                      <li key={e.id} className="episode">
                        <input
                          id={`ep-${e.id}`}
                          type="checkbox"
                          checked={pending[e.id] ?? e.watched}
                          disabled={readOnly || busy}
                          onChange={(ev) => void toggle([e.id], ev.target.checked, 'episode')}
                        />
                        <label htmlFor={`ep-${e.id}`}>
                          <span className="episode-code">{code}</span>{' '}
                          {shield.active &&
                          !shield.revealed &&
                          s.number > 0 &&
                          !e.watched &&
                          absIndex(s.number, e.number) > nextAbs ? (
                            <span className="muted">Title hidden (Spoiler Shield)</span>
                          ) : (
                            (e.title ?? <span className="muted">Untitled</span>)
                          )}
                          {e.airDate && <span className="muted"> · {e.airDate}</span>}
                          {e.skipped && <span className="badge"> Skipped</span>}
                        </label>
                        {!readOnly && (
                          <span className="episode-actions">
                            {s.number > 0 && !e.watched && (
                              <button
                                type="button"
                                className="button button-tiny"
                                onClick={() => upTo(s, e.number)}
                                aria-label={`Mark all up to ${code} watched`}
                              >
                                Up to here
                              </button>
                            )}
                            {!e.watched && (
                              <button
                                type="button"
                                className="button button-tiny"
                                onClick={() => void skip([e.id], !e.skipped)}
                                aria-label={`${e.skipped ? 'Un-skip' : 'Skip'} ${code}`}
                                aria-pressed={!!e.skipped}
                              >
                                {e.skipped ? 'Un-skip' : 'Skip'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="button button-tiny"
                              onClick={() => setEpisodeEdit({ season: s, episode: e })}
                              aria-label={`Edit ${code}`}
                            >
                              Edit
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </details>
          );
        })}
      </div>
      {!readOnly && (
        <button type="button" className="button" onClick={() => setSeasonEdit('new')}>
          Add season
        </button>
      )}
      {seasonEdit && (
        <SeasonDialog
          item={item}
          season={seasonEdit === 'new' ? null : seasonEdit}
          onClose={() => setSeasonEdit(null)}
          onOutcome={onOutcome}
        />
      )}
      {episodeEdit && (
        <EpisodeDialog
          item={item}
          season={episodeEdit.season}
          episode={episodeEdit.episode}
          onClose={() => setEpisodeEdit(null)}
          onOutcome={onOutcome}
        />
      )}
    </div>
  );
}

function SeasonDialog({
  item,
  season,
  onClose,
  onOutcome,
}: {
  item: ItemDetail;
  season: SeasonView | null;
  onClose: () => void;
  onOutcome: (o: MutationOutcome) => void;
}) {
  const { busy, run } = useRunner(onOutcome);
  const nextNumber = Math.max(0, ...item.seasons.map((s) => s.number)) + 1;
  const [num, setNum] = useState<number | null>(season?.number ?? nextNumber);
  const [title, setTitle] = useState(season?.title ?? '');
  const [count, setCount] = useState<number | null>(season?.episodeCountKnown ?? null);
  const [confirmDel, setConfirmDel] = useState(false);
  const save = async () => {
    if (num === null) return;
    if (
      await run(
        () =>
          call(
            getApi().progress.upsertSeason({
              itemId: item.id,
              seasonId: season?.id ?? null,
              number: num,
              title: title || null,
              episodeCountKnown: count,
            }),
          ),
        'Season saved.',
      )
    )
      onClose();
  };
  return (
    <Dialog
      title={season ? `Edit season ${season.number}` : 'Add season'}
      onClose={onClose}
      size="small"
      footer={
        <>
          {season && (
            <button
              type="button"
              className="button button-danger"
              onClick={() => setConfirmDel(true)}
              disabled={busy}
            >
              Delete season
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || num === null}
            onClick={() => void save()}
          >
            Save
          </button>
        </>
      }
    >
      <NumberField
        label="Season number"
        hint="Use 0 for specials."
        value={num}
        onChange={setNum}
        min={0}
        required
      />
      <TextField label="Title (optional)" value={title} onChange={setTitle} />
      <NumberField
        label="Total episodes (if known)"
        hint="Leave empty if unknown. Episodes listed below always count."
        value={count}
        onChange={setCount}
        min={0}
      />
      {confirmDel && season && (
        <p role="alert" className="notice notice-error">
          Delete season {season.number} and its {season.episodes.length} episode(s)? Their watched state is
          removed (history entries remain).{' '}
          <button
            type="button"
            className="button button-danger button-small"
            onClick={() =>
              void run(
                () => call(getApi().progress.deleteSeason({ itemId: item.id, seasonId: season.id })),
                'Season deleted.',
              ).then((ok) => ok && onClose())
            }
          >
            Yes, delete season
          </button>
        </p>
      )}
    </Dialog>
  );
}

function EpisodeDialog({
  item,
  season,
  episode,
  onClose,
  onOutcome,
}: {
  item: ItemDetail;
  season: SeasonView;
  episode: SeasonView['episodes'][number] | null;
  onClose: () => void;
  onOutcome: (o: MutationOutcome) => void;
}) {
  const { busy, run } = useRunner(onOutcome);
  const [num, setNum] = useState<number | null>(
    episode?.number ?? Math.max(0, ...season.episodes.map((e) => e.number)) + 1,
  );
  const [title, setTitle] = useState(episode?.title ?? '');
  const [air, setAir] = useState(episode?.airDate ?? '');
  const [runtime, setRuntime] = useState<number | null>(episode?.runtime ?? null);
  const save = async () => {
    if (num === null) return;
    const ok = await run(
      () =>
        call(
          getApi().progress.upsertEpisode({
            itemId: item.id,
            seasonId: season.id,
            episodeId: episode?.id ?? null,
            number: num,
            title: title || null,
            airDate: air.trim() || null,
            runtime,
          }),
        ),
      'Episode saved.',
    );
    if (ok) onClose();
  };
  return (
    <Dialog
      title={
        episode
          ? `Edit ${episodeCode(season.number, episode.number)}`
          : `Add episode to ${season.number === 0 ? 'Specials' : `season ${season.number}`}`
      }
      onClose={onClose}
      size="small"
      footer={
        <>
          {episode && (
            <button
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() =>
                void run(
                  () => call(getApi().progress.deleteEpisode({ itemId: item.id, episodeId: episode.id })),
                  'Episode deleted.',
                ).then((ok) => ok && onClose())
              }
            >
              Delete episode
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || num === null}
            onClick={() => void save()}
          >
            Save
          </button>
        </>
      }
    >
      <NumberField label="Episode number" value={num} onChange={setNum} min={0} required />
      <TextField label="Title" value={title} onChange={setTitle} />
      <TextField label="Air date" hint="YYYY, YYYY-MM or YYYY-MM-DD" value={air} onChange={setAir} />
      <NumberField label="Runtime (minutes)" value={runtime} onChange={setRuntime} min={0} />
      {episode?.source === 'provider' && (
        <p className="field-hint">Edited episodes are kept as you wrote them on future metadata refreshes.</p>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ game */

const SCHEME_LABELS: Record<GameScheme, string> = {
  percent: 'Percentage',
  hours: 'Hours played',
  milestones: 'Milestones',
  text: 'Free-form',
};

function GamePanel({ item, readOnly, onOutcome }: PanelProps) {
  const { busy, run } = useRunner(onOutcome);
  const scheme = item.personal.gameScheme ?? 'percent';
  const [pct, setPct] = useState<number | null>(null);
  const [hours, setHours] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [milestone, setMilestone] = useState(item.milestones[0]?.id ?? '');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [editMilestones, setEditMilestones] = useState(false);
  const id = useId();

  const entry = (): ProgressEntryInput | null => {
    if (scheme === 'percent') return pct === null ? null : { kind: 'percent', value: pct };
    if (scheme === 'hours') return hours === null ? null : { kind: 'hours', value: hours };
    if (scheme === 'text') return text.trim() ? { kind: 'text', text: text.trim() } : null;
    return milestone ? { kind: 'milestone', milestoneId: milestone } : null;
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const en = entry();
    if (!en) return;
    if (
      await run(
        () =>
          call(
            getApi().progress.add({
              itemId: item.id,
              entry: en,
              occurredAt: localInputToIso(when),
              note: note || null,
            }),
          ),
        'Progress saved.',
      )
    ) {
      setPct(null);
      setHours(null);
      setText('');
      setWhen('');
      setNote('');
    }
  };

  return (
    <div>
      <p>
        <strong>{item.progress.label}</strong>
      </p>
      {!readOnly && (
        <>
          <div className="field field-inline">
            <label htmlFor={`${id}-scheme`}>Track this game by</label>
            <select
              id={`${id}-scheme`}
              className="input input-inline"
              value={scheme}
              disabled={busy}
              onChange={(e) =>
                void run(
                  () =>
                    call(
                      getApi().progress.setScheme({ itemId: item.id, scheme: e.target.value as GameScheme }),
                    ),
                  'Progress scheme changed. Earlier history is kept.',
                )
              }
            >
              {GAME_SCHEMES.map((s) => (
                <option key={s} value={s}>
                  {SCHEME_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <form onSubmit={(e) => void submit(e)} aria-label="Record game progress">
            {scheme === 'percent' && (
              <NumberField
                label="Percent complete"
                value={pct}
                onChange={setPct}
                min={0}
                max={100}
                step={1}
              />
            )}
            {scheme === 'hours' && (
              <NumberField label="Total hours played" value={hours} onChange={setHours} min={0} step={0.5} />
            )}
            {scheme === 'text' && (
              <TextField label="Where are you?" value={text} onChange={setText} maxLength={2000} />
            )}
            {scheme === 'milestones' &&
              (item.milestones.length === 0 ? (
                <p className="muted">No milestones yet. Define your own checkpoints below.</p>
              ) : (
                <SelectField
                  label="Current milestone reached"
                  value={milestone}
                  onChange={setMilestone}
                  options={item.milestones.map((m, i) => ({ value: m.id, label: `${i + 1}. ${m.title}` }))}
                />
              ))}
            <WhenAndNote when={when} setWhen={setWhen} note={note} setNote={setNote} />
            <button type="submit" className="button button-primary" disabled={busy || entry() === null}>
              Save progress
            </button>
          </form>
          {scheme === 'milestones' && (
            <button type="button" className="button" onClick={() => setEditMilestones(true)}>
              Edit milestones…
            </button>
          )}
        </>
      )}
      {editMilestones && (
        <MilestonesDialog item={item} onClose={() => setEditMilestones(false)} onOutcome={onOutcome} />
      )}
    </div>
  );
}

function MilestonesDialog({
  item,
  onClose,
  onOutcome,
}: {
  item: ItemDetail;
  onClose: () => void;
  onOutcome: (o: MutationOutcome) => void;
}) {
  const { busy, run } = useRunner(onOutcome);
  const [list, setList] = useState(
    item.milestones.map((m) => ({ id: m.id as string | null, title: m.title })),
  );
  const [draft, setDraft] = useState<string[]>([]);
  const move = (i: number, d: -1 | 1) =>
    setList((l) => {
      const n = [...l];
      const j = i + d;
      if (j < 0 || j >= n.length) return l;
      const a = n[i];
      const b = n[j];
      if (!a || !b) return l;
      n[i] = b;
      n[j] = a;
      return n;
    });
  return (
    <Dialog
      title="Edit milestones"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  call(
                    getApi().progress.setMilestones({
                      itemId: item.id,
                      milestones: [...list, ...draft.map((t) => ({ id: null, title: t }))],
                    }),
                  ),
                'Milestones saved.',
              ).then((ok) => ok && onClose())
            }
          >
            Save milestones
          </button>
        </>
      }
    >
      <p className="field-hint">
        Order matters: progress is the position of the latest milestone you reached. Removing a milestone
        keeps its name in history.
      </p>
      <ol className="reorder-list">
        {list.map((m, i) => (
          <li key={m.id ?? `n${i}`} className="row">
            <label className="visually-hidden" htmlFor={`ms-${i}`}>
              Milestone {i + 1}
            </label>
            <input
              id={`ms-${i}`}
              className="input"
              value={m.title}
              onChange={(e) =>
                setList((l) => l.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
              }
            />
            <button
              type="button"
              className="button button-tiny"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              aria-label={`Move ${m.title} up`}
            >
              ↑
            </button>
            <button
              type="button"
              className="button button-tiny"
              onClick={() => move(i, 1)}
              disabled={i === list.length - 1}
              aria-label={`Move ${m.title} down`}
            >
              ↓
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setList((l) => l.filter((_, j) => j !== i))}
              aria-label={`Remove ${m.title}`}
            >
              <IconTrash />
            </button>
          </li>
        ))}
      </ol>
      <ListInput
        label="Add milestones"
        values={draft}
        onChange={setDraft}
        placeholder="e.g. Chapter 3, Beat the first boss"
      />
    </Dialog>
  );
}

/* ------------------------------------------------------------------ book */

function BookPanel({ item, readOnly, onOutcome }: PanelProps) {
  const { busy, run } = useRunner(onOutcome);
  const [unit, setUnit] = useState<'pages' | 'percent' | 'audio'>(
    item.personal.bookFormat === 'audiobook' ? 'audio' : item.meta.pageCount ? 'pages' : 'percent',
  );
  const [value, setValue] = useState<number | null>(null);
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (value === null) return;
    const entry: ProgressEntryInput =
      unit === 'pages'
        ? { kind: 'pages', value: Math.round(value) }
        : unit === 'audio'
          ? { kind: 'audio', value: Math.round(value) }
          : { kind: 'percent', value };
    if (
      await run(
        () =>
          call(
            getApi().progress.add({
              itemId: item.id,
              entry,
              occurredAt: localInputToIso(when),
              note: note || null,
            }),
          ),
        'Progress saved.',
      )
    ) {
      setValue(null);
      setWhen('');
      setNote('');
    }
  };
  return (
    <div>
      <p>
        <strong>{item.progress.label}</strong>
      </p>
      {item.meta.pageCount === null && (
        <p className="muted">
          Page count unknown — track by percentage, or add the page count under Edit details (history is kept
          either way).
        </p>
      )}
      {!readOnly && (
        <form onSubmit={(e) => void submit(e)} aria-label="Record reading progress">
          <fieldset className="segmented">
            <legend className="visually-hidden">Record progress as</legend>
            {(['pages', 'percent', 'audio'] as const).map((u) => (
              <label key={u} className="radio-pill">
                <input
                  type="radio"
                  name={`${id}-unit`}
                  value={u}
                  checked={unit === u}
                  onChange={() => setUnit(u)}
                />
                <span>{u === 'pages' ? 'Pages' : u === 'percent' ? 'Percent' : 'Audio minutes'}</span>
              </label>
            ))}
          </fieldset>
          {unit === 'pages' && (
            <NumberField
              label={item.meta.pageCount ? `Current page (of ${item.meta.pageCount})` : 'Pages read'}
              value={value}
              onChange={setValue}
              min={0}
              max={100000}
            />
          )}
          {unit === 'percent' && (
            <NumberField
              label="Percent read"
              value={value}
              onChange={setValue}
              min={0}
              max={100}
              step={0.5}
            />
          )}
          {unit === 'audio' && (
            <NumberField
              label={
                item.meta.audioMinutes
                  ? `Minutes listened (of ${formatMinutes(item.meta.audioMinutes)})`
                  : 'Minutes listened'
              }
              value={value}
              onChange={setValue}
              min={0}
            />
          )}
          <WhenAndNote when={when} setWhen={setWhen} note={note} setNote={setNote} />
          <button type="submit" className="button button-primary" disabled={busy || value === null}>
            Save progress
          </button>
        </form>
      )}
    </div>
  );
}
