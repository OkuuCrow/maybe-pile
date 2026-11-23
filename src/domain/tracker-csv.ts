/**
 * Tracker imports from files the user exported themselves: Goodreads library
 * CSV, Letterboxd export CSVs, and a generic column mapper.
 *
 * Everything here turns rows of text into neutral `MappedRow`s plus row-numbered
 * messages. No URL in a file is ever fetched or opened, nothing is evaluated,
 * and cells are only ever treated as text.
 */
import { z } from 'zod';
import { MEDIA_TYPES, STATUSES, type MediaType, type Status } from '../shared/enums';
import { isValidIsoDate, isValidPartialDate } from './dates';
import { restoreFormula } from './csv';
import { normalizeIsbn } from './normalize';

export const TRACKER_MAX_BYTES = 25 * 1024 * 1024;
export const TRACKER_MAX_ROWS = 50_000;

export interface MappedRow {
  row: number;
  type: MediaType;
  title: string;
  creator: string | null;
  releaseDate: string | null;
  isbn10: string | null;
  isbn13: string | null;
  pageCount: number | null;
  publisher: string | null;
  rating: number | null;
  status: Status;
  dateAdded: string | null;
  dateStarted: string | null;
  dateCompleted: string | null;
  tags: string[];
  notes: string;
  platform: string | null;
  /** Viewing dates (local YYYY-MM-DD) for movies. */
  viewings: string[];
}

export interface RowMessage {
  severity: 'error' | 'warning';
  row: number;
  column: string;
  message: string;
}

export interface MapOutcome {
  rows: MappedRow[];
  messages: RowMessage[];
}

const MAX_MESSAGES = 200;

function blank(row: number, type: MediaType, title: string): MappedRow {
  return {
    row,
    type,
    title,
    creator: null,
    releaseDate: null,
    isbn10: null,
    isbn13: null,
    pageCount: null,
    publisher: null,
    rating: null,
    status: 'planned',
    dateAdded: null,
    dateStarted: null,
    dateCompleted: null,
    tags: [],
    notes: '',
    platform: null,
    viewings: [],
  };
}

/* ------------------------------------------------------------------ cell helpers */

export type DateOrder = 'ymd' | 'mdy' | 'dmy';

/** Parses "2019/03/15", "2019-03-15", "03/15/2019" (mdy) or "15.03.2019" (dmy) into YYYY-MM-DD. */
export function parseFlexibleDate(raw: string, order: DateOrder = 'ymd'): string | null {
  const v = raw.trim();
  if (v === '') return null;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(v);
  let y: string | undefined;
  let m: string | undefined;
  let d: string | undefined;
  if (iso) [, y, m, d] = iso;
  else {
    const other = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
    if (!other) return null;
    if (order === 'dmy') [, d, m, y] = other;
    else [, m, d, y] = other;
  }
  const out = `${y}-${(m ?? '').padStart(2, '0')}-${(d ?? '').padStart(2, '0')}`;
  return isValidIsoDate(out) ? out : null;
}

export type RatingScale = 'stars5' | 'stars5half' | 'ten' | 'hundred';

/** Converts a rating to the app's 1–10 (half-star) scale; 0 or blank means "not rated". */
export function convertRating(raw: string, scale: RatingScale): number | null | 'invalid' {
  const v = raw.trim().replace(',', '.');
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  if (n === 0) return null;
  const max = scale === 'ten' ? 10 : scale === 'hundred' ? 100 : 5;
  if (n > max) return 'invalid';
  const r = Math.round((n / max) * 10);
  return Math.min(10, Math.max(1, r));
}

const STATUS_WORDS: [RegExp, Status][] = [
  [/^(?:read|watched|played|finished|completed?|done|beaten|seen)$/i, 'completed'],
  [/^(?:currently[-\s]?reading|reading|watching|playing|in[-\s_]?progress|started|current)$/i, 'in_progress'],
  [
    /^(?:to[-\s]?read|to[-\s]?watch|to[-\s]?play|want(?:[-\s]to[-\s]\w+)?|planned?|plan[-\s]to[-\s]\w+|wishlist|backlog|watchlist|queue)$/i,
    'planned',
  ],
  [/^(?:on[-\s_]?hold|paused)$/i, 'on_hold'],
  [/^(?:dropped|abandoned|did[-\s]not[-\s]finish|dnf|gave[-\s]up)$/i, 'dropped'],
];

