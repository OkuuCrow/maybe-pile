/** Shared app state: route, settings, layouts, app info, data version (refetch trigger). */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppSettings, SettingsPatch } from '../../shared/schemas';
import type { AppInfo, LayoutsView } from '../../shared/types';
import type { ActiveThemeView } from '../../shared/ipc-contract';
import { call, getApi } from './api';
import { themeToCssVars } from '../../domain/themes';

export type Route =
  | { name: 'dashboard' }
  | { name: 'library' }
  | { name: 'item'; id: string }
  | { name: 'settings'; tab: SettingsTab }
  | { name: 'pick' }
  | { name: 'lists' }
  | { name: 'list'; id: string }
  | { name: 'stats' }
  | { name: 'goals' }
  | { name: 'health' }
  | { name: 'upcoming' }
  | { name: 'pile' }
  | { name: 'import'; tab: ImportTab }
  /* 2.1 */
  | { name: 'trash' }
  | { name: 'changes' }
  | { name: 'wall' }
  | { name: 'triage' }
  | { name: 'people' };

export const IMPORT_TABS = ['sources', 'trackers', 'history'] as const;
export type ImportTab = (typeof IMPORT_TABS)[number];

export const SETTINGS_TABS = [
  'appearance',
  'interface',
  'notifications',
  'layout',
  'providers',
  'library',
  'features',
  'backup',
  'data',
  'advanced',
  'about',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'library') return { name: 'library' };
  if (a === 'pick') return { name: 'pick' };
  if (a === 'lists') return { name: 'lists' };
  if (a === 'list' && b && /^[0-9a-f-]{36}$/i.test(b)) return { name: 'list', id: b };
  if (a === 'stats') return { name: 'stats' };
  if (a === 'goals') return { name: 'goals' };
  if (a === 'health') return { name: 'health' };
  if (a === 'upcoming') return { name: 'upcoming' };
  if (a === 'pile') return { name: 'pile' };
  if (a === 'trash') return { name: 'trash' };
  if (a === 'changes') return { name: 'changes' };
  if (a === 'wall') return { name: 'wall' };
  if (a === 'triage') return { name: 'triage' };
  if (a === 'people') return { name: 'people' };
  if (a === 'import')
    return {
      name: 'import',
      tab: (IMPORT_TABS as readonly string[]).includes(b ?? '') ? (b as ImportTab) : 'sources',
    };
  if (a === 'item' && b && /^[0-9a-f-]{36}$/i.test(b)) return { name: 'item', id: b };
  if (a === 'settings')
    return {
      name: 'settings',
      tab: (SETTINGS_TABS as readonly string[]).includes(b ?? '') ? (b as SettingsTab) : 'appearance',
    };
  return { name: 'dashboard' };
}

export function routeToHash(r: Route): string {
  switch (r.name) {
    case 'dashboard':
      return '#/dashboard';
    case 'library':
      return '#/library';
    case 'item':
      return `#/item/${r.id}`;
    case 'settings':
      return `#/settings/${r.tab}`;
    case 'list':
      return `#/list/${r.id}`;
    case 'import':
      return `#/import/${r.tab}`;
    default:
      return `#/${r.name}`;
  }
}

interface AppCtx {
  route: Route;
  navigate: (r: Route) => void;
  settings: AppSettings | null;
  updateSettings: (p: SettingsPatch) => Promise<void>;
  /** Re-reads settings (after notify:apply, which owns the notification settings). */
  reloadSettings: () => void;
  /** 'simple' | 'full' (§13). */
  level: 'simple' | 'full';
  layouts: LayoutsView | null;
  setLayouts: (l: LayoutsView) => void;
  info: AppInfo | null;
  reloadInfo: () => void;
  dataVersion: number;
  bumpData: () => void;
  theme: ActiveThemeView | null;
  reloadTheme: () => void;
  addOpen: boolean;
  /** Opens Add, optionally prefilled with a title (omnibox "Add “X”"). */
  openAdd: (title?: string) => void;
  addTitle: string;
  closeAdd: () => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  captureOpen: boolean;
  setCaptureOpen: (v: boolean) => void;
}

const Ctx = createContext<AppCtx | null>(null);

/** Turns on Full mode (used by "Turn on Full mode to use this" offers). */
export function switchToFull(app: Pick<AppCtx, 'settings' | 'updateSettings'>): Promise<void> {
  if (!app.settings) return Promise.resolve();
  return app.updateSettings({ interface: { ...app.settings.interface, level: 'full' } });
}

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AppProvider missing');
  return c;
}

/** Applies validated theme tokens via style.setProperty — never by building CSS text. */
export function applyTheme(t: ActiveThemeView, prefersDark: boolean): void {
  const tokens = t.followSystem ? (prefersDark ? t.dark : t.light) : t.light;
  const root = document.documentElement;
  for (const [k, v] of themeToCssVars(tokens)) root.style.setProperty(k, v);
  root.dataset['scheme'] = tokens.colorScheme;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [layouts, setLayouts] = useState<LayoutsView | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [theme, setTheme] = useState<ActiveThemeView | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [infoTick, setInfoTick] = useState(0);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const api = getApi();
    void call(api.settings.get())
      .then(setSettings)
      .catch(() => undefined);
    void call(api.layouts.get())
      .then(setLayouts)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void call(getApi().app.info())
      .then(setInfo)
      .catch(() => undefined);
  }, [infoTick]);
  useEffect(() => {
    void call(getApi().themes.active())
      .then(setTheme)
      .catch(() => undefined);
  }, [themeTick]);

  // Live theme application, following the OS when "System" is selected.
  useEffect(() => {
    if (!theme) return;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    applyTheme(theme, mq?.matches ?? false);
    if (!theme.followSystem || !mq) return;
    const onChange = (e: MediaQueryListEvent) => applyTheme(theme, e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const navigate = useCallback((r: Route) => {
    const h = routeToHash(r);
    if (window.location.hash !== h) window.location.hash = h;
    setRoute(r);
  }, []);

  const updateSettings = useCallback(async (p: SettingsPatch) => {
    const s = await call(getApi().settings.update(p));
    setSettings(s);
  }, []);
  const reloadSettings = useCallback(() => {
    void call(getApi().settings.get())
      .then(setSettings)
      .catch(() => undefined);
  }, []);
  const level = settings?.interface.level ?? 'full';

  const value = useMemo<AppCtx>(
    () => ({
      route,
      navigate,
      settings,
      updateSettings,
      reloadSettings,
      level,
      layouts,
      setLayouts,
      info,
      reloadInfo: () => setInfoTick((t) => t + 1),
      dataVersion,
      bumpData: () => setDataVersion((v) => v + 1),
      theme,
      reloadTheme: () => setThemeTick((t) => t + 1),
      addOpen,
      openAdd: (title?: string) => {
        setAddTitle(typeof title === 'string' ? title : '');
        setAddOpen(true);
      },
      addTitle,
      closeAdd: () => setAddOpen(false),
      shortcutsOpen,
      setShortcutsOpen,
      paletteOpen,
      setPaletteOpen,
      captureOpen,
      setCaptureOpen,
    }),
    [
      route,
      navigate,
      settings,
      updateSettings,
      reloadSettings,
      level,
      layouts,
      info,
      dataVersion,
      theme,
      addOpen,
      addTitle,
      shortcutsOpen,
      paletteOpen,
      captureOpen,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
