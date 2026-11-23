/**
 * Goals: simple targets computed from real completion dates and history.
 * Suggestions, never nags — no OS notifications are sent for goals.
 *
 * Metrics (documented in docs/features/goals.md):
 * - items:    items with status Completed and a completion date in the period
 * - pages:    page counts of books completed in the period (known counts only)
 * - episodes: TV episodes whose watched time falls in the period (local dates)
 * - hours:    for each game, hours logged in the period = latest hours entry in
 *             the period minus the latest entry before it (never negative)
 */
import { randomUUID } from 'node:crypto';
import type { MediaType } from '../../shared/enums';
import { appError } from '../../shared/result';
import type { GoalInput } from '../../shared/schemas';
import type { GoalView } from '../../shared/types';
import { instantToLocalDate } from '../../domain/calendar';
import { localDate } from '../../domain/dates';
import { neededPerWeek, pace, periodRange } from '../../domain/goals';
import { tagKey } from '../../domain/normalize';
import type { ServiceContext } from './context';

interface GoalRow {
  id: string;
  title: string;
  media_type: MediaType | null;
  metric: GoalView['metric'];
  period: GoalView['period'];
  start_date: string;
  end_date: string;
  target: number;
  list_id: string | null;
  list_name: string | null;
  tag: string | null;
  archived_at: string | null;
}

export class GoalsService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly timeZone?: string,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  list(includeArchived = false): GoalView[] {
    const rows = this.db.all<GoalRow>(
      `SELECT g.*, l.name AS list_name FROM goals g LEFT JOIN lists l ON l.id = g.list_id
       ${includeArchived ? '' : 'WHERE g.archived_at IS NULL'} ORDER BY g.archived_at IS NOT NULL, g.end_date, g.title`,
    );
    const today = localDate(this.ctx.clock.now());
    return rows.map((r) => {
      const progress = this.progressFor(r);
      const p = pace(progress, r.target, r.start_date, r.end_date, today);
      return {
        id: r.id,
        title: r.title,
        mediaType: r.media_type,
        metric: r.metric,
        period: r.period,
        startDate: r.start_date,
        endDate: r.end_date,
        target: r.target,
        listId: r.list_id,
        listName: r.list_name,
        tag: r.tag,
        archived: r.archived_at !== null,
        progress,
        pace: {
          status: p.status,
          label: p.label,
          expected: Math.round(p.expected * 10) / 10,
          math: p.math,
          neededPerWeek: neededPerWeek(progress, r.target, r.end_date, today),
        },
      };
    });
  }

  /** Scope SQL shared by every metric. */
  private scope(r: GoalRow): { sql: string; params: string[] } {
    const parts: string[] = ['i.deleted_at IS NULL'];
    const params: string[] = [];
    if (r.media_type) {
      parts.push('i.type = ?');
      params.push(r.media_type);
    }
    if (r.list_id) {
      parts.push('EXISTS (SELECT 1 FROM list_items li WHERE li.item_id = i.id AND li.list_id = ?)');
      params.push(r.list_id);
    }
    if (r.tag) {
      parts.push(
        'EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name_key = ?)',
      );
      params.push(tagKey(r.tag));
    }
    return { sql: parts.join(' AND '), params };
  }

  progressFor(r: GoalRow): number {
    const db = this.db;
    const s = this.scope(r);
    if (r.metric === 'items' || r.metric === 'pages') {
      const row = db.get<{ n: number | null }>(
        `SELECT ${r.metric === 'items' ? 'count(*)' : 'sum(b.page_count)'} AS n
         FROM items i ${r.metric === 'pages' ? 'JOIN book_details b ON b.item_id = i.id' : ''}
         WHERE ${s.sql} AND i.status = 'completed' AND i.date_completed BETWEEN ? AND ?`,
        [...s.params, r.start_date, r.end_date],
      );
      return row?.n ?? 0;
    }
    if (r.metric === 'episodes') {
      // Watched instants are UTC; compare by local date. Pre-filter with a ±1 day UTC window.
      const rows = db.all<{ at: string }>(
        `SELECT e.watched_at AS at FROM episodes e JOIN items i ON i.id = e.item_id JOIN seasons se ON se.id = e.season_id
         WHERE ${s.sql} AND e.watched = 1 AND e.watched_at IS NOT NULL AND se.season_number > 0
           AND e.watched_at >= ? AND e.watched_at < ?`,
        [...s.params, shift(r.start_date, -1), shift(r.end_date, 2)],
      );
      return rows.filter((x) => {
        const d = instantToLocalDate(x.at, this.timeZone);
        return d !== null && d >= r.start_date && d <= r.end_date;
      }).length;
    }
    // hours
    const events = db.all<{ item_id: string; value: number; at: string }>(
      `SELECT p.item_id, p.value, COALESCE(p.occurred_at, p.recorded_at) AS at
       FROM progress_events p JOIN items i ON i.id = p.item_id
       WHERE ${s.sql} AND p.kind = 'hours' AND p.deleted_at IS NULL AND p.value IS NOT NULL
       ORDER BY at`,
      s.params,
    );
    const byItem = new Map<string, { before: number; during: number | null }>();
    for (const e of events) {
      const d = instantToLocalDate(e.at, this.timeZone) ?? e.at.slice(0, 10);
      const cur = byItem.get(e.item_id) ?? { before: 0, during: null };
      if (d < r.start_date) cur.before = e.value;
      else if (d <= r.end_date) cur.during = e.value;
      byItem.set(e.item_id, cur);
    }
    let hours = 0;
    for (const v of byItem.values()) if (v.during !== null) hours += Math.max(0, v.during - v.before);
    return Math.round(hours * 10) / 10;
  }

  save(input: GoalInput): GoalView[] {
    const range = periodRange(
      input.period,
      input.startDate,
      input.period === 'custom'
        ? { start: input.startDate, end: input.endDate ?? input.startDate }
        : undefined,
    );
    if (input.listId && !this.db.get('SELECT 1 FROM lists WHERE id = ?', [input.listId]))
      throw appError('VALIDATION', 'That list no longer exists.', {
        fieldErrors: { listId: 'Choose another list.' },
      });
    const now = this.ctx.clock.now().toISOString();
    if (input.id) {
      const r = this.db.run(
        `UPDATE goals SET title = ?, media_type = ?, metric = ?, period = ?, start_date = ?, end_date = ?, target = ?, list_id = ?, tag = ? WHERE id = ?`,
        [
          input.title,
          input.mediaType,
          input.metric,
          input.period,
          range.start,
          range.end,
          input.target,
          input.listId,
          input.tag,
          input.id,
        ],
      );
      if (r.changes === 0) throw appError('NOT_FOUND', 'That goal no longer exists.');
    } else {
      this.db.run(
        `INSERT INTO goals (id, title, media_type, metric, period, start_date, end_date, target, list_id, tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.title,
          input.mediaType,
          input.metric,
          input.period,
          range.start,
          range.end,
          input.target,
          input.listId,
          input.tag,
          now,
        ],
      );
    }
    return this.list(true);
  }

  setArchived(id: string, archived: boolean): GoalView[] {
    const r = this.db.run('UPDATE goals SET archived_at = ? WHERE id = ?', [
      archived ? this.ctx.clock.now().toISOString() : null,
      id,
    ]);
    if (r.changes === 0) throw appError('NOT_FOUND', 'That goal no longer exists.');
    return this.list(true);
  }

  remove(id: string): GoalView[] {
    this.db.run('DELETE FROM goals WHERE id = ?', [id]);
    return this.list(true);
  }
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
