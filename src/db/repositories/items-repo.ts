/**
 * Item persistence: writes the normalized metadata/personal tables, assembles
 * `ItemDetail` and `ItemSummary` DTOs, runs library queries and maintains the
 * FTS index and cached progress columns.
 *
 * All writers assume they run inside a transaction opened by the service layer
 * (they are composed into larger atomic operations such as imports).
 */
import { randomUUID } from 'node:crypto';
import type { CustomFieldType, ExternalIdKind, MediaType, ProgressKind, Status } from '../../shared/enums';
import { STATUSES } from '../../shared/enums';
import type {
  Creator,
  ExternalId,
  LibraryQuery,
  MetadataField,
  MetadataFields,
  PersonalFields,
  Platform,
} from '../../shared/schemas';
import type {
  ArtworkView,
  CustomFieldView,
  DuplicateMatch,
  ItemDetail,
  ItemSummary,
  LibraryPage,
  MilestoneView,
  ProgressSummary,
  ProvenanceView,
  SeasonView,
  SeriesMembershipView,
  SourceView,
} from '../../shared/types';
import { yearOf } from '../../domain/dates';
import { linksFromExternalIds } from '../../domain/links';
import { emptyMeta } from '../../domain/metadata';
import { foldText, sortTitle, tagKey, titleKey, uniqueTags } from '../../domain/normalize';
import { summarizeProgress, type ProgressEventLike } from '../../domain/progress';
import { b2i, i2b, type Db } from '../connection';

const SEP = '\u001f';

export interface ItemRow {
  rid: number;
  id: string;
  type: MediaType;
  title: string;
  description: string | null;
  release_date: string | null;
  release_year: number | null;
  status: Status;
  rating: number | null;
  notes: string;
  date_added: string;
  date_started: string | null;
  date_completed: string | null;
  pass: number;
  /** From the `up_next` table (joined), not a column on items. */
  up_next_position: number | null;
  artwork_id: string | null;
  progress_pct: number | null;
  progress_label: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export const newId = (): string => randomUUID();

/* ------------------------------------------------------------------ lookups */

function upsertNamed(db: Db, table: 'creators' | 'genres' | 'tags', name: string, key: string): number {
  db.run(`INSERT INTO ${table} (name, name_key) VALUES (?, ?) ON CONFLICT(name_key) DO NOTHING`, [name, key]);
  const row = db.get<{ id: number }>(`SELECT id FROM ${table} WHERE name_key = ?`, [key]);
  if (!row) throw new Error(`Failed to upsert ${table}`);
  return row.id;
}

/** Removes lookup rows no longer referenced by any item. */
export function pruneOrphans(db: Db): void {
  db.run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM item_tags)');
  db.run('DELETE FROM genres WHERE id NOT IN (SELECT genre_id FROM item_genres)');
  db.run('DELETE FROM creators WHERE id NOT IN (SELECT creator_id FROM item_creators)');
}

/* ------------------------------------------------------------------ writes */

