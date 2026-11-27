import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getApi, call } from './api';
import { AppProvider, useApp } from './context';
import { S } from './strings';
import { ToastProvider, useToast } from './toast';
import { SHORTCUTS, isTypingTarget } from './shortcuts';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/Bits';
import { IconGear, IconGrid, IconHome, IconList, IconPlus, IconSearch, IconStack } from '../components/Icons';
import { Dashboard } from '../features/dashboard/Dashboard';
import { Library } from '../features/library/Library';
import { ItemPage } from '../features/item/ItemPage';
import { AddDialog } from '../features/add/AddDialog';
import { Settings } from '../features/settings/Settings';
import { PickPage } from '../features/pick/PickPage';
import { HealthPage } from '../features/health/HealthPage';
import { PilePage } from '../features/pile/PilePage';
import type { SessionView } from '../../shared/types';
import { formatDuration } from '../../domain/sessions';
import { IconTimer } from '../components/Icons';
import { ListDetailPage, ListsPage } from '../features/lists/ListsPage';
import { StatsPage } from '../features/stats/StatsPage';
import { GoalsPage } from '../features/goals/GoalsPage';
import { UpcomingPage } from '../features/radar/UpcomingPage';
import { ImportPage } from '../features/import/ImportPage';
import { CommandPalette, buildCommands } from '../features/palette/CommandPalette';
import { QuickCapture } from '../features/palette/QuickCapture';
import { COMPONENT_LABELS, DEFAULT_LAYOUTS, type DashboardComponentId } from '../../domain/layouts';
import { errorOf } from './api';
import type { ThemeSummary } from '../../shared/types';
import type { MenuCommand } from '../../shared/ipc-channels';
import { isShown, labelFor } from '../../shared/feature-registry';
import { SimpleHome } from '../features/simple/SimpleHome';
import { Omnibox } from '../features/simple/Omnibox';
import {
  FirstRun,
  RatingPromptHost,
  SimpleOfferBanner,
  useAppearanceAttributes,
  useRestorePlace,
  useThemeSchedule,
} from '../features/simple/ShellExtras';
import { ChangesPage, TrashPage } from '../features/history/HistoryPages';
import { WallPage } from '../features/wall/WallPage';
import { TriagePage } from '../features/triage/TriagePage';
import { PeoplePage } from '../features/people/PeoplePage';

export function App() {
  return (
    <ToastProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </ToastProvider>
  );
}

