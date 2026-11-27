/**
 * Pure progress derivation for every media type. Inputs are plain data loaded
 * by the repository; outputs drive the detail view, list sort order (cached as
 * items.progress_pct / progress_label) and dashboard "Continue" widget.
 *
 * Rules (also documented in docs/product-decisions.md):
 * - History keeps every entry in the unit it was recorded in. "Current" is the
 *   latest non-deleted entry of the kinds relevant to the item's current
 *   scheme, within the current pass.
 * - Percentages are never computed against an unknown or zero total.
 * - TV specials (season 0) are tracked but excluded from completion math.
 * - Books: a "pages" entry is displayed against the *current* page count. If
 *   the page count is changed (new edition), history is not rewritten; the
 *   percentage is recomputed and capped at 100%.
 */
import type { GameScheme, MediaType, ProgressKind, ShowStatus } from '../shared/enums';
import type { ProgressSummary } from '../shared/types';

export interface ProgressEventLike {
  kind: ProgressKind;
  value: number | null;
  text: string | null;
  milestoneId: string | null;
  pass: number;
  /** Sort key: occurredAt ?? recordedAt (ISO strings compare lexicographically). */
  at: string;
  /** Tie-breaker for identical timestamps: insertion order. */
  seq: number;
}

export interface EpisodeLike {
  number: number;
  title: string | null;
  watched: boolean;
  /** 2.1 §16.8: skipped (filler/recap/special). Counts toward "caught up", never as watched or watch time. */
  skipped?: boolean;
}

export interface SeasonLike {
  number: number;
  episodeCountKnown: number | null;
  episodes: EpisodeLike[];
}

export interface ProgressInputs {
  type: MediaType;
  pass: number;
  viewings: { pass: number }[];
  seasons: SeasonLike[];
  showStatus: ShowStatus | null;
  gameScheme: GameScheme | null;
  milestones: { id: string; position: number; title: string }[];
  events: ProgressEventLike[];
  pageCount: number | null;
  audioMinutes: number | null;
}

const clampPct = (n: number): number => Math.max(0, Math.min(100, n));
const roundPct = (n: number): number => Math.round(clampPct(n) * 10) / 10;

