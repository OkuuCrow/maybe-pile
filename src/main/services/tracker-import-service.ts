/**
 * Tracker imports (Goodreads, Letterboxd, generic CSV mapper). Files are ones
 * the user exported themselves and chose in a native dialog. Rows are mapped to
 * the portable item format and go through the existing import preview: counts,
 * row-numbered messages, conflicts (provider id / ISBN / title+year) and an
 * explicit skip-or-duplicate choice. Applied imports are undoable batches.
 */
import { randomUUID } from 'node:crypto';
import { gunzipSync, unzipSync } from 'fflate';
import { MalXmlError, malSeasons, parseMalXml, type MalRow } from '../../domain/mal-xml';
import { appError } from '../../shared/result';
import type { CreatorRole, MediaType } from '../../shared/enums';
import { MetadataFieldsSchema, PersonalFieldsSchema } from '../../shared/schemas';
import type { MappingProfileView, TrackerPreviewView, ValidationMessage } from '../../shared/types';
import { detectDelimiter, CsvParseError, parseCsv } from '../../domain/csv';
import { localDate } from '../../domain/dates';
import { defaultPersonal, emptyMeta, pruneMetaForType } from '../../domain/metadata';
import { tagKey, uniqueTags } from '../../domain/normalize';
import { formatZodIssues } from '../../domain/themes';
import {
  CsvMappingSchema,
  detectFormat,
  mapGeneric,
  mapGoodreads,
  mapLetterboxd,
  suggestMapping,
  TRACKER_MAX_BYTES,
  TRACKER_MAX_ROWS,
  type CsvMapping,
  type MappedRow,
  type MapOutcome,
} from '../../domain/tracker-csv';
import type { ServiceContext } from './context';
import type { ImportService } from './import-service';
import type { ExportItem } from './portable-format';

export type TrackerKind = 'goodreads' | 'letterboxd' | 'csv' | 'mal';

/** Decompressed size cap for .xml.gz MAL exports. */
export const MAL_MAX_XML_BYTES = 60 * 1024 * 1024;

export interface TrackerFile {
  name: string;
  bytes: Uint8Array;
}

interface CsvState {
  fileLabel: string;
  rows: string[][];
  delimiter: string;
}

const ROLE_FOR: Record<MediaType, CreatorRole> = {
  book: 'author',
  movie: 'director',
  tv: 'creator',
  game: 'developer',
  anime: 'studio',
};
const LETTERBOXD_FILES = /(?:^|\/)(watched|ratings|watchlist|diary)\.csv$/i;
const MAX_ZIP_ENTRY = 20 * 1024 * 1024;

export class TrackerImportService {
  /** Parsed generic-CSV rows per preview token, so remapping doesn't re-read the file. */
  private readonly csvStates = new Map<string, CsvState>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly importer: ImportService,
    private readonly decode: (b: Uint8Array) => string,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  private parse(text: string, label: string): { rows: string[][]; delimiter: string } {
    const delimiter = detectDelimiter(text);
    try {
      return { rows: parseCsv(text, TRACKER_MAX_ROWS + 1, delimiter), delimiter };
    } catch (e) {
      const line = e instanceof CsvParseError ? e.line : 0;
      throw appError(
        'VALIDATION',
        `${label}: ${e instanceof Error ? e.message : 'invalid CSV'} (line ${line}).`,
        {
          recovery: 'Export the file again from the tracker and choose the new copy.',
        },
      );
    }
  }