export function insertItemRow(
  db: Db,
  id: string,
  type: MediaType,
  meta: MetadataFields,
  personal: PersonalFields,
  nowIso: string,
): void {
  db.run(
    `INSERT INTO items (id, type, title, sort_title, title_key, description, release_date, release_year, status, rating,
       notes, date_added, date_started, date_completed, pass, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      type,
      meta.title,
      sortTitle(meta.title),
      titleKey(meta.title),
      meta.description,
      meta.releaseDate,
      yearOf(meta.releaseDate),
      personal.status,
      personal.rating,
      personal.notes,
      personal.dateAdded,
      personal.dateStarted,
      personal.dateCompleted,
      nowIso,
      nowIso,
    ],
  );
  if (type === 'movie') db.run('INSERT INTO movie_details (item_id) VALUES (?)', [id]);
  if (type === 'tv') db.run('INSERT INTO tv_details (item_id) VALUES (?)', [id]);
  if (type === 'game') db.run('INSERT INTO game_details (item_id) VALUES (?)', [id]);
  if (type === 'book') db.run('INSERT INTO book_details (item_id) VALUES (?)', [id]);
}

export function writeMeta(db: Db, id: string, type: MediaType, meta: MetadataFields): void {
  db.run(
    `UPDATE items SET title = ?, sort_title = ?, title_key = ?, description = ?, release_date = ?, release_year = ?
     WHERE id = ?`,
    [
      meta.title,
      sortTitle(meta.title),
      titleKey(meta.title),
      meta.description,
      meta.releaseDate,
      yearOf(meta.releaseDate),
      id,
    ],
  );
  db.run('DELETE FROM item_alt_titles WHERE item_id = ?', [id]);
  meta.altTitles.forEach((t, i) =>
    db.run('INSERT INTO item_alt_titles (item_id, position, title) VALUES (?, ?, ?)', [id, i, t]),
  );

  db.run('DELETE FROM item_genres WHERE item_id = ?', [id]);
  const seenGenres = new Set<number>();
  meta.genres.forEach((g, i) => {
    const gid = upsertNamed(db, 'genres', g.trim(), foldText(g.trim()));
    if (seenGenres.has(gid)) return;
    seenGenres.add(gid);
    db.run('INSERT INTO item_genres (item_id, genre_id, position) VALUES (?, ?, ?)', [id, gid, i]);
  });

  db.run('DELETE FROM item_creators WHERE item_id = ?', [id]);
  const seenCreators = new Set<string>();
  meta.creators.forEach((c, i) => {
    const cid = upsertNamed(db, 'creators', c.name.trim(), foldText(c.name.trim()));
    const k = `${cid}:${c.role}`;
    if (seenCreators.has(k)) return;
    seenCreators.add(k);
    db.run('INSERT INTO item_creators (item_id, creator_id, role, position) VALUES (?, ?, ?, ?)', [
      id,
      cid,
      c.role,
      i,
    ]);
  });

  db.run('DELETE FROM external_ids WHERE item_id = ?', [id]);
  const seenKinds = new Set<string>();
  for (const e of meta.externalIds) {
    if (seenKinds.has(e.kind)) continue;
    seenKinds.add(e.kind);
    db.run('INSERT INTO external_ids (item_id, kind, value) VALUES (?, ?, ?)', [id, e.kind, e.value]);
  }

  switch (type) {
    case 'movie':
      db.run(
        'UPDATE movie_details SET runtime_minutes = ?, original_language = ?, age_rating = ? WHERE item_id = ?',
        [meta.runtimeMinutes, meta.originalLanguage, meta.ageRating, id],
      );
      break;
    case 'tv':
      db.run(
        'UPDATE tv_details SET network = ?, show_status = ?, episode_runtime = ?, last_air_date = ? WHERE item_id = ?',
        [meta.network, meta.showStatus, meta.episodeRuntime, meta.lastAirDate, id],
      );
      break;
    case 'book':
      db.run(
        'UPDATE book_details SET isbn10 = ?, isbn13 = ?, publisher = ?, page_count = ?, audio_minutes = ? WHERE item_id = ?',
        [meta.isbn10, meta.isbn13, meta.publisher, meta.pageCount, meta.audioMinutes, id],
      );
      break;
    case 'game':
      break;
  }
}

export function writeTags(db: Db, id: string, tags: readonly string[]): void {
  db.run('DELETE FROM item_tags WHERE item_id = ?', [id]);
  for (const t of uniqueTags(tags)) {
    const tid = upsertNamed(db, 'tags', t, tagKey(t));
    db.run('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)', [id, tid]);
  }
}

export function addTag(db: Db, id: string, tag: string): void {
  const [t] = uniqueTags([tag]);
  if (!t) return;
  const tid = upsertNamed(db, 'tags', t, tagKey(t));
  db.run('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)', [id, tid]);
}

export function removeTag(db: Db, id: string, tag: string): void {
  db.run('DELETE FROM item_tags WHERE item_id = ? AND tag_id IN (SELECT id FROM tags WHERE name_key = ?)', [
    id,
    tagKey(tag),
  ]);
}

export function writePersonal(
  db: Db,
  id: string,
  type: MediaType,
  p: PersonalFields,
  customTypes: Map<string, CustomFieldType>,
): void {
  db.run(
    `UPDATE items SET status = ?, rating = ?, notes = ?, date_added = ?, date_started = ?, date_completed = ? WHERE id = ?`,
    [p.status, p.rating, p.notes, p.dateAdded, p.dateStarted, p.dateCompleted, id],
  );
  writeTags(db, id, p.tags);
  if (type === 'game') {
    db.run('UPDATE game_details SET progress_scheme = ? WHERE item_id = ?', [p.gameScheme ?? 'percent', id]);
    writePlatforms(db, id, p.platforms);
  }
  if (type === 'book')
    db.run('UPDATE book_details SET format = ? WHERE item_id = ?', [p.bookFormat ?? 'print', id]);
  db.run('DELETE FROM custom_field_values WHERE item_id = ?', [id]);
  for (const cf of p.customFields) {
    const t = customTypes.get(cf.defId);
    if (!t || cf.value === null || cf.value === '') continue;
    if (t === 'number' || t === 'boolean') {
      const n = t === 'boolean' ? b2i(cf.value === true) : Number(cf.value);
      db.run('INSERT INTO custom_field_values (item_id, def_id, number_value) VALUES (?, ?, ?)', [
        id,
        cf.defId,
        n,
      ]);
    } else {
      db.run('INSERT INTO custom_field_values (item_id, def_id, text_value) VALUES (?, ?, ?)', [
        id,
        cf.defId,
        String(cf.value),
      ]);
    }
  }
}

function writePlatforms(db: Db, id: string, platforms: readonly Platform[]): void {
  db.run('DELETE FROM game_platforms WHERE item_id = ?', [id]);
  platforms.forEach((p, i) =>
    db.run('INSERT INTO game_platforms (item_id, position, name, owned, played) VALUES (?, ?, ?, ?, ?)', [
      id,
      i,
      p.name,
      b2i(p.owned),
      b2i(p.played),
    ]),
  );
}

export function touch(db: Db, id: string, nowIso: string): void {
  db.run('UPDATE items SET updated_at = ? WHERE id = ?', [nowIso, id]);
}

export function setProvenance(
  db: Db,
  id: string,
  field: MetadataField,
  origin: ProvenanceView['origin'],
  providerId: string | null,
  providerValue: string | null,
  nowIso: string,
): void {
  db.run(
    `INSERT INTO field_provenance (item_id, field, origin, provider_id, provider_value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, field) DO UPDATE SET origin = excluded.origin, provider_id = excluded.provider_id,
       provider_value = excluded.provider_value, updated_at = excluded.updated_at`,
    [id, field, origin, providerId, providerValue, nowIso],
  );
}

export function setSource(
  db: Db,
  id: string,
  providerId: string,
  providerRef: string,
  url: string | null,
  nowIso: string,
): void {
  db.run(
    `INSERT INTO item_sources (item_id, provider_id, provider_ref, url, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id, provider_id) DO UPDATE SET provider_ref = excluded.provider_ref, url = excluded.url, fetched_at = excluded.fetched_at`,
    [id, providerId, providerRef, url, nowIso],
  );
}

/* ------------------------------------------------------------------ FTS */

export function reindexItem(db: Db, id: string): void {
  const row = db.get<{ rid: number; title: string; notes: string; deleted_at: string | null }>(
    'SELECT rid, title, notes, deleted_at FROM items WHERE id = ?',
    [id],
  );
  if (!row) return;
  db.run('DELETE FROM items_fts WHERE rowid = ?', [row.rid]);
  if (row.deleted_at) return;
  const alt =
    db.get<{ v: string | null }>(
      "SELECT group_concat(title, ' ') AS v FROM item_alt_titles WHERE item_id = ?",
      [id],
    )?.v ?? '';
  const creators =
    db.get<{ v: string | null }>(
      "SELECT group_concat(c.name, ' ') AS v FROM item_creators ic JOIN creators c ON c.id = ic.creator_id WHERE ic.item_id = ?",
      [id],
    )?.v ?? '';
  const tags =
    db.get<{ v: string | null }>(
      "SELECT group_concat(t.name, ' ') AS v FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ?",
      [id],
    )?.v ?? '';
  db.run(
    'INSERT INTO items_fts (rowid, title, alt_titles, creators, tags, notes) VALUES (?, ?, ?, ?, ?, ?)',
    [row.rid, row.title, alt, creators, tags, row.notes],
  );
}

export function rebuildFts(db: Db): void {
  db.run('DELETE FROM items_fts');
  for (const r of db.all<{ id: string }>('SELECT id FROM items WHERE deleted_at IS NULL'))
    reindexItem(db, r.id);
}

/** Converts free text into a safe FTS5 query: every token quoted, prefix-matched, ANDed. */
export function ftsQuery(text: string): string | null {
  const tokens = text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
}

/* ------------------------------------------------------------------ progress cache */

export function loadProgressInputs(db: Db, id: string): Parameters<typeof summarizeProgress>[0] | null {
  const item = db.get<{ type: MediaType; pass: number }>('SELECT type, pass FROM items WHERE id = ?', [id]);
  if (!item) return null;
  const viewings =
    item.type === 'movie'
      ? db.all<{ pass: number }>('SELECT pass FROM viewing_events WHERE item_id = ?', [id])
      : [];
  const seasons = item.type === 'tv' ? loadSeasons(db, id) : [];
  const tv =
    item.type === 'tv'
      ? db.get<{ show_status: MetadataFields['showStatus'] }>(
          'SELECT show_status FROM tv_details WHERE item_id = ?',
          [id],
        )
      : undefined;
  const game =
    item.type === 'game'
      ? db.get<{ progress_scheme: PersonalFields['gameScheme'] }>(
          'SELECT progress_scheme FROM game_details WHERE item_id = ?',
          [id],
        )
      : undefined;
  const book =
    item.type === 'book'
      ? db.get<{ page_count: number | null; audio_minutes: number | null }>(
          'SELECT page_count, audio_minutes FROM book_details WHERE item_id = ?',
          [id],
        )
      : undefined;
  const events = db
    .all<{
      kind: ProgressKind;
      value: number | null;
      text_value: string | null;
      milestone_id: string | null;
      pass: number;
      at: string;
      seq: number;
    }>(
      `SELECT kind, value, text_value, milestone_id, pass, COALESCE(occurred_at, recorded_at) AS at, seq
       FROM progress_events WHERE item_id = ? AND deleted_at IS NULL`,
      [id],
    )
    .map<ProgressEventLike>((e) => ({
      kind: e.kind,
      value: e.value,
      text: e.text_value,
      milestoneId: e.milestone_id,
      pass: e.pass,
      at: e.at,
      seq: e.seq,
    }));
  return {
    type: item.type,
    pass: item.pass,
    viewings,
    seasons: seasons.map((s) => ({
      number: s.number,
      episodeCountKnown: s.episodeCountKnown,
      episodes: s.episodes,
    })),
    showStatus: tv?.show_status ?? null,
    gameScheme: game?.progress_scheme ?? null,
    milestones: item.type === 'game' ? loadMilestones(db, id) : [],
    events,
    pageCount: book?.page_count ?? null,
    audioMinutes: book?.audio_minutes ?? null,
  };
}

export function computeProgress(db: Db, id: string): ProgressSummary {
  const inputs = loadProgressInputs(db, id);
  if (!inputs)
    return { percent: null, label: '', nextAction: null, isComplete: false, hasAnyProgress: false };
  return summarizeProgress(inputs);
}

/** Recomputes and caches progress_pct/progress_label (used for sorting and lists). */
export function recomputeProgress(db: Db, id: string): ProgressSummary {
  const summary = computeProgress(db, id);
  db.run('UPDATE items SET progress_pct = ?, progress_label = ? WHERE id = ?', [
    summary.percent,
    summary.label,
    id,
  ]);
  return summary;
}

/* ------------------------------------------------------------------ reads */

export function getItemRow(db: Db, id: string, includeDeleted = false): ItemRow | undefined {
  return db.get<ItemRow>(
    `SELECT items.*, (SELECT u.position FROM up_next u WHERE u.item_id = items.id) AS up_next_position
     FROM items WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    [id],
  );
}

