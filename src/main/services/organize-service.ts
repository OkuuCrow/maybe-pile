/**
 * §14.4 saved views · §14.5 item templates · §14.1 time-based goals · §14.2 cover wall.
 *
 * Views and templates are stored as JSON validated by strict schemas on every
 * read (a documented JSON exception, like settings). Views reference lists
 * and moods by stable id; deleted referents are flagged, never silently
 * dropped. Nothing in a view or template is ever evaluated.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { appError } from '../../shared/result';
import { tagKey } from '../../domain/normalize';
import { DEFAULT_LIBRARY_QUERY, LibraryQuerySchema, type LibraryQuery } from '../../shared/schemas';
import {
  ItemTemplateBodySchema,
  type ItemTemplateBody,
  type SavedViewSaveSchema,
  type TimeGoalSaveSchema,
} from '../../shared/pack21-schemas';
import type { MediaType } from '../../shared/enums';
import * as items from '../../db/repositories/items-repo';
import { elapsedSeconds } from '../../domain/sessions';
import { addDays, localDateString, weekdayOf } from '../../notifications/engine/time';
import type { ItemSummary } from '../../shared/types';
import type { ServiceContext } from './context';

export interface SavedViewView {
  id: string;
  name: string;
  query: LibraryQuery;
  viewMode: 'grid' | 'list' | 'wall';
  position: number;
  pinned: boolean;
  /** Problems found when validating the stored view (e.g. a deleted list). */
  notices: string[];
}

export interface TemplateView {
  id: string;
  name: string;
  body: ItemTemplateBody;
  position: number;
}

export interface TimeGoalView {
  id: string;
  title: string;
  targetMinutes: number;
  period: 'day' | 'week';
  mediaType: MediaType | null;
  listId: string | null;
  moodId: string | null;
  archived: boolean;
  minutes: number;
  /** Plain pace label: on track / a bit behind / ahead / done. */
  pace: 'done' | 'ahead' | 'on-track' | 'a-bit-behind';
  paceLabel: string;
  /** Last 7 periods (oldest first). */
  history: { label: string; minutes: number }[];
}

export const STARTER_VIEWS: { name: string; query: Partial<LibraryQuery>; viewMode: 'grid' | 'list' }[] = [
  {
    name: 'In progress',
    query: { statuses: ['in_progress'], sort: 'updatedAt', direction: 'desc' },
    viewMode: 'grid',
  },
  {
    name: 'Short movies to watch',
    query: { types: ['movie'], statuses: ['planned'], sort: 'dateAdded', direction: 'desc' },
    viewMode: 'grid',
  },
  {
    name: 'Games on hold',
    query: { types: ['game'], statuses: ['on_hold'], sort: 'updatedAt', direction: 'desc' },
    viewMode: 'list',
  },
  {
    name: 'Top rated',
    query: { statuses: ['completed'], ratingMin: 8, sort: 'rating', direction: 'desc' },
    viewMode: 'grid',
  },
  { name: 'Recently added', query: { sort: 'dateAdded', direction: 'desc' }, viewMode: 'grid' },
];

export const STARTER_TEMPLATES: { name: string; body: ItemTemplateBody }[] = [
  {
    name: 'Board game night',
    body: {
      version: 1,
      type: 'game',
      status: 'planned',
      tags: ['board game'],
      moodIds: [],
      customFields: [
        { name: 'Players', type: 'text', defaultValue: '2–4', options: [] },
        { name: 'Play time (minutes)', type: 'number', defaultValue: 60, options: [] },
      ],
      checklist: [],
      listId: null,
      platform: 'Tabletop',
    },
  },
  {
    name: 'Book club pick',
    body: {
      version: 1,
      type: 'book',
      status: 'planned',
      tags: ['book club'],
      moodIds: [],
      customFields: [{ name: 'Meeting date', type: 'date', defaultValue: null, options: [] }],
      checklist: ['Finish the book', 'Write down two questions'],
      listId: null,
      platform: null,
    },
  },
  {
    name: 'Weekend binge',
    body: {
      version: 1,
      type: 'tv',
      status: 'planned',
      tags: ['weekend'],
      moodIds: [],
      customFields: [],
      checklist: [],
      listId: null,
      platform: null,
    },
  },
];

