/**
 * Global omnibox (§13.4): typing shows matching library items first and
 * “Add “X” to Maybe Pile” below; Enter does the obvious thing. In Full mode it
 * also finds features; in Simple mode hidden features show a "Full mode" hint.
 * ARIA 1.2 combobox with a listbox popup; arrow keys move, Enter chooses.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { searchFeatures } from '../../../shared/feature-registry';
import type { ItemSummary } from '../../../shared/types';
import { call, getApi } from '../../app/api';
import { switchToFull, useApp } from '../../app/context';
import { typeLabel } from '../../app/strings';

type Option =
  | { kind: 'item'; item: ItemSummary }
  | { kind: 'add'; title: string }
  | { kind: 'feature'; id: string; label: string; route: string; hidden: boolean };

export function Omnibox({
  autoFocus = false,
  onDone,
  id: givenId,
}: {
  autoFocus?: boolean;
  onDone?: () => void;
  id?: string;
}) {
  const app = useApp();
  const gen = useId();
  const inputId = givenId ?? `${gen}-input`;
  const listId = `${gen}-list`;
  const [text, setText] = useState('');
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const t = text.trim();
    if (!t) {
      setItems([]);
      return;
    }
    const mine = ++seq.current;
    const h = setTimeout(() => {
      void call(getApi().quick.omnibox({ text: t }))
        .then((r) => mine === seq.current && setItems(r))
        .catch(() => undefined);
    }, 120);
    return () => clearTimeout(h);
  }, [text, app.dataVersion]);
  const options = useMemo<Option[]>(() => {
    const t = text.trim();
    if (!t) return [];
    const feats = searchFeatures(t, app.level).map((f) => ({
      kind: 'feature' as const,
      id: f.entry.id,
      label: f.entry.label,
      route: f.entry.route ?? '#/',
      hidden: f.hidden,
    }));
    return [
      ...items.map((item) => ({ kind: 'item' as const, item })),
      { kind: 'add' as const, title: t },
      ...feats,
    ];
  }, [items, text, app.level]);
  useEffect(() => setActive(0), [options.length]);

  const choose = (o: Option | undefined) => {
    if (!o) return;
    if (o.kind === 'item') app.navigate({ name: 'item', id: o.item.id });
    else if (o.kind === 'add') app.openAdd(o.title);
    else if (o.hidden) void switchToFull(app).then(() => (window.location.hash = o.route));
    else window.location.hash = o.route;
    setText('');
    onDone?.();
  };
  const optId = (i: number) => `${gen}-opt-${i}`;
  const open = options.length > 0;
  return (
    <div className="omnibox">
      <label htmlFor={inputId} className="visually-hidden">
        Search your library or add something
      </label>
      <input
        id={inputId}
        className="input omnibox-input"
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? optId(active) : undefined}
        placeholder="Search your library or add something…"
        value={text}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(options.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(options[active]);
          } else if (e.key === 'Escape' && text) {
            e.stopPropagation();
            setText('');
          }
        }}
      />
      <div id={listId} role="listbox" aria-label="Results" className={`omnibox-list ${open ? '' : 'hidden'}`}>
        {options.map((o, i) => (
          <div
            key={o.kind === 'item' ? o.item.id : o.kind === 'add' ? 'add' : o.id}
            id={optId(i)}
            role="option"
            aria-selected={i === active}
            className={`omnibox-option ${i === active ? 'active' : ''}`}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(o)}
            onKeyDown={(e) => e.key === 'Enter' && choose(o)}
          >
            {o.kind === 'item' && (
              <>
                <span>{o.item.title}</span> <span className="muted">· {typeLabel(o.item.type)}</span>
              </>
            )}
            {o.kind === 'add' && (
              <span>
                <strong>Add “{o.title}”</strong> to Maybe Pile
              </span>
            )}
            {o.kind === 'feature' && (
              <span>
                Go to {o.label}
                {o.hidden && <span className="muted"> — turns on Full mode</span>}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
