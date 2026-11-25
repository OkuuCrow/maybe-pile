/**
 * "Pick for Me": constraint filtering and weighted random selection.
 *
 * Pure and deterministic given a seed, so it is fully unit-tested. Weights are
 * always > 0 for every eligible item: preferences only tilt the odds, they never
 * exclude anything (only constraints the user sets exclude items).
 *
 * Weight formula (documented in docs/features/pick-for-me.md):
 *   ageYears = days since added / 365, capped at 5
 *   favor "neutral": 1
 *   favor "older":   1 + ageYears            (1 … 6)
 *   favor "newer":   1 + (5 - ageYears)       (1 … 6)
 *   × 2 when "favor items I'm partway through" is on and the item has progress
 *     or is In Progress
 */
import type { MediaType, Status } from '../shared/enums';
import { TYPE_LABELS } from '../shared/enums';
import { daysBetween } from './calendar';
import { tagKey } from './normalize';

export interface PickCandidate {
  id: string;
  title: string;
  type: MediaType;
  status: Status;
  dateAdded: string;
  rating: number | null;
  progressPercent: number | null;
  /** Movie runtime in minutes. */
  runtimeMinutes: number | null;
  /** TV episode runtime in minutes. */
  episodeRuntime: number | null;
  tags: string[];
  genres: string[];
  listIds: string[];
  inUpNext: boolean;
  /** Snoozed via Pile Health, or skipped with "Not now" recently. */
  excluded: 'snoozed' | 'skipped' | null;
  /* Expansion Pack 2 (optional so older callers/tests keep working). */
  moodIds?: string[];
  /** Pile Time remaining (minutes), null when unknown. */
  remainingMinutes?: number | null;
  /** In an ordered series and not the next entry. */
  seriesBlocked?: boolean;
}

export interface PickConstraints {
  types: MediaType[];
  genres: string[];
  tags: string[];
  listIds: string[];
  onlyUpNext: boolean;
  includeInProgress: boolean;
  includeOnHold: boolean;
  /** Minutes available tonight, or null for no time limit. */
  availableMinutes: number | null;
  /** Minimum rating 1–10 (items without a rating are excluded when set). */
  ratingFloor: number | null;
  /** Exclude items skipped with "Not now" whose skip hasn't expired. */
  excludeSkipped: boolean;
  /** Items must carry all these moods. */
  moodIds?: string[] | undefined;
  /** Pile Time: only items that can be *finished* within this many minutes. */
  finishWithinMinutes?: number | null | undefined;
  /** Skip series entries that aren't next (ordered series only). */
  respectSeriesOrder?: boolean | undefined;
}

export interface PickPreferences {
  favor: 'neutral' | 'older' | 'newer';
  favorInProgress: boolean;
}

export const DEFAULT_CONSTRAINTS: PickConstraints = {
  types: [],
  genres: [],
  tags: [],
  listIds: [],
  onlyUpNext: false,
  includeInProgress: false,
  includeOnHold: false,
  availableMinutes: null,
  ratingFloor: null,
  excludeSkipped: true,
};

/** Constraint names reported when a filter empties the pool. */
export type ConstraintKey =
  | 'status'
  | 'snoozed'
  | 'skipped'
  | 'types'
  | 'genres'
  | 'tags'
  | 'listIds'
  | 'onlyUpNext'
  | 'availableMinutes'
  | 'ratingFloor'
  | 'moods'
  | 'finishWithin'
  | 'seriesOrder';

export const CONSTRAINT_LABELS: Record<ConstraintKey, string> = {
  status: 'Only Planned items are eligible (In Progress and On Hold are off)',
  snoozed: 'Everything left is snoozed',
  skipped: 'Everything left was skipped with “Not now” recently',
  types: 'Media type',
  genres: 'Genre',
  tags: 'Tag',
  listIds: 'List',
  onlyUpNext: 'Only Up Next',
  availableMinutes: 'Available time',
  ratingFloor: 'Minimum rating',
  moods: 'Mood',
  finishWithin: 'Finish within (Pile Time)',
  seriesOrder: 'Series order (only the next entry of an ordered series)',
};

/** Time slack: a 90-minute evening fits films up to 110 minutes. */
export const TIME_SLACK_MINUTES = 20;

/**
 * Session length in minutes from tags like "session-30", "session:45" or
 * "30min"; the tag "short" fits any evening. Returns null when untagged.
 */
export function sessionMinutes(tags: readonly string[]): number | 'short' | null {
  let best: number | null = null;
  for (const t of tags) {
    const k = tagKey(t);
    if (k === 'short' || k === 'quick') return 'short';
    const m = /^(?:session[\s:_-]*(\d{1,4})|(\d{1,4})\s*-?\s*min(?:ute)?s?)$/.exec(k);
    const n = m ? Number(m[1] ?? m[2]) : NaN;
    if (Number.isFinite(n) && n > 0) best = best === null ? n : Math.min(best, n);
  }
  return best;
}

/** Whether a candidate fits the available time, with the rules above. */
export function fitsTime(c: PickCandidate, minutes: number): boolean {
  if (c.type === 'movie')
    return c.runtimeMinutes !== null && c.runtimeMinutes <= minutes + TIME_SLACK_MINUTES;
  if (c.type === 'tv' || c.type === 'anime') return c.episodeRuntime !== null && c.episodeRuntime <= minutes;
  const s = sessionMinutes(c.tags);
  return s === 'short' || (s !== null && s <= minutes);
}

export interface FilterOutcome {
  eligible: PickCandidate[];
  /** The first constraint (in application order) that left zero items, or null. */
  emptiedBy: ConstraintKey | null;
}