export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} h played`;
}

export function episodeCode(season: number, episode: number): string {
  return season === 0 ? `Special ${episode}` : `S${season}E${episode}`;
}

/** Latest event among `kinds` in the current pass. */
export function latestEvent(
  events: readonly ProgressEventLike[],
  kinds: readonly ProgressKind[],
  pass: number,
): ProgressEventLike | null {
  let best: ProgressEventLike | null = null;
  for (const e of events) {
    if (e.pass !== pass || !kinds.includes(e.kind)) continue;
    if (!best || e.at > best.at || (e.at === best.at && e.seq > best.seq)) best = e;
  }
  return best;
}

const NONE: ProgressSummary = {
  percent: null,
  label: 'No progress yet',
  nextAction: null,
  isComplete: false,
  hasAnyProgress: false,
};

export interface TvTotals {
  watched: number;
  /** Skipped episodes (reported separately; count toward completion). */
  skipped: number;
  total: number;
  totalKnown: boolean;
  specialsWatched: number;
  next: { season: number; episode: number; title: string | null } | null;
}

export function tvTotals(seasons: readonly SeasonLike[]): TvTotals {
  const regular = [...seasons].filter((s) => s.number > 0).sort((a, b) => a.number - b.number);
  let watched = 0;
  let skipped = 0;
  let total = 0;
  let totalKnown = regular.length > 0;
  let next: TvTotals['next'] = null;
  for (const s of regular) {
    const listed = s.episodes.length;
    const w = s.episodes.filter((e) => e.watched).length;
    watched += w;
    skipped += s.episodes.filter((e) => e.skipped && !e.watched).length;
    // A season's total is the larger of the stated count and episodes actually listed.
    total += Math.max(s.episodeCountKnown ?? 0, listed);
    if (s.episodeCountKnown === null && listed === 0) totalKnown = false;
    if (!next) {
      const firstUnwatched = [...s.episodes]
        .sort((a, b) => a.number - b.number)
        .find((e) => !e.watched && !e.skipped);
      if (firstUnwatched)
        next = { season: s.number, episode: firstUnwatched.number, title: firstUnwatched.title };
    }
  }
  const specialsWatched = seasons
    .filter((s) => s.number === 0)
    .reduce((n, s) => n + s.episodes.filter((e) => e.watched).length, 0);
  if (total === 0) totalKnown = false;
  return { watched, skipped, total, totalKnown, specialsWatched, next };
}

function tvSummary(i: ProgressInputs): ProgressSummary {
  const t = tvTotals(i.seasons);
  const hasAny = t.watched > 0 || t.specialsWatched > 0;
  const nextAction = t.next
    ? `Next: ${episodeCode(t.next.season, t.next.episode)}${t.next.title ? ` · ${t.next.title}` : ''}`
    : null;
  if (!t.totalKnown) {
    return {
      percent: null,
      label:
        t.watched === 0 && !hasAny
          ? 'No episodes watched · total unknown'
          : `${t.watched} watched${t.skipped ? ` · ${t.skipped} skipped` : ''} · total unknown`,
      nextAction,
      isComplete: false,
      hasAnyProgress: hasAny,
    };
  }
  const soFar = i.showStatus === 'returning' ? ' (so far)' : '';
  const done = t.watched + t.skipped;
  const isComplete = done >= t.total;
  return {
    percent: roundPct((Math.min(done, t.total) / t.total) * 100),
    label: t.skipped
      ? `${t.watched} watched · ${t.skipped} skipped · ${t.total} total${soFar}`
      : `${t.watched} of ${t.total} episodes${soFar}`,
    nextAction: isComplete ? null : nextAction,
    isComplete,
    hasAnyProgress: hasAny,
  };
}

function movieSummary(i: ProgressInputs): ProgressSummary {
  const total = i.viewings.length;
  const thisPass = i.viewings.filter((v) => v.pass === i.pass).length;
  if (total === 0) return { ...NONE, label: 'Not watched', percent: 0, nextAction: 'Watch it' };
  const times = total > 1 ? ` · ${total} viewings` : '';
  if (thisPass === 0) {
    return {
      percent: 0,
      label: `Rewatch pending${times}`,
      nextAction: 'Rewatch it',
      isComplete: false,
      hasAnyProgress: true,
    };
  }
  return { percent: 100, label: `Watched${times}`, nextAction: null, isComplete: true, hasAnyProgress: true };
}

function gameSummary(i: ProgressInputs): ProgressSummary {
  const scheme = i.gameScheme ?? 'percent';
  switch (scheme) {
    case 'percent': {
      const e = latestEvent(i.events, ['percent'], i.pass);
      if (!e || e.value === null) return NONE;
      const pct = roundPct(e.value);
      return {
        percent: pct,
        label: `${pct}% complete`,
        nextAction: `At ${pct}%`,
        isComplete: pct >= 100,
        hasAnyProgress: true,
      };
    }
    case 'hours': {
      const e = latestEvent(i.events, ['hours'], i.pass);
      if (!e || e.value === null) return NONE;
      return {
        percent: null,
        label: formatHours(e.value),
        nextAction: formatHours(e.value),
        isComplete: false,
        hasAnyProgress: true,
      };
    }
    case 'milestones': {
      const ordered = [...i.milestones].sort((a, b) => a.position - b.position);
      const e = latestEvent(i.events, ['milestone'], i.pass);
      if (ordered.length === 0) {
        return { ...NONE, label: 'No milestones defined' };
      }
      const idx = e ? ordered.findIndex((m) => m.id === e.milestoneId) : -1;
      if (idx === -1) {
        return {
          ...NONE,
          percent: 0,
          label: `0 of ${ordered.length} milestones`,
          nextAction: `Next: ${ordered[0]?.title ?? ''}`,
        };
      }
      const reached = idx + 1;
      const current = ordered[idx];
      const nextM = ordered[idx + 1];
      return {
        percent: roundPct((reached / ordered.length) * 100),
        label: `${reached} of ${ordered.length} milestones · ${current?.title ?? ''}`,
        nextAction: nextM ? `Next: ${nextM.title}` : null,
        isComplete: reached >= ordered.length,
        hasAnyProgress: true,
      };
    }
    case 'text': {
      const e = latestEvent(i.events, ['text'], i.pass);
      if (!e || !e.text) return NONE;
      return { percent: null, label: e.text, nextAction: e.text, isComplete: false, hasAnyProgress: true };
    }
  }
}

function bookSummary(i: ProgressInputs): ProgressSummary {
  const e = latestEvent(i.events, ['pages', 'percent', 'audio'], i.pass);
  if (!e || e.value === null) return NONE;
  if (e.kind === 'pages') {
    if (i.pageCount && i.pageCount > 0) {
      const pct = roundPct((e.value / i.pageCount) * 100);
      const shown = Math.min(e.value, i.pageCount);
      return {
        percent: pct,
        label: `${shown} of ${i.pageCount} pages`,
        nextAction: pct >= 100 ? null : `Continue from page ${shown + 1}`,
        isComplete: pct >= 100,
        hasAnyProgress: true,
      };
    }
    return {
      percent: null,
      label: `${e.value} pages · total unknown`,
      nextAction: `Continue from page ${e.value + 1}`,
      isComplete: false,
      hasAnyProgress: true,
    };
  }
  if (e.kind === 'audio') {
    if (i.audioMinutes && i.audioMinutes > 0) {
      const pct = roundPct((e.value / i.audioMinutes) * 100);
      return {
        percent: pct,
        label: `${formatMinutes(Math.min(e.value, i.audioMinutes))} of ${formatMinutes(i.audioMinutes)}`,
        nextAction: pct >= 100 ? null : `At ${formatMinutes(e.value)}`,
        isComplete: pct >= 100,
        hasAnyProgress: true,
      };
    }
    return {
      percent: null,
      label: `${formatMinutes(e.value)} listened · length unknown`,
      nextAction: `At ${formatMinutes(e.value)}`,
      isComplete: false,
      hasAnyProgress: true,
    };
  }
  const pct = roundPct(e.value);
  const approx = i.pageCount ? ` · about page ${Math.round((pct / 100) * i.pageCount)}` : '';
  return {
    percent: pct,
    label: `${pct}% read${approx}`,
    nextAction: pct >= 100 ? null : `At ${pct}%`,
    isComplete: pct >= 100,
    hasAnyProgress: true,
  };
}

export function summarizeProgress(i: ProgressInputs): ProgressSummary {
  switch (i.type) {
    case 'movie':
      return movieSummary(i);
    case 'tv':
    case 'anime':
      return tvSummary(i);
    case 'game':
      return gameSummary(i);
    case 'book':
      return bookSummary(i);
  }
}

/** Which progress-entry kinds are valid for an item right now. */
export function allowedEntryKinds(type: MediaType, scheme: GameScheme | null): ProgressKind[] {
  if (type === 'book') return ['pages', 'percent', 'audio'];
  if (type === 'game') {
    switch (scheme ?? 'percent') {
      case 'percent':
        return ['percent'];
      case 'hours':
        return ['hours'];
      case 'milestones':
        return ['milestone'];
      case 'text':
        return ['text'];
    }
  }
  return [];
}
