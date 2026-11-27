/**
 * JSON and CSV exports. Exports exclude: API keys/secrets, absolute paths,
 * logs, soft-deleted items and artwork binaries (JSON references artwork by
 * content hash or remote URL; full backups include the binaries).
 */
import { exportPack2 } from './pack2-portable';
import { exportPack21 } from './pack21-portable';
import { ROLE_LABELS, STATUS_LABELS, TYPE_LABELS, type MediaType } from '../../shared/enums';
import { joinList, toCsv } from '../../domain/csv';
import { ratingToStars } from '../../domain/rating';
import { entriesToLayoutFile } from '../../domain/layouts';
import { LATEST_SCHEMA_VERSION } from '../../db/migrate';
import { listAudit, listCustomFieldDefs, listSeries } from '../../db/repositories/catalog-repo';
import { listThemes, readLayout, readSettings } from '../../db/repositories/config-repo';
import * as items from '../../db/repositories/items-repo';
import { listHistory, listViewings } from '../../db/repositories/progress-repo';
import type { Db } from '../../db/connection';
import type { CountsView } from '../../shared/types';
import {
  CSV_COLUMNS,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportEnvelope,
  type ExportItem,
} from './portable-format';

export function exportItem(db: Db, id: string, includeDeleted = false): ExportItem | null {
  const d = items.loadDetail(db, id, includeDeleted);
  if (!d) return null;
  const art = db.get<{
    source: 'cache' | 'user' | 'remote';
    remote_url: string | null;
    provider_id: string | null;
    file_name: string | null;
  }>(
    'SELECT a.source, a.remote_url, a.provider_id, a.file_name FROM items i JOIN artwork a ON a.id = i.artwork_id WHERE i.id = ?',
    [id],
  );
  const customFieldsByName: Record<string, string | number | boolean> = {};
  for (const cf of d.customFields) if (cf.value !== null) customFieldsByName[cf.name] = cf.value;
  return {
    id: d.id,
    type: d.type,
    meta: d.meta,
    personal: { ...d.personal, customFields: [] },
    pass: d.pass,
    upNextPosition: d.upNextPosition,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    provenance: Object.fromEntries(
      Object.entries(d.provenance).filter(([, v]) => v !== undefined),
    ) as ExportItem['provenance'],
    sources: d.sources,
    seasons: d.seasons.map((s) => ({
      number: s.number,
      title: s.title,
      episodeCountKnown: s.episodeCountKnown,
      episodes: s.episodes.map((e) => ({
        number: e.number,
        title: e.title,
        airDate: e.airDate,
        runtime: e.runtime,
        watched: e.watched,
        watchedAt: e.watchedAt,
        source: e.source,
      })),
    })),
    milestones: d.milestones,
    progress: listHistory(db, id)
      .reverse()
      .map((h) => ({
        id: h.id,
        kind: h.kind,
        value: h.value,
        text: h.text,
        totalAtTime: h.totalAtTime,
        milestoneId: h.milestoneId,
        milestoneTitle: h.milestoneTitle,
        episodeLabel: h.episodeLabel,
        watched: h.watched,
        scheme: h.scheme,
        pass: h.pass,
        occurredAt: h.occurredAt,
        recordedAt: h.recordedAt,
        note: h.note,
      })),
    viewings: listViewings(db, id)
      .reverse()
      .map((v) => ({ watchedAt: v.watchedAt, note: v.note, pass: v.pass, createdAt: v.createdAt })),
    artwork: art
      ? { source: art.source, remoteUrl: art.remote_url, providerId: art.provider_id, file: art.file_name }
      : null,
    audit: listAudit(db, id)
      .reverse()
      .map((a) => ({ at: a.at, action: a.action, providerId: a.providerId, changes: a.changes })),
    customFieldsByName,
  };
}

export function emptyCounts(): CountsView {
  return {
    items: { movie: 0, tv: 0, game: 0, book: 0, anime: 0 },
    episodes: 0,
    progressEntries: 0,
    viewings: 0,
    tags: 0,
    themes: 0,
    layouts: 0,
    artwork: 0,
    lists: 0,
    upNext: 0,
    snoozes: 0,
    goals: 0,
    librarySources: 0,
    sourceEntries: 0,
    importBatches: 0,
    mappingProfiles: 0,
  };
}