export function loadSeasons(db: Db, itemId: string): SeasonView[] {
  const seasons = db.all<{
    id: string;
    season_number: number;
    title: string | null;
    episode_count_known: number | null;
  }>(
    'SELECT id, season_number, title, episode_count_known FROM seasons WHERE item_id = ? ORDER BY season_number',
    [itemId],
  );
  const episodes = db.all<{
    id: string;
    season_id: string;
    episode_number: number;
    title: string | null;
    air_date: string | null;
    runtime: number | null;
    watched: number;
    watched_at: string | null;
    source: 'provider' | 'user';
  }>('SELECT * FROM episodes WHERE item_id = ? ORDER BY episode_number', [itemId]);
  const bySeason = new Map<string, SeasonView['episodes']>();
  for (const e of episodes) {
    const list = bySeason.get(e.season_id) ?? [];
    list.push({
      id: e.id,
      seasonId: e.season_id,
      number: e.episode_number,
      title: e.title,
      airDate: e.air_date,
      runtime: e.runtime,
      watched: i2b(e.watched),
      watchedAt: e.watched_at,
      source: e.source,
    });
    bySeason.set(e.season_id, list);
  }
  return seasons.map((s) => {
    const eps = bySeason.get(s.id) ?? [];
    return {
      id: s.id,
      number: s.season_number,
      title: s.title,
      episodeCountKnown: s.episode_count_known,
      episodes: eps,
      watchedCount: eps.filter((e) => e.watched).length,
    };
  });
}

