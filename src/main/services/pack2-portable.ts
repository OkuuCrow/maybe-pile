/**
 * formatVersion 3 ("pack2") section of the JSON export: everything Expansion
 * Pack 2 stores outside the item record itself. Anime metadata travels inside
 * each item's `meta` (MetadataFieldsSchema), so it needs nothing here.
 *
 * Not included (by design): API keys/secrets (never in the DB), sync state,
 * merge snapshots (local undo history), artwork files (full backups carry
 * those), and episode checkmarks of finished runs (episodes are re-created
 * on import, so their ids don't survive).
 *
 * Import merge semantics: rows whose items aren't in the import are dropped;
 * existing rows win (nothing local is overwritten); moods and services merge
 * by name; built-in moods merge by their built-in key.
 */
import { z } from 'zod';
import type { Db } from '../../db/connection';
import { newId } from '../../db/repositories/items-repo';
import { titleKey } from '../../domain/normalize';
import {
  AUDIO_PREFS,
  AVAILABILITY_KINDS,
  HOURS_SOURCES,
  MEDIA_TYPES,
  MOOD_COLORS,
  MOOD_ICONS,
  RELATION_TYPES,
  SERVICE_KINDS,
  SPOILER_MODES,
  STATUSES,
} from '../../shared/enums';
import { IdSchema } from '../../shared/schemas';

const ts = z.string().max(40);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const N = 200_000;

export const Pack2SectionSchema = z.object({
  itemPrefs: z
    .array(
      z.object({
        itemId: IdSchema,
        spoilerMode: z.enum(SPOILER_MODES),
        notesSpoiler: z.boolean(),
        hoursSource: z.enum(HOURS_SOURCES),
        audioPref: z.enum(AUDIO_PREFS).nullable(),
      }),
    )
    .max(N),
  timeEstimates: z
    .array(
      z.object({
        itemId: IdSchema,
        source: z.enum(['manual', 'provider']),
        minutes: z.number().int().min(1).max(600_000),
        confidence: z.enum(['high', 'medium', 'low']),
        providerId: z.string().max(40).nullable(),
        detail: z.string().max(200).nullable(),
        fetchedAt: ts,
      }),
    )
    .max(N),
  moods: z
    .array(
      z.object({
        id: IdSchema,
        name: z.string().min(1).max(40),
        icon: z.enum(MOOD_ICONS),
        color: z.enum(MOOD_COLORS).nullable(),
        hidden: z.boolean(),
        position: z.number().int().min(0),
        builtinKey: z.string().max(40).nullable(),
      }),
    )
    .max(100),
  itemMoods: z.array(z.object({ itemId: IdSchema, moodId: IdSchema })).max(N * 5),
  runs: z
    .array(
      z.object({
        itemId: IdSchema,
        runNumber: z.number().int().min(1),
        status: z.enum(STATUSES),
        dateStarted: date.nullable(),
        dateCompleted: date.nullable(),
        rating: z.number().int().min(1).max(10).nullable(),
        notes: z.string().max(20_000),
        createdAt: ts,
        updatedAt: ts,
      }),
    )
    .max(N),
  relations: z
    .array(
      z.object({
        id: IdSchema,
        fromItemId: IdSchema,
        toItemId: IdSchema,
        type: z.enum(RELATION_TYPES),
        origin: z.enum(['user', 'provider']),
        createdAt: ts,
      }),
    )
    .max(N),
  relationSuggestions: z
    .array(
      z.object({
        itemId: IdSchema,
        providerId: z.string().max(40),
        targetRef: z.string().max(100),
        targetType: z.enum(MEDIA_TYPES),
        targetTitle: z.string().min(1).max(500),
        targetYear: z.number().int().nullable(),
        relation: z.enum([
          'prequel',
          'sequel',
          'spin_off',
          'side_story',
          'adaptation_of',
          'adapted_as',
          'remake_of',
          'same_franchise',
        ]),
        targetItemId: IdSchema.nullable(),
        state: z.enum(['pending', 'accepted', 'dismissed']),
        createdAt: ts,
      }),
    )
    .max(N),
  franchises: z
    .array(
      z.object({
        id: IdSchema,
        name: z.string().min(1).max(120),
        respectOrder: z.boolean(),
        createdAt: ts,
        updatedAt: ts,
        entries: z
          .array(z.object({ itemId: IdSchema, position: z.number().min(0), mainline: z.boolean() }))
          .max(5_000),
      }),
    )
    .max(10_000),
  purchases: z
    .array(
      z.object({
        id: IdSchema,
        itemId: IdSchema,
        amountMinor: z.number().int().min(0).max(100_000_000_000),
        currency: z.string().regex(/^[A-Z]{3}$/),
        purchasedOn: date.nullable(),
        store: z.string().max(120).nullable(),
        edition: z.string().max(200).nullable(),
        notes: z.string().max(2000).nullable(),
        createdAt: ts,
        updatedAt: ts,
      }),
    )
    .max(N),
  sessions: z
    .array(
      z.object({
        id: IdSchema,
        itemId: IdSchema,
        kind: z.enum(['play', 'watch', 'read']),
        source: z.enum(['timer', 'manual']),
        startedAt: ts,
        endedAt: ts,
        durationSeconds: z.number().int().min(0).max(2_592_000),
        note: z.string().max(2000).nullable(),
        createdAt: ts,
      }),
    )
    .max(N * 5),
  services: z
    .array(
      z.object({
        id: IdSchema,
        name: z.string().min(1).max(80),
        kind: z.enum(SERVICE_KINDS),
        active: z.boolean(),
        createdAt: ts,
      }),
    )
    .max(500),
  availability: z
    .array(
      z.object({
        id: IdSchema,
        itemId: IdSchema,
        kind: z.enum(AVAILABILITY_KINDS),
        serviceId: IdSchema.nullable(),
        platform: z.string().max(80).nullable(),
        availableUntil: date.nullable(),
        remindDays: z.number().int().min(0).max(365).nullable(),
        notes: z.string().max(2000).nullable(),
        createdAt: ts,
        updatedAt: ts,
      }),
    )
    .max(N),
  recFeedback: z
    .array(
      z.object({
        itemId: IdSchema,
        kind: z.enum(['dismissed', 'not_interested']),
        until: date.nullable(),
        createdAt: ts,
      }),
    )
    .max(N),
  streamingLinks: z
    .array(
      z.object({
        itemId: IdSchema,
        providerId: z.string().max(40),
        service: z.string().min(1).max(60),
        url: z.string().max(2000).startsWith('https://'),
        subs: z.array(z.string().max(12)).max(30),
        dubs: z.array(z.string().max(12)).max(30),
        fetchedAt: ts,
      }),
    )
    .max(N),
});
export type Pack2Section = z.infer<typeof Pack2SectionSchema>;