export function libraryCounts(db: Db): CountsView {
  const byType: Record<MediaType, number> = { movie: 0, tv: 0, game: 0, book: 0, anime: 0 };
  for (const r of db.all<{ type: MediaType; n: number }>(
    'SELECT type, count(*) AS n FROM items WHERE deleted_at IS NULL GROUP BY type',
  ))
    byType[r.type] = r.n;
  const n = (sql: string) => db.get<{ n: number }>(sql)?.n ?? 0;
  return {
    items: byType,
    episodes: n(
      'SELECT count(*) AS n FROM episodes e JOIN items i ON i.id = e.item_id WHERE i.deleted_at IS NULL',
    ),
    progressEntries: n(
      'SELECT count(*) AS n FROM progress_events p JOIN items i ON i.id = p.item_id WHERE p.deleted_at IS NULL AND i.deleted_at IS NULL',
    ),
    viewings: n(
      'SELECT count(*) AS n FROM viewing_events v JOIN items i ON i.id = v.item_id WHERE i.deleted_at IS NULL',
    ),
    tags: n('SELECT count(*) AS n FROM tags'),
    themes: n('SELECT count(*) AS n FROM themes'),
    layouts: n('SELECT count(DISTINCT surface) AS n FROM layout_components'),
    artwork: n("SELECT count(*) AS n FROM artwork WHERE source <> 'remote'"),
    lists: n('SELECT count(*) AS n FROM lists'),
    upNext: n(
      'SELECT count(*) AS n FROM up_next u JOIN items i ON i.id = u.item_id WHERE i.deleted_at IS NULL',
    ),
    snoozes: n(
      'SELECT count(*) AS n FROM item_snoozes z JOIN items i ON i.id = z.item_id WHERE i.deleted_at IS NULL',
    ),
    goals: n('SELECT count(*) AS n FROM goals'),
    librarySources: n('SELECT count(*) AS n FROM library_sources'),
    sourceEntries: n('SELECT count(*) AS n FROM library_source_entries'),
    importBatches: n('SELECT count(*) AS n FROM import_batches'),
    mappingProfiles: n('SELECT count(*) AS n FROM csv_mapping_profiles'),
  };
}

export function buildJsonExport(db: Db, appVersion: string, now: Date): ExportEnvelope {
  // 2.1: Recently deleted items are exported too; `pack21.trash` marks them (with their deletion time).
  const ids = db.all<{ id: string }>('SELECT id FROM items ORDER BY created_at, id').map((r) => r.id);
  const exported = ids.map((id) => exportItem(db, id, true)).filter((x): x is ExportItem => x !== null);
  const { settings } = readSettings(db);
  const counts = libraryCounts(db);
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    appVersion,
    schemaVersion: LATEST_SCHEMA_VERSION,
    counts: {
      ...counts.items,
      episodes: counts.episodes,
      progressEntries: counts.progressEntries,
      viewings: counts.viewings,
      tags: counts.tags,
      themes: counts.themes,
    },
    data: {
      items: exported,
      customFieldDefs: listCustomFieldDefs(db).map((d) => ({
        name: d.name,
        type: d.type,
        options: d.options,
      })),
      series: listSeries(db).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        totalKnown: s.totalKnown,
        members: s.members.map((m) => ({ itemId: m.itemId, position: m.position })),
      })),
      themes: listThemes(db)
        .filter((t) => t.tokens !== null)
        .map((t) => ({ id: t.id, name: t.name, tokens: t.tokens as NonNullable<typeof t.tokens> })),
      layouts: entriesToLayoutFile({
        dashboard: readLayout(db, 'dashboard').entries,
        library: readLayout(db, 'library').entries,
      }),
      // Settings never contain secrets (keys live in secrets.json), but the saved
      // library query is user-specific UI state and is omitted.
      settings: {
        activeThemeId: settings.activeThemeId,
        region: settings.region,
        autoApplySuggestions: settings.autoApplySuggestions,
        libraryView: settings.libraryView,
        csvBom: settings.csvBom,
        upNextMax: settings.upNextMax,
        pick: settings.pick,
        pileHealth: settings.pileHealth,
        releaseRadar: settings.releaseRadar,
        quickCapture: settings.quickCapture,
        stats: settings.stats,
        importUndoRetentionDays: settings.importUndoRetentionDays,
        // Expansion Pack 2. `sync` is deliberately omitted: its folder path is machine-specific.
        anime: settings.anime,
        artwork: settings.artwork,
        spoilers: settings.spoilers,
        value: settings.value,
        sessions: settings.sessions,
        availability: settings.availability,
        recommendations: settings.recommendations,
      },
      ...exportFeatureData(db),
      pack2: exportPack2(db),
      pack21: exportPack21(db),
    },
  };
}

