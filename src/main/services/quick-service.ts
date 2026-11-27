/**
 * Simple Mode one-tap actions (§13.4) with Undo, and the global omnibox.
 *
 * Undo uses inverse operations through the normal services (so runs, Up
 * Next, FTS and history stay consistent) plus an exact restore of the
 * status dates captured before the action. Undo tokens live in memory for
 * 10 minutes; they are not a data store.
 */
import { randomUUID } from 'node:crypto';
import type { MediaType, Status } from '../../shared/enums';
import { DEFAULT_LIBRARY_QUERY } from '../../shared/schemas';
import { appError } from '../../shared/result';
import type { ItemSummary, StatusSuggestion } from '../../shared/types';
import * as items from '../../db/repositories/items-repo';
import type { ServiceContext } from './context';
import type { LibraryService } from './library-service';
import type { ProgressService } from './progress-service';

export const QUICK_ACTIONS = [
  'watched',
  'nextEpisode',
  'pages10',
  'setPage',
  'setPercent',
  'start',
  'done',
  'hold',
] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];

interface UndoRecord {
  itemId: string;
  at: number;
  prev: { status: Status; date_started: string | null; date_completed: string | null };
  /** Episodes that became watched (to un-watch). */
  episodes: string[];
  /** Progress events created by the action (to remove). */
  events: string[];
}

const UNDO_TTL_MS = 10 * 60_000;

export interface QuickResult {
  item: ItemSummary;
  undoToken: string;
  message: string;
  suggestion: StatusSuggestion | null;
}

export class QuickService {
  private readonly undo = new Map<string, UndoRecord>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly library: LibraryService,
    private readonly progress: ProgressService,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  /** Which one-tap actions fit this item (type-aware). */
  static actionsFor(type: MediaType, status: Status): QuickAction[] {
    const base: QuickAction[] = [];
    if (type === 'movie') base.push('watched');
    if (type === 'tv' || type === 'anime') base.push('nextEpisode');
    if (type === 'book') base.push('pages10', 'setPage');
    if (type === 'game') base.push('setPercent');
    if (status !== 'in_progress') base.push('start');
    if (status !== 'completed') base.push('done');
    if (status === 'in_progress') base.push('hold');
    return base;
  }

  private snapshot(itemId: string) {
    const row = this.db.get<{ status: Status; date_started: string | null; date_completed: string | null }>(
      'SELECT status, date_started, date_completed FROM items WHERE id = ? AND deleted_at IS NULL',
      [itemId],
    );
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    const unwatched = new Set(
      this.db
        .all<{ id: string }>('SELECT id FROM episodes WHERE item_id = ? AND watched = 0', [itemId])
        .map((r) => r.id),
    );
    const events = new Set(
      this.db
        .all<{ id: string }>('SELECT id FROM progress_events WHERE item_id = ? AND deleted_at IS NULL', [
          itemId,
        ])
        .map((r) => r.id),
    );
    return { row, unwatched, events };
  }

