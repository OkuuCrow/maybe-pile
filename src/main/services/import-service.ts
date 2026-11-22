/**
 * JSON and CSV import with preview, conflict detection and merge.
 *
 * Nothing is written until `apply` is called with the preview token. The whole
 * apply runs in a single transaction: any failure leaves the library exactly as
 * it was. Validation errors block the import (all-or-nothing) so a library is
 * never partially imported from a damaged file.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CREATOR_ROLES,
  MEDIA_TYPES,
  ROLE_LABELS,
  STATUSES,
  type CreatorRole,
  type MediaType,
} from '../../shared/enums';
import { appError } from '../../shared/result';
import {
  IdSchema,
  MetadataFieldsSchema,
  PersonalFieldsSchema,
  type ImportApplyInput,
  type MetadataFields,
  type PersonalFields,
} from '../../shared/schemas';
import type {
  CountsView,
  ImportConflictView,
  ImportPreviewView,
  ImportResultView,
  ValidationMessage,
} from '../../shared/types';
import { CsvParseError, parseCsv, restoreFormula, splitList } from '../../domain/csv';
import { localDate } from '../../domain/dates';
import { checkExternalUrl } from '../../domain/links';
import { defaultPersonal, emptyMeta, pruneMetaForType } from '../../domain/metadata';
import { starsToRating } from '../../domain/rating';
import { formatZodIssues } from '../../domain/themes';
import { ARTWORK_HOSTS } from '../../providers/registry';
import {
  customFieldTypes,
  findCustomFieldByName,
  setSeriesMembership,
  upsertCustomFieldDef,
  upsertSeries,
} from '../../db/repositories/catalog-repo';
import { listThemes, upsertTheme } from '../../db/repositories/config-repo';
import * as items from '../../db/repositories/items-repo';
import { insertProgressEvent } from '../../db/repositories/progress-repo';
import { b2i } from '../../db/connection';
import type { ServiceContext } from './context';
import { libraryCounts } from './export-service';
import type { LibraryService } from './library-service';
import { ARTWORK_FILE_RE } from './artwork-service';
import {
  CSV_COLUMNS,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  ExportEnvelopeSchema,
  ExportItemSchema,
  MAX_IMPORT_BYTES,
  type ExportEnvelope,
  type ExportItem,
} from './portable-format';

interface Pending {
  kind: 'json' | 'csv';
  items: ExportItem[];
  conflicts: (ImportConflictView & { index: number })[];
  envelope: ExportEnvelope | null;
  at: number;
}

const MAX_MESSAGES = 100;

function emptyCounts(): CountsView {
  return {
    items: { movie: 0, tv: 0, game: 0, book: 0 },
    episodes: 0,
    progressEntries: 0,
    viewings: 0,
    tags: 0,
    themes: 0,
    layouts: 0,
    artwork: 0,
  };
}

export class ImportService {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly library: LibraryService,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  /* ---------------------------------------------------------------- JSON */

  previewJson(textContent: string, fileLabel: string): ImportPreviewView {
    const messages: ValidationMessage[] = [];
    const fail = (message: string, path = '$'): ImportPreviewView =>
      this.failedPreview('json', fileLabel, [{ severity: 'error', path, message }]);
    if (textContent.length > MAX_IMPORT_BYTES) return fail('File is larger than the 200 MB import limit.');
    let json: unknown;
    try {
      json = JSON.parse(textContent.charCodeAt(0) === 0xfeff ? textContent.slice(1) : textContent);
    } catch {
      return fail('File is not valid JSON. It may be truncated or not a Maybe Pile export.');
    }
    const fmt = (json as { format?: unknown } | null)?.format;
    if (fmt !== EXPORT_FORMAT)
      return fail('This is not a Maybe Pile export file (missing "format": "maybepile-export").', '$.format');
    const ver = (json as { formatVersion?: unknown }).formatVersion;
    if (typeof ver === 'number' && ver > EXPORT_FORMAT_VERSION) {
      return fail(
        `This export uses format version ${ver}; this app supports up to ${EXPORT_FORMAT_VERSION}. Update Maybe Pile to import it.`,
        '$.formatVersion',
      );
    }
    const env = ExportEnvelopeSchema.safeParse(json);
    if (!env.success) {
      return this.failedPreview(
        'json',
        fileLabel,
        formatZodIssues(env.error).map((i) => ({
          severity: 'error' as const,
          path: i.path,
          message: i.message,
        })),
      );
    }
    const parsedItems: ExportItem[] = [];
    env.data.data.items.forEach((raw, i) => {
      const r = ExportItemSchema.safeParse(raw);
      if (r.success) parsedItems.push(r.data);
      else if (messages.length < MAX_MESSAGES) {
        for (const iss of formatZodIssues(r.error).slice(0, 3)) {
          messages.push({
            severity: 'error',
            path: iss.path.replace('$', `$.data.items[${i}]`),
            message: iss.message,
          });
        }
      }
    });
    const ids = new Set<string>();
    parsedItems.forEach((it, i) => {
      if (ids.has(it.id))
        messages.push({
          severity: 'error',
          path: `$.data.items[${i}].id`,
          message: 'Duplicate item id within the file.',
        });
      ids.add(it.id);
      if (
        it.artwork &&
        it.artwork.source !== 'remote' &&
        it.artwork.file &&
        !existsSync(join(this.ctx.paths.artwork, it.artwork.file))
      ) {
        if (messages.filter((m) => m.path === '$artwork').length === 0) {
          messages.push({
            severity: 'warning',
            path: '$artwork',
            message:
              'Some cached artwork is not included in JSON exports and is not on this computer; those items will have no image. Use a full backup to move artwork.',
          });
        }
      }
    });
    return this.storePreview('json', fileLabel, parsedItems, env.data, messages);
  }

  /* ---------------------------------------------------------------- CSV */

  previewCsv(textContent: string, fileLabel: string): ImportPreviewView {
    if (textContent.length > MAX_IMPORT_BYTES) {
      return this.failedPreview('csv', fileLabel, [
        { severity: 'error', path: '$', message: 'File is larger than the 200 MB import limit.' },
      ]);
    }
    let rows: string[][];
    try {
      rows = parseCsv(textContent);
    } catch (e) {
      const line = e instanceof CsvParseError ? e.line : 0;
      return this.failedPreview('csv', fileLabel, [
        { severity: 'error', path: `line ${line}`, message: e instanceof Error ? e.message : 'Invalid CSV.' },
      ]);
    }
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
    if (!header.includes('type') || !header.includes('title')) {
      return this.failedPreview('csv', fileLabel, [
        {
          severity: 'error',
          path: 'header',
          message: 'The first row must contain at least "type" and "title" columns.',
        },
      ]);
    }
    const messages: ValidationMessage[] = [];
    const unknown = header.filter((h) => h !== '' && !(CSV_COLUMNS as readonly string[]).includes(h));
    if (unknown.length > 0)
      messages.push({
        severity: 'warning',
        path: 'header',
        message: `Ignored unknown column(s): ${unknown.slice(0, 10).join(', ')}.`,
      });
    const today = localDate(this.ctx.clock.now());
    const out: ExportItem[] = [];
    const seenIds = new Set<string>();
    rows.slice(1).forEach((cells, idx) => {
      const rowNo = idx + 2;
      const get = (c: string): string => {
        const i = header.indexOf(c);
        return i === -1 ? '' : restoreFormula((cells[i] ?? '').trim());
      };
      const err = (col: string, message: string) => {
        if (messages.length < MAX_MESSAGES)
          messages.push({ severity: 'error', path: `row ${rowNo}, ${col}`, message });
      };
      const r = this.csvRowToItem(get, today, err);
      if (!r) return;
      if (seenIds.has(r.id)) {
        err('id', 'Duplicate id within the file.');
        return;
      }
      seenIds.add(r.id);
      out.push(r);
    });
    if (rows.length <= 1)
      messages.push({ severity: 'warning', path: '$', message: 'The file has no data rows.' });
    return this.storePreview('csv', fileLabel, out, null, messages);
  }

  private csvRowToItem(
    get: (c: string) => string,
    today: string,
    err: (col: string, msg: string) => void,
  ): ExportItem | null {
    const type = get('type').toLowerCase() as MediaType;
    if (!(MEDIA_TYPES as readonly string[]).includes(type)) {
      err('type', `Type must be one of: ${MEDIA_TYPES.join(', ')}.`);
      return null;
    }
    const creators = splitList(get('creators')).map((c) => {
      const m = /^(.*)\(([^)]+)\)\s*$/.exec(c);
      const roleLabel = m?.[2]?.trim().toLowerCase() ?? '';
      const role = (CREATOR_ROLES as readonly string[]).find(
        (r) => r === roleLabel || ROLE_LABELS[r as CreatorRole].toLowerCase() === roleLabel,
      ) as CreatorRole | undefined;
      const fallback: CreatorRole =
        type === 'book' ? 'author' : type === 'game' ? 'developer' : type === 'tv' ? 'creator' : 'director';
      return { name: (m ? (m[1] ?? '') : c).trim(), role: role ?? fallback };
    });
    const ext: { kind: string; value: string }[] = [];
    const add = (kind: string, col: string) => {
      const v = get(col);
      if (v) ext.push({ kind, value: v });
    };
    add('imdb', 'imdb_id');
    add('tmdb', 'tmdb_id');
    add('tvmaze', 'tvmaze_id');
    add('igdb', 'igdb_id');
    add('openlibrary', 'openlibrary_id');
    add('isbn13', 'isbn13');
    add('isbn10', 'isbn10');
    add('steam', 'steam');
    add('xbox', 'xbox');
    add('playstation', 'playstation');
    const num = (col: string): number | null => {
      const v = get(col);
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        err(col, 'Must be a number.');
        return null;
      }
      return n;
    };
    const metaRaw: MetadataFields = {
      ...emptyMeta(get('title')),
      altTitles: splitList(get('alt_titles')),
      releaseDate: get('release_date') || null,
      genres: splitList(get('genres')),
      creators,
      externalIds: ext as MetadataFields['externalIds'],
      runtimeMinutes: type === 'movie' ? num('runtime_minutes') : null,
      episodeRuntime: type === 'tv' ? num('runtime_minutes') : null,
      network: get('network') || null,
      showStatus: (get('show_status') || null) as MetadataFields['showStatus'],
      pageCount: num('page_count'),
      publisher: get('publisher') || null,
      isbn13: get('isbn13') || null,
      isbn10: get('isbn10') || null,
    };
    const meta = MetadataFieldsSchema.safeParse(pruneMetaForType(type, metaRaw));
    if (!meta.success) {
      for (const i of formatZodIssues(meta.error).slice(0, 3)) err(i.path.replace('$.', ''), i.message);
      return null;
    }
    const status = (get('status')
      .toLowerCase()
      .replace(/[\s-]+/g, '_') || 'planned') as PersonalFields['status'];
    if (!(STATUSES as readonly string[]).includes(status)) {
      err('status', `Status must be one of: ${STATUSES.join(', ')}.`);
      return null;
    }
    const stars = num('rating_stars');
    const rating = stars === null ? null : starsToRating(stars);
    if (stars !== null && rating === null)
      err('rating_stars', 'Rating must be between 0.5 and 5 in half-star steps.');
    const personalRaw: PersonalFields = {
      ...defaultPersonal(type, today),
      status,
      rating,
      notes: get('notes'),
      dateAdded: get('date_added') || today,
      dateStarted: get('date_started') || null,
      dateCompleted: get('date_completed') || null,
      tags: splitList(get('tags')),
      platforms:
        type === 'game'
          ? splitList(get('platforms')).map((name) => ({ name, owned: true, played: false }))
          : [],
      gameScheme:
        type === 'game' ? ((get('game_progress_scheme') || 'percent') as PersonalFields['gameScheme']) : null,
      bookFormat: type === 'book' ? ((get('book_format') || 'print') as PersonalFields['bookFormat']) : null,
    };
    const personal = PersonalFieldsSchema.safeParse(personalRaw);
    if (!personal.success) {
      for (const i of formatZodIssues(personal.error).slice(0, 3)) err(i.path.replace('$.', ''), i.message);
      return null;
    }
    const idCell = get('id');
    const id = idCell && IdSchema.safeParse(idCell).success ? idCell.toLowerCase() : randomUUID();
    const now = this.ctx.clock.now().toISOString();
    return {
      id,
      type,
      meta: meta.data,
      personal: personal.data,
      pass: 1,
      createdAt: now,
      updatedAt: now,
      provenance: {},
      sources: [],
      seasons: [],
      milestones: [],
      progress: [],
      viewings: [],
      artwork: null,
      audit: [],
      customFieldsByName: {},
    };
  }

  /* ---------------------------------------------------------------- shared preview */

  private failedPreview(
    kind: 'json' | 'csv',
    fileLabel: string,
    messages: ValidationMessage[],
  ): ImportPreviewView {
    return {
      token: '',
      kind,
      fileLabel,
      formatVersion: '—',
      mode: 'merge',
      incoming: emptyCounts(),
      current: libraryCounts(this.db),
      messages,
      conflicts: [],
      canApply: false,
      summary: 'Nothing will be imported because the file has errors.',
      confirmationWord: null,
    };
  }

  private storePreview(
    kind: 'json' | 'csv',
    fileLabel: string,
    list: ExportItem[],
    envelope: ExportEnvelope | null,
    messages: ValidationMessage[],
  ): ImportPreviewView {
    const conflicts: (ImportConflictView & { index: number })[] = [];
    list.forEach((it, index) => {
      const existing = items.getItemRow(this.db, it.id);
      if (existing) {
        conflicts.push({
          id: `c${index}`,
          index,
          reason: 'local-id',
          importedTitle: it.meta.title,
          existingTitle: existing.title,
          existingId: existing.id,
          importIsNewer: kind === 'csv' ? null : it.updatedAt > existing.updated_at,
        });
        return;
      }
      const dup = items.findDuplicates(this.db, {
        type: it.type,
        title: it.meta.title,
        releaseDate: it.meta.releaseDate,
        externalIds: it.meta.externalIds,
        excludeId: null,
      })[0];
      if (dup) {
        const ex = items.getItemRow(this.db, dup.id);
        conflicts.push({
          id: `c${index}`,
          index,
          reason: dup.reason,
          importedTitle: it.meta.title,
          existingTitle: dup.title,
          existingId: dup.id,
          importIsNewer: kind === 'csv' || !ex ? null : it.updatedAt > ex.updated_at,
        });
      }
    });
    const incoming = emptyCounts();
    for (const it of list) {
      incoming.items[it.type]++;
      incoming.episodes += it.seasons.reduce((n, s) => n + s.episodes.length, 0);
      incoming.progressEntries += it.progress.length;
      incoming.viewings += it.viewings.length;
    }
    incoming.tags = new Set(list.flatMap((i) => i.personal.tags.map((t) => t.toLowerCase()))).size;
    incoming.themes = envelope?.data.themes.length ?? 0;
    incoming.layouts = envelope?.data.layouts ? 2 : 0;
    const hasErrors = messages.some((m) => m.severity === 'error');
    const token = hasErrors ? '' : randomBytes(16).toString('hex');
    if (token) {
      this.pending.set(token, { kind, items: list, conflicts, envelope, at: Date.now() });
      while (this.pending.size > 5) {
        const k = this.pending.keys().next().value;
        if (k === undefined) break;
        this.pending.delete(k);
      }
    }
    const newCount = list.length - conflicts.length;
    return {
      token,
      kind,
      fileLabel,
      formatVersion: envelope
        ? `${envelope.format} v${envelope.formatVersion} (app ${envelope.appVersion})`
        : 'CSV',
      mode: 'merge',
      incoming,
      current: libraryCounts(this.db),
      messages,
      conflicts: conflicts.map(({ index: _index, ...c }) => c),
      canApply: !hasErrors && list.length > 0,
      summary: hasErrors
        ? 'Nothing will be imported because the file has errors. Fix them and try again.'
        : `Merge: ${newCount} new item(s) will be added. ${conflicts.length} conflict(s) will be handled as you choose below. Your existing items are never deleted.${envelope?.data.themes.length ? ` ${envelope.data.themes.length} custom theme(s) will be added.` : ''}`,
      confirmationWord: null,
    };
  }

  /* ---------------------------------------------------------------- apply */

  apply(input: ImportApplyInput, opts: { failAfterItems?: number } = {}): ImportResultView {
    const p = this.pending.get(input.token);
    if (!p)
      throw appError('NOT_FOUND', 'This import preview has expired.', { recovery: 'Choose the file again.' });
    const db = this.db;
    const now = this.ctx.clock.now().toISOString();
    const result: ImportResultView = { added: 0, updated: 0, skipped: 0, duplicated: 0, snapshotLabel: null };
    const conflictByIndex = new Map(p.conflicts.map((c) => [c.index, c]));
    db.transaction(() => {
      const defIds = this.ensureCustomFieldDefs(p, now);
      const idMap = new Map<string, string>();
      p.items.forEach((it, index) => {
        if (opts.failAfterItems !== undefined && index >= opts.failAfterItems)
          throw new Error('Injected import failure');
        const c = conflictByIndex.get(index);
        if (!c) {
          // A soft-deleted item with the same id is permanently replaced.
          const ghost = items.getItemRow(db, it.id, true);
          if (ghost?.deleted_at) {
            db.run('DELETE FROM items_fts WHERE rowid = ?', [ghost.rid]);
            db.run('DELETE FROM items WHERE id = ?', [it.id]);
          }
          this.insertFull(it, it.id, defIds, now);
          idMap.set(it.id, it.id);
          result.added++;
          return;
        }
        const resolution = input.resolutions[c.id] ?? input.defaultResolution;
        if (resolution === 'skip') {
          result.skipped++;
        } else if (resolution === 'duplicate') {
          const newId = randomUUID();
          this.insertFull(it, newId, defIds, now);
          idMap.set(it.id, newId);
          result.duplicated++;
        } else if (c.importIsNewer === false) {
          // Never overwrite a newer local edit.
          result.skipped++;
        } else {
          const ex = items.getItemRow(db, c.existingId, true);
          if (ex) {
            db.run('DELETE FROM items_fts WHERE rowid = ?', [ex.rid]);
            db.run('DELETE FROM items WHERE id = ?', [ex.id]);
          }
          this.insertFull(it, c.existingId, defIds, now);
          idMap.set(it.id, c.existingId);
          result.updated++;
        }
      });
      if (p.envelope) this.applyExtras(p.envelope, idMap, now);
      items.pruneOrphans(db);
    });
    this.pending.delete(input.token);
    this.ctx.log.info('import.applied', { kind: p.kind, ...result });
    return result;
  }

  private ensureCustomFieldDefs(p: Pending, now: string): Map<string, string> {
    const map = new Map<string, string>();
    const local = customFieldTypes(this.db);
    for (const d of p.envelope?.data.customFieldDefs ?? []) {
      const existing = findCustomFieldByName(this.db, d.name);
      if (existing) {
        if (local.get(existing.id) === d.type) map.set(d.name, existing.id);
        continue;
      }
      map.set(
        d.name,
        upsertCustomFieldDef(this.db, { id: null, name: d.name, type: d.type, options: d.options }, now),
      );
    }
    return map;
  }

  private insertFull(it: ExportItem, id: string, defIds: Map<string, string>, now: string): void {
    const db = this.db;
    const types = customFieldTypes(db);
    const customFields = Object.entries(it.customFieldsByName)
      .map(([name, value]) => ({ defId: defIds.get(name) ?? '', value }))
      .filter((c) => {
        const t = types.get(c.defId);
        if (!t) return false;
        return t === 'number'
          ? typeof c.value === 'number'
          : t === 'boolean'
            ? typeof c.value === 'boolean'
            : typeof c.value === 'string';
      });
    const personal = { ...it.personal, customFields };
    this.library.insertItem(
      id,
      it.type,
      pruneMetaForType(it.type, it.meta),
      personal,
      [],
      [],
      { kind: 'import' },
      now,
    );

    db.run('UPDATE items SET created_at = ?, updated_at = ?, pass = ? WHERE id = ?', [
      it.createdAt,
      it.updatedAt,
      it.pass,
      id,
    ]);
    if (Object.keys(it.provenance).length > 0) {
      db.run('DELETE FROM field_provenance WHERE item_id = ?', [id]);
      for (const [field, v] of Object.entries(it.provenance)) {
        items.setProvenance(
          db,
          id,
          field as keyof MetadataFields,
          v.origin,
          v.providerId,
          v.providerValue,
          v.updatedAt,
        );
      }
    }
    for (const s of it.sources) items.setSource(db, id, s.providerId, s.providerRef, s.url, s.fetchedAt);
    for (const s of it.seasons) {
      const sid = randomUUID();
      db.run(
        'INSERT INTO seasons (id, item_id, season_number, title, episode_count_known) VALUES (?, ?, ?, ?, ?)',
        [sid, id, s.number, s.title, s.episodeCountKnown],
      );
      const seen = new Set<number>();
      for (const e of s.episodes) {
        if (seen.has(e.number)) continue;
        seen.add(e.number);
        db.run(
          `INSERT INTO episodes (id, season_id, item_id, episode_number, title, air_date, runtime, watched, watched_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            sid,
            id,
            e.number,
            e.title,
            e.airDate,
            e.runtime,
            b2i(e.watched),
            e.watchedAt,
            e.source,
          ],
        );
      }
    }
    const milestoneMap = new Map<string, string>();
    for (const m of it.milestones) {
      const mid = db.get('SELECT 1 FROM game_milestones WHERE id = ?', [m.id]) ? randomUUID() : m.id;
      milestoneMap.set(m.id, mid);
      db.run('INSERT INTO game_milestones (id, item_id, position, title) VALUES (?, ?, ?, ?)', [
        mid,
        id,
        m.position,
        m.title,
      ]);
    }
    for (const e of it.progress) {
      insertProgressEvent(db, {
        id: db.get('SELECT 1 FROM progress_events WHERE id = ?', [e.id]) ? randomUUID() : e.id,
        itemId: id,
        kind: e.kind,
        value: e.kind === 'percent' && e.value !== null ? Math.max(0, Math.min(100, e.value)) : e.value,
        text: e.text,
        totalAtTime: e.totalAtTime,
        milestoneId: e.milestoneId ? (milestoneMap.get(e.milestoneId) ?? null) : null,
        milestoneTitle: e.milestoneTitle,
        episodeId: null,
        episodeLabel: e.episodeLabel,
        watched: e.watched,
        scheme: e.scheme,
        pass: e.pass,
        occurredAt: e.occurredAt,
        recordedAt: e.recordedAt,
        note: e.note,
      });
    }
    for (const v of it.viewings) {
      db.run(
        'INSERT INTO viewing_events (id, item_id, watched_at, note, pass, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [randomUUID(), id, v.watchedAt, v.note, v.pass, v.createdAt],
      );
    }
    for (const a of it.audit) {
      const aid = randomUUID();
      db.run('INSERT INTO audit_entries (id, item_id, at, action, provider_id) VALUES (?, ?, ?, ?, ?)', [
        aid,
        id,
        a.at,
        a.action,
        a.providerId,
      ]);
      for (const ch of a.changes) {
        db.run(
          'INSERT OR REPLACE INTO audit_changes (audit_id, field, old_value, new_value) VALUES (?, ?, ?, ?)',
          [aid, ch.field, ch.oldValue, ch.newValue],
        );
      }
    }
    if (it.artwork) this.attachArtwork(id, it.artwork, now);
    items.reindexItem(db, id);
    items.recomputeProgress(db, id);
  }

  /** Artwork references: remote URLs re-validated; cached files reused only if already present locally. */
  private attachArtwork(itemId: string, a: NonNullable<ExportItem['artwork']>, now: string): void {
    const db = this.db;
    let artId: string | null = null;
    if (
      a.source !== 'remote' &&
      a.file &&
      ARTWORK_FILE_RE.test(a.file) &&
      existsSync(join(this.ctx.paths.artwork, a.file))
    ) {
      const thumb = a.file.replace(/\.(jpg|png)$/, '.thumb.jpg');
      artId = randomUUID();
      db.run(
        'INSERT INTO artwork (id, source, file_name, thumb_name, remote_url, provider_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          artId,
          a.source,
          a.file,
          existsSync(join(this.ctx.paths.artwork, thumb)) ? thumb : null,
          a.remoteUrl && checkExternalUrl(a.remoteUrl, ARTWORK_HOSTS).ok ? a.remoteUrl : null,
          a.providerId,
          now,
        ],
      );
    } else if (a.remoteUrl) {
      const check = checkExternalUrl(a.remoteUrl, ARTWORK_HOSTS);
      if (check.ok) {
        artId = randomUUID();
        db.run(
          "INSERT INTO artwork (id, source, remote_url, provider_id, created_at) VALUES (?, 'remote', ?, ?, ?)",
          [artId, check.url, a.providerId, now],
        );
      }
    }
    if (artId) db.run('UPDATE items SET artwork_id = ? WHERE id = ?', [artId, itemId]);
  }

  private applyExtras(env: ExportEnvelope, idMap: Map<string, string>, now: string): void {
    const db = this.db;
    const existingThemes = listThemes(db);
    const takenNames = new Set(existingThemes.map((t) => t.name.toLowerCase()));
    for (const t of env.data.themes) {
      if (existingThemes.some((x) => x.id === t.id)) continue;
      let name = t.name;
      for (let n = 2; takenNames.has(name.toLowerCase()); n++) name = `${t.name} (${n})`;
      takenNames.add(name.toLowerCase());
      upsertTheme(
        db,
        IdSchema.safeParse(t.id).success ? t.id : randomUUID(),
        name.slice(0, 60),
        t.tokens,
        now,
      );
    }
    for (const s of env.data.series) {
      const exists = db.get('SELECT 1 FROM book_series WHERE id = ?', [s.id]);
      const sid = exists
        ? s.id
        : upsertSeries(
            db,
            { id: s.id, name: s.name, description: s.description, totalKnown: s.totalKnown },
            now,
          );
      for (const m of s.members) {
        const target = idMap.get(m.itemId);
        if (!target) continue;
        const row = items.getItemRow(db, target);
        if (row?.type === 'book') setSeriesMembership(db, sid, target, m.position);
      }
    }
  }
}

export const ImportKindSchema = z.enum(['json', 'csv']);