/** formatVersion 2 sections. Secrets (API keys) live outside the database and are never included. */
export function exportFeatureData(
  db: Db,
): Pick<
  ExportEnvelope['data'],
  'lists' | 'goals' | 'snoozes' | 'librarySources' | 'importBatches' | 'mappingProfiles'
> {
  type ListRow = {
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    icon: string | null;
    position: number;
  };
  const lists = db
    .all<ListRow>('SELECT id, name, description, color, icon, position FROM lists ORDER BY position')
    .map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      color: l.color as NonNullable<ExportEnvelope['data']['lists']>[number]['color'],
      icon: l.icon as NonNullable<ExportEnvelope['data']['lists']>[number]['icon'],
      position: l.position,
      items: db
        .all<{ item_id: string; position: number }>(
          `SELECT li.item_id, li.position FROM list_items li JOIN items i ON i.id = li.item_id
         WHERE li.list_id = ? AND i.deleted_at IS NULL ORDER BY li.position`,
          [l.id],
        )
        .map((r) => ({ itemId: r.item_id, position: r.position })),
    }));
  const goals = db
    .all<{
      id: string;
      title: string;
      media_type: MediaType | null;
      metric: 'items' | 'pages' | 'episodes' | 'hours';
      period: 'year' | 'month' | 'custom';
      start_date: string;
      end_date: string;
      target: number;
      list_id: string | null;
      tag: string | null;
      archived_at: string | null;
      created_at: string;
    }>('SELECT * FROM goals ORDER BY created_at')
    .map((g) => ({
      id: g.id,
      title: g.title,
      mediaType: g.media_type,
      metric: g.metric,
      period: g.period,
      startDate: g.start_date,
      endDate: g.end_date,
      target: g.target,
      listId: g.list_id,
      tag: g.tag,
      archivedAt: g.archived_at,
      createdAt: g.created_at,
    }));
  const snoozes = db
    .all<{ item_id: string; until: string; reason: 'manual' | 'pile-health' | 'keep'; created_at: string }>(
      `SELECT z.item_id, z.until, z.reason, z.created_at FROM item_snoozes z JOIN items i ON i.id = z.item_id WHERE i.deleted_at IS NULL`,
    )
    .map((z) => ({ itemId: z.item_id, until: z.until, reason: z.reason, createdAt: z.created_at }));
  const librarySources = db
    .all<{
      id: string;
      kind: 'steam' | 'manual';
      label: string;
      account_ref: string | null;
      account_input: string | null;
      last_synced_at: string | null;
      last_sync_status: 'ok' | 'private' | 'error' | 'cancelled' | 'empty' | null;
      created_at: string;
    }>('SELECT * FROM library_sources ORDER BY created_at')
    .map((src) => ({
      id: src.id,
      kind: src.kind,
      label: src.label,
      accountRef: src.account_ref,
      accountInput: src.account_input,
      lastSyncedAt: src.last_synced_at,
      lastSyncStatus: src.last_sync_status,
      createdAt: src.created_at,
      entries: db
        .all<{
          external_id: string;
          name: string;
          platform: string | null;
          playtime_minutes: number | null;
          prev_playtime_minutes: number | null;
          last_played_at: string | null;
          non_game_reason: string | null;
          first_seen_at: string;
          seen_at: string;
          removed_at: string | null;
          ignored: number;
          item_id: string | null;
        }>(
          `SELECT e.*, CASE WHEN i.deleted_at IS NULL THEN e.item_id END AS item_id
           FROM library_source_entries e LEFT JOIN items i ON i.id = e.item_id WHERE e.source_id = ? ORDER BY e.external_id`,
          [src.id],
        )
        .map((e) => ({
          externalId: e.external_id,
          name: e.name,
          platform: e.platform,
          playtimeMinutes: e.playtime_minutes,
          prevPlaytimeMinutes: e.prev_playtime_minutes,
          lastPlayedAt: e.last_played_at,
          nonGameReason: e.non_game_reason,
          firstSeenAt: e.first_seen_at,
          seenAt: e.seen_at,
          removedAt: e.removed_at,
          ignored: e.ignored === 1,
          itemId: e.item_id,
        })),
    }));
  const importBatches = db
    .all<{
      id: string;
      kind: 'steam' | 'manual-list' | 'goodreads' | 'letterboxd' | 'csv-mapped' | 'mal-xml';
      source_id: string | null;
      label: string;
      created_at: string;
      undone_at: string | null;
    }>('SELECT * FROM import_batches ORDER BY created_at')
    .map((b) => ({
      id: b.id,
      kind: b.kind,
      sourceId: b.source_id,
      label: b.label,
      createdAt: b.created_at,
      undoneAt: b.undone_at,
      items: db
        .all<{ item_id: string; title: string; baseline_updated_at: string; baseline_events: number }>(
          'SELECT item_id, title, baseline_updated_at, baseline_events FROM import_batch_items WHERE batch_id = ?',
          [b.id],
        )
        .map((i) => ({
          itemId: i.item_id,
          title: i.title,
          baselineUpdatedAt: i.baseline_updated_at,
          baselineEvents: i.baseline_events,
        })),
    }));
  const mappingProfiles = db
    .all<{ name: string; mapping: string }>('SELECT name, mapping FROM csv_mapping_profiles ORDER BY name')
    .map((m) => ({ name: m.name, mapping: JSON.parse(m.mapping) as unknown }));
  return { lists, goals, snoozes, librarySources, importBatches, mappingProfiles };
}

