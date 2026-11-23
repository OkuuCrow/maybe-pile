/**
 * Command palette (Ctrl/Cmd+K): fuzzy search over items, views and actions.
 * ARIA combobox + listbox: the input keeps focus, ↑/↓ move the active option
 * (aria-activedescendant), Enter runs it, Esc closes and focus returns to
 * where it was. The result count is announced politely.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CommandTarget } from '../../../shared/types';
import { fuzzyRank } from '../../../domain/fuzzy';
import { call, errorOf, getApi } from '../../app/api';
import { useApp, type Route } from '../../app/context';
import { typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Dialog } from '../../components/Dialog';

export interface Command {
  id: string;
  label: string;
  group: 'Action' | 'Go to' | 'Item' | 'Layout';
  keywords?: string;
  shortcut?: string;
  run: () => void | Promise<void>;
}

/** Static command registry (navigation + actions). Exported for tests. */
export function buildCommands(ctx: {
  navigate: (r: Route) => void;
  openAdd: () => void;
  openCapture: () => void;
  showShortcuts: () => void;
  exportJson: () => Promise<void>;
  startSteamSync: () => void;
  switchTheme: (id: string, name: string) => Promise<void>;
  toggleComponent: (id: string, label: string) => Promise<void>;
  themes: { id: string; name: string }[];
  dashboardComponents: { id: string; label: string; visible: boolean }[];
}): Command[] {
  const go = (label: string, route: Route, keywords?: string): Command => ({
    id: `go:${label}`,
    label: `Go to ${label}`,
    group: 'Go to',
    ...(keywords ? { keywords } : {}),
    run: () => ctx.navigate(route),
  });
  return [
    {
      id: 'add',
      label: 'Add item…',
      group: 'Action',
      keywords: 'new create',
      shortcut: 'Ctrl/⌘+N',
      run: ctx.openAdd,
    },
    {
      id: 'capture',
      label: 'Quick Capture…',
      group: 'Action',
      keywords: 'add fast title',
      shortcut: 'Ctrl/⌘+Shift+N',
      run: ctx.openCapture,
    },
    {
      id: 'pick',
      label: 'Pick for Me',
      group: 'Action',
      keywords: 'random tonight choose',
      shortcut: 'Ctrl/⌘+Shift+P',
      run: () => ctx.navigate({ name: 'pick' }),
    },
    {
      id: 'steam',
      label: 'Start Steam sync',
      group: 'Action',
      keywords: 'import library games',
      run: ctx.startSteamSync,
    },
    {
      id: 'export',
      label: 'Export library (JSON)…',
      group: 'Action',
      keywords: 'backup save',
      run: ctx.exportJson,
    },
    {
      id: 'ics',
      label: 'Export upcoming releases (.ics)…',
      group: 'Action',
      keywords: 'calendar radar',
      run: () => ctx.navigate({ name: 'upcoming' }),
    },
    {
      id: 'shortcuts',
      label: 'Show keyboard shortcuts',
      group: 'Action',
      keywords: 'help keys',
      shortcut: '?',
      run: ctx.showShortcuts,
    },
    go('Dashboard', { name: 'dashboard' }, 'home'),
    go('Library', { name: 'library' }, 'all items search'),
    go('Lists', { name: 'lists' }, 'collections'),
    go('Stats', { name: 'stats' }, 'charts year in review'),
    go('Goals', { name: 'goals' }, 'targets'),
    go('Pile Health', { name: 'health' }, 'stale snooze'),
    go('Upcoming releases', { name: 'upcoming' }, 'release radar'),
    go('Import', { name: 'import', tab: 'sources' }, 'steam goodreads letterboxd csv'),
    go('Settings', { name: 'settings', tab: 'appearance' }, 'preferences'),
    ...ctx.themes.map<Command>((t) => ({
      id: `theme:${t.id}`,
      label: `Switch theme: ${t.name}`,
      group: 'Action',
      keywords: 'appearance color dark light',
      run: () => ctx.switchTheme(t.id, t.name),
    })),
    ...ctx.dashboardComponents.map<Command>((c) => ({
      id: `layout:${c.id}`,
      label: `${c.visible ? 'Hide' : 'Show'} dashboard component: ${c.label}`,
      group: 'Layout',
      keywords: 'toggle widget',
      run: () => ctx.toggleComponent(c.id, c.label),
    })),
  ];
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const uid = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [titles, setTitles] = useState<CommandTarget[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void call(getApi().items.titles())
      .then(setTitles)
      .catch(() => undefined);
  }, []);

  const results = useMemo(() => {
    const items: Command[] = titles.map((t) => ({
      id: `item:${t.id}`,
      label: t.title,
      group: 'Item',
      keywords: `${typeLabel(t.type)} ${t.year ?? ''}`,
      run: () => app.navigate({ name: 'item', id: t.id }),
    }));
    if (!query.trim()) return commands.slice(0, 30);
    return fuzzyRank(query, [...commands, ...items], 40);
  }, [query, titles, commands, app]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    document.getElementById(`${uid}-opt-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, uid]);

  const run = async (c: Command | undefined) => {
    if (!c) return;
    onClose();
    try {
      await c.run();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };

  return (
    <Dialog title="Command palette" onClose={onClose} size="medium" initialFocusId={`${uid}-input`}>
      <div className="palette">
        <label htmlFor={`${uid}-input`} className="visually-hidden">
          Search items, views and actions
        </label>
        <input
          id={`${uid}-input`}
          className="input search-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${uid}-list`}
          aria-autocomplete="list"
          aria-activedescendant={results[active] ? `${uid}-opt-${active}` : undefined}
          placeholder="Type to search items, views and actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Home') {
              e.preventDefault();
              setActive(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              setActive(results.length - 1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              void run(results[active]);
            }
          }}
        />
        <p className="visually-hidden" aria-live="polite">
          {results.length === 0 ? 'No results' : `${results.length} result${results.length === 1 ? '' : 's'}`}
        </p>
        <div id={`${uid}-list`} role="listbox" aria-label="Results" className="palette-list" ref={listRef}>
          {results.map((r, i) => (
            // The combobox input owns keyboard interaction (aria-activedescendant); options are pointer targets.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <div
              key={r.id}
              id={`${uid}-opt-${i}`}
              tabIndex={-1}
              role="option"
              aria-selected={i === active}
              className={`palette-option ${i === active ? 'palette-active' : ''}`}
              onMouseMove={() => setActive(i)}
              onClick={() => void run(r)}
            >
              <span className="palette-group">{r.group}</span>
              <span className="palette-label">{r.label}</span>
              {r.shortcut && <kbd>{r.shortcut}</kbd>}
            </div>
          ))}
        </div>
        {results.length === 0 && <p className="muted">Nothing matches “{query}”.</p>}
      </div>
    </Dialog>
  );
}
