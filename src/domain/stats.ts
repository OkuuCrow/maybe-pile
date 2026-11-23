/**
 * Stats & Year in Review aggregation. Pure: the service loads rows with indexed
 * queries and these functions fold them. Nothing is invented — every number is
 * derived from completion dates, ratings and history the user recorded, and
 * missing data is counted and reported rather than guessed.
 *
 * Boundaries: `dateCompleted`/`dateStarted` are local calendar dates; history
 * instants are converted to local dates by the service (see calendar.ts).
 */
import { MEDIA_TYPES, type MediaType } from '../shared/enums';
import { daysBetween } from './calendar';

export interface CompletedRow {
  id: string;
  type: MediaType;
  title: string;
  rating: number | null;
  dateStarted: string | null;
  dateCompleted: string;
  pageCount: number | null;
  genres: string[];
  creators: string[];
  tags: string[];
  /** Latest recorded hours for games (hours scheme), else null. */
  hours: number | null;
  /** Watched regular episodes, TV only. */
  episodes: number | null;
}

export interface ActivityRow {
  /** Local calendar date. */
  date: string;
  kind: 'episode' | 'viewing' | 'progress';
}

export type TypeCounts = Record<MediaType, number>;
const zero = (): TypeCounts => ({ movie: 0, tv: 0, game: 0, book: 0 });

export interface MonthBucket {
  month: string; // YYYY-MM
  byType: TypeCounts;
  total: number;
}

export interface StatsResult {
  completedByMonth: MonthBucket[];
  completedByYear: { year: number; byType: TypeCounts; total: number }[];
  avgRatingByType: { type: MediaType; average: number | null; rated: number; completed: number }[];
  topGenres: { name: string; count: number }[];
  topCreators: { name: string; count: number }[];
  timeToComplete: { bucket: string; count: number }[];
  timeToCompleteUnknown: number;
  pages: { total: number; booksWithPages: number; booksWithoutPages: number };
  episodesByMonth: { month: string; count: number }[];
  gameHours: { total: number; gamesTracked: number };
  /** Consecutive ISO weeks with any activity, ending this week (0 when none). */
  currentStreakWeeks: number;
  longestStreakWeeks: number;
}

export const TTC_BUCKETS: { label: string; maxDays: number }[] = [
  { label: 'Under a week', maxDays: 6 },
  { label: '1–4 weeks', maxDays: 30 },
  { label: '1–3 months', maxDays: 91 },
  { label: '3–12 months', maxDays: 365 },
  { label: 'Over a year', maxDays: Number.POSITIVE_INFINITY },
];

function topN(counter: Map<string, { name: string; count: number }>, n: number) {
  return [...counter.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, n);
}

function count(counter: Map<string, { name: string; count: number }>, name: string) {
  const k = name.trim().toLowerCase();
  if (!k) return;
  const e = counter.get(k);
  if (e) e.count++;
  else counter.set(k, { name: name.trim(), count: 1 });
}

