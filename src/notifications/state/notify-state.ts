/**
 * notify-state.sqlite — owned by the notification subsystem, shared by the
 * main app (all modes) and the headless helper. The library database is never
 * written by the helper; everything the helper must remember lives here.
 *
 * Exactly-once: before showing anything, a runner *claims* every dedupe key of
 * the notification in one IMMEDIATE transaction. If any key is already taken
 * (by resident mode, the scheduled helper, or an overlapping run) the whole
 * notification is abandoned. Failed deliveries are retried with backoff, at
 * most MAX_ATTEMPTS times, never in a loop.
 *
 * Contents are runtime state only: excluded from backups and exports by default.
 */
import { Db } from '../../db/connection';
import type { NotificationCategory } from '../../shared/notification-settings';
import type { PlannedNotification, RecordedSuppression, SnoozeScope, StateView } from '../engine/types';

export const STATE_SCHEMA_VERSION = 1;
export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000] as const;
export const DEFAULT_LIBRARY_ID = 'default';

export const OUTCOMES = [
  'claimed',
  'delivered',
  'coalesced',
  'failed',
  'unsupported',
  'quiet_dropped',
  'capped',
  'missed',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

const STATE_MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE notification_log (
  id INTEGER PRIMARY KEY,
  library_id TEXT NOT NULL,
  category TEXT NOT NULL,
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) <= 300),
  parent_key TEXT,
  item_id TEXT,
  kind TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single', 'digest', 'member', 'record')),
  planned_for TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  delivered_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN (${OUTCOMES.map((o) => `'${o}'`).join(', ')})),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  attempts INTEGER NOT NULL DEFAULT 1,
  next_retry_at TEXT,
  delivery_mode TEXT,
  adapter TEXT,
  clicked_at TEXT,
  action TEXT,
  UNIQUE (library_id, dedupe_key)
);
CREATE INDEX idx_nlog_delivered ON notification_log(library_id, outcome, delivered_at);
CREATE INDEX idx_nlog_item ON notification_log(library_id, category, item_id, delivered_at);
CREATE TABLE snoozes (
  library_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('item', 'category', 'reminder', 'global')),
  target TEXT NOT NULL,
  until TEXT NOT NULL,
  PRIMARY KEY (library_id, scope, target)
);
CREATE TABLE mutes (
  library_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('item', 'category', 'reminder')),
  target TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (library_id, scope, target)
);
CREATE TABLE helper_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];

export interface HistoryEntry {
  id: number;
  category: NotificationCategory;
  kind: 'single' | 'digest' | 'member' | 'record';
  itemId: string | null;
  plannedFor: string;
  at: string;
  outcome: Outcome;
  reason: string | null;
  deliveryMode: string | null;
  adapter: string | null;
  clickedAt: string | null;
}

export class NotifyState {
  private constructor(readonly db: Db) {}

