/**
 * Read-only library snapshot for the reminder engine. Only SELECT statements;
 * the headless helper passes a read-only connection, so any accidental write
 * fails with SQLITE_READONLY instead of touching the library.
 *
 * Soft-deleted items (Recently deleted) never appear here, so they never
 * trigger reminders.
 */
import type { Db } from '../db/connection';
import { readSettings } from '../db/repositories/config-repo';
import { shieldActive } from '../domain/spoilers';
import { staleness } from '../domain/pile-health';
import { elapsedSeconds } from '../domain/sessions';
import { episodeCode } from '../domain/progress';
import type { MediaType, SpoilerMode, Status } from '../shared/enums';
import type { AppSettings } from '../shared/schemas';
import { GoalsService } from '../main/services/goals-service';
import { PileHealthService } from '../main/services/pile-health-service';
import type { ServiceContext } from '../main/services/context';
import { MemoryLogger } from '../main/services/logger';
import { addDays, localDateString, startOfLocalDay, weekdayOf } from './engine/time';
import type { LibrarySnapshot, RepeatRule, SnapshotItem } from './engine/types';

interface BaseRow {
  id: string;
  title: string;
  type: MediaType;
  status: Status;
  is_adult: number | null;
  spoiler_mode: SpoilerMode | null;
}

const BASE_COLS = `i.id, i.title, i.type, i.status, ad.is_adult, ip.spoiler_mode`;
const BASE_JOINS = `LEFT JOIN anime_details ad ON ad.item_id = i.id LEFT JOIN item_prefs ip ON ip.item_id = i.id`;

export function weekdaysFromMask(mask: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < 7; d++) if (mask & (1 << d)) out.push(d);
  return out;
}
export function maskFromWeekdays(days: readonly number[]): number {
  return days.reduce((m, d) => m | (1 << d), 0);
}

export interface SnapshotOptions {
  now: Date;
  timeZone: string;
  libraryLabel?: string | null;
  settings?: AppSettings;
}