/** Monday-start week key for a local calendar date. */
export function weekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function streaks(
  activityDates: readonly string[],
  today: string,
): { current: number; longest: number } {
  const weeks = new Set(activityDates.map(weekKey));
  if (weeks.size === 0) return { current: 0, longest: 0 };
  const sorted = [...weeks].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = daysBetween(sorted[i - 1] ?? '', sorted[i] ?? '') === 7 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  let current = 0;
  let w = weekKey(today);
  // The current week may still be empty; count from last week in that case.
  if (!weeks.has(w))
    w = weekKey(new Date(Date.parse(`${w}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10));
  while (weeks.has(w)) {
    current++;
    w = new Date(Date.parse(`${w}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  }
  return { current, longest };
}

export function computeStats(
  completed: readonly CompletedRow[],
  activity: readonly ActivityRow[],
  today: string,
  opts: { year?: number | null } = {},
): StatsResult {
  const rows = opts.year ? completed.filter((r) => r.dateCompleted.startsWith(String(opts.year))) : completed;
  const months = new Map<string, MonthBucket>();
  const years = new Map<number, { year: number; byType: TypeCounts; total: number }>();
  const genres = new Map<string, { name: string; count: number }>();
  const creators = new Map<string, { name: string; count: number }>();
  const ttc = TTC_BUCKETS.map((b) => ({ bucket: b.label, count: 0 }));
  let ttcUnknown = 0;
  const ratings = new Map<MediaType, { sum: number; n: number; completed: number }>();
  let pages = 0;
  let withPages = 0;
  let withoutPages = 0;
  let hours = 0;
  let gamesTracked = 0;
  for (const r of rows) {
    const month = r.dateCompleted.slice(0, 7);
    const mb = months.get(month) ?? { month, byType: zero(), total: 0 };
    mb.byType[r.type]++;
    mb.total++;
    months.set(month, mb);
    const y = Number(r.dateCompleted.slice(0, 4));
    const yb = years.get(y) ?? { year: y, byType: zero(), total: 0 };
    yb.byType[r.type]++;
    yb.total++;
    years.set(y, yb);
    const rt = ratings.get(r.type) ?? { sum: 0, n: 0, completed: 0 };
    rt.completed++;
    if (r.rating !== null) {
      rt.sum += r.rating;
      rt.n++;
    }
    ratings.set(r.type, rt);
    r.genres.forEach((g) => count(genres, g));
    r.creators.forEach((c) => count(creators, c));
    if (r.dateStarted && r.dateStarted <= r.dateCompleted) {
      const d = daysBetween(r.dateStarted, r.dateCompleted);
      const i = TTC_BUCKETS.findIndex((b) => d <= b.maxDays);
      const slot = ttc[i];
      if (slot) slot.count++;
    } else ttcUnknown++;
    if (r.type === 'book') {
      if (r.pageCount) {
        pages += r.pageCount;
        withPages++;
      } else withoutPages++;
    }
    if (r.type === 'game' && r.hours !== null) {
      hours += r.hours;
      gamesTracked++;
    }
  }
  const episodesByMonth = new Map<string, number>();
  for (const a of activity) {
    if (a.kind !== 'episode') continue;
    if (opts.year && !a.date.startsWith(String(opts.year))) continue;
    const m = a.date.slice(0, 7);
    episodesByMonth.set(m, (episodesByMonth.get(m) ?? 0) + 1);
  }
  const st = streaks([...activity.map((a) => a.date), ...completed.map((c) => c.dateCompleted)], today);
  return {
    completedByMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    completedByYear: [...years.values()].sort((a, b) => a.year - b.year),
    avgRatingByType: MEDIA_TYPES.map((type) => {
      const r = ratings.get(type);
      return {
        type,
        average: r && r.n > 0 ? Math.round((r.sum / r.n) * 10) / 10 : null,
        rated: r?.n ?? 0,
        completed: r?.completed ?? 0,
      };
    }),
    topGenres: topN(genres, 10),
    topCreators: topN(creators, 10),
    timeToComplete: ttc,
    timeToCompleteUnknown: ttcUnknown,
    pages: { total: pages, booksWithPages: withPages, booksWithoutPages: withoutPages },
    episodesByMonth: [...episodesByMonth.entries()]
      .map(([month, n]) => ({ month, count: n }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    gameHours: { total: Math.round(hours * 10) / 10, gamesTracked },
    currentStreakWeeks: st.current,
    longestStreakWeeks: st.longest,
  };
}

export interface YearInReview {
  year: number;
  finished: number;
  finishedByType: TypeCounts;
  favorites: { id: string; title: string; type: MediaType; rating: number }[];
  longestBook: { id: string; title: string; pages: number } | null;
  longestGame: { id: string; title: string; hours: number } | null;
  longestShow: { id: string; title: string; episodes: number } | null;
  busiestMonth: { month: string; count: number } | null;
  topTags: { name: string; count: number }[];
  missing: { unrated: number; noStartDate: number; booksWithoutPages: number };
}

export function yearInReview(completed: readonly CompletedRow[], year: number): YearInReview {
  const rows = completed.filter((r) => r.dateCompleted.startsWith(`${year}-`));
  const byType = zero();
  const months = new Map<string, number>();
  const tags = new Map<string, { name: string; count: number }>();
  for (const r of rows) {
    byType[r.type]++;
    const m = r.dateCompleted.slice(0, 7);
    months.set(m, (months.get(m) ?? 0) + 1);
    r.tags.forEach((t) => count(tags, t));
  }
  const best = <T>(xs: T[], v: (x: T) => number | null): T | null => {
    let out: T | null = null;
    let bv = -Infinity;
    for (const x of xs) {
      const n = v(x);
      if (n !== null && n > bv) {
        bv = n;
        out = x;
      }
    }
    return out;
  };
  const book = best(
    rows.filter((r) => r.type === 'book'),
    (r) => r.pageCount,
  );
  const game = best(
    rows.filter((r) => r.type === 'game'),
    (r) => r.hours,
  );
  const show = best(
    rows.filter((r) => r.type === 'tv'),
    (r) => r.episodes,
  );
  let busiest: { month: string; count: number } | null = null;
  for (const [month, n] of [...months.entries()].sort())
    if (!busiest || n > busiest.count) busiest = { month, count: n };
  return {
    year,
    finished: rows.length,
    finishedByType: byType,
    favorites: rows
      .filter((r): r is CompletedRow & { rating: number } => r.rating !== null)
      .sort((a, b) => b.rating - a.rating || a.title.localeCompare(b.title))
      .slice(0, 5)
      .map((r) => ({ id: r.id, title: r.title, type: r.type, rating: r.rating })),
    longestBook: book?.pageCount ? { id: book.id, title: book.title, pages: book.pageCount } : null,
    longestGame: game?.hours ? { id: game.id, title: game.title, hours: game.hours } : null,
    longestShow: show?.episodes ? { id: show.id, title: show.title, episodes: show.episodes } : null,
    busiestMonth: busiest,
    topTags: topN(tags, 5),
    missing: {
      unrated: rows.filter((r) => r.rating === null).length,
      noStartDate: rows.filter((r) => !r.dateStarted).length,
      booksWithoutPages: rows.filter((r) => r.type === 'book' && !r.pageCount).length,
    },
  };
}