export function normalizeStatus(raw: string): Status | null {
  const v = raw.trim();
  if (v === '') return null;
  if ((STATUSES as readonly string[]).includes(v.toLowerCase())) return v.toLowerCase() as Status;
  for (const [re, s] of STATUS_WORDS) if (re.test(v)) return s;
  return null;
}

export function normalizeType(raw: string): MediaType | null {
  const v = raw.trim().toLowerCase();
  if ((MEDIA_TYPES as readonly string[]).includes(v)) return v as MediaType;
  if (/^(?:film|movies?)$/.test(v)) return 'movie';
  if (/^(?:tv|show|series|tv[-\s]?shows?|anime)$/.test(v)) return 'tv';
  if (/^(?:video[-\s]?games?|games?)$/.test(v)) return 'game';
  if (/^(?:books?|novels?|audiobooks?|ebooks?|comics?|manga)$/.test(v)) return 'book';
  return null;
}

/** Goodreads wraps ISBNs as ="0441172717" to stop spreadsheets eating zeros. */
export function cleanIsbnCell(raw: string): string {
  return raw.replace(/^="?/, '').replace(/"$/, '').trim();
}

const cell = (s: string | undefined) => restoreFormula((s ?? '').trim());

function headerIndex(header: readonly string[]): (name: string) => number {
  const lower = header.map((h) => h.trim().toLowerCase());
  return (name) => lower.indexOf(name.toLowerCase());
}

/* ------------------------------------------------------------------ detection */

export type DetectedFormat =
  | 'goodreads'
  | 'letterboxd-watched'
  | 'letterboxd-ratings'
  | 'letterboxd-watchlist'
  | 'letterboxd-diary'
  | 'unknown';

