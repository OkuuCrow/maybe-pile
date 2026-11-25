/**
 * Play/watch/read sessions with a timer that survives restarts (state is in
 * the DB, see src/domain/sessions.ts). At most one timer runs at a time:
 * starting another pauses the running one.
 *
 * Hours rule: when an item's hours source is 'sessions', finishing a session
 * records the new session total as an 'hours' progress entry (so goals and
 * stats see it). With 'manual' or 'steam', sessions are a log only and never
 * change the hours the user typed or Steam reported.
 */
import type { SessionView } from '../../shared/types';
import { appError } from '../../shared/result';
import { sessionKindFor, type MediaType } from '../../shared/enums';
import { readSettings } from '../../db/repositories/config-repo';
import { newId } from '../../db/repositories/items-repo';
import * as prog from '../../db/repositories/progress-repo';
import * as items from '../../db/repositories/items-repo';
import { elapsedSeconds, hoursFromSeconds, needsReview, MAX_SESSION_SECONDS } from '../../domain/sessions';
import type { ServiceContext } from './context';

interface Row {
  id: string;
  item_id: string;
  title: string;
  kind: 'play' | 'watch' | 'read';
  state: 'running' | 'paused' | 'done';
  source: 'timer' | 'manual';
  started_at: string;
  ended_at: string | null;
  accumulated_seconds: number;
  segment_started_at: string | null;
  duration_seconds: number | null;
  note: string | null;
}

const SELECT = `SELECT s.*, i.title FROM sessions s JOIN items i ON i.id = s.item_id`;

