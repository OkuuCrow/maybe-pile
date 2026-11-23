/**
 * Settings, custom themes and layouts.
 *
 * Deliberate JSON exceptions (documented in docs/data-model.md):
 * - `settings.value` holds one JSON value per key; each key is validated with
 *   its Zod schema on read, and invalid values fall back to the default.
 * - `themes.tokens` holds the validated theme token map; it is never queried
 *   by column and is re-validated on every read.
 * Layouts are fully normalized in `layout_components`.
 */
import { AppSettingsSchema, DEFAULT_LIBRARY_QUERY, type AppSettings } from '../../shared/schemas';
import { b2i, i2b, type Db } from '../connection';
import { DEFAULT_LAYOUTS, repairLayout, type LayoutEntry, type LayoutSurface } from '../../domain/layouts';
import { SYSTEM_THEME_ID, ThemeTokensSchema, type ThemeTokens } from '../../domain/themes';

export const DEFAULT_SETTINGS: AppSettings = {
  activeThemeId: SYSTEM_THEME_ID,
  region: 'US',
  autoApplySuggestions: false,
  libraryView: 'grid',
  libraryQuery: DEFAULT_LIBRARY_QUERY,
  providerEnabled: {},
  csvBom: true,
  lastSeenSchemaVersion: 0,
  upNextMax: 10,
  pick: {
    favor: 'neutral',
    favorInProgress: false,
    includeInProgress: false,
    includeOnHold: false,
    skipDays: 7,
  },
  pileHealth: { enabled: true, plannedStaleMonths: 12, inProgressStaleDays: 60 },
  releaseRadar: { includeOnHold: false, notifications: false, refreshOnStart: false },
  quickCapture: { globalShortcut: false, accelerator: 'CommandOrControl+Shift+Space' },
  stats: { showStreaks: false },
  importUndoRetentionDays: 30,
};

export function readSettings(
  db: Db,
  defaults: AppSettings = DEFAULT_SETTINGS,
): { settings: AppSettings; invalidKeys: string[] } {
  const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: Record<string, unknown> = { ...defaults };
  const invalidKeys: string[] = [];
  const shape = AppSettingsSchema.shape;
  for (const r of rows) {
    if (!(r.key in shape)) continue; // unknown/legacy keys are ignored
    const schema = shape[r.key as keyof typeof shape];
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.value);
    } catch {
      invalidKeys.push(r.key);
      continue;
    }
    const v = schema.safeParse(parsed);
    if (v.success) out[r.key] = v.data;
    else invalidKeys.push(r.key);
  }
  return { settings: out as AppSettings, invalidKeys };
}

export function writeSettings(db: Db, patch: Partial<AppSettings>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [k, JSON.stringify(v)],
    );
  }
}

/* ---------- themes ---------- */

export interface StoredTheme {
  id: string;
  name: string;
  tokens: ThemeTokens | null; // null = stored tokens are corrupt/invalid
  updatedAt: string;
}

export function listThemes(db: Db): StoredTheme[] {
  return db
    .all<{ id: string; name: string; tokens: string; updated_at: string }>(
      'SELECT id, name, tokens, updated_at FROM themes ORDER BY name COLLATE NOCASE',
    )
    .map((r) => ({ id: r.id, name: r.name, tokens: parseTokens(r.tokens), updatedAt: r.updated_at }));
}

function parseTokens(json: string): ThemeTokens | null {
  try {
    const r = ThemeTokensSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function getTheme(db: Db, id: string): StoredTheme | undefined {
  return listThemes(db).find((t) => t.id === id);
}

export function upsertTheme(db: Db, id: string, name: string, tokens: ThemeTokens, nowIso: string): void {
  db.run(
    `INSERT INTO themes (id, name, schema_version, tokens, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, tokens = excluded.tokens, updated_at = excluded.updated_at`,
    [id, name, JSON.stringify(tokens), nowIso, nowIso],
  );
}

export function deleteTheme(db: Db, id: string): void {
  db.run('DELETE FROM themes WHERE id = ?', [id]);
}

/* ---------- layouts ---------- */

export function readLayout(db: Db, surface: LayoutSurface): { entries: LayoutEntry[]; notices: string[] } {
  const rows = db.all<{ component_id: string; visible: number; span: number }>(
    'SELECT component_id, visible, span FROM layout_components WHERE surface = ? ORDER BY position',
    [surface],
  );
  if (rows.length === 0) return { entries: DEFAULT_LAYOUTS[surface].map((e) => ({ ...e })), notices: [] };
  // Components introduced by newer app versions are appended silently; notices are
  // reserved for imported layout files, where missing entries indicate a problem.
  const repaired = repairLayout(
    surface,
    rows.map((r) => ({ id: r.component_id, visible: i2b(r.visible), span: r.span === 2 ? 2 : 1 })),
  );
  return { entries: repaired.entries, notices: [] };
}

export function writeLayout(db: Db, surface: LayoutSurface, entries: readonly LayoutEntry[]): void {
  db.run('DELETE FROM layout_components WHERE surface = ?', [surface]);
  entries.forEach((e, i) =>
    db.run(
      'INSERT INTO layout_components (surface, component_id, position, visible, span) VALUES (?, ?, ?, ?, ?)',
      [surface, e.id, i, b2i(e.visible), e.span],
    ),
  );
}

export function resetLayout(db: Db, surface: LayoutSurface): void {
  db.run('DELETE FROM layout_components WHERE surface = ?', [surface]);
}