export function loadMilestones(db: Db, itemId: string): MilestoneView[] {
  return db.all<MilestoneView>(
    'SELECT id, position, title FROM game_milestones WHERE item_id = ? ORDER BY position',
    [itemId],
  );
}

export function artworkView(
  row:
    | {
        id: string;
        source: ArtworkView['source'];
        file_name: string | null;
        thumb_name: string | null;
        provider_id: string | null;
      }
    | undefined,
): ArtworkView | null {
  if (!row) return null;
  if (row.source === 'remote') {
    const url = `maybepile-art://remote/${row.id}`;
    return { id: row.id, source: row.source, thumbUrl: url, fullUrl: url, providerId: row.provider_id };
  }
  if (!row.file_name) return null;
  return {
    id: row.id,
    source: row.source,
    thumbUrl: `maybepile-art://file/${row.thumb_name ?? row.file_name}`,
    fullUrl: `maybepile-art://file/${row.file_name}`,
    providerId: row.provider_id,
  };
}

export function loadMeta(db: Db, row: ItemRow): MetadataFields {
  const id = row.id;
  const meta = emptyMeta(row.title);
  meta.description = row.description;
  meta.releaseDate = row.release_date;
  meta.altTitles = db
    .all<{ title: string }>('SELECT title FROM item_alt_titles WHERE item_id = ? ORDER BY position', [id])
    .map((r) => r.title);
  meta.genres = db
    .all<{ name: string }>(
      'SELECT g.name FROM item_genres ig JOIN genres g ON g.id = ig.genre_id WHERE ig.item_id = ? ORDER BY ig.position',
      [id],
    )
    .map((r) => r.name);
  meta.creators = db.all<Creator>(
    'SELECT c.name AS name, ic.role AS role FROM item_creators ic JOIN creators c ON c.id = ic.creator_id WHERE ic.item_id = ? ORDER BY ic.position',
    [id],
  );
  meta.externalIds = db
    .all<{ kind: ExternalIdKind; value: string }>(
      'SELECT kind, value FROM external_ids WHERE item_id = ? ORDER BY kind',
      [id],
    )
    .map((r): ExternalId => ({ kind: r.kind, value: r.value }));
  if (row.type === 'movie') {
    const d = db.get<{
      runtime_minutes: number | null;
      original_language: string | null;
      age_rating: string | null;
    }>('SELECT runtime_minutes, original_language, age_rating FROM movie_details WHERE item_id = ?', [id]);
    meta.runtimeMinutes = d?.runtime_minutes ?? null;
    meta.originalLanguage = d?.original_language ?? null;
    meta.ageRating = d?.age_rating ?? null;
  } else if (row.type === 'tv') {
    const d = db.get<{
      network: string | null;
      show_status: MetadataFields['showStatus'];
      episode_runtime: number | null;
      last_air_date: string | null;
    }>('SELECT network, show_status, episode_runtime, last_air_date FROM tv_details WHERE item_id = ?', [id]);
    meta.network = d?.network ?? null;
    meta.showStatus = d?.show_status ?? null;
    meta.episodeRuntime = d?.episode_runtime ?? null;
    meta.lastAirDate = d?.last_air_date ?? null;
  } else if (row.type === 'book') {
    const d = db.get<{
      isbn10: string | null;
      isbn13: string | null;
      publisher: string | null;
      page_count: number | null;
      audio_minutes: number | null;
    }>('SELECT isbn10, isbn13, publisher, page_count, audio_minutes FROM book_details WHERE item_id = ?', [
      id,
    ]);
    meta.isbn10 = d?.isbn10 ?? null;
    meta.isbn13 = d?.isbn13 ?? null;
    meta.publisher = d?.publisher ?? null;
    meta.pageCount = d?.page_count ?? null;
    meta.audioMinutes = d?.audio_minutes ?? null;
  }
  return meta;
}

