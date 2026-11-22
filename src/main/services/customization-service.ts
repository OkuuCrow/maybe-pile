/** Settings, themes and layouts. */
import { randomUUID } from 'node:crypto';
import { appError } from '../../shared/result';
import type { AppSettings, SettingsPatch } from '../../shared/schemas';
import type { LayoutsView, ThemeSummary } from '../../shared/types';
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEMES,
  FALLBACK_THEME_ID,
  PILE_DARK,
  PILE_LIGHT,
  SYSTEM_THEME_ID,
  THEME_FORMAT,
  THEME_SCHEMA_VERSION,
  contrastWarnings,
  parseThemeFile,
  ThemeTokensSchema,
  type ContrastWarning,
  type ThemeFile,
  type ThemeTokens,
} from '../../domain/themes';
import {
  entriesToLayoutFile,
  layoutFileToEntries,
  parseLayoutFile,
  repairLayout,
  type LayoutEntry,
  type LayoutSurface,
} from '../../domain/layouts';
import * as cfg from '../../db/repositories/config-repo';
import type { ServiceContext } from './context';

export interface ActiveTheme {
  /** The selected id ('system' or a theme id). */
  selectedId: string;
  /** Tokens to apply; for 'system' both variants are returned so the renderer can follow the OS live. */
  light: ThemeTokens;
  dark: ThemeTokens;
  followSystem: boolean;
  notice: string | null;
}

export interface ThemeDetail {
  id: string;
  name: string;
  builtIn: boolean;
  tokens: ThemeTokens;
  warnings: ContrastWarning[];
}