/** Applies constraints in a fixed order so an empty result can name the culprit. */
export function filterCandidates(all: readonly PickCandidate[], c: PickConstraints): FilterOutcome {
  const keyset = (xs: readonly string[]) => new Set(xs.map(tagKey));
  const genres = keyset(c.genres);
  const tags = keyset(c.tags);
  const steps: [ConstraintKey, (x: PickCandidate) => boolean, boolean][] = [
    [
      'status',
      (x) =>
        x.status === 'planned' ||
        (c.includeInProgress && x.status === 'in_progress') ||
        (c.includeOnHold && x.status === 'on_hold'),
      true,
    ],
    ['snoozed', (x) => x.excluded !== 'snoozed', true],
    ['skipped', (x) => !c.excludeSkipped || x.excluded !== 'skipped', true],
    ['types', (x) => c.types.includes(x.type), c.types.length > 0],
    ['genres', (x) => x.genres.some((g) => genres.has(tagKey(g))), genres.size > 0],
    ['tags', (x) => x.tags.some((t) => tags.has(tagKey(t))), tags.size > 0],
    ['listIds', (x) => x.listIds.some((l) => c.listIds.includes(l)), c.listIds.length > 0],
    ['onlyUpNext', (x) => x.inUpNext, c.onlyUpNext],
    [
      'availableMinutes',
      (x) => c.availableMinutes !== null && fitsTime(x, c.availableMinutes),
      c.availableMinutes !== null,
    ],
    ['ratingFloor', (x) => x.rating !== null && x.rating >= (c.ratingFloor ?? 0), c.ratingFloor !== null],
    [
      'moods',
      (x) => (c.moodIds ?? []).every((m) => (x.moodIds ?? []).includes(m)),
      (c.moodIds ?? []).length > 0,
    ],
    [
      'finishWithin',
      (x) =>
        x.remainingMinutes !== null &&
        x.remainingMinutes !== undefined &&
        x.remainingMinutes > 0 &&
        x.remainingMinutes <= (c.finishWithinMinutes ?? 0),
      c.finishWithinMinutes !== null && c.finishWithinMinutes !== undefined,
    ],
    ['seriesOrder', (x) => !x.seriesBlocked, c.respectSeriesOrder === true],
  ];
  let pool = [...all];
  let emptiedBy: ConstraintKey | null = null;
  for (const [key, pred, active] of steps) {
    if (!active) continue;
    const next = pool.filter(pred);
    if (next.length === 0 && pool.length > 0 && emptiedBy === null) emptiedBy = key;
    pool = next;
  }
  if (all.length === 0) emptiedBy = 'status';
  return { eligible: pool, emptiedBy: pool.length === 0 ? emptiedBy : null };
}

export function weightOf(c: PickCandidate, prefs: PickPreferences, today: string): number {
  const ageYears = Math.min(5, Math.max(0, daysBetween(c.dateAdded, today)) / 365);
  let w = prefs.favor === 'older' ? 1 + ageYears : prefs.favor === 'newer' ? 1 + (5 - ageYears) : 1;
  if (prefs.favorInProgress && (c.status === 'in_progress' || (c.progressPercent ?? 0) > 0)) w *= 2;
  return Math.max(w, 0.01);
}

/** Small, fast, seedable PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Weighted random choice. Items listed in `avoid` (e.g. the previous pick) are
 * skipped when any other option exists, so "Re-roll" never repeats immediately.
 */
export function pickWeighted(
  pool: readonly PickCandidate[],
  prefs: PickPreferences,
  today: string,
  rng: () => number,
  avoid: readonly string[] = [],
): PickCandidate | null {
  const filtered = pool.filter((p) => !avoid.includes(p.id));
  const list = filtered.length > 0 ? filtered : [...pool];
  if (list.length === 0) return null;
  // Sort for determinism regardless of input order.
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const weights = list.map((c) => weightOf(c, prefs, today));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i] ?? 0;
    if (r < 0) return list[i] ?? null;
  }
  return list[list.length - 1] ?? null;
}

function ageLabel(days: number): string {
  if (days < 1) return 'today';
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  return `${Math.floor(days / 365.25)} years`;
}

/** Plain-language reasons the pick matched, e.g. "Planned 14 months · fits 90 min · tag: cozy". */
export function pickReasons(c: PickCandidate, k: PickConstraints, today: string): string[] {
  const out: string[] = [];
  const age = daysBetween(c.dateAdded, today);
  out.push(
    c.status === 'planned'
      ? `Planned ${ageLabel(age)}`
      : c.status === 'in_progress'
        ? `In progress${c.progressPercent !== null ? ` (${Math.round(c.progressPercent)}%)` : ''}`
        : 'On hold',
  );
  if (k.availableMinutes !== null) {
    const len =
      c.type === 'movie'
        ? `${c.runtimeMinutes} min`
        : c.type === 'tv' || c.type === 'anime'
          ? `${c.episodeRuntime}-min episodes`
          : sessionMinutes(c.tags) === 'short'
            ? 'tagged short'
            : `${String(sessionMinutes(c.tags))}-min sessions`;
    out.push(`fits ${k.availableMinutes} min (${len})`);
  }
  if (k.types.length > 0) out.push(TYPE_LABELS[c.type]);
  const tagKeys = new Set(k.tags.map(tagKey));
  for (const t of c.tags) if (tagKeys.has(tagKey(t))) out.push(`tag: ${t}`);
  const genreKeys = new Set(k.genres.map(tagKey));
  for (const g of c.genres) if (genreKeys.has(tagKey(g))) out.push(`genre: ${g}`);
  if (c.inUpNext) out.push('in Up Next');
  if (k.ratingFloor !== null && c.rating !== null) out.push(`rated ${c.rating / 2}★`);
  return out;
}