export function loadCustomFields(db: Db, itemId: string): CustomFieldView[] {
  const defs = db.all<{ id: string; name: string; value_type: CustomFieldType }>(
    'SELECT id, name, value_type FROM custom_field_defs ORDER BY name_key',
  );
  const opts = db.all<{ def_id: string; value: string }>(
    'SELECT def_id, value FROM custom_field_options ORDER BY def_id, position',
  );
  const vals = db.all<{ def_id: string; text_value: string | null; number_value: number | null }>(
    'SELECT def_id, text_value, number_value FROM custom_field_values WHERE item_id = ?',
    [itemId],
  );
  return defs.map((d) => {
    const v = vals.find((x) => x.def_id === d.id);
    let value: CustomFieldView['value'] = null;
    if (v) {
      if (d.value_type === 'boolean') value = v.number_value === 1;
      else if (d.value_type === 'number') value = v.number_value;
      else value = v.text_value;
    }
    return {
      defId: d.id,
      name: d.name,
      type: d.value_type,
      options: opts.filter((o) => o.def_id === d.id).map((o) => o.value),
      value,
    };
  });
}

export function loadPersonal(db: Db, row: ItemRow): PersonalFields {
  const id = row.id;
  const tags = db
    .all<{ name: string }>(
      'SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ? ORDER BY t.name_key',
      [id],
    )
    .map((r) => r.name);
  const game =
    row.type === 'game'
      ? db.get<{ progress_scheme: PersonalFields['gameScheme'] }>(
          'SELECT progress_scheme FROM game_details WHERE item_id = ?',
          [id],
        )
      : undefined;
  const platforms =
    row.type === 'game'
      ? db
          .all<{ name: string; owned: number; played: number }>(
            'SELECT name, owned, played FROM game_platforms WHERE item_id = ? ORDER BY position',
            [id],
          )
          .map((p) => ({ name: p.name, owned: i2b(p.owned), played: i2b(p.played) }))
      : [];
  const book =
    row.type === 'book'
      ? db.get<{ format: PersonalFields['bookFormat'] }>(
          'SELECT format FROM book_details WHERE item_id = ?',
          [id],
        )
      : undefined;
  return {
    status: row.status,
    rating: row.rating,
    notes: row.notes,
    dateAdded: row.date_added,
    dateStarted: row.date_started,
    dateCompleted: row.date_completed,
    tags,
    gameScheme: game?.progress_scheme ?? null,
    platforms,
    bookFormat: book?.format ?? null,
    customFields: loadCustomFields(db, id)
      .filter((c) => c.value !== null)
      .map((c) => ({ defId: c.defId, value: c.value })),
  };
}

