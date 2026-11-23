/**
 * Stats & Year in Review. Local-only: rows are read with indexed queries and
 * folded by the pure functions in domain/stats.ts. Charts can be exported as
 * CSV (built here) or PNG (captured by main from the visible chart).
 *
 * Time zones: completion dates are local calendar dates (used as is); history
 * instants are UTC and converted to local dates with `timeZone` (default: the
 * system zone). See docs/features/stats.md.
 */
import type { MediaType } from '../../shared/enums';
import { TYPE_LABELS } from '../../shared/enums';
import { appError } from '../../shared/result';
import type { StatsView, YearInReviewView } from '../../shared/types';
import { instantToLocalDate } from '../../domain/calendar';
import { toCsv } from '../../domain/csv';
import { localDate } from '../../domain/dates';
import { computeStats, yearInReview, type ActivityRow, type CompletedRow } from '../../domain/stats';
import { readSettings } from '../../db/repositories/config-repo';
import type { ServiceContext } from './context';

const SEP = '\u001f';

export const STATS_CHARTS = [
  'completedByMonth',
  'completedByYear',
  'avgRatingByType',
  'topGenres',
  'topCreators',
  'timeToComplete',
  'episodesByMonth',
] as const;
export type StatsChart = (typeof STATS_CHARTS)[number];