export function buildCsvExport(db: Db, bom: boolean): string {
  const ids = db
    .all<{ id: string }>('SELECT id FROM items WHERE deleted_at IS NULL ORDER BY sort_title, id')
    .map((r) => r.id);
  const rows: (string | number | null)[][] = [];
  for (const id of ids) {
    const d = items.loadDetail(db, id);
    if (!d) continue;
    const ext = (k: string) => d.meta.externalIds.find((e) => e.kind === k)?.value ?? null;
    const record: Record<(typeof CSV_COLUMNS)[number], string | number | null> = {
      id: d.id,
      type: d.type,
      title: d.meta.title,
      alt_titles: joinList(d.meta.altTitles),
      status: d.personal.status,
      rating_stars: ratingToStars(d.personal.rating),
      date_added: d.personal.dateAdded,
      date_started: d.personal.dateStarted,
      date_completed: d.personal.dateCompleted,
      release_date: d.meta.releaseDate,
      tags: joinList(d.personal.tags),
      genres: joinList(d.meta.genres),
      creators: joinList(d.meta.creators.map((c) => `${c.name} (${ROLE_LABELS[c.role]})`)),
      imdb_id: ext('imdb'),
      tmdb_id: ext('tmdb'),
      tvmaze_id: ext('tvmaze'),
      igdb_id: ext('igdb'),
      openlibrary_id: ext('openlibrary'),
      isbn13: d.meta.isbn13 ?? ext('isbn13'),
      isbn10: d.meta.isbn10 ?? ext('isbn10'),
      steam: ext('steam'),
      xbox: ext('xbox'),
      playstation: ext('playstation'),
      runtime_minutes: d.meta.runtimeMinutes ?? d.meta.episodeRuntime,
      network: d.meta.network,
      show_status: d.meta.showStatus,
      page_count: d.meta.pageCount,
      publisher: d.meta.publisher,
      book_format: d.personal.bookFormat,
      platforms: joinList(d.personal.platforms.map((p) => p.name)),
      game_progress_scheme: d.personal.gameScheme,
      progress: d.progress.label,
      progress_percent: d.progress.percent,
      notes: d.personal.notes,
      lists: joinList(d.lists.map((l) => l.name)),
      up_next_position: d.upNextPosition === null ? null : d.upNextPosition + 1,
    };
    rows.push(CSV_COLUMNS.map((c) => record[c]));
  }
  return toCsv(CSV_COLUMNS, rows, bom);
}

/** Human labels used in docs and the export dialog. */
export const CSV_NOTES = {
  status: Object.keys(STATUS_LABELS).join(' | '),
  type: Object.keys(TYPE_LABELS).join(' | '),
};