export class OrganizeService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db();
  }
  private nowIso() {
    return this.ctx.clock.now().toISOString();
  }

  /* ---------------------------------------------------------------- saved views */

  private validateView(raw: string): { query: LibraryQuery; notices: string[] } {
    const notices: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        query: DEFAULT_LIBRARY_QUERY,
        notices: ['This view could not be read and shows everything instead.'],
      };
    }
    const r = LibraryQuerySchema.safeParse(parsed);
    if (!r.success)
      return {
        query: DEFAULT_LIBRARY_QUERY,
        notices: ['This view uses filters this version does not understand.'],
      };
    const q = r.data;
    if (q.listId && !this.db.get('SELECT 1 AS x FROM lists WHERE id = ?', [q.listId]))
      notices.push('The list this view filtered by was deleted.');
    return { query: q, notices };
  }

  views(): SavedViewView[] {
    return this.db
      .all<{
        id: string;
        name: string;
        query: string;
        view_mode: 'grid' | 'list' | 'wall';
        position: number;
        pinned: number;
      }>('SELECT id, name, query, view_mode, position, pinned FROM saved_views ORDER BY position')
      .map((r) => {
        const v = this.validateView(r.query);
        return {
          id: r.id,
          name: r.name,
          query: v.query,
          viewMode: r.view_mode,
          position: r.position,
          pinned: r.pinned === 1,
          notices: v.notices,
        };
      });
  }

  saveView(input: z.output<typeof SavedViewSaveSchema>): SavedViewView[] {
    const key = tagKey(input.name);
    const clash = this.db.get<{ id: string }>('SELECT id FROM saved_views WHERE name_key = ?', [key]);
    if (clash && clash.id !== input.id)
      throw appError('VALIDATION', 'A view with that name already exists.', {
        fieldErrors: { name: 'Choose another name.' },
      });
    const q = JSON.stringify({ ...input.query, offset: 0, limit: 200 });
    const now = this.nowIso();
    if (input.id) {
      if (
        this.db.run(
          'UPDATE saved_views SET name = ?, name_key = ?, query = ?, view_mode = ?, pinned = ?, updated_at = ? WHERE id = ?',
          [input.name, key, q, input.viewMode, input.pinned ? 1 : 0, now, input.id],
        ).changes === 0
      )
        throw appError('NOT_FOUND', 'That view no longer exists.');
    } else {
      const n = this.db.get<{ n: number }>('SELECT count(*) AS n FROM saved_views')?.n ?? 0;
      if (n >= 200) throw appError('VALIDATION', 'You can save up to 200 views.');
      this.db.run(
        'INSERT INTO saved_views (id, name, name_key, query, view_mode, position, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [randomUUID(), input.name, key, q, input.viewMode, n, input.pinned ? 1 : 0, now, now],
      );
    }
    return this.views();
  }

  duplicateView(id: string): SavedViewView[] {
    const v = this.views().find((x) => x.id === id);
    if (!v) throw appError('NOT_FOUND', 'That view no longer exists.');
    let name = `${v.name} (copy)`;
    for (let i = 2; this.db.get('SELECT 1 AS x FROM saved_views WHERE name_key = ?', [tagKey(name)]); i++)
      name = `${v.name} (copy ${i})`;
    return this.saveView({
      id: null,
      name: name.slice(0, 80),
      query: v.query,
      viewMode: v.viewMode,
      pinned: false,
    });
  }

  deleteView(id: string): SavedViewView[] {
    this.db.transaction(() => {
      this.db.run('DELETE FROM saved_views WHERE id = ?', [id]);
      this.db
        .all<{ id: string }>('SELECT id FROM saved_views ORDER BY position')
        .forEach((r, i) => this.db.run('UPDATE saved_views SET position = ? WHERE id = ?', [i, r.id]));
    });
    return this.views();
  }

  moveView(id: string, direction: 'up' | 'down'): SavedViewView[] {
    const list = this.views();
    const i = list.findIndex((v) => v.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    const a = list[i];
    const b = list[j];
    if (!a || !b) return list;
    this.db.transaction(() => {
      this.db.run('UPDATE saved_views SET position = ? WHERE id = ?', [j, a.id]);
      this.db.run('UPDATE saved_views SET position = ? WHERE id = ?', [i, b.id]);
    });
    return this.views();
  }

  /* ---------------------------------------------------------------- templates */

  templates(): TemplateView[] {
    const out: TemplateView[] = [];
    for (const r of this.db.all<{ id: string; name: string; body: string; position: number }>(
      'SELECT id, name, body, position FROM item_templates ORDER BY position',
    )) {
      try {
        const b = ItemTemplateBodySchema.safeParse(JSON.parse(r.body));
        if (b.success) out.push({ id: r.id, name: r.name, body: b.data, position: r.position });
      } catch {
        /* invalid stored template: hidden; never evaluated */
      }
    }
    return out;
  }

  saveTemplate(id: string | null, name: string, body: ItemTemplateBody): TemplateView[] {
    const key = tagKey(name);
    const clash = this.db.get<{ id: string }>('SELECT id FROM item_templates WHERE name_key = ?', [key]);
    if (clash && clash.id !== id)
      throw appError('VALIDATION', 'A template with that name already exists.', {
        fieldErrors: { name: 'Choose another name.' },
      });
    const now = this.nowIso();
    const json = JSON.stringify(ItemTemplateBodySchema.parse(body));
    if (id) {
      if (
        this.db.run(
          'UPDATE item_templates SET name = ?, name_key = ?, body = ?, updated_at = ? WHERE id = ?',
          [name, key, json, now, id],
        ).changes === 0
      )
        throw appError('NOT_FOUND', 'That template no longer exists.');
    } else {
      const n = this.db.get<{ n: number }>('SELECT count(*) AS n FROM item_templates')?.n ?? 0;
      if (n >= 100) throw appError('VALIDATION', 'You can save up to 100 templates.');
      this.db.run(
        'INSERT INTO item_templates (id, name, name_key, body, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [randomUUID(), name, key, json, n, now, now],
      );
    }
    return this.templates();
  }

  duplicateTemplate(id: string): TemplateView[] {
    const t = this.templates().find((x) => x.id === id);
    if (!t) throw appError('NOT_FOUND', 'That template no longer exists.');
    let name = `${t.name} (copy)`;
    for (let i = 2; this.db.get('SELECT 1 AS x FROM item_templates WHERE name_key = ?', [tagKey(name)]); i++)
      name = `${t.name} (copy ${i})`;
    return this.saveTemplate(null, name.slice(0, 80), t.body);
  }

  /** Deleting a template never touches items created from it. */
  deleteTemplate(id: string): TemplateView[] {
    this.db.run('DELETE FROM item_templates WHERE id = ?', [id]);
    return this.templates();
  }

  /* ---------------------------------------------------------------- time goals */

  timeGoals(includeArchived = false): TimeGoalView[] {
    const now = this.ctx.clock.now();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const today = localDateString(now, tz);
    const rows = this.db.all<{
      id: string;
      title: string;
      target_minutes: number;
      period: 'day' | 'week';
      media_type: MediaType | null;
      list_id: string | null;
      mood_id: string | null;
      archived_at: string | null;
    }>(
      `SELECT * FROM time_goals ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY archived_at IS NOT NULL, created_at`,
    );
    if (rows.length === 0) return [];
    const since = new Date(now.getTime() - 60 * 86_400_000).toISOString();
    const sessions = this.db.all<{
      item_id: string;
      type: MediaType;
      kind: string;
      state: 'running' | 'paused' | 'done';
      started_at: string;
      ended_at: string | null;
      duration_seconds: number | null;
      accumulated_seconds: number;
      segment_started_at: string | null;
    }>(
      `SELECT s.item_id, i.type, s.kind, s.state, s.started_at, s.ended_at, s.duration_seconds, s.accumulated_seconds, s.segment_started_at
         FROM sessions s JOIN items i ON i.id = s.item_id WHERE i.deleted_at IS NULL AND s.started_at >= ?`,
      [since],
    );
    const inList = new Map<string, Set<string>>();
    const inMood = new Map<string, Set<string>>();
    const memberSet = (map: Map<string, Set<string>>, sql: string, id: string) => {
      let set = map.get(id);
      if (!set) {
        set = new Set(this.db.all<{ item_id: string }>(sql, [id]).map((r) => r.item_id));
        map.set(id, set);
      }
      return set;
    };
    /**
     * Minutes per local day for a goal. A session spanning midnight is split at local midnight so each day
     * gets its own share (sessions only store start/end + duration; time is spread evenly between them).
     */
    const minutesByDay = (g: (typeof rows)[number]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const s of sessions) {
        if (g.media_type && s.type !== g.media_type) continue;
        if (
          g.list_id &&
          !memberSet(inList, 'SELECT item_id FROM list_items WHERE list_id = ?', g.list_id).has(s.item_id)
        )
          continue;
        if (
          g.mood_id &&
          !memberSet(inMood, 'SELECT item_id FROM item_moods WHERE mood_id = ?', g.mood_id).has(s.item_id)
        )
          continue;
        const secs =
          s.state === 'done'
            ? (s.duration_seconds ?? 0)
            : elapsedSeconds(
                {
                  state: s.state,
                  accumulatedSeconds: s.accumulated_seconds,
                  segmentStartedAt: s.segment_started_at,
                },
                now.getTime(),
              );
        const start = Date.parse(s.started_at);
        const end = s.ended_at ? Date.parse(s.ended_at) : now.getTime();
        splitAcrossDays(start, Math.max(start, end), secs, tz, (day, sec) =>
          m.set(day, (m.get(day) ?? 0) + sec / 60),
        );
      }
      return m;
    };
    return rows.map((g) => {
      const byDay = minutesByDay(g);
      const periodStart = (d: string) => (g.period === 'day' ? d : addDays(d, -weekdayOf(d)));
      const sumPeriod = (start: string) => {
        let t = 0;
        const days = g.period === 'day' ? 1 : 7;
        for (let i = 0; i < days; i++) t += byDay.get(addDays(start, i)) ?? 0;
        return Math.floor(t);
      };
      const cur = periodStart(today);
      const minutes = sumPeriod(cur);
      const elapsedFraction = g.period === 'day' ? 1 : (weekdayOf(today) + 1) / 7;
      const expected = g.target_minutes * elapsedFraction;
      const pace: TimeGoalView['pace'] =
        minutes >= g.target_minutes
          ? 'done'
          : minutes >= expected * 1.15
            ? 'ahead'
            : minutes >= expected * 0.85
              ? 'on-track'
              : 'a-bit-behind';
      const history = Array.from({ length: 7 }, (_, i) => {
        const start = g.period === 'day' ? addDays(cur, i - 6) : addDays(cur, (i - 6) * 7);
        return { label: start, minutes: sumPeriod(start) };
      });
      return {
        id: g.id,
        title: g.title,
        targetMinutes: g.target_minutes,
        period: g.period,
        mediaType: g.media_type,
        listId: g.list_id,
        moodId: g.mood_id,
        archived: g.archived_at !== null,
        minutes,
        pace,
        paceLabel: {
          done: 'Done for this period',
          ahead: 'Ahead',
          'on-track': 'On track',
          'a-bit-behind': 'A bit behind',
        }[pace],
        history,
      };
    });
  }

  saveTimeGoal(input: z.output<typeof TimeGoalSaveSchema>): TimeGoalView[] {
    const now = this.nowIso();
    if (input.listId && !this.db.get('SELECT 1 AS x FROM lists WHERE id = ?', [input.listId]))
      throw appError('NOT_FOUND', 'That list no longer exists.');
    if (input.moodId && !this.db.get('SELECT 1 AS x FROM moods WHERE id = ?', [input.moodId]))
      throw appError('NOT_FOUND', 'That mood no longer exists.');
    const params = [
      input.title,
      input.targetMinutes,
      input.period,
      input.mediaType,
      input.listId,
      input.moodId,
      now,
    ];
    if (input.id) {
      if (
        this.db.run(
          'UPDATE time_goals SET title = ?, target_minutes = ?, period = ?, media_type = ?, list_id = ?, mood_id = ?, updated_at = ? WHERE id = ?',
          [...params, input.id],
        ).changes === 0
      )
        throw appError('NOT_FOUND', 'That goal no longer exists.');
    } else
      this.db.run(
        'INSERT INTO time_goals (title, target_minutes, period, media_type, list_id, mood_id, updated_at, id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [...params, randomUUID(), now],
      );
    return this.timeGoals(true);
  }

  archiveTimeGoal(id: string, archived: boolean): TimeGoalView[] {
    this.db.run('UPDATE time_goals SET archived_at = ? WHERE id = ?', [archived ? this.nowIso() : null, id]);
    return this.timeGoals(true);
  }

  deleteTimeGoal(id: string): TimeGoalView[] {
    this.db.run('DELETE FROM time_goals WHERE id = ?', [id]);
    return this.timeGoals(true);
  }

  /* ---------------------------------------------------------------- cover wall */

  wall(opts: {
    year: number | null;
    type: MediaType | null;
    sort: 'completed' | 'rating' | 'title';
  }): (ItemSummary & { dateCompleted: string | null })[] {
    const where: string[] = ["i.status = 'completed'"];
    const params: (string | number)[] = [];
    if (opts.year) {
      where.push('substr(i.date_completed, 1, 4) = ?');
      params.push(String(opts.year));
    }
    if (opts.type) {
      where.push('i.type = ?');
      params.push(opts.type);
    }
    const order =
      opts.sort === 'rating'
        ? 'ORDER BY i.rating IS NULL, i.rating DESC, i.sort_title'
        : opts.sort === 'title'
          ? 'ORDER BY i.sort_title'
          : 'ORDER BY i.date_completed IS NULL, i.date_completed DESC, i.sort_title';
    const ids = this.db.all<{ id: string; date_completed: string | null }>(
      `SELECT i.id, i.date_completed FROM items i WHERE i.deleted_at IS NULL AND ${where.join(' AND ')} ${order} LIMIT 20000`,
      params,
    );
    if (ids.length === 0) return [];
    const byId = new Map(ids.map((r) => [r.id, r.date_completed]));
    const summaries = new Map<string, ItemSummary>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500).map((r) => r.id);
      for (const s of items.summariesWhere(this.db, `i.id IN (${chunk.map(() => '?').join(',')})`, chunk, ''))
        summaries.set(s.id, s);
    }
    return ids
      .map((r) => summaries.get(r.id))
      .filter((s): s is ItemSummary => !!s)
      .map((s) => ({ ...s, dateCompleted: byId.get(s.id) ?? null }));
  }

  wallYears(): number[] {
    return this.db
      .all<{ y: string }>(
        "SELECT DISTINCT substr(date_completed, 1, 4) AS y FROM items WHERE deleted_at IS NULL AND status = 'completed' AND date_completed IS NOT NULL ORDER BY y DESC",
      )
      .map((r) => Number(r.y));
  }
}

/** Spreads `seconds` evenly over [start, end] and reports the share per local day. */
export function splitAcrossDays(
  start: number,
  end: number,
  seconds: number,
  tz: string,
  add: (day: string, seconds: number) => void,
): void {
  if (seconds <= 0) return;
  if (end - start < 1000) return add(localDateString(new Date(start), tz), seconds);
  const span = end - start;
  let cursor = start;
  for (let guard = 0; guard < 400 && cursor < end; guard++) {
    const day = localDateString(new Date(cursor), tz);
    // Next local midnight (search hour by hour from cursor; DST-safe because it re-reads the date).
    let next = cursor + 3_600_000;
    while (next < end && localDateString(new Date(next), tz) === day) next += 3_600_000;
    if (next >= end) next = end;
    else {
      // Refine to the minute.
      let lo = next - 3_600_000;
      while (next - lo > 60_000) {
        const mid = Math.floor((lo + next) / 2);
        if (localDateString(new Date(mid), tz) === day) lo = mid;
        else next = mid;
      }
    }
    add(day, (seconds * (next - cursor)) / span);
    cursor = next;
  }
}