export function detectFormat(header: readonly string[]): DetectedFormat {
  const h = new Set(header.map((x) => x.trim().toLowerCase()));
  if (h.has('book id') && h.has('exclusive shelf') && h.has('title')) return 'goodreads';
  if (h.has('letterboxd uri') && h.has('name')) {
    if (h.has('watched date')) return 'letterboxd-diary';
    if (h.has('rating')) return 'letterboxd-ratings';
    return 'letterboxd-watched'; // watched.csv and watchlist.csv share a header; the file name decides
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ Goodreads */

const GOODREADS_SHELVES: Record<string, Status> = {
  read: 'completed',
  'currently-reading': 'in_progress',
  'to-read': 'planned',
};

export function mapGoodreads(rows: readonly string[][]): MapOutcome {
  const header = rows[0] ?? [];
  const ix = headerIndex(header);
  const messages: RowMessage[] = [];
  const out: MappedRow[] = [];
  const warn = (row: number, column: string, message: string, severity: 'warning' | 'error' = 'warning') => {
    if (messages.length < MAX_MESSAGES) messages.push({ severity, row, column, message });
  };
  rows.slice(1).forEach((cells, i) => {
    const rowNo = i + 2;
    const get = (name: string) => {
      const k = ix(name);
      return k === -1 ? '' : cell(cells[k]);
    };
    const title = get('Title');
    if (!title) {
      warn(rowNo, 'Title', 'Row has no title and was skipped.', 'error');
      return;
    }
    const r = blank(rowNo, 'book', title.slice(0, 500));
    r.creator = get('Author') || null;
    const isbn = normalizeIsbn(cleanIsbnCell(get('ISBN')));
    const isbn13 = normalizeIsbn(cleanIsbnCell(get('ISBN13')));
    r.isbn10 = isbn.isbn10;
    r.isbn13 = isbn13.isbn13 ?? isbn.isbn13;
    const pages = Number(get('Number of Pages'));
    r.pageCount = Number.isInteger(pages) && pages > 0 && pages <= 100_000 ? pages : null;
    r.publisher = get('Publisher') || null;
    const year = get('Original Publication Year') || get('Year Published');
    r.releaseDate = /^\d{4}$/.test(year) && isValidPartialDate(year) ? year : null;
    const rating = convertRating(get('My Rating'), 'stars5');
    if (rating === 'invalid') warn(rowNo, 'My Rating', 'Rating is not 0–5; it was left empty.');
    else r.rating = rating;
    r.dateAdded = parseFlexibleDate(get('Date Added'));
    r.dateCompleted = parseFlexibleDate(get('Date Read'));
    const shelf = get('Exclusive Shelf').toLowerCase();
    const mapped = GOODREADS_SHELVES[shelf];
    if (mapped) r.status = mapped;
    else {
      r.status = normalizeStatus(shelf) ?? 'planned';
      if (shelf) {
        warn(
          rowNo,
          'Exclusive Shelf',
          `Unknown shelf "${shelf.slice(0, 40)}" — imported as ${r.status === 'planned' ? 'Planned' : r.status} and kept as a tag.`,
        );
        r.tags.push(shelf);
      }
    }
    if (r.status === 'completed' && !r.dateCompleted)
      warn(rowNo, 'Date Read', 'Read, but no date read — completion date left empty.');
    for (const s of get('Bookshelves').split(',')) {
      const t = s.trim();
      if (t && !GOODREADS_SHELVES[t.toLowerCase()] && !r.tags.includes(t)) r.tags.push(t.slice(0, 64));
    }
    const review = get('My Review');
    const priv = get('Private Notes');
    r.notes = [review, priv].filter(Boolean).join('\n\n').slice(0, 100_000);
    out.push(r);
  });
  return { rows: out, messages };
}

/* ------------------------------------------------------------------ Letterboxd */

export interface LetterboxdFile {
  /** File name inside the export (watched.csv, ratings.csv, watchlist.csv, diary.csv). */
  name: string;
  rows: string[][];
}

/**
 * Merges Letterboxd CSVs by film (Letterboxd URI, else name + year):
 * watchlist → Planned; watched/diary → Completed with viewings on diary
 * "Watched Date"s; ratings (0.5–5 stars) → rating; diary tags → tags.
 */
export function mapLetterboxd(files: readonly LetterboxdFile[]): MapOutcome {
  const messages: RowMessage[] = [];
  const films = new Map<string, MappedRow & { watched: boolean; listed: boolean }>();
  let rowCounter = 0;
  const order = (n: string) =>
    /watchlist/i.test(n) ? 0 : /watched/i.test(n) ? 1 : /diary/i.test(n) ? 2 : /ratings/i.test(n) ? 3 : 4;
  for (const f of [...files].sort((a, b) => order(a.name) - order(b.name))) {
    const header = f.rows[0] ?? [];
    const ix = headerIndex(header);
    const fmt = detectFormat(header);
    if (fmt === 'unknown' || fmt === 'goodreads') {
      messages.push({
        severity: 'warning',
        row: 1,
        column: f.name,
        message: `${f.name} is not a Letterboxd export file and was ignored.`,
      });
      continue;
    }
    const isWatchlist = /watchlist/i.test(f.name);
    f.rows.slice(1).forEach((cells, i) => {
      const rowNo = i + 2;
      const get = (name: string) => {
        const k = ix(name);
        return k === -1 ? '' : cell(cells[k]);
      };
      const name = get('Name');
      if (!name) {
        if (messages.length < MAX_MESSAGES)
          messages.push({
            severity: 'error',
            row: rowNo,
            column: `${f.name}: Name`,
            message: 'Row has no film name and was skipped.',
          });
        return;
      }
      const year = get('Year');
      const key = get('Letterboxd URI') || `${name.toLowerCase()}|${year}`;
      let film = films.get(key);
      if (!film) {
        film = { ...blank(++rowCounter, 'movie', name.slice(0, 500)), watched: false, listed: false };
        film.releaseDate = /^\d{4}$/.test(year) ? year : null;
        films.set(key, film);
      }
      const date = parseFlexibleDate(get('Date'));
      if (isWatchlist) {
        film.listed = true;
        film.dateAdded = film.dateAdded ?? date;
        return;
      }
      film.watched = true;
      if (fmt === 'letterboxd-watched') film.dateCompleted = maxDate(film.dateCompleted, date);
      if (fmt === 'letterboxd-ratings' || fmt === 'letterboxd-diary') {
        const r = convertRating(get('Rating'), 'stars5half');
        if (r === 'invalid') {
          if (messages.length < MAX_MESSAGES)
            messages.push({
              severity: 'warning',
              row: rowNo,
              column: `${f.name}: Rating`,
              message: 'Rating is not 0.5–5; it was left empty.',
            });
        } else if (r !== null) film.rating = r;
      }
      if (fmt === 'letterboxd-diary') {
        const watched = parseFlexibleDate(get('Watched Date')) ?? date;
        if (watched && !film.viewings.includes(watched)) film.viewings.push(watched);
        film.dateCompleted = maxDate(film.dateCompleted, watched);
        for (const t of get('Tags').split(',')) {
          const tag = t.trim();
          if (tag && !film.tags.includes(tag)) film.tags.push(tag.slice(0, 64));
        }
      }
      film.dateAdded = minDate(film.dateAdded, date);
    });
  }
  const rows: MappedRow[] = [];
  for (const f of films.values()) {
    const { watched, listed: _listed, ...r } = f;
    r.status = watched ? 'completed' : 'planned';
    r.viewings.sort();
    rows.push(r);
  }
  return { rows, messages };
}

const maxDate = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));
const minDate = (a: string | null, b: string | null) => (a && b ? (a < b ? a : b) : (a ?? b));