export function loadProvenance(db: Db, itemId: string): Partial<Record<MetadataField, ProvenanceView>> {
  const rows = db.all<{
    field: MetadataField;
    origin: ProvenanceView['origin'];
    provider_id: string | null;
    provider_value: string | null;
    updated_at: string;
  }>(
    'SELECT field, origin, provider_id, provider_value, updated_at FROM field_provenance WHERE item_id = ?',
    [itemId],
  );
  const out: Partial<Record<MetadataField, ProvenanceView>> = {};
  for (const r of rows)
    out[r.field] = {
      origin: r.origin,
      providerId: r.provider_id,
      providerValue: r.provider_value,
      updatedAt: r.updated_at,
    };
  return out;
}

export function loadDetail(db: Db, id: string): ItemDetail | null {
  const row = getItemRow(db, id);
  if (!row) return null;
  const meta = loadMeta(db, row);
  const art = row.artwork_id
    ? db.get<{
        id: string;
        source: ArtworkView['source'];
        file_name: string | null;
        thumb_name: string | null;
        provider_id: string | null;
      }>('SELECT id, source, file_name, thumb_name, provider_id FROM artwork WHERE id = ?', [row.artwork_id])
    : undefined;
  const sources = db.all<{
    provider_id: string;
    provider_ref: string;
    url: string | null;
    fetched_at: string;
  }>(
    'SELECT provider_id, provider_ref, url, fetched_at FROM item_sources WHERE item_id = ? ORDER BY fetched_at DESC',
    [id],
  );
  const series = db.all<{ series_id: string; name: string; position: number | null }>(
    'SELECT sm.series_id, s.name, sm.position FROM series_members sm JOIN book_series s ON s.id = sm.series_id WHERE sm.item_id = ? ORDER BY s.name',
    [id],
  );
  return {
    id: row.id,
    type: row.type,
    meta,
    personal: loadPersonal(db, row),
    pass: row.pass,
    upNextPosition: row.up_next_position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    artwork: artworkView(art),
    provenance: loadProvenance(db, id),
    sources: sources.map<SourceView>((s) => ({
      providerId: s.provider_id,
      providerRef: s.provider_ref,
      url: s.url,
      fetchedAt: s.fetched_at,
    })),
    customFields: loadCustomFields(db, id),
    series: series.map<SeriesMembershipView>((s) => ({
      seriesId: s.series_id,
      name: s.name,
      position: s.position,
    })),
    seasons: row.type === 'tv' ? loadSeasons(db, id) : [],
    milestones: row.type === 'game' ? loadMilestones(db, id) : [],
    progress: computeProgress(db, id),
    links: linksFromExternalIds(row.type, meta.externalIds),
    lists: db.all<{ id: string; name: string }>(
      'SELECT l.id, l.name FROM lists l JOIN list_items li ON li.list_id = l.id WHERE li.item_id = ? ORDER BY l.position',
      [id],
    ),
    snoozedUntil:
      db.get<{ until: string }>("SELECT until FROM item_snoozes WHERE item_id = ? AND reason <> 'keep'", [id])
        ?.until ?? null,
    goneFromSources: db
      .all<{ label: string }>(
        `SELECT DISTINCT s.label FROM library_source_entries e JOIN library_sources s ON s.id = e.source_id
         WHERE e.item_id = ? AND e.removed_at IS NOT NULL ORDER BY s.label`,
        [id],
      )
      .map((r) => r.label),
  };
}

/* ------------------------------------------------------------------ summaries & queries */