const json = (s: string): string[] => {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const LIVE = 'item_id IN (SELECT id FROM items WHERE deleted_at IS NULL)';

export function exportPack2(db: Db): Pack2Section {
  return {
    itemPrefs: db
      .all<{
        item_id: string;
        spoiler_mode: never;
        notes_spoiler: number;
        hours_source: never;
        audio_pref: never;
      }>(`SELECT * FROM item_prefs WHERE ${LIVE}`)
      .map((r) => ({
        itemId: r.item_id,
        spoilerMode: r.spoiler_mode,
        notesSpoiler: r.notes_spoiler === 1,
        hoursSource: r.hours_source,
        audioPref: r.audio_pref,
      })),
    timeEstimates: db
      .all<{
        item_id: string;
        source: never;
        minutes: number;
        confidence: never;
        provider_id: string | null;
        detail: string | null;
        fetched_at: string;
      }>(`SELECT * FROM time_estimates WHERE ${LIVE}`)
      .map((r) => ({
        itemId: r.item_id,
        source: r.source,
        minutes: r.minutes,
        confidence: r.confidence,
        providerId: r.provider_id,
        detail: r.detail,
        fetchedAt: r.fetched_at,
      })),
    moods: db
      .all<{
        id: string;
        name: string;
        icon: never;
        color: never;
        hidden: number;
        position: number;
        builtin_key: string | null;
      }>('SELECT * FROM moods ORDER BY position')
      .map((r) => ({
        id: r.id,
        name: r.name,
        icon: r.icon,
        color: r.color,
        hidden: r.hidden === 1,
        position: r.position,
        builtinKey: r.builtin_key,
      })),
    itemMoods: db
      .all<{ item_id: string; mood_id: string }>(`SELECT * FROM item_moods WHERE ${LIVE}`)
      .map((r) => ({ itemId: r.item_id, moodId: r.mood_id })),
    runs: db
      .all<{
        item_id: string;
        run_number: number;
        status: never;
        date_started: string | null;
        date_completed: string | null;
        rating: number | null;
        notes: string;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT r.* FROM item_runs r JOIN items i ON i.id = r.item_id WHERE i.deleted_at IS NULL AND r.run_number < i.pass`,
      )
      .map((r) => ({
        itemId: r.item_id,
        runNumber: r.run_number,
        status: r.status,
        dateStarted: r.date_started,
        dateCompleted: r.date_completed,
        rating: r.rating,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    relations: db
      .all<{
        id: string;
        from_item_id: string;
        to_item_id: string;
        type: never;
        origin: never;
        created_at: string;
      }>(
        `SELECT * FROM item_relations WHERE from_item_id IN (SELECT id FROM items WHERE deleted_at IS NULL) AND to_item_id IN (SELECT id FROM items WHERE deleted_at IS NULL)`,
      )
      .map((r) => ({
        id: r.id,
        fromItemId: r.from_item_id,
        toItemId: r.to_item_id,
        type: r.type,
        origin: r.origin,
        createdAt: r.created_at,
      })),
    relationSuggestions: db
      .all<{
        item_id: string;
        provider_id: string;
        target_ref: string;
        target_type: never;
        target_title: string;
        target_year: number | null;
        relation: never;
        target_item_id: string | null;
        state: never;
        created_at: string;
      }>(`SELECT * FROM relation_suggestions WHERE ${LIVE}`)
      .map((r) => ({
        itemId: r.item_id,
        providerId: r.provider_id,
        targetRef: r.target_ref,
        targetType: r.target_type,
        targetTitle: r.target_title,
        targetYear: r.target_year,
        relation: r.relation,
        targetItemId: r.target_item_id,
        state: r.state,
        createdAt: r.created_at,
      })),
    franchises: db
      .all<{ id: string; name: string; respect_order: number; created_at: string; updated_at: string }>(
        'SELECT * FROM franchises ORDER BY name',
      )
      .map((f) => ({
        id: f.id,
        name: f.name,
        respectOrder: f.respect_order === 1,
        createdAt: f.created_at,
        updatedAt: f.updated_at,
        entries: db
          .all<{ item_id: string; position: number; mainline: number }>(
            `SELECT * FROM franchise_items WHERE franchise_id = ? AND ${LIVE} ORDER BY position`,
            [f.id],
          )
          .map((e) => ({ itemId: e.item_id, position: e.position, mainline: e.mainline === 1 })),
      })),
    purchases: db
      .all<{
        id: string;
        item_id: string;
        amount_minor: number;
        currency: string;
        purchased_on: string | null;
        store: string | null;
        edition: string | null;
        notes: string | null;
        created_at: string;
        updated_at: string;
      }>(`SELECT * FROM purchases WHERE ${LIVE}`)
      .map((p) => ({
        id: p.id,
        itemId: p.item_id,
        amountMinor: p.amount_minor,
        currency: p.currency,
        purchasedOn: p.purchased_on,
        store: p.store,
        edition: p.edition,
        notes: p.notes,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    sessions: db
      .all<{
        id: string;
        item_id: string;
        kind: never;
        source: never;
        started_at: string;
        ended_at: string;
        duration_seconds: number;
        note: string | null;
        created_at: string;
      }>(`SELECT * FROM sessions WHERE state = 'done' AND ${LIVE}`)
      .map((s) => ({
        id: s.id,
        itemId: s.item_id,
        kind: s.kind,
        source: s.source,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        durationSeconds: s.duration_seconds,
        note: s.note,
        createdAt: s.created_at,
      })),
    services: db
      .all<{ id: string; name: string; kind: never; active: number; created_at: string }>(
        'SELECT * FROM services ORDER BY name',
      )
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        active: s.active === 1,
        createdAt: s.created_at,
      })),
    availability: db
      .all<{
        id: string;
        item_id: string;
        kind: never;
        service_id: string | null;
        platform: string | null;
        available_until: string | null;
        remind_days: number | null;
        notes: string | null;
        created_at: string;
        updated_at: string;
      }>(`SELECT * FROM availability_entries WHERE ${LIVE}`)
      .map((a) => ({
        id: a.id,
        itemId: a.item_id,
        kind: a.kind,
        serviceId: a.service_id,
        platform: a.platform,
        availableUntil: a.available_until,
        remindDays: a.remind_days,
        notes: a.notes,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    recFeedback: db
      .all<{ item_id: string; kind: never; until: string | null; created_at: string }>(
        `SELECT * FROM rec_feedback WHERE ${LIVE}`,
      )
      .map((r) => ({ itemId: r.item_id, kind: r.kind, until: r.until, createdAt: r.created_at })),
    streamingLinks: db
      .all<{
        item_id: string;
        provider_id: string;
        service: string;
        url: string;
        subs: string;
        dubs: string;
        fetched_at: string;
      }>(`SELECT * FROM streaming_links WHERE ${LIVE}`)
      .map((l) => ({
        itemId: l.item_id,
        providerId: l.provider_id,
        service: l.service,
        url: l.url,
        subs: json(l.subs),
        dubs: json(l.dubs),
        fetchedAt: l.fetched_at,
      })),
  };
}

/** Merges a pack2 section (inside the caller's transaction). Returns rows inserted. */
export function importPack2(db: Db, s: Pack2Section, idMap: Map<string, string>, now: string): number {
  let n = 0;
  const item = (id: string) => idMap.get(id) ?? null;
  const run = (sql: string, params: unknown[]) => (n += db.run(sql, params as never[]).changes);

  for (const p of s.itemPrefs) {
    const id = item(p.itemId);
    if (id)
      run(
        'INSERT OR IGNORE INTO item_prefs (item_id, spoiler_mode, notes_spoiler, hours_source, audio_pref) VALUES (?, ?, ?, ?, ?)',
        [id, p.spoilerMode, p.notesSpoiler ? 1 : 0, p.hoursSource, p.audioPref],
      );
  }
  for (const t of s.timeEstimates) {
    const id = item(t.itemId);
    if (id)
      run(
        `INSERT OR IGNORE INTO time_estimates (item_id, source, minutes, confidence, provider_id, detail, user_set, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          t.source,
          t.minutes,
          t.confidence,
          t.providerId,
          t.detail,
          t.source === 'manual' ? 1 : 0,
          t.fetchedAt,
        ],
      );
  }
  // Moods: built-ins by key, custom by name.
  const moodMap = new Map<string, string>();
  for (const m of s.moods) {
    const existing = m.builtinKey
      ? db.get<{ id: string }>('SELECT id FROM moods WHERE builtin_key = ?', [m.builtinKey])
      : db.get<{ id: string }>('SELECT id FROM moods WHERE name_key = ?', [titleKey(m.name)]);
    if (existing) {
      moodMap.set(m.id, existing.id);
      continue;
    }
    if (m.builtinKey) continue; // unknown built-in key from a newer version: skip
    const id = newId();
    const pos = (db.get<{ p: number | null }>('SELECT max(position) AS p FROM moods')?.p ?? -1) + 1;
    run(
      'INSERT INTO moods (id, name, name_key, icon, color, hidden, position, builtin_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
      [id, m.name, titleKey(m.name), m.icon, m.color, m.hidden ? 1 : 0, pos, now],
    );
    moodMap.set(m.id, id);
  }
  for (const im of s.itemMoods) {
    const id = item(im.itemId);
    const mood = moodMap.get(im.moodId);
    if (id && mood) run('INSERT OR IGNORE INTO item_moods (item_id, mood_id) VALUES (?, ?)', [id, mood]);
  }
  for (const r of s.runs) {
    const id = item(r.itemId);
    if (id)
      run(
        `INSERT OR IGNORE INTO item_runs (id, item_id, run_number, status, date_started, date_completed, rating, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          id,
          r.runNumber,
          r.status,
          r.dateStarted,
          r.dateCompleted,
          r.rating,
          r.notes,
          r.createdAt,
          r.updatedAt,
        ],
      );
  }
  for (const r of s.relations) {
    const a = item(r.fromItemId);
    const b = item(r.toItemId);
    if (a && b && a !== b)
      run(
        'INSERT OR IGNORE INTO item_relations (id, from_item_id, to_item_id, type, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [newId(), a, b, r.type, r.origin, r.createdAt],
      );
  }
  for (const r of s.relationSuggestions) {
    const id = item(r.itemId);
    if (id)
      run(
        `INSERT OR IGNORE INTO relation_suggestions (id, item_id, provider_id, target_ref, target_type, target_title, target_year, relation, target_item_id, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          id,
          r.providerId,
          r.targetRef,
          r.targetType,
          r.targetTitle,
          r.targetYear,
          r.relation,
          r.targetItemId ? item(r.targetItemId) : null,
          r.state,
          r.createdAt,
        ],
      );
  }
  for (const f of s.franchises) {
    const key = titleKey(f.name);
    let fid = db.get<{ id: string }>('SELECT id FROM franchises WHERE name_key = ?', [key])?.id;
    if (!fid) {
      fid = newId();
      run(
        'INSERT INTO franchises (id, name, name_key, respect_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [fid, f.name, key, f.respectOrder ? 1 : 0, f.createdAt, f.updatedAt],
      );
    }
    for (const e of f.entries) {
      const id = item(e.itemId);
      if (id)
        run(
          'INSERT OR IGNORE INTO franchise_items (franchise_id, item_id, position, mainline) VALUES (?, ?, ?, ?)',
          [fid, id, e.position, e.mainline ? 1 : 0],
        );
    }
  }
  for (const p of s.purchases) {
    const id = item(p.itemId);
    if (id && !db.get('SELECT 1 FROM purchases WHERE id = ?', [p.id]))
      run(
        `INSERT INTO purchases (id, item_id, amount_minor, currency, purchased_on, store, edition, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          id,
          p.amountMinor,
          p.currency,
          p.purchasedOn,
          p.store,
          p.edition,
          p.notes,
          p.createdAt,
          p.updatedAt,
        ],
      );
  }
  for (const x of s.sessions) {
    const id = item(x.itemId);
    if (id && !db.get('SELECT 1 FROM sessions WHERE id = ?', [x.id]))
      run(
        `INSERT INTO sessions (id, item_id, run_id, kind, state, source, started_at, ended_at, accumulated_seconds, segment_started_at,
                               duration_seconds, note, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'done', ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [
          x.id,
          id,
          x.kind,
          x.source,
          x.startedAt,
          x.endedAt,
          x.durationSeconds,
          x.durationSeconds,
          x.note,
          x.createdAt,
          now,
        ],
      );
  }
  const serviceMap = new Map<string, string>();
  for (const sv of s.services) {
    const key = titleKey(sv.name);
    const existing = db.get<{ id: string }>('SELECT id FROM services WHERE name_key = ?', [key]);
    if (existing) {
      serviceMap.set(sv.id, existing.id);
      continue;
    }
    const id = newId();
    run('INSERT INTO services (id, name, name_key, kind, active, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      sv.name,
      key,
      sv.kind,
      sv.active ? 1 : 0,
      sv.createdAt,
    ]);
    serviceMap.set(sv.id, id);
  }
  for (const a of s.availability) {
    const id = item(a.itemId);
    if (id && !db.get('SELECT 1 FROM availability_entries WHERE id = ?', [a.id]))
      run(
        `INSERT INTO availability_entries (id, item_id, kind, service_id, platform, available_until, remind_days, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          a.id,
          id,
          a.kind,
          a.serviceId ? (serviceMap.get(a.serviceId) ?? null) : null,
          a.platform,
          a.availableUntil,
          a.remindDays,
          a.notes,
          a.createdAt,
          a.updatedAt,
        ],
      );
  }
  for (const r of s.recFeedback) {
    const id = item(r.itemId);
    if (id)
      run('INSERT OR IGNORE INTO rec_feedback (item_id, kind, until, created_at) VALUES (?, ?, ?, ?)', [
        id,
        r.kind,
        r.until,
        r.createdAt,
      ]);
  }
  for (const l of s.streamingLinks) {
    const id = item(l.itemId);
    if (id)
      run(
        `INSERT OR IGNORE INTO streaming_links (id, item_id, provider_id, service, url, subs, dubs, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          id,
          l.providerId,
          l.service,
          l.url,
          JSON.stringify(l.subs),
          JSON.stringify(l.dubs),
          l.fetchedAt,
        ],
      );
  }
  return n;
}
