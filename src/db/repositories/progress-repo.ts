/**
 * Progress history, movie viewings, TV seasons/episodes and game milestones.
 *
 * History entries are soft-deleted (`deleted_at`) so the derived "current"
 * value is always "latest non-deleted entry in the current pass". TV episode
 * state lives on the `episodes` rows; TV history rows are an audit log of
 * those toggles (editing/deleting them does not flip episode state — documented
 * in docs/product-decisions.md).
 */
import type { GameScheme, ProgressKind } from '../../shared/enums';
import type { SeasonInput } from '../../shared/schemas';
import type { ProgressEventView, ViewingView } from '../../shared/types';
import { episodeCode } from '../../domain/progress';
import { b2i, type Db } from '../connection';
import { newId } from './items-repo';

export interface NewProgressEvent {
  /** Preserved id (imports); a new one is generated when omitted. */
  id?: string;
  itemId: string;
  kind: ProgressKind;
  value: number | null;
  text: string | null;
  totalAtTime: number | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  episodeId: string | null;
  episodeLabel: string | null;
  watched: boolean | null;
  scheme: GameScheme | null;
  pass: number;
  occurredAt: string | null;
  recordedAt: string;
  note: string | null;
}

export function insertProgressEvent(db: Db, e: NewProgressEvent): string {
  const id = e.id ?? newId();
  const seq = (db.get<{ s: number | null }>('SELECT max(seq) AS s FROM progress_events')?.s ?? 0) + 1;
  db.run(
    `INSERT INTO progress_events (id, item_id, seq, kind, value, text_value, total_at_time, milestone_id, milestone_title,
       episode_id, episode_label, watched, scheme, pass, occurred_at, recorded_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      e.itemId,
      seq,
      e.kind,
      e.value,
      e.text,
      e.totalAtTime,
      e.milestoneId,
      e.milestoneTitle,
      e.episodeId,
      e.episodeLabel,
      e.watched === null ? null : b2i(e.watched),
      e.scheme,
      e.pass,
      e.occurredAt,
      e.recordedAt,
      e.note,
    ],
  );
  return id;
}

interface EventRow {
  id: string;
  item_id: string;
  kind: ProgressKind;
  value: number | null;
  text_value: string | null;
  total_at_time: number | null;
  milestone_id: string | null;
  milestone_title: string | null;
  episode_label: string | null;
  watched: number | null;
  scheme: GameScheme | null;
  pass: number;
  occurred_at: string | null;
  recorded_at: string;
  note: string | null;
}

export function getEvent(db: Db, eventId: string): EventRow | undefined {
  return db.get<EventRow>('SELECT * FROM progress_events WHERE id = ? AND deleted_at IS NULL', [eventId]);
}

export function listHistory(db: Db, itemId: string): ProgressEventView[] {
  return db
    .all<EventRow>(
      `SELECT * FROM progress_events WHERE item_id = ? AND deleted_at IS NULL
       ORDER BY COALESCE(occurred_at, recorded_at) DESC, seq DESC`,
      [itemId],
    )
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      occurredAt: r.occurred_at,
      recordedAt: r.recorded_at,
      value: r.value,
      text: r.text_value,
      totalAtTime: r.total_at_time,
      milestoneId: r.milestone_id,
      milestoneTitle: r.milestone_title,
      episodeLabel: r.episode_label,
      watched: r.watched === null ? null : r.watched === 1,
      pass: r.pass,
      note: r.note,
      scheme: r.scheme,
    }));
}

export function updateEvent(
  db: Db,
  eventId: string,
  patch: { occurredAt: string | null; note: string | null; value: number | null; text: string | null },
): void {
  db.run(
    `UPDATE progress_events SET occurred_at = ?, note = ?, value = COALESCE(?, value), text_value = COALESCE(?, text_value)
     WHERE id = ?`,
    [patch.occurredAt, patch.note, patch.value, patch.text, eventId],
  );
}

export function softDeleteEvent(db: Db, eventId: string, nowIso: string): void {
  db.run('UPDATE progress_events SET deleted_at = ? WHERE id = ?', [nowIso, eventId]);
}

/* ---------- viewings (movies) ---------- */

export function addViewing(
  db: Db,
  itemId: string,
  watchedAt: string | null,
  note: string | null,
  pass: number,
  nowIso: string,
): string {
  const id = newId();
  db.run(
    'INSERT INTO viewing_events (id, item_id, watched_at, note, pass, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, itemId, watchedAt, note, pass, nowIso],
  );
  return id;
}

export function listViewings(db: Db, itemId: string): ViewingView[] {
  return db
    .all<{ id: string; watched_at: string | null; note: string | null; pass: number; created_at: string }>(
      'SELECT id, watched_at, note, pass, created_at FROM viewing_events WHERE item_id = ? ORDER BY COALESCE(watched_at, created_at) DESC',
      [itemId],
    )
    .map((v) => ({ id: v.id, watchedAt: v.watched_at, note: v.note, pass: v.pass, createdAt: v.created_at }));
}

export function getViewing(db: Db, viewingId: string): { item_id: string } | undefined {
  return db.get<{ item_id: string }>('SELECT item_id FROM viewing_events WHERE id = ?', [viewingId]);
}

/* ---------- TV ---------- */

export function insertSeasons(
  db: Db,
  itemId: string,
  seasons: readonly SeasonInput[],
  source: 'provider' | 'user',
): void {
  for (const s of seasons) {
    const sid = newId();
    db.run(
      'INSERT INTO seasons (id, item_id, season_number, title, episode_count_known) VALUES (?, ?, ?, ?, ?)',
      [sid, itemId, s.number, s.title, s.episodeCountKnown],
    );
    const seen = new Set<number>();
    for (const e of s.episodes) {
      if (seen.has(e.number)) continue;
      seen.add(e.number);
      db.run(
        `INSERT INTO episodes (id, season_id, item_id, episode_number, title, air_date, runtime, watched, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [newId(), sid, itemId, e.number, e.title, e.airDate, e.runtime, source],
      );
    }
  }
}