/* ------------------------------------------------------------------ generic mapper */

export const MAPPABLE_FIELDS = [
  'title',
  'type',
  'creator',
  'status',
  'rating',
  'dateAdded',
  'dateStarted',
  'dateCompleted',
  'releaseDate',
  'tags',
  'isbn',
  'pageCount',
  'platform',
  'notes',
] as const;
export type MappableField = (typeof MAPPABLE_FIELDS)[number];

export const FIELD_LABELS_CSV: Record<MappableField, string> = {
  title: 'Title (required)',
  type: 'Media type',
  creator: 'Author / director / developer',
  status: 'Status',
  rating: 'Rating',
  dateAdded: 'Date added',
  dateStarted: 'Date started',
  dateCompleted: 'Date completed',
  releaseDate: 'Release year/date',
  tags: 'Tags',
  isbn: 'ISBN',
  pageCount: 'Page count',
  platform: 'Platform (games)',
  notes: 'Notes',
};

export const CsvMappingSchema = z.strictObject({
  /** Column header name per field (exact header text), or null when unmapped. */
  columns: z.record(z.enum(MAPPABLE_FIELDS), z.string().max(200).nullable()),
  /** Used when no type column is mapped, or a row's type is blank/unknown. */
  defaultType: z.enum(MEDIA_TYPES),
  ratingScale: z.enum(['stars5', 'stars5half', 'ten', 'hundred']),
  dateOrder: z.enum(['ymd', 'mdy', 'dmy']),
  /** Separator for multiple tags inside one cell. */
  tagSeparator: z.enum([';', ',', '|']),
});
export type CsvMapping = z.infer<typeof CsvMappingSchema>;

/** Suggests a mapping by matching common header names. */
export function suggestMapping(header: readonly string[], defaultType: MediaType = 'book'): CsvMapping {
  const lower = header.map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => {
    for (const n of names) {
      const i = lower.indexOf(n);
      if (i !== -1) return header[i] ?? null;
    }
    return null;
  };
  return {
    columns: {
      title: find('title', 'name', 'book title', 'film', 'game'),
      type: find('type', 'media type', 'kind', 'category'),
      creator: find('author', 'creator', 'director', 'developer', 'artist'),
      status: find('status', 'state', 'shelf', 'exclusive shelf'),
      rating: find('rating', 'my rating', 'score', 'stars'),
      dateAdded: find('date added', 'added', 'created'),
      dateStarted: find('date started', 'started'),
      dateCompleted: find('date completed', 'date read', 'completed', 'finished', 'watched date'),
      releaseDate: find('year', 'release date', 'release year', 'year published'),
      tags: find('tags', 'labels', 'shelves', 'bookshelves'),
      isbn: find('isbn13', 'isbn'),
      pageCount: find('pages', 'page count', 'number of pages'),
      platform: find('platform', 'system', 'console'),
      notes: find('notes', 'comment', 'comments', 'review'),
    },
    defaultType,
    ratingScale: 'stars5',
    dateOrder: 'ymd',
    tagSeparator: ';',
  };
}