const SUMMARY_SELECT = `
  SELECT i.id, i.type, i.title, i.release_year, i.status, i.rating, i.date_added, i.updated_at, i.release_date,
         i.progress_pct, i.progress_label, i.date_completed,
         a.id AS art_id, a.source AS art_source, a.file_name AS art_file, a.thumb_name AS art_thumb, a.provider_id AS art_provider,
         (SELECT group_concat(t.name, '${SEP}') FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id) AS tag_list,
         (SELECT group_concat(name, '${SEP}') FROM (SELECT c.name FROM item_creators ic JOIN creators c ON c.id = ic.creator_id
            WHERE ic.item_id = i.id ORDER BY ic.position LIMIT 3)) AS creator_list
  FROM items i LEFT JOIN artwork a ON a.id = i.artwork_id`;

interface SummaryRow {
  id: string;
  type: MediaType;
  title: string;
  release_year: number | null;
  status: Status;
  rating: number | null;
  date_added: string;
  updated_at: string;
  release_date: string | null;
  progress_pct: number | null;
  progress_label: string;
  date_completed: string | null;
  art_id: string | null;
  art_source: ArtworkView['source'] | null;
  art_file: string | null;
  art_thumb: string | null;
  art_provider: string | null;
  tag_list: string | null;
  creator_list: string | null;
}

export function toSummary(r: SummaryRow): ItemSummary {
  const art =
    r.art_id && r.art_source
      ? artworkView({
          id: r.art_id,
          source: r.art_source,
          file_name: r.art_file,
          thumb_name: r.art_thumb,
          provider_id: r.art_provider,
        })
      : null;
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    year: r.release_year,
    status: r.status,
    rating: r.rating,
    tags: r.tag_list ? r.tag_list.split(SEP).sort((a, b) => a.localeCompare(b)) : [],
    creators: r.creator_list ? r.creator_list.split(SEP) : [],
    dateAdded: r.date_added,
    updatedAt: r.updated_at,
    releaseDate: r.release_date,
    thumbUrl: art?.thumbUrl ?? null,
    progressPercent: r.progress_pct,
    progressLabel: r.progress_label,
  };
}

export function summariesWhere(
  db: Db,
  where: string,
  params: (string | number)[],
  orderLimit: string,
): (ItemSummary & { dateCompleted: string | null })[] {
  return db
    .all<SummaryRow>(`${SUMMARY_SELECT} WHERE i.deleted_at IS NULL AND (${where}) ${orderLimit}`, params)
    .map((r) => ({ ...toSummary(r), dateCompleted: r.date_completed }));
}

const STATUS_ORDER_SQL = `CASE i.status ${STATUSES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} END`;

const SORT_SQL: Record<LibraryQuery['sort'], { expr: string; nullsLast: boolean }> = {
  title: { expr: 'i.sort_title', nullsLast: false },
  dateAdded: { expr: 'i.date_added', nullsLast: false },
  updatedAt: { expr: 'i.updated_at', nullsLast: false },
  rating: { expr: 'i.rating', nullsLast: true },
  status: { expr: STATUS_ORDER_SQL, nullsLast: false },
  releaseDate: { expr: 'i.release_date', nullsLast: true },
  progress: { expr: 'i.progress_pct', nullsLast: true },
};

/** Date context for the Pile Health library filter. */
export interface HealthFilterContext {
  today: string;
  /** Planned items added on or before this date are stale. */
  plannedCutoff: string;
  /** In-progress items whose last activity is on or before this date are stale. */
  idleCutoff: string;
}

/** Local date of an item's latest activity (progress, viewing, episode), else start/added date. */
export const LAST_ACTIVITY_SQL = `COALESCE(
  (SELECT max(d) FROM (
     SELECT max(substr(COALESCE(p.occurred_at, p.recorded_at), 1, 10)) AS d FROM progress_events p WHERE p.item_id = i.id AND p.deleted_at IS NULL
     UNION ALL SELECT max(substr(COALESCE(v.watched_at, v.created_at), 1, 10)) FROM viewing_events v WHERE v.item_id = i.id
     UNION ALL SELECT max(substr(e.watched_at, 1, 10)) FROM episodes e WHERE e.item_id = i.id AND e.watched = 1)),
  i.date_started, i.date_added)`;