  preview(kind: TrackerKind, files: readonly TrackerFile[], mapping?: CsvMapping): TrackerPreviewView {
    const label = files
      .map((f) => f.name)
      .join(', ')
      .slice(0, 200);
    for (const f of files)
      if (f.bytes.byteLength > TRACKER_MAX_BYTES)
        throw appError(
          'TOO_LARGE',
          `"${f.name}" is too large (limit ${TRACKER_MAX_BYTES / 1024 / 1024} MB).`,
        );
    if (kind === 'letterboxd') {
      const csvs = this.letterboxdFiles(files);
      if (csvs.length === 0)
        throw appError('VALIDATION', 'No Letterboxd CSV files were found.', {
          recovery: 'Choose the .zip from Letterboxd → Settings → Import & Export, or one of its CSV files.',
        });
      const out = mapLetterboxd(csvs.map((c) => ({ name: c.name, rows: this.parse(c.text, c.name).rows })));
      return this.finish(
        'letterboxd',
        label,
        out,
        { header: [], sample: [], delimiter: ',', mapping: null },
        'Letterboxd export',
      );
    }
    const first = files[0];
    if (!first) throw appError('VALIDATION', 'Choose a file.');
    if (kind === 'mal') return this.previewMal(first, label);
    const text = this.decode(first.bytes);
    const { rows, delimiter } = this.parse(text, first.name);
    if (rows.length - 1 > TRACKER_MAX_ROWS)
      throw appError('TOO_LARGE', `The file has more than ${TRACKER_MAX_ROWS.toLocaleString()} rows.`, {
        recovery: 'Split it into smaller files.',
      });
    const header = rows[0] ?? [];
    if (kind === 'goodreads') {
      if (detectFormat(header) !== 'goodreads')
        throw appError('VALIDATION', 'This does not look like a Goodreads library export.', {
          recovery:
            'On Goodreads open My Books → Import and export → Export Library, then choose that CSV. For other files use “Custom CSV”.',
        });
      return this.finish(
        'goodreads',
        label,
        mapGoodreads(rows),
        { header: [], sample: [], delimiter, mapping: null },
        'Goodreads library export',
      );
    }
    const m = mapping ?? suggestMapping(header);
    const view = this.finish(
      'csv',
      label,
      mapGeneric(rows, m),
      { header, sample: rows.slice(1, 6), delimiter, mapping: m },
      `CSV (${delimiter === '\t' ? 'tab' : delimiter}-separated)`,
    );
    // Keep the parsed rows under their own handle so the mapping can be changed (even after an error).
    const mapToken = randomUUID();
    this.csvStates.set(mapToken, { fileLabel: label, rows, delimiter });
    while (this.csvStates.size > 5) {
      const k = this.csvStates.keys().next().value;
      if (k === undefined) break;
      this.csvStates.delete(k);
    }
    return { ...view, mapToken };
  }

  /** Re-applies a changed column mapping to the same file (works even when the last mapping had errors). */
  remap(mapToken: string, previousToken: string, mapping: CsvMapping): TrackerPreviewView {
    const st = this.csvStates.get(mapToken);
    if (!st) throw appError('NOT_FOUND', 'This preview has expired.', { recovery: 'Choose the file again.' });
    if (previousToken) this.importer.forget(previousToken);
    const header = st.rows[0] ?? [];
    const view = this.finish(
      'csv',
      st.fileLabel,
      mapGeneric(st.rows, mapping),
      { header, sample: st.rows.slice(1, 6), delimiter: st.delimiter, mapping },
      'CSV',
    );
    return { ...view, mapToken };
  }

