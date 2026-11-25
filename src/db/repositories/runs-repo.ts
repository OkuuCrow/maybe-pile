/**
 * Runs (rewatch / replay / reread). `item_runs.run_number` formalizes the
 * existing `items.pass`: the row for `run_number = items.pass` mirrors the
 * item's live status/dates/rating, earlier rows are finished runs. Episode
 * checkmarks of finished runs are snapshotted in `run_episode_states` just
 * before a new run resets them.
 */
import type { Db } from '../connection';
import type { Status } from '../../shared/enums';
import { newId } from './items-repo';

export interface RunRow {
  id: string;
  item_id: string;
  run_number: number;
  status: Status;
  date_started: string | null;
  date_completed: string | null;
  rating: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

/** Ensures rows 1..pass exist and the current run mirrors the item. Idempotent. */
export function syncRuns(db: Db, itemId: string, now: string): void {
  const it = db.get<{
    pass: number;
    status: Status;
    date_started: string | null;
    date_completed: string | null;
    rating: number | null;
  }>('SELECT pass, status, date_started, date_completed, rating FROM items WHERE id = ?', [itemId]);
  if (!it) return;
  for (let n = 1; n < it.pass; n++) {
    db.run(
      `INSERT OR IGNORE INTO item_runs (id, item_id, run_number, status, date_started, date_completed, rating, notes, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', NULL, NULL, NULL, '', ?, ?)`,
      [newId(), itemId, n, now, now],
    );
  }
  db.run(
    `INSERT INTO item_runs (id, item_id, run_number, status, date_started, date_completed, rating, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)
     ON CONFLICT (item_id, run_number) DO UPDATE SET
       status = excluded.status, date_started = excluded.date_started,
       date_completed = excluded.date_completed, rating = excluded.rating, updated_at = excluded.updated_at
     WHERE item_runs.status IS NOT excluded.status OR item_runs.date_started IS NOT excluded.date_started
        OR item_runs.date_completed IS NOT excluded.date_completed OR item_runs.rating IS NOT excluded.rating`,
    [newId(), itemId, it.pass, it.status, it.date_started, it.date_completed, it.rating, now, now],
  );
}

/** Copies the current episode checkmarks into the run's snapshot (before they are reset). */
export function snapshotRunEpisodes(db: Db, itemId: string, runNumber: number): number {
  const run = db.get<{ id: string }>('SELECT id FROM item_runs WHERE item_id = ? AND run_number = ?', [
    itemId,
    runNumber,
  ]);
  if (!run) return 0;
  return db.run(
    `INSERT OR IGNORE INTO run_episode_states (run_id, episode_id, watched_at)
     SELECT ?, e.id, e.watched_at FROM episodes e WHERE e.item_id = ? AND e.watched = 1`,
    [run.id, itemId],
  ).changes;
}

export function listRuns(db: Db, itemId: string): (RunRow & { episodes_watched: number })[] {
  return db.all<RunRow & { episodes_watched: number }>(
    `SELECT r.*, (SELECT count(*) FROM run_episode_states s WHERE s.run_id = r.id) AS episodes_watched
       FROM item_runs r WHERE r.item_id = ? ORDER BY r.run_number`,
    [itemId],
  );
}
