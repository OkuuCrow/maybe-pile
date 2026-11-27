/**
 * §14.2 Cover wall: finished items as a poster grid. Virtualized (only visible
 * rows render), cached thumbnails only, keyboard grid (arrows, Home/End,
 * Enter opens; roving tabindex), accessible names, generated placeholders.
 * Adult art stays blurred per the anime settings (Cover handles it).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Cover, EmptyState, ErrorBox, Loading, RatingDisplay } from '../../components/Bits';

const GAP = 12;

export function WallPage() {
  const app = useApp();
  const toast = useToast();
  const [year, setYear] = useState<number | null>(null);
  const [type, setType] = useState<MediaType | null>(null);
  const [sort, setSort] = useState<'completed' | 'rating' | 'title'>('completed');
  const [size, setSize] = useState(140);
  const years = useAsync(() => call(getApi().wall.years()), [app.dataVersion]);
  const items = useAsync(
    () => call(getApi().wall.items({ year, type, sort })),
    [year, type, sort, app.dataVersion],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scrollTop, setScrollTop] = useState(0);
  const [focus, setFocus] = useState(0);
  const [viewH, setViewH] = useState(600);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth || 800);
      setViewH(el.clientHeight || 600);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const list = useMemo(() => items.data ?? [], [items.data]);
  const tileH = Math.round(size * 1.5) + 48;
  const cols = Math.max(1, Math.floor((width + GAP) / (size + GAP)));
  const rows = Math.ceil(list.length / cols);
  const first = Math.max(0, Math.floor(scrollTop / (tileH + GAP)) - 2);
  const last = Math.min(rows, Math.ceil((scrollTop + viewH) / (tileH + GAP)) + 2);
  const visible = useMemo(() => list.slice(first * cols, last * cols), [list, first, last, cols]);
  useEffect(() => setFocus((f) => Math.min(f, Math.max(0, list.length - 1))), [list.length]);

  const move = (to: number) => {
    const idx = Math.max(0, Math.min(list.length - 1, to));
    setFocus(idx);
    const row = Math.floor(idx / cols);
    const el = scroller.current;
    if (el) {
      const top = row * (tileH + GAP);
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + tileH > el.scrollTop + el.clientHeight) el.scrollTop = top + tileH - el.clientHeight;
    }
    requestAnimationFrame(() => document.getElementById(`wall-${idx}`)?.focus());
  };
  const onKey = (e: React.KeyboardEvent, idx: number) => {
    const map: Record<string, number> = {
      ArrowRight: idx + 1,
      ArrowLeft: idx - 1,
      ArrowDown: idx + cols,
      ArrowUp: idx - cols,
      Home: 0,
      End: list.length - 1,
    };
    if (e.key in map) {
      e.preventDefault();
      move(map[e.key] ?? idx);
    }
  };
  const savePng = async () => {
    const r = scroller.current?.getBoundingClientRect();
    if (!r) return;
    try {
      const res = await call(
        getApi().wall.savePng({
          rect: {
            x: Math.max(0, Math.round(r.x)),
            y: Math.max(0, Math.round(r.y)),
            width: Math.max(1, Math.round(r.width)),
            height: Math.max(1, Math.round(r.height)),
          },
        }),
      );
      if (res) toast.success(`Saved ${res.fileLabel}.`);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <div className="page wall-page">
      <div className="page-header">
        <h1>Cover wall</h1>
        <button type="button" className="button" onClick={() => void savePng()} disabled={list.length === 0}>
          Save as image
        </button>
      </div>
      <div className="library-toolbar">
        <div className="toolbar-block row">
          <label htmlFor="wall-year">Year</label>
          <select
            id="wall-year"
            className="input input-inline"
            value={year ?? ''}
            onChange={(e) => setYear(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All years</option>
            {(years.data ?? []).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <label htmlFor="wall-type">Type</label>
          <select
            id="wall-type"
            className="input input-inline"
            value={type ?? ''}
            onChange={(e) => setType((e.target.value || null) as MediaType | null)}
          >
            <option value="">All types</option>
            {MEDIA_TYPES.map((t) => (
              <option key={t} value={t}>
                {typeLabelPlural(t)}
              </option>
            ))}
          </select>
          <label htmlFor="wall-sort">Sort</label>
          <select
            id="wall-sort"
            className="input input-inline"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="completed">Finished (newest)</option>
            <option value="rating">Rating</option>
            <option value="title">Title</option>
          </select>
          <label htmlFor="wall-size">Size</label>
          <input
            id="wall-size"
            type="range"
            min={90}
            max={240}
            step={10}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            aria-valuetext={`${size} pixels`}
          />
        </div>
      </div>
      <p className="muted" aria-live="polite">
        {list.length} finished item(s). Use the arrow keys to move, Enter to open.
      </p>
      {items.loading && !items.data && <Loading />}
      {items.error && <ErrorBox error={items.error} onRetry={items.reload} />}
      {items.data && list.length === 0 && (
        <EmptyState title="Nothing finished yet">Completed items show up here.</EmptyState>
      )}
      <div ref={scroller} className="wall-scroller" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div
          role="grid"
          aria-label="Finished items"
          aria-rowcount={rows}
          aria-colcount={cols}
          style={{ height: rows * (tileH + GAP), position: 'relative' }}
        >
          {visible.map((it, k) => {
            const idx = first * cols + k;
            const r = Math.floor(idx / cols);
            const c = idx % cols;
            return (
              <div
                key={it.id}
                role="gridcell"
                aria-rowindex={r + 1}
                aria-colindex={c + 1}
                className="wall-tile"
                style={{
                  position: 'absolute',
                  top: r * (tileH + GAP),
                  left: c * (size + GAP),
                  width: size,
                  height: tileH,
                }}
              >
                <a
                  id={`wall-${idx}`}
                  href={`#/item/${it.id}`}
                  tabIndex={idx === focus ? 0 : -1}
                  onFocus={() => setFocus(idx)}
                  onKeyDown={(e) => onKey(e, idx)}
                  aria-label={`${it.title}${it.rating ? `, rated ${it.rating / 2} of 5` : ''}${it.dateCompleted ? `, finished ${it.dateCompleted}` : ''}`}
                  className="wall-link"
                  title={it.title}
                >
                  <Cover url={it.thumbUrl} title={it.title} type={it.type} size="medium" />
                  <span className="wall-caption" aria-hidden="true">
                    <span className="wall-title">{it.title}</span>
                    <RatingDisplay rating={it.rating} />
                  </span>
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
