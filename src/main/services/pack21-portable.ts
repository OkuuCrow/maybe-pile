/**
 * formatVersion 4 ("pack21") section of the JSON export: Notifications Pack +
 * Simple Mode data stored outside the item record.
 *
 * Included: custom reminders, next steps, checklists, people + loans +
 * "recommended by" (third-party names: included in exports by design,
 * documented), saved views, templates, journal entries, time goals, item
 * flags, skipped-episode marks, Recently-deleted markers (the deleted items
 * themselves travel in `items`), and the 2.1 settings (validated per key).
 *
 * Not included: notify-state.sqlite (runtime: claims, history, snoozes),
 * the change log and the offline lookup queue (local, regenerable), and —
 * never — background registrations: on a new computer the user re-enables
 * them explicitly.
 *
 * Import merge semantics (same as pack2): rows of items not in the import
 * are dropped; existing rows win; settings are applied only for keys the
 * target library never stored, and a background delivery mode is downgraded
 * to "While the app is open" (registrations are never restored silently).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../../db/connection';
import { tagKey } from '../../domain/normalize';
import { MEDIA_TYPES } from '../../shared/enums';
import { AppSettingsSchema, IdSchema, LibraryQuerySchema } from '../../shared/schemas';
import { ItemTemplateBodySchema } from '../../shared/pack21-schemas';

const ts = z.string().max(40);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const N = 200_000;

export const PACK21_SETTING_KEYS = [
  'notifications',
  'interface',
  'backdrops',
  'artworkSources',
  'trash',
  'changeLog',
  'ratingPrompt',
  'autoRules',
  'themeSchedule',
  'nextStep',
] as const;

export const Pack21SectionSchema = z.object({
  reminders: z
    .array(
      z.object({
        id: IdSchema,
        itemId: IdSchema.nullable(),
        message: z.string().min(1).max(140),
        kind: z.enum(['once', 'repeat']),
        anchorAt: ts,
        anchorDate: date,
        localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        repeatFreq: z.enum(['daily', 'weekly', 'monthly', 'weekdays']).nullable(),
        repeatInterval: z.number().int().min(1).max(30),
        repeatWeekdays: z.number().int().min(0).max(127),
        enabled: z.boolean(),
      }),
    )
    .max(N),
  nextSteps: z
    .array(z.object({ itemId: IdSchema, text: z.string().min(1).max(140), spoiler: z.boolean() }))
    .max(N),
  checklists: z
    .array(
      z.object({
        itemId: IdSchema,
        items: z
          .array(
            z.object({
              text: z.string().min(1).max(200),
              position: z.number().int().min(0),
              checkedAt: ts.nullable(),
            }),
          )
          .max(500),
      }),
    )
    .max(N),
  people: z.array(z.object({ id: IdSchema, name: z.string().min(1).max(80), forgotten: z.boolean() })).max(N),
  loans: z
    .array(
      z.object({
        itemId: IdSchema,
        personId: IdSchema.nullable(),
        direction: z.enum(['lent', 'borrowed']),
        loanedOn: date,
        dueOn: date.nullable(),
        returnedOn: date.nullable(),
        note: z.string().max(500).nullable(),
      }),
    )
    .max(N),
  recommenders: z
    .array(
      z.object({
        itemId: IdSchema,
        personId: IdSchema,
        note: z.string().max(500).nullable(),
        recommendedOn: date.nullable(),
      }),
    )
    .max(N),
  savedViews: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        query: z.unknown(),
        viewMode: z.enum(['grid', 'list', 'wall']),
        position: z.number().int().min(0),
        pinned: z.boolean(),
      }),
    )
    .max(500),
  templates: z
    .array(
      z.object({ name: z.string().min(1).max(80), body: z.unknown(), position: z.number().int().min(0) }),
    )
    .max(500),
  journal: z
    .array(
      z.object({
        itemId: IdSchema,
        entryDate: date,
        body: z.string().min(1).max(20_000),
        progressLabel: z.string().max(40).nullable(),
        spoiler: z.boolean(),
      }),
    )
    .max(N),
  timeGoals: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        targetMinutes: z.number().int().min(1).max(10_080),
        period: z.enum(['day', 'week']),
        mediaType: z.enum(MEDIA_TYPES).nullable(),
        archived: z.boolean(),
      }),
    )
    .max(1_000),
  itemFlags: z.array(z.object({ itemId: IdSchema, flag: z.enum(['stale']), setAt: ts })).max(N),
  skippedEpisodes: z
    .array(z.object({ itemId: IdSchema, season: z.number().int().min(0), episode: z.number().int().min(0) }))
    .max(N),
  trash: z.array(z.object({ itemId: IdSchema, deletedAt: ts })).max(N),
  settings: z.record(z.string().max(40), z.unknown()),
});
export type Pack21Section = z.infer<typeof Pack21SectionSchema>;

export function exportPack21(db: Db): Pack21Section {
  const settingsRows = db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const settings: Record<string, unknown> = {};
  for (const r of settingsRows) {
    if (!(PACK21_SETTING_KEYS as readonly string[]).includes(r.key)) continue;
    try {
      settings[r.key] = JSON.parse(r.value) as unknown;
    } catch {
      /* skip corrupt value */
    }
  }
  const checklistRows = db.all<{
    item_id: string;
    text: string;
    position: number;
    checked_at: string | null;
  }>(
    'SELECT c.item_id, i.text, i.position, i.checked_at FROM checklists c JOIN checklist_items i ON i.checklist_id = c.id ORDER BY c.item_id, i.position',
  );
  const byItem = new Map<string, Pack21Section['checklists'][number]['items']>();
  for (const r of checklistRows)
    byItem.set(r.item_id, [
      ...(byItem.get(r.item_id) ?? []),
      { text: r.text, position: r.position, checkedAt: r.checked_at },
    ]);
  return {
    reminders: db
      .all<{
        id: string;
        item_id: string | null;
        message: string;
        kind: 'once' | 'repeat';
        anchor_at: string;
        anchor_date: string;
        local_time: string;
        repeat_freq: Pack21Section['reminders'][number]['repeatFreq'];
        repeat_interval: number;
        repeat_weekdays: number;
        enabled: number;
      }>('SELECT * FROM reminders ORDER BY created_at, id')
      .map((r) => ({
        id: r.id,
        itemId: r.item_id,
        message: r.message,
        kind: r.kind,
        anchorAt: r.anchor_at,
        anchorDate: r.anchor_date,
        localTime: r.local_time,
        repeatFreq: r.repeat_freq,
        repeatInterval: r.repeat_interval,
        repeatWeekdays: r.repeat_weekdays,
        enabled: r.enabled === 1,
      })),
    nextSteps: db
      .all<{ item_id: string; text: string; spoiler: number }>(
        'SELECT item_id, text, spoiler FROM item_next_steps',
      )
      .map((r) => ({ itemId: r.item_id, text: r.text, spoiler: r.spoiler === 1 })),
    checklists: [...byItem].map(([itemId, items]) => ({ itemId, items })),
    people: db
      .all<{ id: string; name: string; forgotten: number }>('SELECT id, name, forgotten FROM people')
      .map((r) => ({ id: r.id, name: r.name, forgotten: r.forgotten === 1 })),
    loans: db
      .all<{
        item_id: string;
        person_id: string | null;
        direction: 'lent' | 'borrowed';
        loaned_on: string;
        due_on: string | null;
        returned_on: string | null;
        note: string | null;
      }>('SELECT item_id, person_id, direction, loaned_on, due_on, returned_on, note FROM loans')
      .map((r) => ({
        itemId: r.item_id,
        personId: r.person_id,
        direction: r.direction,
        loanedOn: r.loaned_on,
        dueOn: r.due_on,
        returnedOn: r.returned_on,
        note: r.note,
      })),
    recommenders: db
      .all<{ item_id: string; person_id: string; note: string | null; recommended_on: string | null }>(
        'SELECT item_id, person_id, note, recommended_on FROM item_recommenders',
      )
      .map((r) => ({
        itemId: r.item_id,
        personId: r.person_id,
        note: r.note,
        recommendedOn: r.recommended_on,
      })),
    savedViews: db
      .all<{
        name: string;
        query: string;
        view_mode: 'grid' | 'list' | 'wall';
        position: number;
        pinned: number;
      }>('SELECT name, query, view_mode, position, pinned FROM saved_views ORDER BY position')
      .map((r) => ({
        name: r.name,
        query: JSON.parse(r.query) as unknown,
        viewMode: r.view_mode,
        position: r.position,
        pinned: r.pinned === 1,
      })),
    templates: db
      .all<{ name: string; body: string; position: number }>(
        'SELECT name, body, position FROM item_templates ORDER BY position',
      )
      .map((r) => ({ name: r.name, body: JSON.parse(r.body) as unknown, position: r.position })),
    journal: db
      .all<{
        item_id: string;
        entry_date: string;
        body: string;
        progress_label: string | null;
        spoiler: number;
      }>(
        'SELECT item_id, entry_date, body, progress_label, spoiler FROM journal_entries ORDER BY entry_date, created_at',
      )
      .map((r) => ({
        itemId: r.item_id,
        entryDate: r.entry_date,
        body: r.body,
        progressLabel: r.progress_label,
        spoiler: r.spoiler === 1,
      })),
    timeGoals: db
      .all<{
        title: string;
        target_minutes: number;
        period: 'day' | 'week';
        media_type: (typeof MEDIA_TYPES)[number] | null;
        archived_at: string | null;
      }>('SELECT title, target_minutes, period, media_type, archived_at FROM time_goals')
      .map((r) => ({
        title: r.title,
        targetMinutes: r.target_minutes,
        period: r.period,
        mediaType: r.media_type,
        archived: r.archived_at !== null,
      })),
    itemFlags: db
      .all<{ item_id: string; flag: 'stale'; set_at: string }>('SELECT item_id, flag, set_at FROM item_flags')
      .map((r) => ({ itemId: r.item_id, flag: r.flag, setAt: r.set_at })),
    skippedEpisodes: db
      .all<{ item_id: string; s: number; e: number }>(
        'SELECT e.item_id, se.season_number AS s, e.episode_number AS e FROM episodes e JOIN seasons se ON se.id = e.season_id WHERE e.skipped = 1',
      )
      .map((r) => ({ itemId: r.item_id, season: r.s, episode: r.e })),
    trash: db
      .all<{ id: string; deleted_at: string }>(
        'SELECT id, deleted_at FROM items WHERE deleted_at IS NOT NULL',
      )
      .map((r) => ({ itemId: r.id, deletedAt: r.deleted_at })),
    settings,
  };
}