  /** Opens (creating/migrating) the state DB. Throws on failure — callers degrade to "notifications off". */
  static open(file: string): NotifyState {
    const db = new Db(file);
    try {
      migrateState(db);
      return new NotifyState(db);
    } catch (e) {
      db.close();
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  /* ---------------------------------------------------------------- claims */

  private claimableRow(lib: string, key: string, nowIso: string): 'free' | 'retry' | 'taken' {
    const row = this.db.get<{ outcome: string; attempts: number; next_retry_at: string | null }>(
      'SELECT outcome, attempts, next_retry_at FROM notification_log WHERE library_id = ? AND dedupe_key = ?',
      [lib, key],
    );
    if (!row) return 'free';
    if (row.outcome === 'failed' && row.attempts < MAX_ATTEMPTS && (row.next_retry_at ?? '') <= nowIso)
      return 'retry';
    return 'taken';
  }

  isClaimed(lib: string, key: string, now: Date): boolean {
    return this.claimableRow(lib, key, now.toISOString()) === 'taken';
  }

  /**
   * Atomically claims every key of a planned notification. Returns false (and
   * claims nothing) if any key is already taken by another run.
   */
  claim(lib: string, n: PlannedNotification, meta: { mode: string; now: Date }): boolean {
    const nowIso = meta.now.toISOString();
    return this.db.transaction(() => {
      const states = n.memberKeys.map((k) => this.claimableRow(lib, k, nowIso));
      if (states.some((s) => s === 'taken')) return false;
      const memberMeta = new Map(n.members.map((m) => [m.key, m]));
      n.memberKeys.forEach((key, i) => {
        const isHead = key === n.key;
        const m = memberMeta.get(key);
        const kind = isHead ? n.kind : 'member';
        const outcome: Outcome = isHead ? 'claimed' : 'coalesced';
        if (states[i] === 'retry') {
          this.db.run(
            `UPDATE notification_log SET outcome = ?, kind = ?, parent_key = ?, claimed_at = ?, attempts = attempts + 1,
               next_retry_at = NULL, reason = NULL, delivery_mode = ? WHERE library_id = ? AND dedupe_key = ?`,
            [outcome, kind, isHead ? null : n.key, nowIso, meta.mode, lib, key],
          );
        } else {
          this.db.run(
            `INSERT INTO notification_log (library_id, category, dedupe_key, parent_key, item_id, kind, planned_for, claimed_at, outcome, delivery_mode)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              lib,
              m?.category ?? n.category,
              key,
              isHead ? null : n.key,
              isHead ? n.itemId : (m?.itemId ?? null),
              kind,
              isHead ? n.scheduledFor : (m?.scheduledFor ?? n.scheduledFor),
              nowIso,
              outcome,
              meta.mode,
            ],
          );
        }
      });
      return true;
    });
  }

  markDelivered(lib: string, key: string, adapter: string, now: Date): void {
    this.db.run(
      "UPDATE notification_log SET outcome = 'delivered', delivered_at = ?, adapter = ?, reason = NULL WHERE library_id = ? AND dedupe_key = ?",
      [now.toISOString(), adapter, lib, key],
    );
  }

  /** Records a failed delivery; members of a failed digest become retryable too. */
  markFailed(
    lib: string,
    key: string,
    reason: string,
    adapter: string,
    now: Date,
    unsupported = false,
  ): void {
    this.db.transaction(() => {
      const row = this.db.get<{ attempts: number }>(
        'SELECT attempts FROM notification_log WHERE library_id = ? AND dedupe_key = ?',
        [lib, key],
      );
      const attempts = row?.attempts ?? 1;
      const backoff =
        RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? RETRY_BACKOFF_MS[2];
      const next = new Date(now.getTime() + backoff).toISOString();
      const outcome: Outcome = unsupported ? 'unsupported' : 'failed';
      const safeReason = reason.replace(/[^\w .:,()'/-]/g, '').slice(0, 200);
      this.db.run(
        'UPDATE notification_log SET outcome = ?, reason = ?, adapter = ?, next_retry_at = ? WHERE library_id = ? AND dedupe_key = ?',
        [outcome, safeReason, adapter, next, lib, key],
      );
      this.db.run(
        "UPDATE notification_log SET outcome = ?, reason = ?, next_retry_at = ? WHERE library_id = ? AND parent_key = ? AND outcome = 'coalesced'",
        [outcome, 'part of a failed digest', next, lib, key],
      );
    });
  }

  markClicked(lib: string, key: string, action: string, now: Date): void {
    this.db.run(
      'UPDATE notification_log SET clicked_at = ?, action = ? WHERE library_id = ? AND dedupe_key = ?',
      [now.toISOString(), action.slice(0, 40), lib, key],
    );
  }

  /** Records suppressed candidates (quiet-dropped, capped, missed) once each, for the history view. */
  recordSuppressed(
    lib: string,
    recs: readonly RecordedSuppression[],
    meta: { mode: string; now: Date },
  ): number {
    if (recs.length === 0) return 0;
    const nowIso = meta.now.toISOString();
    return this.db.transaction(() => {
      let n = 0;
      for (const r of recs) {
        n += this.db.run(
          `INSERT INTO notification_log (library_id, category, dedupe_key, item_id, kind, planned_for, claimed_at, outcome, delivery_mode)
           VALUES (?, ?, ?, ?, 'record', ?, ?, ?, ?) ON CONFLICT(library_id, dedupe_key) DO NOTHING`,
          [lib, r.category, r.key, r.itemId, r.scheduledFor, nowIso, r.reason, meta.mode],
        ).changes;
      }
      return n;
    });
  }

  deliveredSince(
    lib: string,
    since: Date,
  ): { total: number; byCategory: Partial<Record<NotificationCategory, number>> } {
    const rows = this.db.all<{ category: NotificationCategory; n: number }>(
      `SELECT category, count(*) AS n FROM notification_log
        WHERE library_id = ? AND outcome = 'delivered' AND kind IN ('single', 'digest') AND delivered_at >= ?
        GROUP BY category`,
      [lib, since.toISOString()],
    );
    const byCategory: Partial<Record<NotificationCategory, number>> = {};
    let total = 0;
    for (const r of rows) {
      byCategory[r.category] = r.n;
      total += r.n;
    }
    return { total, byCategory };
  }

  /** Deliveries across all libraries since an instant (the global daily cap is per computer). */
  lastDeliveredFor(lib: string, category: NotificationCategory, itemId: string): Date | null {
    const r = this.db.get<{ at: string | null }>(
      `SELECT max(delivered_at) AS at FROM notification_log
        WHERE library_id = ? AND category = ? AND item_id = ? AND outcome = 'delivered'`,
      [lib, category, itemId],
    );
    return r?.at ? new Date(r.at) : null;
  }

  /* ---------------------------------------------------------------- snoozes / mutes */

  snooze(lib: string, scope: SnoozeScope, target: string, until: Date): void {
    this.db.run(
      `INSERT INTO snoozes (library_id, scope, target, until) VALUES (?, ?, ?, ?)
       ON CONFLICT(library_id, scope, target) DO UPDATE SET until = excluded.until`,
      [lib, scope, target, until.toISOString()],
    );
  }

  unsnooze(lib: string, scope: SnoozeScope, target: string): void {
    this.db.run('DELETE FROM snoozes WHERE library_id = ? AND scope = ? AND target = ?', [
      lib,
      scope,
      target,
    ]);
  }

  snoozedUntil(lib: string, scope: SnoozeScope, target: string): Date | null {
    const r = this.db.get<{ until: string }>(
      'SELECT until FROM snoozes WHERE library_id = ? AND scope = ? AND target = ?',
      [lib, scope, target],
    );
    return r ? new Date(r.until) : null;
  }

  reminderSnoozes(lib: string): { target: string; until: Date }[] {
    return this.db
      .all<{ target: string; until: string }>(
        "SELECT target, until FROM snoozes WHERE library_id = ? AND scope = 'reminder'",
        [lib],
      )
      .map((r) => ({ target: r.target, until: new Date(r.until) }));
  }

  mute(lib: string, scope: 'item' | 'category' | 'reminder', target: string, now: Date): void {
    this.db.run('INSERT OR IGNORE INTO mutes (library_id, scope, target, created_at) VALUES (?, ?, ?, ?)', [
      lib,
      scope,
      target,
      now.toISOString(),
    ]);
  }

  unmute(lib: string, scope: 'item' | 'category' | 'reminder', target: string): void {
    this.db.run('DELETE FROM mutes WHERE library_id = ? AND scope = ? AND target = ?', [lib, scope, target]);
  }

  isMuted(lib: string, scope: 'item' | 'category' | 'reminder', target: string): boolean {
    return !!this.db.get('SELECT 1 AS x FROM mutes WHERE library_id = ? AND scope = ? AND target = ?', [
      lib,
      scope,
      target,
    ]);
  }

  mutes(lib: string): { scope: string; target: string; createdAt: string }[] {
    return this.db
      .all<{ scope: string; target: string; created_at: string }>(
        'SELECT scope, target, created_at FROM mutes WHERE library_id = ? ORDER BY created_at DESC',
        [lib],
      )
      .map((r) => ({ scope: r.scope, target: r.target, createdAt: r.created_at }));
  }

  /* ---------------------------------------------------------------- lease (no overlapping checks) */

  acquireLease(holder: string, ttlMs: number, now: Date): boolean {
    const nowIso = now.toISOString();
    const exp = new Date(now.getTime() + ttlMs).toISOString();
    return this.db.transaction(() => {
      const row = this.db.get<{ holder: string; expires_at: string }>(
        'SELECT holder, expires_at FROM helper_lease WHERE id = 1',
      );
      if (row && row.expires_at > nowIso && row.holder !== holder) return false;
      this.db.run(
        'INSERT INTO helper_lease (id, holder, expires_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at',
        [holder, exp],
      );
      return true;
    });
  }

  releaseLease(holder: string): void {
    this.db.run('DELETE FROM helper_lease WHERE id = 1 AND holder = ?', [holder]);
  }

  /* ---------------------------------------------------------------- meta + history */

  getMeta(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  history(lib: string, sinceDays: number, now: Date, limit = 500): HistoryEntry[] {
    const since = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
    return this.db
      .all<{
        id: number;
        category: NotificationCategory;
        kind: HistoryEntry['kind'];
        item_id: string | null;
        planned_for: string;
        claimed_at: string;
        delivered_at: string | null;
        outcome: Outcome;
        reason: string | null;
        delivery_mode: string | null;
        adapter: string | null;
        clicked_at: string | null;
      }>(
        `SELECT id, category, kind, item_id, planned_for, claimed_at, delivered_at, outcome, reason, delivery_mode, adapter, clicked_at
           FROM notification_log WHERE library_id = ? AND kind != 'member' AND claimed_at >= ?
          ORDER BY claimed_at DESC, id DESC LIMIT ?`,
        [lib, since, Math.max(1, Math.min(2000, limit))],
      )
      .map((r) => ({
        id: r.id,
        category: r.category,
        kind: r.kind,
        itemId: r.item_id,
        plannedFor: r.planned_for,
        at: r.delivered_at ?? r.claimed_at,
        outcome: r.outcome,
        reason: r.reason,
        deliveryMode: r.delivery_mode,
        adapter: r.adapter,
        clickedAt: r.clicked_at,
      }));
  }

  clearHistory(lib: string, now: Date): number {
    // Keys still inside their relevance window (≤ 2 days) stay claimed so clearing history never re-sends them.
    return this.db.run('DELETE FROM notification_log WHERE library_id = ? AND claimed_at < ?', [
      lib,
      new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    ]).changes;
  }

  /** Retention: drops log rows older than `days` and expired snoozes. */
  prune(now: Date, days: number): number {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return this.db.transaction(() => {
      const n = this.db.run('DELETE FROM notification_log WHERE claimed_at < ?', [cutoff]).changes;
      this.db.run('DELETE FROM snoozes WHERE until < ?', [
        new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      ]);
      return n;
    });
  }

  /** A StateView bound to one library and instant, for the pure engine. */
  view(lib: string, now: Date): StateView {
    return {
      isClaimed: (k) => this.isClaimed(lib, k, now),
      lastDeliveredFor: (c, id) => this.lastDeliveredFor(lib, c, id),
      deliveredSince: (s) => this.deliveredSince(lib, s),
      snoozedUntil: (scope, target) => this.snoozedUntil(scope === 'global' ? '*' : lib, scope, target),
      isMuted: (scope, target) => this.isMuted(lib, scope, target),
      reminderSnoozes: () => this.reminderSnoozes(lib),
    };
  }

  /** Global pause (all libraries, all modes): stored as a 'global' snooze under library '*'. */
  pause(until: Date): void {
    this.snooze('*', 'global', '*', until);
  }
  resume(): void {
    this.unsnooze('*', 'global', '*');
  }
  pausedUntil(now: Date): Date | null {
    const u = this.snoozedUntil('*', 'global', '*');
    return u && u.getTime() > now.getTime() ? u : null;
  }
}

/** Mini migration runner for the state DB (own version table; independent of the library schema). */
export function migrateState(db: Db): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS state_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const cur = db.get<{ v: number | null }>('SELECT max(version) AS v FROM state_migrations')?.v ?? 0;
  if (cur > STATE_SCHEMA_VERSION)
    throw new Error(`notify-state schema v${cur} is newer than supported v${STATE_SCHEMA_VERSION}`);
  for (const m of STATE_MIGRATIONS) {
    if (m.version <= cur) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.run('INSERT INTO state_migrations (version, applied_at) VALUES (?, ?)', [
        m.version,
        new Date().toISOString(),
      ]);
    });
  }
  return STATE_SCHEMA_VERSION;
}