  private letterboxdFiles(files: readonly TrackerFile[]): { name: string; text: string }[] {
    const out: { name: string; text: string }[] = [];
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        let entries: Record<string, Uint8Array>;
        try {
          entries = unzipSync(f.bytes, {
            filter: (e) => LETTERBOXD_FILES.test(e.name) && e.originalSize <= MAX_ZIP_ENTRY,
          });
        } catch {
          throw appError('CORRUPT', `"${f.name}" is not a readable ZIP file.`);
        }
        for (const [name, bytes] of Object.entries(entries))
          if (!name.includes('/deleted/') && !name.includes('/orphaned/'))
            out.push({ name: name.split('/').pop() ?? name, text: this.decode(bytes) });
      } else out.push({ name: f.name, text: this.decode(f.bytes) });
    }
    return out;
  }

  private finish(
    tracker: TrackerKind,
    fileLabel: string,
    out: MapOutcome,
    extra: { header: string[]; sample: string[][]; delimiter: string; mapping: CsvMapping | null },
    formatLabel: string,
  ): TrackerPreviewView {
    const today = localDate(this.ctx.clock.now());
    const messages: ValidationMessage[] = out.messages.map((m) => ({
      // A bad row is skipped (warning) as long as other rows are importable; otherwise it blocks.
      severity: m.severity === 'error' && out.rows.length > 0 ? 'warning' : m.severity,
      path: `row ${m.row}, ${m.column}`,
      message: m.message,
    }));
    const items: ExportItem[] = [];
    for (const r of out.rows) {
      const it = this.toExportItem(r, today, (msg) =>
        messages.push({ severity: 'warning', path: `row ${r.row}`, message: `${msg} This row was skipped.` }),
      );
      if (it) items.push(it);
    }
    if (out.rows.length === 0 && !messages.some((m) => m.severity === 'error'))
      messages.push({ severity: 'error', path: '$', message: 'No importable rows were found.' });
    const kind =
      tracker === 'goodreads'
        ? 'goodreads'
        : tracker === 'letterboxd'
          ? 'letterboxd'
          : tracker === 'mal'
            ? 'mal-xml'
            : 'csv-mapped';
    const view = this.importer.storePreview('csv', fileLabel, items, null, messages.slice(0, 200), {
      batch: { kind, label: `${formatLabel}: ${fileLabel}`.slice(0, 200) },
      allowed: ['skip', 'duplicate'],
      formatLabel,
    });
    return {
      ...view,
      tracker,
      header: extra.header,
      sample: extra.sample,
      delimiter: extra.delimiter,
      mapping: extra.mapping,
      mapToken: null,
    };
  }

  toExportItem(r: MappedRow, today: string, skip: (msg: string) => void): ExportItem | null {
    const ext: { kind: 'isbn13' | 'isbn10'; value: string }[] = [];
    if (r.isbn13) ext.push({ kind: 'isbn13', value: r.isbn13 });
    if (r.isbn10) ext.push({ kind: 'isbn10', value: r.isbn10 });
    const meta = MetadataFieldsSchema.safeParse(
      pruneMetaForType(r.type, {
        ...emptyMeta(r.title),
        releaseDate: r.releaseDate,
        creators: r.creator ? [{ name: r.creator.slice(0, 200), role: ROLE_FOR[r.type] }] : [],
        externalIds: ext,
        pageCount: r.pageCount,
        publisher: r.publisher,
        isbn13: r.isbn13,
        isbn10: r.isbn10,
      }),
    );
    if (!meta.success) {
      skip(formatZodIssues(meta.error)[0]?.message ?? 'Invalid details.');
      return null;
    }
    const dateStarted =
      r.dateStarted && r.dateCompleted && r.dateCompleted < r.dateStarted ? null : r.dateStarted;
    const personal = PersonalFieldsSchema.safeParse({
      ...defaultPersonal(r.type, today),
      status: r.status,
      rating: r.rating,
      notes: r.notes,
      dateAdded: r.dateAdded && r.dateAdded <= today ? r.dateAdded : today,
      dateStarted,
      dateCompleted: r.status === 'completed' ? r.dateCompleted : null,
      tags: uniqueTags(r.tags.map((t) => t.slice(0, 64)).filter((t) => tagKey(t) !== '')).slice(0, 100),
      platforms: r.type === 'game' && r.platform ? [{ name: r.platform, owned: true, played: false }] : [],
    });
    if (!personal.success) {
      skip(formatZodIssues(personal.error)[0]?.message ?? 'Invalid personal fields.');
      return null;
    }
    const now = this.ctx.clock.now().toISOString();
    return {
      id: randomUUID(),
      type: r.type,
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
      // Diary dates are calendar dates; noon UTC keeps the same local date in every time zone ±11h.
      viewings: r.viewings.map((d) => ({
        watchedAt: `${d}T12:00:00.000Z`,
        note: null,
        pass: 1,
        createdAt: now,
      })),
      artwork: null,
      audit: [],
      customFieldsByName: {},
    };
  }

  /* ---------------------------------------------------------------- MyAnimeList XML */

  private previewMal(f: TrackerFile, label: string): TrackerPreviewView {
    let bytes = f.bytes;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try {
        // Reject decompression bombs: the gzip footer's ISIZE is checked first, then the real output.
        const isize =
          bytes.length >= 4
            ? new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0, true)
            : 0;
        if (isize > MAL_MAX_XML_BYTES) throw new MalXmlError('too large');
        bytes = gunzipSync(bytes);
      } catch (e) {
        if (e instanceof MalXmlError)
          throw appError(
            'TOO_LARGE',
            `"${f.name}" expands to more than ${MAL_MAX_XML_BYTES / 1024 / 1024} MB.`,
          );
        throw appError('CORRUPT', `"${f.name}" is not a readable .gz file.`);
      }
      if (bytes.byteLength > MAL_MAX_XML_BYTES)
        throw appError(
          'TOO_LARGE',
          `"${f.name}" expands to more than ${MAL_MAX_XML_BYTES / 1024 / 1024} MB.`,
        );
    }
    let parsed;
    try {
      parsed = parseMalXml(this.decode(bytes));
    } catch (e) {
      throw appError(
        'VALIDATION',
        e instanceof MalXmlError ? e.message : 'The MyAnimeList file could not be read.',
        {
          recovery:
            'On MyAnimeList open your profile → Export lists, export your anime list and choose that file.',
        },
      );
    }
    const today = localDate(this.ctx.clock.now());
    const messages: ValidationMessage[] = parsed.messages.map((m) => ({
      severity: m.severity === 'error' && parsed.rows.length > 0 ? 'warning' : m.severity,
      path: `anime ${m.row}, ${m.column}`,
      message: m.message,
    }));
    if (parsed.mangaSkipped > 0)
      messages.push({
        severity: 'warning',
        path: '$',
        message: `${parsed.mangaSkipped} manga entr${parsed.mangaSkipped === 1 ? 'y was' : 'ies were'} skipped. Track manga as Books.`,
      });
    const items: ExportItem[] = [];
    for (const r of parsed.rows) {
      const it = this.malToExportItem(r, today, (msg) =>
        messages.push({
          severity: 'warning',
          path: `anime ${r.row}`,
          message: `${msg} This entry was skipped.`,
        }),
      );
      if (it) items.push(it);
    }
    if (items.length === 0 && !messages.some((m) => m.severity === 'error'))
      messages.push({ severity: 'error', path: '$', message: 'No importable anime were found.' });
    const view = this.importer.storePreview('csv', label, items, null, messages.slice(0, 200), {
      batch: { kind: 'mal-xml', label: `MyAnimeList list: ${label}`.slice(0, 200) },
      allowed: ['skip', 'duplicate'],
      formatLabel: 'MyAnimeList list export',
    });
    return { ...view, tracker: 'mal', header: [], sample: [], delimiter: ',', mapping: null, mapToken: null };
  }

  private malToExportItem(r: MalRow, today: string, skip: (msg: string) => void): ExportItem | null {
    const meta = MetadataFieldsSchema.safeParse(
      pruneMetaForType('anime', {
        ...emptyMeta(r.title),
        externalIds: [{ kind: 'mal', value: r.malId }],
        titleRomaji: r.title,
        animeFormat: r.format,
        episodeCount: r.totalEpisodes,
      }),
    );
    if (!meta.success) {
      skip(formatZodIssues(meta.error)[0]?.message ?? 'Invalid details.');
      return null;
    }
    const dateStarted =
      r.dateStarted && r.dateCompleted && r.dateCompleted < r.dateStarted ? null : r.dateStarted;
    const personal = PersonalFieldsSchema.safeParse({
      ...defaultPersonal('anime', today),
      status: r.status,
      rating: r.rating,
      notes: r.notes,
      dateAdded: today,
      dateStarted: dateStarted && dateStarted <= today ? dateStarted : null,
      dateCompleted:
        r.status === 'completed' && r.dateCompleted && r.dateCompleted <= today ? r.dateCompleted : null,
      tags: uniqueTags(r.tags.map((t) => t.slice(0, 64)).filter((t) => tagKey(t) !== '')).slice(0, 100),
    });
    if (!personal.success) {
      skip(formatZodIssues(personal.error)[0]?.message ?? 'Invalid personal fields.');
      return null;
    }
    const now = this.ctx.clock.now().toISOString();
    const seasons = malSeasons(r).map((s) => ({
      number: s.number,
      title: s.title,
      episodeCountKnown: s.episodeCountKnown,
      episodes: s.episodes.map((e) => ({
        number: e.number,
        title: e.title,
        airDate: null,
        runtime: e.runtime,
        watched: e.number <= s.watchedUpTo,
        watchedAt: e.number <= s.watchedUpTo ? now : null,
        source: 'user' as const,
      })),
    }));
    return {
      id: randomUUID(),
      type: 'anime',
      meta: meta.data,
      personal: personal.data,
      // MAL "times watched" counts completed rewatches: the current run is one more.
      pass: Math.min(1000, 1 + r.timesWatched),
      createdAt: now,
      updatedAt: now,
      provenance: {},
      sources: [],
      seasons,
      milestones: [],
      progress: [],
      viewings: [],
      artwork: null,
      audit: [],
      customFieldsByName: {},
    };
  }

  /* ---------------------------------------------------------------- mapping profiles */

  profiles(): MappingProfileView[] {
    return this.db
      .all<{ id: string; name: string; mapping: string; updated_at: string }>(
        'SELECT id, name, mapping, updated_at FROM csv_mapping_profiles ORDER BY name COLLATE NOCASE',
      )
      .flatMap((r) => {
        try {
          const m = CsvMappingSchema.safeParse(JSON.parse(r.mapping));
          return m.success ? [{ id: r.id, name: r.name, mapping: m.data, updatedAt: r.updated_at }] : [];
        } catch {
          return [];
        }
      });
  }

  saveProfile(name: string, mapping: CsvMapping): MappingProfileView[] {
    const parsed = CsvMappingSchema.parse(mapping);
    const now = this.ctx.clock.now().toISOString();
    this.db.run(
      `INSERT INTO csv_mapping_profiles (id, name, name_key, mapping, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, mapping = excluded.mapping, updated_at = excluded.updated_at`,
      [randomUUID(), name, tagKey(name), JSON.stringify(parsed), now, now],
    );
    return this.profiles();
  }

  deleteProfile(id: string): MappingProfileView[] {
    this.db.run('DELETE FROM csv_mapping_profiles WHERE id = ?', [id]);
    return this.profiles();
  }
}