function Shell() {
  const app = useApp();
  const toast = useToast();
  const mainRef = useRef<HTMLElement>(null);
  const pendingG = useRef<number | null>(null);
  const [omniOpen, setOmniOpen] = useState(false);
  useAppearanceAttributes();
  useThemeSchedule();
  useRestorePlace();
  const simple = app.level === 'simple';

  // Move focus to main content on route changes so keyboard/screen-reader users land in the new view.
  const routeKey = app.route.name === 'item' ? `item:${app.route.id}` : app.route.name;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [routeKey]);

  const runCommand = (c: MenuCommand) => {
    switch (c) {
      case 'new-item':
        app.openAdd();
        break;
      case 'focus-search':
        if (app.route.name !== 'library') app.navigate({ name: 'library' });
        setTimeout(() => document.getElementById('library-search')?.focus(), 50);
        break;
      case 'go-dashboard':
        app.navigate({ name: 'dashboard' });
        break;
      case 'go-library':
        app.navigate({ name: 'library' });
        break;
      case 'go-settings':
        app.navigate({ name: 'settings', tab: 'appearance' });
        break;
      case 'show-shortcuts':
        app.setShortcutsOpen(true);
        break;
      case 'import':
      case 'export':
      case 'backup':
        app.navigate({ name: 'settings', tab: 'backup' });
        break;
      case 'about':
        app.navigate({ name: 'settings', tab: 'about' });
        break;
      case 'command-palette':
        // Simple Mode: the omnibox (find or add). Full mode: the command palette (also finds items).
        if (app.level === 'simple') setOmniOpen(true);
        else app.setPaletteOpen(true);
        break;
      case 'quick-capture':
        app.setCaptureOpen(true);
        break;
      case 'pick-for-me':
        app.navigate({ name: 'pick' });
        break;
    }
  };
  const runRef = useRef(runCommand);
  runRef.current = runCommand;

  useEffect(() => getApi().events.onMenuCommand((c) => runRef.current(c)), []);
  // 2.1: in-app reminder banners (when the OS could not show one) and notification clicks.
  const navigateRef = useRef(app.navigate);
  navigateRef.current = app.navigate;
  useEffect(() => {
    const ev = getApi().events;
    const offA = ev.onInAppNotification?.((n) =>
      toast.show(
        {
          kind: 'info',
          message: n.title,
          detail: n.body,
          action: n.itemId
            ? { label: 'Open', run: () => n.itemId && navigateRef.current({ name: 'item', id: n.itemId }) }
            : undefined,
        },
        12_000,
      ),
    );
    const offB = ev.onOpenItem?.((id) => navigateRef.current({ name: 'item', id }));
    return () => {
      offA?.();
      offB?.();
    };
  }, [toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Modifier shortcuts also come from the native menu; handling them here keeps them working
      // when the menu is hidden and in tests. Opening twice is harmless.
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'k' && !e.shiftKey) {
          e.preventDefault();
          runRef.current('command-palette');
        } else if (key === 'n' && e.shiftKey) {
          e.preventDefault();
          runRef.current('quick-capture');
        } else if (key === 'p' && e.shiftKey) {
          e.preventDefault();
          runRef.current('pick-for-me');
        }
        return;
      }
      if (e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const k = e.key;
      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        const map: Record<string, MenuCommand> = { d: 'go-dashboard', l: 'go-library', s: 'go-settings' };
        const cmd = map[k.toLowerCase()];
        if (cmd) {
          e.preventDefault();
          runRef.current(cmd);
        }
        return;
      }
      if (k === 'g' || k === 'G') {
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 1200);
        return;
      }
      if (k === '?') {
        e.preventDefault();
        runRef.current('show-shortcuts');
      } else if (k === '/') {
        e.preventDefault();
        runRef.current('focus-search');
      } else if (k === 'n' || k === 'N') {
        e.preventDefault();
        runRef.current('new-item');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const goOffline = () => toast.show({ kind: 'info', message: S.errors.offline });
    window.addEventListener('offline', goOffline);
    return () => window.removeEventListener('offline', goOffline);
  }, [toast]);

  const info = app.info;
  const notices = [
    info?.readOnly
      ? {
          k: 'ro',
          kind: 'warning' as const,
          text: 'This library was created by a newer version of Maybe Pile and is open read-only. Changes cannot be saved.',
        }
      : null,
    info?.recoveryNotice ? { k: 'rec', kind: 'warning' as const, text: info.recoveryNotice } : null,
    info?.upgradeNotice ? { k: 'up', kind: 'info' as const, text: info.upgradeNotice } : null,
    info?.dataLocationNotice ? { k: 'loc', kind: 'info' as const, text: info.dataLocationNotice } : null,
    app.theme?.notice ? { k: 'theme', kind: 'warning' as const, text: app.theme.notice } : null,
    ...(app.layouts?.notices ?? []).map((n, i) => ({ k: `lay${i}`, kind: 'info' as const, text: n })),
    ...(info?.extraNotices ?? []).map((n, i) => ({ k: `x${i}`, kind: 'info' as const, text: n })),
  ].filter((n): n is NonNullable<typeof n> => n !== null);

  const navItem = (
    name: 'dashboard' | 'library' | 'settings' | 'lists' | 'stats' | 'import' | 'pile',
    label: string,
    icon: ReactNode,
  ) => {
    const current =
      app.route.name === name ||
      (name === 'library' && app.route.name === 'item') ||
      (name === 'lists' && app.route.name === 'list');
    return (
      <li>
        <a
          href={
            name === 'settings'
              ? '#/settings/appearance'
              : name === 'import'
                ? '#/import/sources'
                : `#/${name}`
          }
          className={`nav-link ${current ? 'nav-current' : ''}`}
          aria-current={app.route.name === name ? 'page' : undefined}
        >
          {icon}
          <span>{label}</span>
        </a>
      </li>
    );
  };

  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => (e.preventDefault(), mainRef.current?.focus())}>
        {S.app.skip}
      </a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <IconStack size={22} />
          </span>
          <span className="brand-name">{S.app.name}</span>
        </div>
        <nav aria-label={S.nav.label}>
          <ul className="nav-list">
            {navItem('dashboard', labelFor('nav.home', app.level), <IconHome />)}
            {navItem('library', S.nav.library, <IconStack />)}
            {!simple && navItem('pile', 'Pile', <IconGrid />)}
            {navItem('settings', S.nav.settings, <IconGear />)}
            {!simple && (
              <li>
                <details className="nav-more">
                  <summary className="nav-link">More</summary>
                  <ul className="nav-more-list">
                    {(['lists', 'stats', 'import'] as const).map((n) =>
                      navItem(
                        n,
                        n === 'lists' ? 'Lists' : n === 'stats' ? 'Stats' : 'Import',
                        n === 'lists' ? <IconList /> : n === 'stats' ? <IconGrid /> : <IconPlus />,
                      ),
                    )}
                    {(
                      [
                        ['nav.upcoming', '#/upcoming'],
                        ['nav.pick', '#/pick'],
                        ['nav.goals', '#/goals'],
                        ['nav.wall', '#/wall'],
                        ['nav.triage', '#/triage'],
                        ['nav.people', '#/people'],
                        ['nav.changes', '#/changes'],
                        ['nav.trash', '#/trash'],
                      ] as const
                    )
                      .filter(([id]) => isShown(id, app.level))
                      .map(([id, href]) => (
                        <li key={id}>
                          <a className="nav-link" href={href}>
                            <span>{labelFor(id, app.level)}</span>
                          </a>
                        </li>
                      ))}
                  </ul>
                </details>
              </li>
            )}
          </ul>
        </nav>
        <HeaderTimer />
        <button
          type="button"
          className="button"
          onClick={() => (simple ? setOmniOpen(true) : app.setPaletteOpen(true))}
          aria-keyshortcuts="Control+K Meta+K"
        >
          <IconSearch />
          <span>{simple ? 'Search' : 'Search & commands'}</span>
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={() => app.openAdd()}
          disabled={info?.readOnly}
        >
          <IconPlus />
          <span>{S.nav.add}</span>
        </button>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="app-main">
        {notices.length > 0 && (
          <div className="notices">
            {notices.map((n) => (
              <Notice
                key={n.k}
                kind={n.kind}
                onDismiss={
                  n.k === 'up' || n.k === 'rec' || n.k.startsWith('x')
                    ? () => {
                        void call(getApi().app.acknowledgeNotices()).then(app.reloadInfo);
                      }
                    : undefined
                }
              >
                {n.text}
              </Notice>
            ))}
          </div>
        )}
        <SimpleOfferBanner />
        <RatingPromptHost />
        {app.route.name === 'dashboard' && (simple ? <SimpleHome /> : <Dashboard />)}
        {app.route.name === 'trash' && <TrashPage />}
        {app.route.name === 'changes' && <ChangesPage />}
        {app.route.name === 'wall' && <WallPage />}
        {app.route.name === 'triage' && <TriagePage />}
        {app.route.name === 'people' && <PeoplePage />}
        {app.route.name === 'library' && <Library />}
        {app.route.name === 'item' && <ItemPage id={app.route.id} key={app.route.id} />}
        {app.route.name === 'settings' && <Settings tab={app.route.tab} />}
        {app.route.name === 'pick' && <PickPage />}
        {app.route.name === 'health' && <HealthPage />}
        {app.route.name === 'lists' && <ListsPage />}
        {app.route.name === 'list' && <ListDetailPage id={app.route.id} key={app.route.id} />}
        {app.route.name === 'stats' && <StatsPage />}
        {app.route.name === 'goals' && <GoalsPage />}
        {app.route.name === 'upcoming' && <UpcomingPage />}
        {app.route.name === 'pile' && <PilePage />}
        {app.route.name === 'import' && <ImportPage tab={app.route.tab} />}
      </main>
      {app.addOpen && <AddDialog onClose={app.closeAdd} />}
      {omniOpen && (
        <Dialog title="Find or add" onClose={() => setOmniOpen(false)} size="medium">
          <Omnibox onDone={() => setOmniOpen(false)} />
        </Dialog>
      )}
      <FirstRun />
      {app.paletteOpen && <PaletteHost />}
      {app.captureOpen && !info?.readOnly && <QuickCapture onClose={() => app.setCaptureOpen(false)} />}
      {app.shortcutsOpen && (
        <Dialog title="Keyboard shortcuts" onClose={() => app.setShortcutsOpen(false)} size="medium">
          <table className="table">
            <caption className="visually-hidden">Keyboard shortcuts</caption>
            <thead>
              <tr>
                <th scope="col">Shortcut</th>
                <th scope="col">Alternative</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map((s) => (
                <tr key={s.description}>
                  <td>
                    <kbd>{s.keys}</kbd>
                  </td>
                  <td>{s.alt ? <kbd>{s.alt}</kbd> : '—'}</td>
                  <td>{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Single-key shortcuts are ignored while you are typing in a text field.</p>
        </Dialog>
      )}
    </>
  );
}

/** Builds the command registry from current app state and renders the palette. */
function PaletteHost() {
  const app = useApp();
  const toast = useToast();
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  useEffect(() => {
    void call(getApi().themes.list())
      .then(setThemes)
      .catch(() => undefined);
  }, []);
  const layout = app.layouts?.dashboard ?? DEFAULT_LAYOUTS.dashboard;
  const commands = useMemo(
    () =>
      buildCommands({
        navigate: app.navigate,
        openAdd: app.openAdd,
        openCapture: () => app.setCaptureOpen(true),
        showShortcuts: () => app.setShortcutsOpen(true),
        exportJson: async () => {
          const r = await call(getApi().data.exportJson());
          if (r) toast.success(`Saved ${r.fileLabel}.`);
        },
        startSteamSync: () => app.navigate({ name: 'import', tab: 'sources' }),
        switchTheme: async (id, name) => {
          await app.updateSettings({ activeThemeId: id });
          app.reloadTheme();
          toast.success(`Theme: ${name}.`);
        },
        toggleComponent: async (id, label) => {
          try {
            const entries = layout.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e));
            app.setLayouts(await call(getApi().layouts.set({ surface: 'dashboard', entries })));
            toast.success(
              `${label} ${entries.find((e) => e.id === id)?.visible ? 'shown' : 'hidden'} on the dashboard.`,
            );
          } catch (e) {
            toast.error(errorOf(e));
          }
        },
        themes: [{ id: 'system', name: 'System' }, ...themes.filter((t) => t.id !== 'system')],
        dashboardComponents: layout.map((e) => ({
          id: e.id,
          label: COMPONENT_LABELS[e.id as DashboardComponentId] ?? e.id,
          visible: e.visible,
        })),
      }),
    [app, themes, layout, toast],
  );
  return <CommandPalette commands={commands} onClose={() => app.setPaletteOpen(false)} />;
}

/** Running/paused session timers (they survive restarts; state lives in the database). */
function HeaderTimer() {
  const app = useApp();
  const [open, setOpen] = useState<SessionView[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [fetched, setFetched] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () =>
      void call(getApi().sessions.open())
        .then((r) => {
          if (!alive) return;
          setOpen(r);
          setFetched(Date.now());
        })
        .catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [app.dataVersion]);
  const running = open.find((s) => s.state === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const s = running ?? open[0];
  if (!s) return null;
  const secs =
    s.state === 'running' ? s.seconds + Math.max(0, Math.floor((now - fetched) / 1000)) : s.seconds;
  return (
    <a
      className="button header-timer"
      href={`#/item/${s.itemId}`}
      aria-label={`${s.state === 'running' ? 'Timer running' : 'Timer paused'} for ${s.itemTitle}: ${formatDuration(secs)}. Open item.`}
    >
      <IconTimer />{' '}
      <span aria-hidden="true">
        {s.state === 'running' ? '' : 'Paused · '}
        {formatDuration(secs)}
      </span>
    </a>
  );
}
