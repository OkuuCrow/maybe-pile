/**
 * Metadata field catalog, defaults, provenance detection and refresh merge rules.
 *
 * Refresh rule: a field counts as *user-edited* when its provenance origin is
 * `user` or `manual-entry`, or when it is `provider` but the current value no
 * longer equals the provider value recorded at the last fetch. User-edited
 * fields default to "Keep my edit"; untouched provider fields default to "Update".
 * Personal fields (status, rating, notes, dates, tags, progress, custom fields)
 * are never part of a refresh.
 */
import type { MediaType } from '../shared/enums';
import { ROLE_LABELS, TYPE_LABELS } from '../shared/enums';
import type { MetadataField, MetadataFields, PersonalFields } from '../shared/schemas';
import type { ProvenanceView, RefreshFieldRow } from '../shared/types';

export const COMMON_FIELDS: MetadataField[] = [
  'title',
  'altTitles',
  'description',
  'releaseDate',
  'genres',
  'creators',
  'externalIds',
];

export const FIELDS_BY_TYPE: Record<MediaType, MetadataField[]> = {
  movie: [...COMMON_FIELDS, 'runtimeMinutes', 'originalLanguage', 'ageRating'],
  tv: [...COMMON_FIELDS, 'network', 'showStatus', 'episodeRuntime', 'lastAirDate'],
  game: [...COMMON_FIELDS],
  book: [...COMMON_FIELDS, 'publisher', 'pageCount', 'audioMinutes', 'isbn10', 'isbn13'],
};

export const FIELD_LABELS: Record<MetadataField, string> = {
  title: 'Title',
  altTitles: 'Alternate titles',
  description: 'Description',
  releaseDate: 'Release date',
  genres: 'Genres',
  creators: 'Creators',
  externalIds: 'External IDs',
  runtimeMinutes: 'Runtime (minutes)',
  originalLanguage: 'Original language',
  ageRating: 'Age rating',
  network: 'Network',
  showStatus: 'Show status',
  episodeRuntime: 'Episode runtime (minutes)',
  lastAirDate: 'Last air date',
  publisher: 'Publisher',
  pageCount: 'Page count',
  audioMinutes: 'Audiobook length (minutes)',
  isbn10: 'ISBN-10',
  isbn13: 'ISBN-13',
};

export function releaseDateLabel(type: MediaType): string {
  return type === 'tv' ? 'First air date' : type === 'book' ? 'Publication date' : 'Release date';
}

export function emptyMeta(title = ''): MetadataFields {
  return {
    title,
    altTitles: [],
    description: null,
    releaseDate: null,
    genres: [],
    creators: [],
    externalIds: [],
    runtimeMinutes: null,
    originalLanguage: null,
    ageRating: null,
    network: null,
    showStatus: null,
    episodeRuntime: null,
    lastAirDate: null,
    publisher: null,
    pageCount: null,
    audioMinutes: null,
    isbn10: null,
    isbn13: null,
  };
}

export function defaultPersonal(type: MediaType, today: string): PersonalFields {
  return {
    status: 'planned',
    rating: null,
    notes: '',
    dateAdded: today,
    dateStarted: null,
    dateCompleted: null,
    tags: [],
    gameScheme: type === 'game' ? 'percent' : null,
    platforms: [],
    bookFormat: type === 'book' ? 'print' : null,
    customFields: [],
  };
}

/** Nulls out fields that don't apply to the type so stored data stays coherent. */
export function pruneMetaForType(type: MediaType, meta: MetadataFields): MetadataFields {
  const allowed = new Set(FIELDS_BY_TYPE[type]);
  const out = { ...meta };
  const blank = emptyMeta();
  for (const k of Object.keys(out) as MetadataField[]) {
    if (!allowed.has(k)) (out as Record<string, unknown>)[k] = blank[k];
  }
  return out;
}

/** Canonical JSON used for provenance comparisons (order-insensitive for sets like genres). */
export function canonicalValue(field: MetadataField, value: unknown): string {
  if (Array.isArray(value)) {
    if (field === 'creators') {
      const v = (value as { name: string; role: string }[]).map((c) => `${c.role}:${c.name}`);
      return JSON.stringify(v);
    }
    if (field === 'externalIds') {
      const v = (value as { kind: string; value: string }[]).map((e) => `${e.kind}:${e.value}`).sort();
      return JSON.stringify(v);
    }
    if (field === 'genres')
      return JSON.stringify([...(value as string[])].map((g) => g.toLowerCase()).sort());
    return JSON.stringify(value);
  }
  return JSON.stringify(value ?? null);
}

export function isEmptyValue(value: unknown): boolean {
  return (
    value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  );
}

export function displayValue(field: MetadataField, value: unknown): string {
  if (isEmptyValue(value)) return '—';
  if (field === 'creators') {
    return (value as { name: string; role: keyof typeof ROLE_LABELS }[])
      .map((c) => `${c.name} (${ROLE_LABELS[c.role]})`)
      .join(', ');
  }
  if (field === 'externalIds') {
    return (value as { kind: string; value: string }[]).map((e) => `${e.kind}: ${e.value}`).join(', ');
  }
  if (Array.isArray(value)) return value.join(', ');
  if (field === 'description' && typeof value === 'string' && value.length > 400)
    return `${value.slice(0, 400)}…`;
  return String(value);
}

export function isUserEdited(
  field: MetadataField,
  current: unknown,
  prov: ProvenanceView | undefined,
): boolean {
  if (isEmptyValue(current)) return false;
  if (!prov) return true; // value exists but we don't know where it came from: protect it
  if (prov.origin !== 'provider') return true;
  return prov.providerValue !== canonicalValue(field, current);
}

export interface RefreshComparison {
  rows: RefreshFieldRow[];
  unchanged: MetadataField[];
}

export function compareForRefresh(
  type: MediaType,
  current: MetadataFields,
  incoming: MetadataFields,
  provenance: Partial<Record<MetadataField, ProvenanceView>>,
): RefreshComparison {
  const rows: RefreshFieldRow[] = [];
  const unchanged: MetadataField[] = [];
  for (const field of FIELDS_BY_TYPE[type]) {
    const cur = current[field];
    const inc = incoming[field];
    if (canonicalValue(field, cur) === canonicalValue(field, inc)) {
      unchanged.push(field);
      continue;
    }
    // A provider that has no value for a field never blanks out existing data.
    if (isEmptyValue(inc)) {
      unchanged.push(field);
      continue;
    }
    const prov = provenance[field];
    const userEdited = isUserEdited(field, cur, prov);
    rows.push({
      field,
      label: field === 'releaseDate' ? releaseDateLabel(type) : FIELD_LABELS[field],
      current: displayValue(field, cur),
      incoming: displayValue(field, inc),
      origin: prov?.origin ?? null,
      lastEdited: prov?.updatedAt ?? null,
      userEdited,
      defaultChoice: userEdited ? 'keep' : 'update',
    });
  }
  return { rows, unchanged };
}

export function mergeRefresh(
  current: MetadataFields,
  incoming: MetadataFields,
  rows: readonly RefreshFieldRow[],
  choices: Record<string, 'keep' | 'update'>,
): { meta: MetadataFields; updated: MetadataField[] } {
  const meta = { ...current };
  const updated: MetadataField[] = [];
  for (const row of rows) {
    const field = row.field as MetadataField;
    const choice = choices[field] ?? row.defaultChoice;
    if (choice === 'update') {
      (meta as Record<string, unknown>)[field] = incoming[field];
      updated.push(field);
    }
  }
  return { meta, updated };
}

export function typeLabel(t: MediaType): string {
  return TYPE_LABELS[t];
}