export function mapGeneric(rows: readonly string[][], m: CsvMapping): MapOutcome {
  const header = rows[0] ?? [];
  const messages: RowMessage[] = [];
  const out: MappedRow[] = [];
  const idx = (f: MappableField) => {
    const name = m.columns[f];
    return name ? header.indexOf(name) : -1;
  };
  const warn = (row: number, column: string, message: string, severity: 'warning' | 'error' = 'warning') => {
    if (messages.length < MAX_MESSAGES) messages.push({ severity, row, column, message });
  };
  if (!m.columns.title || idx('title') === -1) {
    return {
      rows: [],
      messages: [
        { severity: 'error', row: 1, column: 'title', message: 'Map a column to Title before importing.' },
      ],
    };
  }
  for (const f of MAPPABLE_FIELDS) {
    const name = m.columns[f];
    if (name && header.indexOf(name) === -1)
      warn(1, f, `Column "${name.slice(0, 60)}" is not in this file; ${FIELD_LABELS_CSV[f]} will be empty.`);
  }
  rows.slice(1).forEach((cells, i) => {
    const rowNo = i + 2;
    const get = (f: MappableField) => {
      const k = idx(f);
      return k === -1 ? '' : cell(cells[k]);
    };
    const title = get('title');
    if (!title) {
      warn(rowNo, m.columns.title ?? 'title', 'Row has no title and was skipped.', 'error');
      return;
    }
    const typeCell = get('type');
    let type = m.defaultType;
    if (typeCell) {
      const t = normalizeType(typeCell);
      if (t) type = t;
      else
        warn(
          rowNo,
          m.columns.type ?? 'type',
          `Unknown type "${typeCell.slice(0, 30)}" — used ${m.defaultType}.`,
        );
    }
    const r = blank(rowNo, type, title.slice(0, 500));
    r.creator = get('creator') || null;
    const statusCell = get('status');
    if (statusCell) {
      const s = normalizeStatus(statusCell);
      if (s) r.status = s;
      else {
        warn(
          rowNo,
          m.columns.status ?? 'status',
          `Unknown status "${statusCell.slice(0, 30)}" — imported as Planned and kept as a tag.`,
        );
        r.tags.push(statusCell.slice(0, 64));
      }
    }
    const rating = convertRating(get('rating'), m.ratingScale);
    if (rating === 'invalid')
      warn(rowNo, m.columns.rating ?? 'rating', 'Rating is outside the chosen scale; it was left empty.');
    else r.rating = rating;
    for (const f of ['dateAdded', 'dateStarted', 'dateCompleted'] as const) {
      const raw = get(f);
      const d = parseFlexibleDate(raw, m.dateOrder);
      if (raw && !d)
        warn(rowNo, m.columns[f] ?? f, `Could not read the date "${raw.slice(0, 30)}"; it was left empty.`);
      r[f] = d;
    }
    const rel = get('releaseDate');
    if (rel) {
      const asDate = parseFlexibleDate(rel, m.dateOrder);
      r.releaseDate = /^\d{4}$/.test(rel) && isValidPartialDate(rel) ? rel : asDate;
    }
    for (const t of get('tags').split(m.tagSeparator)) {
      const tag = t.trim();
      if (tag && !r.tags.includes(tag)) r.tags.push(tag.slice(0, 64));
    }
    if (r.type === 'book') {
      const isbn = normalizeIsbn(cleanIsbnCell(get('isbn')));
      r.isbn10 = isbn.isbn10;
      r.isbn13 = isbn.isbn13;
      const pages = Number(get('pageCount'));
      r.pageCount = Number.isInteger(pages) && pages > 0 && pages <= 100_000 ? pages : null;
    }
    r.platform = r.type === 'game' ? get('platform').slice(0, 80) || null : null;
    r.notes = get('notes').slice(0, 100_000);
    if (r.dateStarted && r.dateCompleted && r.dateCompleted < r.dateStarted) {
      warn(
        rowNo,
        m.columns.dateCompleted ?? 'dateCompleted',
        'Completed before started — start date dropped.',
      );
      r.dateStarted = null;
    }
    out.push(r);
  });
  return { rows: out, messages };
}