/**
 * Merges refreshed provider seasons into an existing show. Never deletes
 * seasons/episodes and never touches watched state or user-added episodes.
 */
export function mergeProviderSeasons(
  db: Db,
  itemId: string,
  seasons: readonly SeasonInput[],
): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  for (const s of seasons) {
    let season = db.get<{ id: string; episode_count_known: number | null }>(
      'SELECT id, episode_count_known FROM seasons WHERE item_id = ? AND season_number = ?',
      [itemId, s.number],
    );
    if (!season) {
      const sid = newId();
      db.run(
        'INSERT INTO seasons (id, item_id, season_number, title, episode_count_known) VALUES (?, ?, ?, ?, ?)',
        [sid, itemId, s.number, s.title, s.episodeCountKnown],
      );
      season = { id: sid, episode_count_known: s.episodeCountKnown };
    } else if (s.episodeCountKnown !== null && s.episodeCountKnown !== season.episode_count_known) {
      db.run('UPDATE seasons SET episode_count_known = ? WHERE id = ?', [s.episodeCountKnown, season.id]);
    }
    for (const e of s.episodes) {
      const existing = db.get<{
        id: string;
        source: string;
        title: string | null;
        air_date: string | null;
        runtime: number | null;
      }>(
        'SELECT id, source, title, air_date, runtime FROM episodes WHERE season_id = ? AND episode_number = ?',
        [season.id, e.number],
      );
      if (!existing) {
        db.run(
          `INSERT INTO episodes (id, season_id, item_id, episode_number, title, air_date, runtime, watched, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'provider')`,
          [newId(), season.id, itemId, e.number, e.title, e.airDate, e.runtime],
        );
        added++;
      } else if (
        existing.source === 'provider' &&
        (existing.title !== e.title || existing.air_date !== e.airDate || existing.runtime !== e.runtime)
      ) {
        db.run('UPDATE episodes SET title = ?, air_date = ?, runtime = ? WHERE id = ?', [
          e.title,
          e.airDate,
          e.runtime,
          existing.id,
        ]);
        updated++;
      }
    }
  }
  return { added, updated };
}

/** Counts what a merge would do, without writing. */
export function previewSeasonMerge(
  db: Db,
  itemId: string,
  seasons: readonly SeasonInput[],
): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  for (const s of seasons) {
    const season = db.get<{ id: string }>('SELECT id FROM seasons WHERE item_id = ? AND season_number = ?', [
      itemId,
      s.number,
    ]);
    for (const e of s.episodes) {
      const ex = season
        ? db.get<{ source: string; title: string | null; air_date: string | null; runtime: number | null }>(
            'SELECT source, title, air_date, runtime FROM episodes WHERE season_id = ? AND episode_number = ?',
            [season.id, e.number],
          )
        : undefined;
      if (!ex) added++;
      else if (
        ex.source === 'provider' &&
        (ex.title !== e.title || ex.air_date !== e.airDate || ex.runtime !== e.runtime)
      )
        updated++;
    }
  }
  return { added, updated };
}

export interface EpisodeRef {
  id: string;
  season_number: number;
  episode_number: number;
  watched: number;
}

export function episodesForItem(db: Db, itemId: string, ids: readonly string[]): EpisodeRef[] {
  if (ids.length === 0) return [];
  const out: EpisodeRef[] = [];
  // Chunk to stay well below SQLite's bound-parameter limit.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(
      ...db.all<EpisodeRef>(
        `SELECT e.id, s.season_number, e.episode_number, e.watched FROM episodes e JOIN seasons s ON s.id = e.season_id
         WHERE e.item_id = ? AND e.id IN (${chunk.map(() => '?').join(',')})`,
        [itemId, ...chunk],
      ),
    );
  }
  return out;
}

export function setEpisodesWatched(
  db: Db,
  ids: readonly string[],
  watched: boolean,
  at: string | null,
): void {
  for (const id of ids)
    db.run('UPDATE episodes SET watched = ?, watched_at = ? WHERE id = ?', [
      b2i(watched),
      watched ? at : null,
      id,
    ]);
}

export function resetEpisodes(db: Db, itemId: string): void {
  db.run('UPDATE episodes SET watched = 0, watched_at = NULL WHERE item_id = ?', [itemId]);
}

export function episodeLabel(seasonNumber: number, episodeNumber: number): string {
  return episodeCode(seasonNumber, episodeNumber);
}

/* ---------- milestones ---------- */

export function setMilestones(
  db: Db,
  itemId: string,
  list: readonly { id: string | null; title: string }[],
): void {
  const existing = new Set(
    db.all<{ id: string }>('SELECT id FROM game_milestones WHERE item_id = ?', [itemId]).map((r) => r.id),
  );
  const keep = new Set<string>();
  list.forEach((m, position) => {
    if (m.id && existing.has(m.id)) {
      db.run('UPDATE game_milestones SET position = ?, title = ? WHERE id = ?', [position, m.title, m.id]);
      keep.add(m.id);
    } else {
      const id = newId();
      db.run('INSERT INTO game_milestones (id, item_id, position, title) VALUES (?, ?, ?, ?)', [
        id,
        itemId,
        position,
        m.title,
      ]);
      keep.add(id);
    }
  });
  for (const id of existing) if (!keep.has(id)) db.run('DELETE FROM game_milestones WHERE id = ?', [id]);
}
