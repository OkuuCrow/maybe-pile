/** Custom field definitions, book series and the metadata audit log. */
import type { CustomFieldType } from '../../shared/enums';
import type { AuditEntryView, CustomFieldDefView, SeriesView, TagCount } from '../../shared/types';
import type { Status } from '../../shared/enums';
import { foldText } from '../../domain/normalize';
import type { Db } from '../connection';
import { newId } from './items-repo';

/* ---------- custom fields ---------- */

export function listCustomFieldDefs(db: Db): CustomFieldDefView[] {
  const defs = db.all<{ id: string; name: string; value_type: CustomFieldType; usage: number }>(
    `SELECT d.id, d.name, d.value_type, (SELECT count(*) FROM custom_field_values v WHERE v.def_id = d.id) AS usage
     FROM custom_field_defs d ORDER BY d.name_key`,
  );
  const opts = db.all<{ def_id: string; value: string }>(
    'SELECT def_id, value FROM custom_field_options ORDER BY def_id, position',
  );
  return defs.map((d) => ({
    id: d.id,
    name: d.name,
    type: d.value_type,
    options: opts.filter((o) => o.def_id === d.id).map((o) => o.value),
    usageCount: d.usage,
  }));
}

export function customFieldTypes(db: Db): Map<string, CustomFieldType> {
  return new Map(
    db
      .all<{ id: string; value_type: CustomFieldType }>('SELECT id, value_type FROM custom_field_defs')
      .map((r) => [r.id, r.value_type]),
  );
}

export function customFieldOptions(db: Db, defId: string): string[] {
  return db
    .all<{ value: string }>('SELECT value FROM custom_field_options WHERE def_id = ? ORDER BY position', [
      defId,
    ])
    .map((r) => r.value);
}

export function findCustomFieldByName(db: Db, name: string): { id: string } | undefined {
  return db.get<{ id: string }>('SELECT id FROM custom_field_defs WHERE name_key = ?', [
    foldText(name.trim()),
  ]);
}

export function upsertCustomFieldDef(
  db: Db,
  def: { id: string | null; name: string; type: CustomFieldType; options: string[] },
  nowIso: string,
): string {
  const id = def.id ?? newId();
  if (def.id) {
    db.run('UPDATE custom_field_defs SET name = ?, name_key = ? WHERE id = ?', [
      def.name,
      foldText(def.name),
      id,
    ]);
  } else {
    db.run(
      'INSERT INTO custom_field_defs (id, name, name_key, value_type, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, def.name, foldText(def.name), def.type, nowIso],
    );
  }
  db.run('DELETE FROM custom_field_options WHERE def_id = ?', [id]);
  def.options.forEach((o, i) =>
    db.run('INSERT INTO custom_field_options (def_id, position, value) VALUES (?, ?, ?)', [id, i, o]),
  );
  return id;
}

export function deleteCustomFieldDef(db: Db, id: string): void {
  db.run('DELETE FROM custom_field_defs WHERE id = ?', [id]);
}

/* ---------- series ---------- */

export function listSeries(db: Db): SeriesView[] {
  const series = db.all<{ id: string; name: string; description: string | null; total_known: number | null }>(
    'SELECT id, name, description, total_known FROM book_series ORDER BY name COLLATE NOCASE',
  );
  const members = db.all<{
    series_id: string;
    item_id: string;
    title: string;
    position: number | null;
    status: Status;
  }>(
    `SELECT sm.series_id, sm.item_id, i.title, sm.position, i.status FROM series_members sm JOIN items i ON i.id = sm.item_id
     WHERE i.deleted_at IS NULL ORDER BY sm.position IS NULL, sm.position, i.sort_title`,
  );
  return series.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    totalKnown: s.total_known,
    members: members
      .filter((m) => m.series_id === s.id)
      .map((m) => ({ itemId: m.item_id, title: m.title, position: m.position, status: m.status })),
  }));
}

export function upsertSeries(
  db: Db,
  s: { id: string | null; name: string; description: string | null; totalKnown: number | null },
  nowIso: string,
): string {
  const id = s.id ?? newId();
  db.run(
    `INSERT INTO book_series (id, name, description, total_known, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, total_known = excluded.total_known,
       updated_at = excluded.updated_at`,
    [id, s.name, s.description, s.totalKnown, nowIso, nowIso],
  );
  return id;
}

export function deleteSeries(db: Db, id: string): void {
  db.run('DELETE FROM book_series WHERE id = ?', [id]);
}

export function setSeriesMembership(db: Db, seriesId: string, itemId: string, position: number | null): void {
  db.run(
    `INSERT INTO series_members (series_id, item_id, position) VALUES (?, ?, ?)
     ON CONFLICT(series_id, item_id) DO UPDATE SET position = excluded.position`,
    [seriesId, itemId, position],
  );
}

export function removeSeriesMembership(db: Db, seriesId: string, itemId: string): void {
  db.run('DELETE FROM series_members WHERE series_id = ? AND item_id = ?', [seriesId, itemId]);
}

/* ---------- audit ---------- */

export function addAudit(
  db: Db,
  itemId: string,
  action: AuditEntryView['action'],
  providerId: string | null,
  changes: { field: string; oldValue: string | null; newValue: string | null }[],
  nowIso: string,
): void {
  const id = newId();
  db.run('INSERT INTO audit_entries (id, item_id, at, action, provider_id) VALUES (?, ?, ?, ?, ?)', [
    id,
    itemId,
    nowIso,
    action,
    providerId,
  ]);
  for (const c of changes) {
    db.run(
      'INSERT OR REPLACE INTO audit_changes (audit_id, field, old_value, new_value) VALUES (?, ?, ?, ?)',
      [id, c.field, c.oldValue, c.newValue],
    );
  }
}

export function listAudit(db: Db, itemId: string): AuditEntryView[] {
  const entries = db.all<{
    id: string;
    at: string;
    action: AuditEntryView['action'];
    provider_id: string | null;
  }>('SELECT id, at, action, provider_id FROM audit_entries WHERE item_id = ? ORDER BY at DESC LIMIT 100', [
    itemId,
  ]);
  return entries.map((e) => ({
    id: e.id,
    at: e.at,
    action: e.action,
    providerId: e.provider_id,
    changes: db
      .all<{ field: string; old_value: string | null; new_value: string | null }>(
        'SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ? ORDER BY field',
        [e.id],
      )
      .map((c) => ({ field: c.field, oldValue: c.old_value, newValue: c.new_value })),
  }));
}

/* ---------- tags ---------- */

export function tagCounts(db: Db, limit = 500): TagCount[] {
  return db.all<TagCount>(
    `SELECT t.name AS tag, count(i.id) AS count FROM tags t
     JOIN item_tags it ON it.tag_id = t.id JOIN items i ON i.id = it.item_id AND i.deleted_at IS NULL
     GROUP BY t.id ORDER BY count DESC, t.name_key LIMIT ?`,
    [limit],
  );
}