export class SessionsService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db();
  }

  private nowMs(): number {
    return this.ctx.clock.now().getTime();
  }

  private view(r: Row): SessionView {
    const seconds =
      r.state === 'done'
        ? (r.duration_seconds ?? 0)
        : elapsedSeconds(
            {
              state: r.state,
              accumulatedSeconds: r.accumulated_seconds,
              segmentStartedAt: r.segment_started_at,
            },
            this.nowMs(),
          );
    const max = readSettings(this.db).settings.sessions.maxSessionHours;
    return {
      id: r.id,
      itemId: r.item_id,
      itemTitle: r.title,
      kind: r.kind,
      state: r.state,
      source: r.source,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      seconds,
      note: r.note,
      needsReview: needsReview(seconds, max),
    };
  }

  private row(id: string): Row {
    const r = this.db.get<Row>(`${SELECT} WHERE s.id = ?`, [id]);
    if (!r) throw appError('NOT_FOUND', 'That session no longer exists.');
    return r;
  }

  /** Timers that are running or paused (shown in the header; restored after restart). */
  open(): SessionView[] {
    return this.db
      .all<Row>(`${SELECT} WHERE s.state <> 'done' ORDER BY s.started_at`)
      .map((r) => this.view(r));
  }

  forItem(itemId: string, limit = 100): SessionView[] {
    return this.db
      .all<Row>(`${SELECT} WHERE s.item_id = ? ORDER BY s.started_at DESC LIMIT ?`, [itemId, limit])
      .map((r) => this.view(r));
  }

  totalSeconds(itemId: string): number {
    return (
      this.db.get<{ t: number | null }>(
        "SELECT sum(duration_seconds) AS t FROM sessions WHERE item_id = ? AND state = 'done'",
        [itemId],
      )?.t ?? 0
    );
  }

  start(itemId: string): SessionView {
    const db = this.db;
    const item = db.get<{ type: MediaType; pass: number }>(
      'SELECT type, pass FROM items WHERE id = ? AND deleted_at IS NULL',
      [itemId],
    );
    if (!item) throw appError('NOT_FOUND', 'That item no longer exists.');
    const now = this.ctx.clock.now().toISOString();
    const id = newId();
    db.transaction(() => {
      // One timer at a time: pause whatever is running.
      for (const r of db.all<Row>(`${SELECT} WHERE s.state = 'running'`)) this.pauseRow(r, now);
      const run = db.get<{ id: string }>('SELECT id FROM item_runs WHERE item_id = ? AND run_number = ?', [
        itemId,
        item.pass,
      ]);
      db.run(
        `INSERT INTO sessions (id, item_id, run_id, kind, state, source, started_at, ended_at, accumulated_seconds,
                               segment_started_at, duration_seconds, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', 'timer', ?, NULL, 0, ?, NULL, NULL, ?, ?)`,
        [id, itemId, run?.id ?? null, sessionKindFor(item.type), now, now, now, now],
      );
    });
    this.ctx.log.info('session.start', { itemId });
    return this.view(this.row(id));
  }

  private pauseRow(r: Row, now: string): void {
    const secs = elapsedSeconds(
      { state: r.state, accumulatedSeconds: r.accumulated_seconds, segmentStartedAt: r.segment_started_at },
      Date.parse(now),
    );
    this.db.run(
      "UPDATE sessions SET state = 'paused', accumulated_seconds = ?, segment_started_at = NULL, updated_at = ? WHERE id = ?",
      [secs, now, r.id],
    );
  }

  pause(id: string): SessionView {
    const r = this.row(id);
    if (r.state !== 'running') throw appError('VALIDATION', 'That timer is not running.');
    this.pauseRow(r, this.ctx.clock.now().toISOString());
    return this.view(this.row(id));
  }

  resume(id: string): SessionView {
    const r = this.row(id);
    if (r.state !== 'paused') throw appError('VALIDATION', 'That timer is not paused.');
    const now = this.ctx.clock.now().toISOString();
    this.db.transaction(() => {
      for (const other of this.db.all<Row>(`${SELECT} WHERE s.state = 'running'`)) this.pauseRow(other, now);
      this.db.run(
        "UPDATE sessions SET state = 'running', segment_started_at = ?, updated_at = ? WHERE id = ?",
        [now, now, id],
      );
    });
    return this.view(this.row(id));
  }

  /** Stops a timer. `adjustedSeconds` lets the user correct a timer left running. */
  stop(id: string, adjustedSeconds: number | null, note: string | null): SessionView {
    const r = this.row(id);
    if (r.state === 'done') throw appError('VALIDATION', 'That session has already ended.');
    const now = this.ctx.clock.now().toISOString();
    const measured = elapsedSeconds(
      { state: r.state, accumulatedSeconds: r.accumulated_seconds, segmentStartedAt: r.segment_started_at },
      this.nowMs(),
    );
    const secs = Math.min(MAX_SESSION_SECONDS, Math.max(0, adjustedSeconds ?? measured));
    this.db.transaction(() => {
      this.db.run(
        `UPDATE sessions SET state = 'done', ended_at = ?, duration_seconds = ?, accumulated_seconds = ?,
                segment_started_at = NULL, note = COALESCE(?, note), updated_at = ? WHERE id = ?`,
        [now, secs, secs, note, now, id],
      );
      this.applyHours(r.item_id, now);
    });
    this.ctx.log.info('session.stop', { itemId: r.item_id, seconds: secs });
    return this.view(this.row(id));
  }

  /** Logs a past session by hand. */
  logManual(itemId: string, startedAt: string, seconds: number, note: string | null): SessionView {
    const db = this.db;
    const item = db.get<{ type: MediaType; pass: number }>(
      'SELECT type, pass FROM items WHERE id = ? AND deleted_at IS NULL',
      [itemId],
    );
    if (!item) throw appError('NOT_FOUND', 'That item no longer exists.');
    const start = Date.parse(startedAt);
    if (!Number.isFinite(start)) throw appError('VALIDATION', 'Enter a valid start time.');
    if (start > this.nowMs() + 60_000) throw appError('VALIDATION', "A session can't start in the future.");
    const now = this.ctx.clock.now().toISOString();
    const id = newId();
    const ended = new Date(start + seconds * 1000).toISOString();
    db.transaction(() => {
      const run = db.get<{ id: string }>('SELECT id FROM item_runs WHERE item_id = ? AND run_number = ?', [
        itemId,
        item.pass,
      ]);
      db.run(
        `INSERT INTO sessions (id, item_id, run_id, kind, state, source, started_at, ended_at, accumulated_seconds,
                               segment_started_at, duration_seconds, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'done', 'manual', ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [
          id,
          itemId,
          run?.id ?? null,
          sessionKindFor(item.type),
          new Date(start).toISOString(),
          ended,
          seconds,
          seconds,
          note,
          now,
          now,
        ],
      );
      this.applyHours(itemId, now);
    });
    return this.view(this.row(id));
  }

  edit(id: string, patch: { seconds?: number | undefined; note?: string | null | undefined }): SessionView {
    const r = this.row(id);
    if (r.state !== 'done') throw appError('VALIDATION', 'Stop the timer before editing it.');
    const now = this.ctx.clock.now().toISOString();
    this.db.transaction(() => {
      if (patch.seconds !== undefined)
        this.db.run(
          'UPDATE sessions SET duration_seconds = ?, accumulated_seconds = ?, updated_at = ? WHERE id = ?',
          [patch.seconds, patch.seconds, now, id],
        );
      if (patch.note !== undefined)
        this.db.run('UPDATE sessions SET note = ?, updated_at = ? WHERE id = ?', [patch.note, now, id]);
      this.applyHours(r.item_id, now);
    });
    return this.view(this.row(id));
  }

  remove(id: string): void {
    const r = this.row(id);
    const now = this.ctx.clock.now().toISOString();
    this.db.transaction(() => {
      this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
      this.applyHours(r.item_id, now);
    });
  }

  /** Records session hours as progress, only when the item's hours source is 'sessions'. */
  private applyHours(itemId: string, now: string): void {
    const db = this.db;
    const src = db.get<{ hours_source: string }>('SELECT hours_source FROM item_prefs WHERE item_id = ?', [
      itemId,
    ])?.hours_source;
    if (src !== 'sessions') return;
    const row = items.getItemRow(db, itemId);
    if (!row || row.type !== 'game') return;
    const hours = hoursFromSeconds(this.totalSeconds(itemId));
    const last = db.get<{ value: number | null }>(
      "SELECT value FROM progress_events WHERE item_id = ? AND kind = 'hours' AND deleted_at IS NULL AND pass = ? ORDER BY seq DESC LIMIT 1",
      [itemId, row.pass],
    );
    if (last?.value === hours) return;
    prog.insertProgressEvent(db, {
      itemId,
      kind: 'hours',
      value: hours,
      text: null,
      totalAtTime: null,
      milestoneId: null,
      milestoneTitle: null,
      episodeId: null,
      episodeLabel: null,
      watched: null,
      scheme: 'hours',
      pass: row.pass,
      occurredAt: now,
      recordedAt: now,
      note: 'From sessions',
    });
    items.recomputeProgress(db, itemId);
  }
}