/** Imports the section; returns the number of rows written. */
export function importPack21(db: Db, s: Pack21Section, idMap: Map<string, string>, now: string): number {
  const item = (id: string | null) => (id === null ? null : (idMap.get(id) ?? null));
  const has = (id: string) => !!db.get('SELECT 1 AS x FROM items WHERE id = ?', [id]);
  let n = 0;
  const run = (sql: string, params: (string | number | null)[]) => (n += db.run(sql, params).changes);

  const personMap = new Map<string, string>();
  for (const p of s.people) {
    const key = p.forgotten ? `forgotten:${p.id}` : tagKey(p.name);
    const existing = db.get<{ id: string }>('SELECT id FROM people WHERE name_key = ?', [key]);
    if (existing) {
      personMap.set(p.id, existing.id);
      continue;
    }
    const id = randomUUID();
    run('INSERT INTO people (id, name, name_key, forgotten, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      p.name,
      key,
      p.forgotten ? 1 : 0,
      now,
    ]);
    personMap.set(p.id, id);
  }
  for (const r of s.reminders) {
    const itemId = r.itemId ? item(r.itemId) : null;
    if (r.itemId && !itemId) continue;
    if ((r.kind === 'once') !== (r.repeatFreq === null)) continue;
    run(
      `INSERT OR IGNORE INTO reminders (id, item_id, message, kind, anchor_at, anchor_date, local_time, repeat_freq, repeat_interval, repeat_weekdays, next_fire_at, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        r.id,
        itemId,
        r.message,
        r.kind,
        r.anchorAt,
        r.anchorDate,
        r.localTime,
        r.repeatFreq,
        r.repeatInterval,
        r.repeatWeekdays,
        r.enabled ? 1 : 0,
        now,
        now,
      ],
    );
  }
  for (const x of s.nextSteps) {
    const id = item(x.itemId);
    if (id && has(id))
      run('INSERT OR IGNORE INTO item_next_steps (item_id, text, spoiler, updated_at) VALUES (?, ?, ?, ?)', [
        id,
        x.text,
        x.spoiler ? 1 : 0,
        now,
      ]);
  }
  for (const c of s.checklists) {
    const id = item(c.itemId);
    if (!id || !has(id) || db.get('SELECT 1 AS x FROM checklists WHERE item_id = ?', [id])) continue;
    const cl = randomUUID();
    run('INSERT INTO checklists (id, item_id, created_at) VALUES (?, ?, ?)', [cl, id, now]);
    c.items.forEach((ci, i) =>
      run(
        'INSERT INTO checklist_items (id, checklist_id, text, position, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [randomUUID(), cl, ci.text, i, ci.checkedAt, now],
      ),
    );
  }
  for (const l of s.loans) {
    const id = item(l.itemId);
    if (!id || !has(id)) continue;
    run(
      'INSERT INTO loans (id, item_id, person_id, direction, loaned_on, due_on, returned_on, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        id,
        l.personId ? (personMap.get(l.personId) ?? null) : null,
        l.direction,
        l.loanedOn,
        l.dueOn,
        l.returnedOn,
        l.note,
        now,
        now,
      ],
    );
  }
  for (const r of s.recommenders) {
    const id = item(r.itemId);
    const person = personMap.get(r.personId);
    if (id && person && has(id))
      run(
        'INSERT OR IGNORE INTO item_recommenders (item_id, person_id, note, recommended_on, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, person, r.note, r.recommendedOn, now],
      );
  }
  let pos = db.get<{ p: number | null }>('SELECT max(position) AS p FROM saved_views')?.p ?? -1;
  for (const v of s.savedViews) {
    const q = LibraryQuerySchema.safeParse(v.query);
    if (!q.success) continue;
    // Stable ids inside the query (lists) are remapped or dropped; stale referents are flagged in the UI.
    run(
      'INSERT OR IGNORE INTO saved_views (id, name, name_key, query, view_mode, position, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        v.name,
        tagKey(v.name),
        JSON.stringify(q.data),
        v.viewMode,
        ++pos,
        v.pinned ? 1 : 0,
        now,
        now,
      ],
    );
  }
  let tpos = db.get<{ p: number | null }>('SELECT max(position) AS p FROM item_templates')?.p ?? -1;
  for (const t of s.templates) {
    const b = ItemTemplateBodySchema.safeParse(t.body);
    if (!b.success) continue;
    run(
      'INSERT OR IGNORE INTO item_templates (id, name, name_key, body, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), t.name, tagKey(t.name), JSON.stringify(b.data), ++tpos, now, now],
    );
  }
  for (const j of s.journal) {
    const id = item(j.itemId);
    if (!id || !has(id)) continue;
    const jid = randomUUID();
    run(
      'INSERT INTO journal_entries (id, item_id, entry_date, body, progress_label, spoiler, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [jid, id, j.entryDate, j.body, j.progressLabel, j.spoiler ? 1 : 0, now, now],
    );
    const rid = db.get<{ rid: number }>('SELECT rid FROM journal_entries WHERE id = ?', [jid])?.rid;
    if (rid !== undefined) db.run('INSERT INTO journal_fts (rowid, body) VALUES (?, ?)', [rid, j.body]);
  }
  for (const g of s.timeGoals)
    run(
      'INSERT INTO time_goals (id, title, target_minutes, period, media_type, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), g.title, g.targetMinutes, g.period, g.mediaType, g.archived ? now : null, now, now],
    );
  for (const f of s.itemFlags) {
    const id = item(f.itemId);
    if (id && has(id))
      run('INSERT OR IGNORE INTO item_flags (item_id, flag, set_at) VALUES (?, ?, ?)', [id, f.flag, f.setAt]);
  }
  for (const e of s.skippedEpisodes) {
    const id = item(e.itemId);
    if (!id) continue;
    run(
      'UPDATE episodes SET skipped = 1 WHERE item_id = ? AND season_id IN (SELECT id FROM seasons WHERE item_id = ? AND season_number = ?) AND episode_number = ?',
      [id, id, e.season, e.episode],
    );
  }
  for (const t of s.trash) {
    const id = item(t.itemId);
    if (id) run('UPDATE items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [t.deletedAt, id]);
  }
  // Settings: only keys the target never stored, validated; background modes are never restored.
  const shape = AppSettingsSchema.shape;
  for (const key of PACK21_SETTING_KEYS) {
    if (!(key in s.settings)) continue;
    if (db.get('SELECT 1 AS x FROM settings WHERE key = ?', [key])) continue;
    const parsed = shape[key].safeParse(s.settings[key]);
    if (!parsed.success) continue;
    let value: unknown = parsed.data;
    if (key === 'notifications') {
      const ns = parsed.data as z.infer<typeof shape.notifications>;
      value =
        ns.mode === 'tray' || ns.mode === 'scheduled'
          ? { ...ns, mode: 'whileOpen', alsoScheduled: false, startAtLogin: false }
          : ns;
    }
    run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  }
  return n;
}