export function buildLibraryWhere(
  q: LibraryQuery,
  health?: HealthFilterContext,
): { where: string; params: (string | number)[] } {
  const clauses: string[] = ['i.deleted_at IS NULL'];
  const params: (string | number)[] = [];
  if (q.listId) {
    clauses.push('EXISTS (SELECT 1 FROM list_items li WHERE li.item_id = i.id AND li.list_id = ?)');
    params.push(q.listId);
  }
  if (q.upNextOnly) clauses.push('EXISTS (SELECT 1 FROM up_next u WHERE u.item_id = i.id)');
  if (q.health === 'snoozed' && health) {
    clauses.push(
      "EXISTS (SELECT 1 FROM item_snoozes z WHERE z.item_id = i.id AND z.reason <> 'keep' AND z.until >= ?)",
    );
    params.push(health.today);
  }
  if (q.health === 'stale' && health) {
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM item_snoozes z WHERE z.item_id = i.id AND z.until >= ?)
       AND ((i.status = 'planned' AND i.date_added <= ?) OR (i.status = 'in_progress' AND ${LAST_ACTIVITY_SQL} <= ?))`,
    );
    params.push(health.today, health.plannedCutoff, health.idleCutoff);
  }
  if (q.types.length > 0) {
    clauses.push(`i.type IN (${q.types.map(() => '?').join(',')})`);
    params.push(...q.types);
  }
  if (q.statuses.length > 0) {
    clauses.push(`i.status IN (${q.statuses.map(() => '?').join(',')})`);
    params.push(...q.statuses);
  }
  if (q.ratingMin !== null) {
    clauses.push('i.rating >= ?');
    params.push(q.ratingMin);
  }
  if (q.ratingMax !== null) {
    clauses.push('i.rating <= ?');
    params.push(q.ratingMax);
  }
  if (q.addedFrom) {
    clauses.push('i.date_added >= ?');
    params.push(q.addedFrom);
  }
  if (q.addedTo) {
    clauses.push('i.date_added <= ?');
    params.push(q.addedTo);
  }
  const tagKeys = [...new Set(q.tags.map(tagKey))].filter((k) => k !== '');
  if (tagKeys.length > 0) {
    const ph = tagKeys.map(() => '?').join(',');
    if (q.tagMode === 'any') {
      clauses.push(
        `EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name_key IN (${ph}))`,
      );
      params.push(...tagKeys);
    } else {
      clauses.push(
        `(SELECT count(DISTINCT t.name_key) FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name_key IN (${ph})) = ?`,
      );
      params.push(...tagKeys, tagKeys.length);
    }
  }
  const fts = ftsQuery(q.text);
  if (fts) {
    clauses.push('i.rid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
    params.push(fts);
  }
  return { where: clauses.join(' AND '), params };
}

export function queryLibrary(db: Db, q: LibraryQuery, health?: HealthFilterContext): LibraryPage {
  const { where, params } = buildLibraryWhere(q, health);
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM items i WHERE ${where}`, params)?.n ?? 0;
  const sort = SORT_SQL[q.sort];
  const dir = q.direction === 'asc' ? 'ASC' : 'DESC';
  const nulls = sort.nullsLast ? `(${sort.expr} IS NULL) ASC, ` : '';
  // Stable tie-breaking: title then id.
  const order = `ORDER BY ${nulls}${sort.expr} ${dir}, i.sort_title ASC, i.id ASC LIMIT ? OFFSET ?`;
  const rows = db.all<SummaryRow>(`${SUMMARY_SELECT} WHERE ${where} ${order}`, [
    ...params,
    q.limit,
    q.offset,
  ]);
  return { total, items: rows.map(toSummary) };
}

export function findDuplicates(
  db: Db,
  input: {
    type: MediaType;
    title: string;
    releaseDate: string | null;
    externalIds: readonly ExternalId[];
    excludeId: string | null;
  },
): DuplicateMatch[] {
  const out = new Map<string, DuplicateMatch>();
  const exclude = input.excludeId ?? '';
  for (const e of input.externalIds) {
    if (
      ![
        'tmdb',
        'imdb',
        'tvmaze',
        'openlibrary',
        'igdb',
        'isbn13',
        'isbn10',
        'steam',
        'wikidata',
        'anilist',
        'mal',
      ].includes(e.kind)
    )
      continue;
    const rows = db.all<{ id: string; title: string; type: MediaType; release_year: number | null }>(
      `SELECT i.id, i.title, i.type, i.release_year FROM external_ids x JOIN items i ON i.id = x.item_id
       WHERE x.kind = ? AND x.value = ? AND i.type = ? AND i.deleted_at IS NULL AND i.id <> ?`,
      [e.kind, e.value, input.type, exclude],
    );
    for (const r of rows)
      out.set(r.id, { id: r.id, title: r.title, type: r.type, year: r.release_year, reason: 'provider-id' });
  }
  const year = yearOf(input.releaseDate);
  const rows = db.all<{ id: string; title: string; type: MediaType; release_year: number | null }>(
    `SELECT id, title, type, release_year FROM items
     WHERE type = ? AND title_key = ? AND deleted_at IS NULL AND id <> ?
       AND (? IS NULL OR release_year IS NULL OR release_year = ?)`,
    [input.type, titleKey(input.title), exclude, year, year],
  );
  for (const r of rows)
    if (!out.has(r.id))
      out.set(r.id, {
        id: r.id,
        title: r.title,
        type: r.type,
        year: r.release_year,
        reason: 'title-year-type',
      });
  return [...out.values()];
}
