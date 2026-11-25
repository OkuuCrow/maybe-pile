/**
 * Pile Time: per-item estimates, backlog totals and "what fits in N minutes".
 * One aggregate query feeds the pure estimator (src/domain/pile-time.ts), so
 * totals stay fast on large libraries. IGDB time-to-beat is fetched only on
 * explicit request and stored as a provider estimate.
 */
import type { PileTimeRow } from '../../shared/types';
import { appError } from '../../shared/result';
import type { MediaType, Status } from '../../shared/enums';
import {
  estimatePileTime,
  sumPileTime,
  type PileTimeEstimate,
  type PileTimeTotals,
} from '../../domain/pile-time';
import type { ServiceContext } from './context';

interface Raw {
  id: string;
  title: string;
  type: MediaType;
  status: Status;
  progress_pct: number | null;
  runtime_minutes: number | null;
  episode_runtime: number | null;
  ep_total: number;
  ep_watched: number;
  page_count: number | null;
  audio_minutes: number | null;
  book_format: string | null;
  hours: number | null;
  pages: number | null;
  manual_minutes: number | null;
  provider_minutes: number | null;
}

const SELECT = `
SELECT i.id, i.title, i.type, i.status, i.progress_pct,
  md.runtime_minutes, td.episode_runtime,
  (SELECT count(*) FROM episodes e WHERE e.item_id = i.id) AS ep_total,
  (SELECT count(*) FROM episodes e WHERE e.item_id = i.id AND e.watched = 1) AS ep_watched,
  bd.page_count, bd.audio_minutes, bd.format AS book_format,
  (SELECT p.value FROM progress_events p WHERE p.item_id = i.id AND p.kind = 'hours' AND p.deleted_at IS NULL AND p.pass = i.pass ORDER BY p.seq DESC LIMIT 1) AS hours,
  (SELECT p.value FROM progress_events p WHERE p.item_id = i.id AND p.kind = 'pages' AND p.deleted_at IS NULL AND p.pass = i.pass ORDER BY p.seq DESC LIMIT 1) AS pages,
  (SELECT t.minutes FROM time_estimates t WHERE t.item_id = i.id AND t.source = 'manual') AS manual_minutes,
  (SELECT t.minutes FROM time_estimates t WHERE t.item_id = i.id AND t.source = 'provider') AS provider_minutes
FROM items i
LEFT JOIN movie_details md ON md.item_id = i.id
LEFT JOIN tv_details td ON td.item_id = i.id
LEFT JOIN book_details bd ON bd.item_id = i.id
WHERE i.deleted_at IS NULL`;

function toEstimate(r: Raw): PileTimeEstimate {
  return estimatePileTime({
    type: r.type,
    status: r.status,
    runtimeMinutes: r.runtime_minutes,
    episodeRuntime: r.episode_runtime,
    episodesTotal: r.ep_total,
    episodesWatched: r.ep_watched,
    pageCount: r.page_count,
    pagesRead: r.pages,
    audioMinutes: r.audio_minutes,
    bookFormat: r.book_format,
    hoursPlayed: r.hours,
    progressPct: r.progress_pct,
    manualMinutes: r.manual_minutes,
    providerMinutes: r.provider_minutes,
  });
}

export class PileTimeService {
  constructor(private readonly ctx: ServiceContext) {}

  forItem(
    itemId: string,
  ): PileTimeEstimate & { manualMinutes: number | null; providerMinutes: number | null } {
    const r = this.ctx.db().get<Raw>(`${SELECT} AND i.id = ?`, [itemId]);
    if (!r) throw appError('NOT_FOUND', 'That item no longer exists.');
    return { ...toEstimate(r), manualMinutes: r.manual_minutes, providerMinutes: r.provider_minutes };
  }

  /** Unfinished items (planned, in progress, on hold) with their estimates. */
  backlog(): PileTimeRow[] {
    return this.ctx
      .db()
      .all<Raw>(`${SELECT} AND i.status IN ('planned', 'in_progress', 'on_hold')`)
      .map((r) => ({ id: r.id, title: r.title, type: r.type, status: r.status, estimate: toEstimate(r) }));
  }

  totals(): PileTimeTotals {
    return sumPileTime(this.backlog().map((r) => ({ type: r.type, est: r.estimate })));
  }

  /** Items whose remaining time fits the budget, longest first (fills the time best). */
  fits(budgetMinutes: number, types: MediaType[] | null, limit = 50): PileTimeRow[] {
    return this.backlog()
      .filter(
        (r) =>
          r.estimate.remainingMinutes !== null &&
          r.estimate.remainingMinutes > 0 &&
          r.estimate.remainingMinutes <= budgetMinutes &&
          (!types || types.includes(r.type)),
      )
      .sort((a, b) => (b.estimate.remainingMinutes ?? 0) - (a.estimate.remainingMinutes ?? 0))
      .slice(0, limit);
  }

  /** Sets (or clears, with null) the user's own estimate. */
  setManual(itemId: string, minutes: number | null): PileTimeEstimate {
    const db = this.ctx.db();
    if (!db.get('SELECT 1 FROM items WHERE id = ? AND deleted_at IS NULL', [itemId]))
      throw appError('NOT_FOUND', 'That item no longer exists.');
    if (minutes === null)
      db.run("DELETE FROM time_estimates WHERE item_id = ? AND source = 'manual'", [itemId]);
    else
      db.run(
        `INSERT INTO time_estimates (item_id, source, minutes, confidence, provider_id, detail, user_set, fetched_at)
         VALUES (?, 'manual', ?, 'high', NULL, NULL, 1, ?)
         ON CONFLICT (item_id, source) DO UPDATE SET minutes = excluded.minutes, fetched_at = excluded.fetched_at`,
        [itemId, minutes, this.ctx.clock.now().toISOString()],
      );
    return this.forItem(itemId);
  }

  /** Stores a provider estimate (e.g. IGDB time-to-beat). Never touches the manual row. */
  setProvider(itemId: string, minutes: number, providerId: string, detail: string | null): void {
    this.ctx.db().run(
      `INSERT INTO time_estimates (item_id, source, minutes, confidence, provider_id, detail, user_set, fetched_at)
       VALUES (?, 'provider', ?, 'medium', ?, ?, 0, ?)
       ON CONFLICT (item_id, source) DO UPDATE SET minutes = excluded.minutes, provider_id = excluded.provider_id,
         detail = excluded.detail, fetched_at = excluded.fetched_at`,
      [itemId, minutes, providerId, detail?.slice(0, 200) ?? null, this.ctx.clock.now().toISOString()],
    );
  }
}