export class StatsService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly timeZone?: string,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  completedRows(): CompletedRow[] {
    return this.db
      .all<{
        id: string;
        type: MediaType;
        title: string;
        rating: number | null;
        date_started: string | null;
        date_completed: string;
        page_count: number | null;
        genres: string | null;
        creators: string | null;
        tags: string | null;
        hours: number | null;
        episodes: number | null;
      }>(
        `SELECT i.id, i.type, i.title, i.rating, i.date_started, i.date_completed, b.page_count,
                (SELECT group_concat(g.name, '${SEP}') FROM item_genres ig JOIN genres g ON g.id = ig.genre_id WHERE ig.item_id = i.id) AS genres,
                (SELECT group_concat(c.name, '${SEP}') FROM item_creators ic JOIN creators c ON c.id = ic.creator_id WHERE ic.item_id = i.id AND ic.role IN ('director','creator','developer','author')) AS creators,
                (SELECT group_concat(t.name, '${SEP}') FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id) AS tags,
                CASE WHEN i.type = 'game' THEN (SELECT p.value FROM progress_events p WHERE p.item_id = i.id AND p.kind = 'hours' AND p.deleted_at IS NULL
                     ORDER BY COALESCE(p.occurred_at, p.recorded_at) DESC, p.seq DESC LIMIT 1) END AS hours,
                CASE WHEN i.type = 'tv' THEN (SELECT count(*) FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.item_id = i.id AND e.watched = 1 AND s.season_number > 0) END AS episodes
         FROM items i LEFT JOIN book_details b ON b.item_id = i.id
         WHERE i.deleted_at IS NULL AND i.status = 'completed' AND i.date_completed IS NOT NULL`,
      )
      .map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        rating: r.rating,
        dateStarted: r.date_started,
        dateCompleted: r.date_completed,
        pageCount: r.page_count,
        genres: r.genres ? r.genres.split(SEP) : [],
        creators: r.creators ? r.creators.split(SEP) : [],
        tags: r.tags ? r.tags.split(SEP) : [],
        hours: r.hours,
        episodes: r.episodes,
      }));
  }

  activityRows(): ActivityRow[] {
    const out: ActivityRow[] = [];
    // Time-zone offsets are whole minutes, so UTC instants in the same minute share a local date.
    const memo = new Map<string, string | null>();
    const push = (at: string | null, kind: ActivityRow['kind']) => {
      if (!at) return;
      const key = at.endsWith('Z') && at.length >= 17 ? at.slice(0, 16) : at;
      let d = memo.get(key);
      if (d === undefined) {
        d = instantToLocalDate(at, this.timeZone);
        memo.set(key, d);
      }
      if (d) out.push({ date: d, kind });
    };
    for (const r of this.db.all<{ at: string | null }>(
      `SELECT e.watched_at AS at FROM episodes e JOIN items i ON i.id = e.item_id JOIN seasons s ON s.id = e.season_id
       WHERE i.deleted_at IS NULL AND e.watched = 1 AND s.season_number > 0`,
    ))
      push(r.at, 'episode');
    for (const r of this.db.all<{ at: string | null }>(
      `SELECT COALESCE(v.watched_at, v.created_at) AS at FROM viewing_events v JOIN items i ON i.id = v.item_id WHERE i.deleted_at IS NULL`,
    ))
      push(r.at, 'viewing');
    for (const r of this.db.all<{ at: string | null }>(
      `SELECT COALESCE(p.occurred_at, p.recorded_at) AS at FROM progress_events p JOIN items i ON i.id = p.item_id
       WHERE i.deleted_at IS NULL AND p.deleted_at IS NULL AND p.kind NOT IN ('episode', 'season')`,
    ))
      push(r.at, 'progress');
    return out;
  }

  get(year: number | null): StatsView {
    const completed = this.completedRows();
    const activity = this.activityRows();
    const today = localDate(this.ctx.clock.now());
    const s = computeStats(completed, activity, today, { year });
    const showStreaks = readSettings(this.db).settings.stats.showStreaks;
    const years = [...new Set(completed.map((c) => Number(c.dateCompleted.slice(0, 4))))].sort(
      (a, b) => b - a,
    );
    return {
      year,
      years,
      completedTotal: s.completedByMonth.reduce((n, m) => n + m.total, 0),
      completedByMonth: s.completedByMonth,
      completedByYear: s.completedByYear,
      avgRatingByType: s.avgRatingByType,
      topGenres: s.topGenres,
      topCreators: s.topCreators,
      timeToComplete: s.timeToComplete,
      timeToCompleteUnknown: s.timeToCompleteUnknown,
      pages: s.pages,
      episodesByMonth: s.episodesByMonth,
      gameHours: s.gameHours,
      streaks: showStreaks ? { current: s.currentStreakWeeks, longest: s.longestStreakWeeks } : null,
    };
  }

  yearInReview(year: number): YearInReviewView {
    return yearInReview(this.completedRows(), year);
  }

  /** CSV for one chart's data (same numbers as the chart's data table). Formula-safe via toCsv. */
  chartCsv(chart: StatsChart, year: number | null, bom: boolean): string {
    const s = this.get(year);
    const types: MediaType[] = ['movie', 'tv', 'game', 'book'];
    switch (chart) {
      case 'completedByMonth':
        return toCsv(
          ['month', ...types.map((t) => TYPE_LABELS[t]), 'total'],
          s.completedByMonth.map((m) => [m.month, ...types.map((t) => m.byType[t]), m.total]),
          bom,
        );
      case 'completedByYear':
        return toCsv(
          ['year', ...types.map((t) => TYPE_LABELS[t]), 'total'],
          s.completedByYear.map((m) => [m.year, ...types.map((t) => m.byType[t]), m.total]),
          bom,
        );
      case 'avgRatingByType':
        return toCsv(
          ['type', 'average_stars', 'rated', 'completed'],
          s.avgRatingByType.map((r) => [
            TYPE_LABELS[r.type],
            r.average === null ? null : r.average / 2,
            r.rated,
            r.completed,
          ]),
          bom,
        );
      case 'topGenres':
        return toCsv(
          ['genre', 'completed'],
          s.topGenres.map((g) => [g.name, g.count]),
          bom,
        );
      case 'topCreators':
        return toCsv(
          ['creator', 'completed'],
          s.topCreators.map((g) => [g.name, g.count]),
          bom,
        );
      case 'timeToComplete':
        return toCsv(
          ['time_to_complete', 'items'],
          [
            ...s.timeToComplete.map((b) => [b.bucket, b.count]),
            ['Unknown (no start date)', s.timeToCompleteUnknown],
          ],
          bom,
        );
      case 'episodesByMonth':
        return toCsv(
          ['month', 'episodes'],
          s.episodesByMonth.map((m) => [m.month, m.count]),
          bom,
        );
      default:
        throw appError('VALIDATION', 'Unknown chart.');
    }
  }
}