  act(itemId: string, action: QuickAction, value: number | null): QuickResult {
    const before = this.snapshot(itemId);
    const detail = this.library.get(itemId);
    let suggestion: StatusSuggestion | null = null;
    let message = '';
    const setStatus = (status: Status, fill: boolean) =>
      this.library.setStatus({
        id: itemId,
        status,
        startNewPass: false,
        clearDateCompleted: status !== 'completed',
        fillRemaining: fill,
      });
    switch (action) {
      case 'watched': {
        if (detail.type !== 'movie')
          throw appError('VALIDATION', 'Only movies can be marked watched in one step.');
        setStatus('completed', true);
        message = `Marked ${detail.meta.title} as watched.`;
        break;
      }
      case 'nextEpisode': {
        const next = this.db.get<{ id: string; s: number; e: number }>(
          `SELECT e.id, se.season_number AS s, e.episode_number AS e FROM episodes e JOIN seasons se ON se.id = e.season_id
            WHERE e.item_id = ? AND e.watched = 0 AND e.skipped = 0 AND se.season_number > 0
            ORDER BY se.season_number, e.episode_number LIMIT 1`,
          [itemId],
        );
        if (!next)
          throw appError('VALIDATION', 'There is no next episode to mark. Add episodes on the item page.');
        const r = this.progress.toggleEpisodes({
          itemId,
          episodeIds: [next.id],
          watched: true,
          scope: 'episode',
        });
        suggestion = r.suggestions[0] ?? null;
        message = `Watched S${next.s}E${next.e}.`;
        break;
      }
      case 'pages10':
      case 'setPage': {
        if (detail.type !== 'book') throw appError('VALIDATION', 'Pages apply to books only.');
        const cur =
          this.db.get<{ v: number | null }>(
            "SELECT value AS v FROM progress_events WHERE item_id = ? AND kind = 'pages' AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1",
            [itemId],
          )?.v ?? 0;
        const total =
          this.db.get<{ n: number | null }>('SELECT page_count AS n FROM book_details WHERE item_id = ?', [
            itemId,
          ])?.n ?? null;
        let page = action === 'pages10' ? cur + 10 : Math.round(value ?? NaN);
        if (!Number.isFinite(page) || page < 0) throw appError('VALIDATION', 'Enter a page number.');
        if (total) page = Math.min(page, total);
        const r = this.progress.add({
          itemId,
          entry: { kind: 'pages', value: page },
          occurredAt: null,
          note: null,
        });
        suggestion = r.suggestions[0] ?? null;
        message = `Now on page ${page}${total ? ` of ${total}` : ''}.`;
        break;
      }
      case 'setPercent': {
        const pct = Math.round(value ?? NaN);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100)
          throw appError('VALIDATION', 'Enter a percentage from 0 to 100.');
        const r = this.progress.add({
          itemId,
          entry: { kind: 'percent', value: pct },
          occurredAt: null,
          note: null,
        });
        suggestion = r.suggestions[0] ?? null;
        message = `Progress set to ${pct}%.`;
        break;
      }
      case 'start':
        setStatus('in_progress', false);
        message = `Started ${detail.meta.title}.`;
        break;
      case 'done':
        setStatus('completed', true);
        message = `Finished ${detail.meta.title}.`;
        break;
      case 'hold':
        setStatus('on_hold', false);
        message = `Put ${detail.meta.title} on hold.`;
        break;
    }
    const after = this.snapshot(itemId);
    const token = randomUUID();
    this.prune();
    this.undo.set(token, {
      itemId,
      at: Date.now(),
      prev: before.row,
      episodes: [...before.unwatched].filter((id) => !after.unwatched.has(id)),
      events: [...after.events].filter((id) => !before.events.has(id)),
    });
    return { item: this.summary(itemId), undoToken: token, message, suggestion };
  }

  undoAction(token: string): ItemSummary {
    const u = this.undo.get(token);
    if (!u) throw appError('NOT_FOUND', 'This action can no longer be undone.');
    this.undo.delete(token);
    const db = this.db;
    if (u.episodes.length > 0)
      this.progress.toggleEpisodes({
        itemId: u.itemId,
        episodeIds: u.episodes,
        watched: false,
        scope: 'upTo',
      });
    for (const ev of u.events) {
      try {
        this.progress.remove(ev);
      } catch {
        /* already gone */
      }
    }
    // The un-watch above may itself have logged an event; drop it so history reads as if nothing happened.
    db.run(
      "UPDATE progress_events SET deleted_at = ? WHERE item_id = ? AND kind = 'season' AND recorded_at >= ? AND deleted_at IS NULL",
      [new Date().toISOString(), u.itemId, new Date(u.at).toISOString()],
    );
    const cur = db.get<{ status: Status }>('SELECT status FROM items WHERE id = ?', [u.itemId]);
    if (cur && cur.status !== u.prev.status)
      this.library.setStatus({
        id: u.itemId,
        status: u.prev.status,
        startNewPass: false,
        clearDateCompleted: true,
        fillRemaining: false,
      });
    db.run('UPDATE items SET date_started = ?, date_completed = ? WHERE id = ?', [
      u.prev.date_started,
      u.prev.date_completed,
      u.itemId,
    ]);
    items.recomputeProgress(db, u.itemId);
    return this.summary(u.itemId);
  }

  private summary(id: string): ItemSummary {
    const s = items.summariesWhere(this.db, 'i.id = ?', [id], '')[0];
    if (!s) throw appError('NOT_FOUND', 'That item no longer exists.');
    return s;
  }

  private prune(): void {
    const cutoff = Date.now() - UNDO_TTL_MS;
    for (const [k, v] of this.undo) if (v.at < cutoff) this.undo.delete(k);
  }

  /** Omnibox: library matches first (≤ 6), the caller adds "Add “X”". */
  search(text: string): ItemSummary[] {
    const t = text.trim();
    if (t.length === 0) return [];
    return this.library.query({
      ...DEFAULT_LIBRARY_QUERY,
      text: t,
      sort: 'updatedAt',
      direction: 'desc',
      limit: 6,
      offset: 0,
    }).items;
  }
}
