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
  | { name: 'settings'; tab: SettingsTab };

export const SETTINGS_TABS = [
  'appearance',
  'layout',
  'providers',
  'library',
  'backup',
  'data',
  'about',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'library') return { name: 'library' };
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
  }
}

interface AppCtx {
  route: Route;
  navigate: (r: Route) => void;
  settings: AppSettings | null;
  updateSettings: (p: SettingsPatch) => Promise<void>;
  layouts: LayoutsView | null;
  setLayouts: (l: LayoutsView) => void;
  info: AppInfo | null;
  reloadInfo: () => void;
  dataVersion: number;
  bumpData: () => void;
  theme: ActiveThemeView | null;
  reloadTheme: () => void;
  addOpen: boolean;
  openAdd: () => void;
  closeAdd: () => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
}

const Ctx = createContext<AppCtx | null>(null);

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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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

  const value = useMemo<AppCtx>(
    () => ({
      route,
      navigate,
      settings,
      updateSettings,
      layouts,
      setLayouts,
      info,
      reloadInfo: () => setInfoTick((t) => t + 1),
      dataVersion,
      bumpData: () => setDataVersion((v) => v + 1),
      theme,
      reloadTheme: () => setThemeTick((t) => t + 1),
      addOpen,
      openAdd: () => setAddOpen(true),
      closeAdd: () => setAddOpen(false),
      shortcutsOpen,
      setShortcutsOpen,
    }),
    [route, navigate, settings, updateSettings, layouts, info, dataVersion, theme, addOpen, shortcutsOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
