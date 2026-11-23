/**
 * Virtualized, keyboard-operable multi-select listbox (used by the Steam /
 * game-list review screen; stays responsive at 10,000+ rows).
 *
 * Keyboard: ↑/↓ move, Home/End jump, Space toggles the focused row,
 * Shift+↑/↓ extends the selection from the anchor, Ctrl/Cmd+A selects every
 * (filtered) row. Mouse: click toggles, Shift+click selects a range.
 * Rows contain only text (no nested controls); row actions live in a toolbar
 * that acts on the focused row, so the listbox pattern stays valid.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export const ROW_HEIGHT = 52;
const OVERSCAN = 8;

export interface VirtualListProps<T> {
  id: string;
  label: string;
  rows: readonly T[];
  rowKey: (r: T) => string;
  renderRow: (r: T) => ReactNode;
  rowLabel: (r: T) => string;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  active: number;
  onActiveChange: (index: number) => void;
  /** Extra key handling for the focused row (e.g. "i" to ignore). Return true when handled. */
  onRowKey?: (e: KeyboardEvent<HTMLDivElement>, row: T) => boolean;
  height?: number;
}

export function VirtualList<T>(p: VirtualListProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const anchor = useRef<number | null>(null);
  const height = p.height ?? 480;
  const viewport = ref.current?.clientHeight || height;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(p.rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const active = Math.min(p.active, p.rows.length - 1);

  // Keep the active row visible.
  useEffect(() => {
    const el = ref.current;
    if (!el || active < 0) return;
    const top = active * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + (el.clientHeight || height))
      el.scrollTop = top + ROW_HEIGHT - (el.clientHeight || height);
  }, [active, height]);

  const keyOf = (i: number) => {
    const r = p.rows[i];
    return r === undefined ? null : p.rowKey(r);
  };

  const selectRange = (from: number, to: number, base: Set<string>) => {
    const [a, b] = from < to ? [from, to] : [to, from];
    for (let i = a; i <= b; i++) {
      const k = keyOf(i);
      if (k) base.add(k);
    }
    return base;
  };

  const toggle = (i: number) => {
    const k = keyOf(i);
    if (!k) return;
    const next = new Set(p.selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    anchor.current = i;
    p.onSelectedChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = p.rows.length;
    if (n === 0) return;
    const cur = active < 0 ? 0 : active;
    const move = (to: number) => {
      const t = Math.max(0, Math.min(n - 1, to));
      if (e.shiftKey) {
        if (anchor.current === null) anchor.current = cur;
        p.onSelectedChange(selectRange(anchor.current, t, new Set(p.selected)));
      }
      p.onActiveChange(t);
    };
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      p.onSelectedChange(new Set(p.rows.map(p.rowKey)));
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(cur + 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(cur - 1);
        return;
      case 'PageDown':
        e.preventDefault();
        move(cur + Math.floor(viewport / ROW_HEIGHT));
        return;
      case 'PageUp':
        e.preventDefault();
        move(cur - Math.floor(viewport / ROW_HEIGHT));
        return;
      case 'Home':
        e.preventDefault();
        move(0);
        return;
      case 'End':
        e.preventDefault();
        move(n - 1);
        return;
      case ' ':
        e.preventDefault();
        toggle(cur);
        return;
    }
    const row = p.rows[cur];
    if (row !== undefined && p.onRowKey?.(e, row)) e.preventDefault();
  };

  const activeId = active >= 0 && active < p.rows.length ? `${p.id}-opt-${active}` : undefined;
  return (
    <div
      ref={ref}
      id={p.id}
      role="listbox"
      aria-label={p.label}
      aria-multiselectable="true"
      aria-activedescendant={activeId}
      tabIndex={0}
      className="vlist"
      style={{ height, overflowY: 'auto', position: 'relative' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (p.active < 0 && p.rows.length > 0) p.onActiveChange(0);
      }}
    >
      <div style={{ height: p.rows.length * ROW_HEIGHT, position: 'relative' }}>
        {p.rows.slice(first, last).map((r, off) => {
          const i = first + off;
          const k = p.rowKey(r);
          const sel = p.selected.has(k);
          return (
            // Keyboard interaction is handled by the listbox (aria-activedescendant pattern); options are
            // click targets for pointer users only, so a per-option key handler would duplicate it.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <div
              key={k}
              id={`${p.id}-opt-${i}`}
              tabIndex={-1}
              role="option"
              aria-selected={sel}
              aria-setsize={p.rows.length}
              aria-posinset={i + 1}
              aria-label={p.rowLabel(r)}
              className={`vrow ${sel ? 'vrow-selected' : ''} ${i === active ? 'vrow-active' : ''}`}
              style={{ position: 'absolute', top: i * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }}
              onClick={(e) => {
                p.onActiveChange(i);
                if (e.shiftKey && anchor.current !== null)
                  p.onSelectedChange(selectRange(anchor.current, i, new Set(p.selected)));
                else toggle(i);
              }}
            >
              <span className="vrow-check" aria-hidden="true">
                {sel ? '☑' : '☐'}
              </span>
              {p.renderRow(r)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