export function buildSnapshot(db: Db, opts: SnapshotOptions): LibrarySnapshot {
  const settings = opts.settings ?? readSettings(db).settings;
  const { now } = opts;
  const tz = opts.timeZone;
  const today = localDateString(now, tz);
  const base = (r: BaseRow): SnapshotItem => ({
    id: r.id,
    title: r.title,
    type: r.type,
    adult: r.is_adult === 1,
    shielded: shieldActive({
      mode: r.spoiler_mode ?? 'default',
      shieldByDefault: settings.spoilers.shieldByDefault,
      status: r.status,
    }),
  });

  /* in progress */
  const inProgressRows = db.all<
    BaseRow & { last: string | null; step: string | null; step_spoiler: number | null }
  >(
    `SELECT ${BASE_COLS},
       (SELECT max(x) FROM (
          SELECT max(COALESCE(p.occurred_at, p.recorded_at)) AS x FROM progress_events p WHERE p.item_id = i.id AND p.deleted_at IS NULL
          UNION ALL SELECT max(COALESCE(v.watched_at, v.created_at)) FROM viewing_events v WHERE v.item_id = i.id
          UNION ALL SELECT max(e.watched_at) FROM episodes e WHERE e.item_id = i.id AND e.watched = 1
          UNION ALL SELECT max(COALESCE(s.ended_at, s.updated_at)) FROM sessions s WHERE s.item_id = i.id
          UNION ALL SELECT i.date_started)) AS last,
       ns.text AS step, ns.spoiler AS step_spoiler
     FROM items i ${BASE_JOINS} LEFT JOIN item_next_steps ns ON ns.item_id = i.id
     WHERE i.deleted_at IS NULL AND i.status = 'in_progress'
     ORDER BY i.updated_at DESC LIMIT 200`,
  );
  const nextEp = (itemId: string): string | null => {
    const r = db.get<{ s: number; e: number }>(
      `SELECT se.season_number AS s, e.episode_number AS e FROM episodes e JOIN seasons se ON se.id = e.season_id
        WHERE e.item_id = ? AND e.watched = 0 AND e.skipped = 0 AND se.season_number > 0
        ORDER BY se.season_number, e.episode_number LIMIT 1`,
      [itemId],
    );
    return r ? episodeCode(r.s, r.e) : null;
  };
  const inProgress = inProgressRows.map((r) => ({
    ...base(r),
    lastActivityAt: r.last ? (r.last.length === 10 ? `${r.last}T00:00:00.000Z` : r.last) : null,
    nextEpisode: r.type === 'tv' || r.type === 'anime' ? nextEp(r.id) : null,
    nextStep: r.step,
    nextStepSpoiler: r.step_spoiler === 1,
  }));

  /* up next */
  const upNext = db
    .all<BaseRow>(
      `SELECT ${BASE_COLS} FROM up_next u JOIN items i ON i.id = u.item_id ${BASE_JOINS}
        WHERE i.deleted_at IS NULL ORDER BY u.position LIMIT 10`,
    )
    .map(base);

  /* releases (full dates only) */
  const statuses = settings.releaseRadar.includeOnHold ? `('planned', 'on_hold')` : `('planned')`;
  const releases = db
    .all<BaseRow & { release_date: string }>(
      `SELECT ${BASE_COLS}, i.release_date FROM items i ${BASE_JOINS}
        WHERE i.deleted_at IS NULL AND i.status IN ${statuses} AND length(i.release_date) = 10
          AND i.release_date BETWEEN ? AND ? LIMIT 500`,
      [addDays(today, -1), addDays(today, 32)],
    )
    .map((r) => ({ ...base(r), releaseDate: r.release_date }));

  const airing = db
    .all<BaseRow & { next_episode: number; next_airing_at: string }>(
      `SELECT ${BASE_COLS}, ad.next_episode, ad.next_airing_at FROM items i ${BASE_JOINS}
        WHERE i.deleted_at IS NULL AND i.status IN ('planned', 'in_progress') AND ad.next_airing_at IS NOT NULL
          AND ad.next_episode IS NOT NULL AND ad.next_airing_at BETWEEN ? AND ? LIMIT 200`,
      [
        new Date(now.getTime() - 2 * 86_400_000).toISOString(),
        new Date(now.getTime() + 86_400_000).toISOString(),
      ],
    )
    .map((r) => ({ ...base(r), episode: r.next_episode, airingAt: r.next_airing_at }));

  /* leaving soon (subscription entries) */
  const leaving = db
    .all<BaseRow & { entry_id: string; service: string | null; until: string }>(
      `SELECT ${BASE_COLS}, a.id AS entry_id, s.name AS service, a.available_until AS until
         FROM availability_entries a JOIN items i ON i.id = a.item_id LEFT JOIN services s ON s.id = a.service_id ${BASE_JOINS}
        WHERE i.deleted_at IS NULL AND a.kind = 'subscription' AND a.available_until BETWEEN ? AND ?
          AND i.status NOT IN ('completed', 'dropped') LIMIT 200`,
      [today, addDays(today, 100)],
    )
    .map((r) => ({ ...base(r), entryId: r.entry_id, serviceName: r.service, availableUntil: r.until }));

  /* goals + pile health reuse the read-only service queries */
  const roCtx: ServiceContext = {
    db: () => db,
    clock: { now: () => now },
    log: new MemoryLogger(),
    paths: { userData: '', artwork: '', backups: '', logs: '', database: db.file, secrets: '' },
    appVersion: 'snapshot',
  };
  const goals = new GoalsService(roCtx, tz)
    .list(false)
    .filter((g) => g.startDate <= today && g.endDate >= today)
    .map((g) => ({
      id: g.id,
      title: g.title,
      metric: g.metric,
      target: g.target,
      progress: g.progress,
      start: g.startDate,
      end: g.endDate,
    }));
  let staleCount = 0;
  if (settings.pileHealth.enabled) {
    for (const r of new PileHealthService(roCtx).rows())
      if (staleness(r, settings.pileHealth, today)) staleCount++;
  }

  /* time goals (minutes from sessions; running timers count live) */
  const weekStart = addDays(today, -weekdayOf(today));
  const sessionRows = db.all<{
    item_id: string;
    type: MediaType;
    state: 'running' | 'paused' | 'done';
    started_at: string;
    duration_seconds: number | null;
    accumulated_seconds: number;
    segment_started_at: string | null;
  }>(
    `SELECT s.item_id, i.type, s.state, s.started_at, s.duration_seconds, s.accumulated_seconds, s.segment_started_at
       FROM sessions s JOIN items i ON i.id = s.item_id
      WHERE i.deleted_at IS NULL AND (s.state != 'done' OR s.started_at >= ?)`,
    [new Date(now.getTime() - 9 * 86_400_000).toISOString()],
  );
  const timeGoalRows = db.all<{
    id: string;
    title: string;
    target_minutes: number;
    period: 'day' | 'week';
    media_type: MediaType | null;
    list_id: string | null;
    mood_id: string | null;
  }>(
    'SELECT id, title, target_minutes, period, media_type, list_id, mood_id FROM time_goals WHERE archived_at IS NULL',
  );
  const inScope = (goal: (typeof timeGoalRows)[number], itemId: string, type: MediaType) => {
    if (goal.media_type && goal.media_type !== type) return false;
    if (
      goal.list_id &&
      !db.get('SELECT 1 AS x FROM list_items WHERE list_id = ? AND item_id = ?', [goal.list_id, itemId])
    )
      return false;
    if (
      goal.mood_id &&
      !db.get('SELECT 1 AS x FROM item_moods WHERE mood_id = ? AND item_id = ?', [goal.mood_id, itemId])
    )
      return false;
    return true;
  };
  const timeGoals = timeGoalRows.map((goal) => {
    const from = goal.period === 'day' ? today : weekStart;
    let seconds = 0;
    for (const s of sessionRows) {
      if (localDateString(new Date(s.started_at), tz) < from) continue;
      if (!inScope(goal, s.item_id, s.type)) continue;
      seconds +=
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
    }
    return {
      id: goal.id,
      title: goal.title,
      targetMinutes: goal.target_minutes,
      minutesInPeriod: Math.floor(seconds / 60),
      period: goal.period,
    };
  });

  /* running sessions */
  const sessions = db
    .all<BaseRow & { sid: string; accumulated_seconds: number; segment_started_at: string | null }>(
      `SELECT ${BASE_COLS}, s.id AS sid, s.accumulated_seconds, s.segment_started_at
         FROM sessions s JOIN items i ON i.id = s.item_id ${BASE_JOINS}
        WHERE i.deleted_at IS NULL AND s.state = 'running'`,
    )
    .map((r) => ({
      ...base(r),
      sessionId: r.sid,
      elapsedSeconds: elapsedSeconds(
        {
          state: 'running',
          accumulatedSeconds: r.accumulated_seconds,
          segmentStartedAt: r.segment_started_at,
        },
        now.getTime(),
      ),
    }));

  /* week */
  const completedWeek =
    db.get<{ n: number }>(
      "SELECT count(*) AS n FROM items WHERE deleted_at IS NULL AND status = 'completed' AND date_completed >= ?",
      [weekStart],
    )?.n ?? 0;

  /* loans */
  const loans = db
    .all<
      BaseRow & {
        loan_id: string;
        direction: 'lent' | 'borrowed';
        name: string | null;
        forgotten: number | null;
        due_on: string;
      }
    >(
      `SELECT ${BASE_COLS}, l.id AS loan_id, l.direction, p.name, p.forgotten, l.due_on
         FROM loans l JOIN items i ON i.id = l.item_id LEFT JOIN people p ON p.id = l.person_id ${BASE_JOINS}
        WHERE i.deleted_at IS NULL AND l.returned_on IS NULL AND l.due_on IS NOT NULL AND l.due_on <= ?`,
      [addDays(today, 1)],
    )
    .map((r) => ({
      ...base(r),
      loanId: r.loan_id,
      direction: r.direction,
      person: r.forgotten === 1 || !r.name ? 'someone' : r.name,
      dueDate: r.due_on,
    }));

  /* custom reminders */
  const reminders = db
    .all<{
      id: string;
      item_id: string | null;
      message: string;
      kind: 'once' | 'repeat';
      anchor_at: string;
      anchor_date: string;
      local_time: string;
      repeat_freq: RepeatRule['freq'] | null;
      repeat_interval: number;
      repeat_weekdays: number;
    }>(
      `SELECT r.id, r.item_id, r.message, r.kind, r.anchor_at, r.anchor_date, r.local_time, r.repeat_freq, r.repeat_interval, r.repeat_weekdays
         FROM reminders r LEFT JOIN items i ON i.id = r.item_id
        WHERE r.enabled = 1 AND (r.item_id IS NULL OR i.deleted_at IS NULL)`,
    )
    .map((r) => {
      const itemRow = r.item_id
        ? db.get<BaseRow>(`SELECT ${BASE_COLS} FROM items i ${BASE_JOINS} WHERE i.id = ?`, [r.item_id])
        : undefined;
      return {
        id: r.id,
        itemId: r.item_id,
        item: itemRow ? base(itemRow) : null,
        message: r.message,
        kind: r.kind,
        anchorAt: r.anchor_at,
        anchorDate: r.anchor_date,
        localTime: r.local_time,
        rule: r.repeat_freq
          ? {
              freq: r.repeat_freq,
              interval: r.repeat_interval,
              weekdays: r.repeat_freq === 'weekdays' ? weekdaysFromMask(r.repeat_weekdays) : [],
            }
          : null,
      };
    });

  const event = (key: string) =>
    db.get<{ at: string; value: string | null }>('SELECT at, value FROM app_events WHERE key = ?', [key]);
  const backupDir = event('last_backup_dir_check');
  const queue = event('offline_queue_finished');
  const autoRuleChanges =
    db.get<{ n: number }>(
      "SELECT count(DISTINCT item_id) AS n FROM change_log WHERE source = 'rule' AND at >= ? AND undone_at IS NULL",
      [startOfLocalDay(now, tz).toISOString()],
    )?.n ?? 0;

  return {
    libraryLabel: opts.libraryLabel ?? null,
    inProgress,
    upNext,
    releases,
    airing,
    leaving,
    goals,
    timeGoals,
    stale: { count: staleCount, months: settings.pileHealth.plannedStaleMonths },
    lastBackupAt: event('last_backup')?.at ?? null,
    backupSameDrive: backupDir?.value === 'same-volume',
    lastCheckupAt: event('last_checkup')?.at ?? null,
    sessions,
    week: { completed: completedWeek, inProgress: inProgress.length, nextUp: upNext[0] ?? null },
    loans,
    reminders,
    offlineQueue: { finishedAt: queue?.at ?? null, count: Number(queue?.value ?? 0) || 0 },
    autoRuleChanges,
  };
}