export class CustomizationService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db();
  }

  /* ---------------------------------------------------------------- settings */

  getSettings(): AppSettings {
    const { settings, invalidKeys } = cfg.readSettings(this.db);
    if (invalidKeys.length > 0) this.ctx.log.warn('settings.invalidKeysIgnored', { keys: invalidKeys });
    return settings;
  }

  patchSettings(patch: SettingsPatch): AppSettings {
    if (patch.activeThemeId !== undefined) this.requireThemeExists(patch.activeThemeId);
    cfg.writeSettings(this.db, patch as Partial<AppSettings>);
    return this.getSettings();
  }

  /* ---------------------------------------------------------------- themes */

  private requireThemeExists(id: string): void {
    if (BUILTIN_THEME_IDS.has(id)) return;
    if (!cfg.getTheme(this.db, id)) throw appError('NOT_FOUND', 'That theme no longer exists.');
  }

  listThemes(): ThemeSummary[] {
    return [
      { id: SYSTEM_THEME_ID, name: 'System (follows OS)', builtIn: true },
      ...BUILTIN_THEMES.map((t) => ({ id: t.id, name: t.name, builtIn: true })),
      ...cfg.listThemes(this.db).map((t) => ({ id: t.id, name: t.name, builtIn: false })),
    ];
  }

  getTheme(id: string): ThemeDetail {
    const builtin = BUILTIN_THEMES.find((t) => t.id === id);
    if (builtin)
      return {
        id,
        name: builtin.name,
        builtIn: true,
        tokens: builtin.tokens,
        warnings: contrastWarnings(builtin.tokens),
      };
    if (id === SYSTEM_THEME_ID)
      return { id, name: 'System (follows OS)', builtIn: true, tokens: PILE_LIGHT, warnings: [] };
    const t = cfg.getTheme(this.db, id);
    if (!t) throw appError('NOT_FOUND', 'That theme no longer exists.');
    if (!t.tokens)
      throw appError('CORRUPT', `The theme "${t.name}" is damaged and can't be loaded.`, {
        recovery: 'Delete it or import a fresh copy.',
      });
    return { id, name: t.name, builtIn: false, tokens: t.tokens, warnings: contrastWarnings(t.tokens) };
  }

  /** Resolves the active theme, falling back to the built-in theme if it is missing or corrupt. */
  activeTheme(): ActiveTheme {
    const { activeThemeId } = this.getSettings();
    if (activeThemeId === SYSTEM_THEME_ID)
      return {
        selectedId: activeThemeId,
        light: PILE_LIGHT,
        dark: PILE_DARK,
        followSystem: true,
        notice: null,
      };
    const builtin = BUILTIN_THEMES.find((t) => t.id === activeThemeId);
    if (builtin)
      return {
        selectedId: activeThemeId,
        light: builtin.tokens,
        dark: builtin.tokens,
        followSystem: false,
        notice: null,
      };
    const t = cfg.getTheme(this.db, activeThemeId);
    if (t?.tokens)
      return {
        selectedId: activeThemeId,
        light: t.tokens,
        dark: t.tokens,
        followSystem: false,
        notice: null,
      };
    this.ctx.log.warn('theme.fallback', { reason: t ? 'corrupt' : 'missing' });
    cfg.writeSettings(this.db, { activeThemeId: FALLBACK_THEME_ID });
    return {
      selectedId: FALLBACK_THEME_ID,
      light: PILE_LIGHT,
      dark: PILE_LIGHT,
      followSystem: false,
      notice: t
        ? `Your theme "${t.name}" is damaged, so Pile Light is being used instead.`
        : 'Your selected theme could not be found, so Pile Light is being used instead.',
    };
  }

  saveTheme(input: { id: string | null; name: string; tokens: unknown }): ThemeDetail {
    if (input.id && BUILTIN_THEME_IDS.has(input.id))
      throw appError('READ_ONLY', 'Built-in themes are read-only.', {
        recovery: 'Duplicate it to customize.',
      });
    const parsed = ThemeTokensSchema.safeParse(input.tokens);
    if (!parsed.success) throw appError('VALIDATION', 'The theme has invalid values.');
    const name = input.name.trim().slice(0, 60);
    if (!name)
      throw appError('VALIDATION', 'Theme name is required.', { fieldErrors: { name: 'Enter a name.' } });
    if (input.id && !cfg.getTheme(this.db, input.id))
      throw appError('NOT_FOUND', 'That theme no longer exists.');
    const id = input.id ?? randomUUID();
    cfg.upsertTheme(this.db, id, name, parsed.data, this.ctx.clock.now().toISOString());
    return this.getTheme(id);
  }

  duplicateTheme(id: string): ThemeDetail {
    const src = this.getTheme(id === SYSTEM_THEME_ID ? FALLBACK_THEME_ID : id);
    const existing = new Set(this.listThemes().map((t) => t.name.toLowerCase()));
    let name = `${src.name} copy`;
    for (let n = 2; existing.has(name.toLowerCase()); n++) name = `${src.name} copy ${n}`;
    return this.saveTheme({ id: null, name: name.slice(0, 60), tokens: src.tokens });
  }

  deleteTheme(id: string): void {
    if (BUILTIN_THEME_IDS.has(id)) throw appError('READ_ONLY', 'Built-in themes cannot be deleted.');
    cfg.deleteTheme(this.db, id);
    if (this.getSettings().activeThemeId === id)
      cfg.writeSettings(this.db, { activeThemeId: SYSTEM_THEME_ID });
  }

  /** Validates and imports a theme file's text. Never evaluates anything. */
  importTheme(textContent: string): ThemeDetail {
    const r = parseThemeFile(textContent);
    if (!r.ok) {
      throw appError('VALIDATION', 'This theme file is not valid.', {
        fieldErrors: Object.fromEntries(r.issues.map((i) => [i.path, i.message])),
      });
    }
    const taken = new Set(this.listThemes().map((t) => t.name.toLowerCase()));
    let name = r.value.name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${r.value.name} (${n})`;
    return this.saveTheme({ id: null, name: name.slice(0, 60), tokens: r.value.tokens });
  }

  exportTheme(id: string): { fileName: string; text: string } {
    const t = this.getTheme(id === SYSTEM_THEME_ID ? FALLBACK_THEME_ID : id);
    const file: ThemeFile = {
      format: THEME_FORMAT,
      schemaVersion: THEME_SCHEMA_VERSION,
      name: t.name,
      tokens: t.tokens,
    };
    const safe =
      t.name
        .replace(/[^\p{L}\p{N} _-]+/gu, '')
        .trim()
        .replace(/\s+/g, '-') || 'theme';
    return { fileName: `${safe}.mptheme.json`, text: `${JSON.stringify(file, null, 2)}\n` };
  }

  /** Resets the active theme to System; optionally deletes all custom themes. */
  resetThemes(deleteCustom: boolean): void {
    this.db.transaction(() => {
      cfg.writeSettings(this.db, { activeThemeId: SYSTEM_THEME_ID });
      if (deleteCustom) this.db.run('DELETE FROM themes');
    });
  }

  /* ---------------------------------------------------------------- layouts */

  layouts(): LayoutsView {
    const d = cfg.readLayout(this.db, 'dashboard');
    const l = cfg.readLayout(this.db, 'library');
    return {
      dashboard: d.entries,
      library: l.entries.map((e) => ({ ...e, span: 1 as const })),
      notices: [...d.notices, ...l.notices],
    };
  }

  setLayout(surface: LayoutSurface, entries: LayoutEntry[]): LayoutsView {
    const repaired = repairLayout(surface, entries);
    cfg.writeLayout(this.db, surface, repaired.entries);
    const v = this.layouts();
    return { ...v, notices: [...repaired.notices, ...v.notices] };
  }

  resetLayout(surface: LayoutSurface | 'both'): LayoutsView {
    this.db.transaction(() => {
      if (surface === 'both' || surface === 'dashboard') cfg.resetLayout(this.db, 'dashboard');
      if (surface === 'both' || surface === 'library') cfg.resetLayout(this.db, 'library');
    });
    return this.layouts();
  }

  importLayout(textContent: string): LayoutsView {
    const r = parseLayoutFile(textContent);
    if (!r.ok) {
      throw appError('VALIDATION', 'This layout file is not valid.', {
        fieldErrors: Object.fromEntries(r.issues.map((i) => [i.path, i.message])),
      });
    }
    const entries = layoutFileToEntries(r.value);
    const notices: string[] = [];
    this.db.transaction(() => {
      for (const surface of ['dashboard', 'library'] as const) {
        const rep = repairLayout(surface, entries[surface]);
        notices.push(...rep.notices);
        cfg.writeLayout(this.db, surface, rep.entries);
      }
    });
    const v = this.layouts();
    return { ...v, notices: [...notices, ...v.notices] };
  }

  exportLayout(): { fileName: string; text: string } {
    const v = this.layouts();
    return {
      fileName: 'maybe-pile-layout.mplayout.json',
      text: `${JSON.stringify(entriesToLayoutFile(v), null, 2)}\n`,
    };
  }
}
