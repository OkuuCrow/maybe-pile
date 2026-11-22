/**
 * JSON and CSV exports. Exports exclude: API keys/secrets, absolute paths,
 * logs, soft-deleted items and artwork binaries (JSON references artwork by
 * content hash or remote URL; full backups include the binaries).
 */
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

export function exportItem(db: Db, id: string): ExportItem | null {
  const d = items.loadDetail(db, id);
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

export function libraryCounts(db: Db): CountsView {
  const byType: Record<MediaType, number> = { movie: 0, tv: 0, game: 0, book: 0 };
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
  };
}

export function buildJsonExport(db: Db, appVersion: string, now: Date): ExportEnvelope {
  const ids = db
    .all<{ id: string }>('SELECT id FROM items WHERE deleted_at IS NULL ORDER BY created_at, id')
    .map((r) => r.id);
  const exported = ids.map((id) => exportItem(db, id)).filter((x): x is ExportItem => x !== null);
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
      },
    },
  };
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
