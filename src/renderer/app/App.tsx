import { useEffect, useRef, type ReactNode } from 'react';
import { getApi, call } from './api';
import { AppProvider, useApp } from './context';
import { S } from './strings';
import { ToastProvider, useToast } from './toast';
import { SHORTCUTS, isTypingTarget } from './shortcuts';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/Bits';
import { IconGear, IconHome, IconPlus, IconStack } from '../components/Icons';
import { Dashboard } from '../features/dashboard/Dashboard';
import { Library } from '../features/library/Library';
import { ItemPage } from '../features/item/ItemPage';
import { AddDialog } from '../features/add/AddDialog';
import { Settings } from '../features/settings/Settings';
import type { MenuCommand } from '../../shared/ipc-channels';

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
    }
  };
  const runRef = useRef(runCommand);
  runRef.current = runCommand;

  useEffect(() => getApi().events.onMenuCommand((c) => runRef.current(c)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
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
  ].filter((n): n is NonNullable<typeof n> => n !== null);

  const navItem = (name: 'dashboard' | 'library' | 'settings', label: string, icon: ReactNode) => {
    const current = app.route.name === name || (name === 'library' && app.route.name === 'item');
    return (
      <li>
        <a
          href={name === 'settings' ? '#/settings/appearance' : `#/${name}`}
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
            {navItem('dashboard', S.nav.dashboard, <IconHome />)}
            {navItem('library', S.nav.library, <IconStack />)}
            {navItem('settings', S.nav.settings, <IconGear />)}
          </ul>
        </nav>
        <button
          type="button"
          className="button button-primary"
          onClick={app.openAdd}
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
                  n.k === 'up' || n.k === 'rec'
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
        {app.route.name === 'dashboard' && <Dashboard />}
        {app.route.name === 'library' && <Library />}
        {app.route.name === 'item' && <ItemPage id={app.route.id} key={app.route.id} />}
        {app.route.name === 'settings' && <Settings tab={app.route.tab} />}
      </main>
      {app.addOpen && <AddDialog onClose={app.closeAdd} />}
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
