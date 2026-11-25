/**
 * Sync folder: pure planning logic (no I/O). See docs/sync.md.
 *
 * Scope (v1): item existence (create/delete) and the personal fields below.
 * Metadata is not synced (each device can refresh it from providers).
 * Identity: natural keys, so the same item matches across devices without
 * shared ids: the first available external id in a fixed priority, else
 * type + normalized title + year.
 */
import { z } from 'zod';
import { MEDIA_TYPES, STATUSES } from '../shared/enums';

export const SYNC_FIELDS = [
  'status',
  'rating',
  'notes',
  'dateStarted',
  'dateCompleted',
  'tags',
  'deleted',
] as const;
export type SyncField = (typeof SYNC_FIELDS)[number];

export const SyncFieldsSchema = z.strictObject({
  status: z.enum(STATUSES),
  rating: z.number().int().min(1).max(10).nullable(),
  notes: z.string().max(100_000),
  dateStarted: z.string().max(10).nullable(),
  dateCompleted: z.string().max(10).nullable(),
  tags: z.array(z.string().max(64)).max(100),
  deleted: z.boolean(),
});
export type SyncFields = z.infer<typeof SyncFieldsSchema>;

/** What a receiving device needs to create an item it doesn't have. */
export const SyncCreateSchema = z.strictObject({
  type: z.enum(MEDIA_TYPES),
  title: z.string().min(1).max(500),
  releaseDate: z.string().max(10).nullable(),
  externalIds: z.array(z.strictObject({ kind: z.string().max(20), value: z.string().max(200) })).max(20),
});
export type SyncCreate = z.infer<typeof SyncCreateSchema>;

export const ChangeSchema = z.strictObject({
  key: z.string().min(3).max(700),
  fields: SyncFieldsSchema.partial(),
  create: SyncCreateSchema.nullable(),
});
export type Change = z.infer<typeof ChangeSchema>;

export const ChangesetSchema = z.strictObject({
  v: z.literal(1),
  deviceId: z.uuid(),
  deviceName: z.string().max(60),
  seq: z.number().int().min(1),
  at: z.iso.datetime({ offset: true }),
  changes: z.array(ChangeSchema).max(100_000),
});
export type Changeset = z.infer<typeof ChangesetSchema>;

const KEY_PRIORITY = [
  'tmdb',
  'imdb',
  'tvmaze',
  'igdb',
  'steam',
  'isbn13',
  'openlibrary',
  'mal',
  'anilist',
  'kitsu',
  'wikidata',
];

export function naturalKey(i: {
  type: string;
  titleKey: string;
  year: number | null;
  externalIds: { kind: string; value: string }[];
}): string {
  for (const k of KEY_PRIORITY) {
    const e = i.externalIds.find((x) => x.kind === k);
    if (e) return `${i.type}|${k}:${e.value}`;
  }
  return `${i.type}|t:${i.titleKey}|${i.year ?? ''}`;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Fields that changed locally since the baseline (all fields when there is no baseline). */
export function localDiff(current: SyncFields, baseline: Partial<SyncFields> | null): Partial<SyncFields> {
  const out: Partial<SyncFields> = {};
  for (const f of SYNC_FIELDS)
    if (!baseline || !same(current[f], baseline[f])) (out as Record<string, unknown>)[f] = current[f];
  return out;
}

export interface RemoteChange {
  key: string;
  field: SyncField;
  value: unknown;
  deviceId: string;
  at: string;
  create: SyncCreate | null;
}

export type Decision =
  | { kind: 'apply'; change: RemoteChange }
  | { kind: 'noop'; change: RemoteChange }
  | { kind: 'conflict'; change: RemoteChange; local: unknown };

/**
 * Three-way decision per field: local L, baseline B, remote R.
 *  L == R → noop; L == B (local untouched) → apply R; otherwise → conflict.
 * When several remote devices changed the same field, the latest `at` wins
 * among them (ties: higher device id) before the three-way check.
 */
export function decide(
  remote: RemoteChange[],
  local: (key: string) => SyncFields | null,
  baseline: (key: string) => Partial<SyncFields> | null,
): Decision[] {
  const latest = new Map<string, RemoteChange>();
  for (const c of remote) {
    const k = `${c.key}\u0000${c.field}`;
    const prev = latest.get(k);
    if (!prev || c.at > prev.at || (c.at === prev.at && c.deviceId > prev.deviceId))
      latest.set(k, { ...c, create: c.create ?? prev?.create ?? null });
  }
  const out: Decision[] = [];
  for (const c of latest.values()) {
    const L = local(c.key);
    if (!L) {
      // Not here: creatable only when the change carries a create payload and isn't a delete.
      out.push(
        c.create && !(c.field === 'deleted' && c.value === true)
          ? { kind: 'apply', change: c }
          : { kind: 'noop', change: c },
      );
      continue;
    }
    const B = baseline(c.key);
    const lv = L[c.field];
    if (same(lv, c.value)) out.push({ kind: 'noop', change: c });
    else if (B && same(lv, B[c.field])) out.push({ kind: 'apply', change: c });
    else if (!B && c.field !== 'deleted' && isEmptyish(c.field, lv)) out.push({ kind: 'apply', change: c });
    else out.push({ kind: 'conflict', change: c, local: lv });
  }
  return out;
}

/** With no baseline (first sync of an item both sides have), empty local values accept remote data. */
function isEmptyish(field: SyncField, v: unknown): boolean {
  if (field === 'notes') return v === '';
  if (field === 'tags') return Array.isArray(v) && v.length === 0;
  if (field === 'status') return v === 'planned';
  return v === null;
}
