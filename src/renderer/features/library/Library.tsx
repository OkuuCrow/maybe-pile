import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  MEDIA_TYPES,
  SORT_FIELDS,
  STATUSES,
  type MediaType,
  type SortField,
  type Status,
} from '../../../shared/enums';
import { DEFAULT_LIBRARY_QUERY, LibraryQuerySchema, type LibraryQuery } from '../../../shared/schemas';
import type { ItemSummary, TagCount } from '../../../shared/types';
import { DEFAULT_LAYOUTS } from '../../../domain/layouts';
import { ratingToStars } from '../../../domain/rating';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { AddToListDialog } from '../lists/ListsPage';
import { SnoozeDialog } from '../health/HealthPage';
import { S, fmtPartialDate, statusLabel, typeLabel, typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { isTypingTarget } from '../../app/shortcuts';
import {
  Cover,
  EmptyState,
  ErrorBox,
  Highlight,
  Loading,
  ProgressBar,
  RATING_OPTIONS,
  RatingDisplay,
  StatusBadge,
  TypeBadge,
} from '../../components/Bits';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { TextField } from '../../components/Fields';
import { QuickActions } from '../simple/QuickActions';
import { BulkEditDialog } from './BulkEditDialog';
import { SharePageDialog } from './SharePageDialog';
import { IconClose, IconGrid, IconList, IconSearch } from '../../components/Icons';

const PAGE = 200;
const SORT_LABELS: Record<SortField, string> = {
  title: 'Title',
  dateAdded: 'Date added',
  updatedAt: 'Last updated',
  rating: 'Rating',
  status: 'Status',
  releaseDate: 'Release date',
  progress: 'Progress',
};

function readHint(): Partial<LibraryQuery> | null {
  try {
    const raw = sessionStorage.getItem('mp-library-hint');
    sessionStorage.removeItem('mp-library-hint');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // A saved view passes its whole (validated) query.
    const full = LibraryQuerySchema.safeParse(parsed);
    if (full.success) return { ...full.data, offset: 0, limit: PAGE };
    const h = parsed as {
      statuses?: unknown;
      types?: unknown;
      tags?: unknown;
      upNextOnly?: unknown;
      listId?: unknown;
      health?: unknown;
    };
    const out: Partial<LibraryQuery> = {};
    if (h.upNextOnly === true) out.upNextOnly = true;
    if (typeof h.listId === 'string' && /^[0-9a-f-]{36}$/i.test(h.listId)) out.listId = h.listId;
    if (h.health === 'stale' || h.health === 'snoozed') out.health = h.health;
    if (Array.isArray(h.types))
      out.types = h.types.filter((t): t is MediaType => (MEDIA_TYPES as readonly unknown[]).includes(t));
    if (Array.isArray(h.statuses))
      out.statuses = h.statuses.filter((t): t is Status => (STATUSES as readonly unknown[]).includes(t));
    if (Array.isArray(h.tags))
      out.tags = h.tags.filter((t): t is string => typeof t === 'string').slice(0, 10);
    return out;
  } catch {
    return null;
  }
}

export function Library() {
  const app = useApp();
  const toast = useToast();
  const [query, setQuery] = useState<LibraryQuery>(() => {
    const hint = readHint();
    const base = app.settings?.libraryQuery ?? DEFAULT_LIBRARY_QUERY;
    return hint
      ? { ...DEFAULT_LIBRARY_QUERY, sort: base.sort, direction: base.direction, ...hint }
      : { ...base, offset: 0, limit: PAGE };
  });
  const [textDraft, setTextDraft] = useState(query.text);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof errorOf> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const view = app.settings?.libraryView ?? 'grid';
  const layout = app.layouts?.library ?? DEFAULT_LAYOUTS.library;
  const tags = useAsync(() => call(getApi().items.tags()), [app.dataVersion]);
  const lists = useAsync(() => call(getApi().lists.list()), [app.dataVersion]);
  const seq = useRef(0);

  // Debounced search text → query.
  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => (q.text === textDraft ? q : { ...q, text: textDraft })), 200);
    return () => clearTimeout(t);
  }, [textDraft]);

  // Persist filters/sort per user (debounced).
  const { updateSettings } = app;
  useEffect(() => {
    const t = setTimeout(() => {
      void updateSettings({ libraryQuery: { ...query, offset: 0, limit: PAGE } }).catch(() => undefined);
    }, 600);
    return () => clearTimeout(t);
  }, [query, updateSettings]);

  const load = useCallback(
    async (offset: number) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const page = await call(getApi().items.query({ ...query, offset, limit: PAGE }));
        if (mine !== seq.current) return;
        setTotal(page.total);
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setError(null);
      } catch (e) {
        if (mine === seq.current) setError(errorOf(e));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void load(0);
  }, [load, app.dataVersion]);

  // Drop selections that are no longer in the result set.
  useEffect(() => {
    setSelected((s) => {
      const ids = new Set(items.map((i) => i.id));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [items]);

  const patch = (p: Partial<LibraryQuery>) => setQuery((q) => ({ ...q, ...p, offset: 0 }));
  const reset = () => {
    setTextDraft('');
    setQuery({ ...DEFAULT_LIBRARY_QUERY, sort: query.sort, direction: query.direction });
  };
  const activeFilterCount =
    query.types.length +
    query.statuses.length +
    query.tags.length +
    (query.ratingMin !== null ? 1 : 0) +
    (query.ratingMax !== null ? 1 : 0) +
    (query.addedFrom ? 1 : 0) +
    (query.addedTo ? 1 : 0) +
    (query.listId ? 1 : 0) +
    (query.upNextOnly ? 1 : 0) +
    (query.health ? 1 : 0) +
    (query.text ? 1 : 0);

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const blocks: Record<string, ReactNode> = {
    search: (
      <div className="toolbar-block search-block" key="search">
        <label htmlFor="library-search" className="visually-hidden">
          {S.library.search}
        </label>
        <span className="search-icon" aria-hidden="true">
          <IconSearch />
        </span>
        <input
          id="library-search"
          className="input search-input"
          type="search"
          value={textDraft}
          placeholder={S.library.searchPlaceholder}
          onChange={(e) => setTextDraft(e.target.value)}
          aria-describedby="library-count"
        />
      </div>
    ),
    filters: (
      <FilterBar key="filters" lists={lists.data ?? []} query={query} patch={patch} tags={tags.data ?? []} />
    ),
    sort: (
      <div className="toolbar-block row" key="sort">
        <label htmlFor="sort-field">{S.library.sort}</label>
        <select
          id="sort-field"
          className="input input-inline"
          value={query.sort}
          onChange={(e) => patch({ sort: e.target.value as SortField })}
        >
          {SORT_FIELDS.map((f) => (
            <option key={f} value={f}>
              {SORT_LABELS[f]}
            </option>
          ))}
        </select>
        <label htmlFor="sort-dir" className="visually-hidden">
          {S.library.direction}
        </label>
        <select
          id="sort-dir"
          className="input input-inline"
          value={query.direction}
          onChange={(e) => patch({ direction: e.target.value as 'asc' | 'desc' })}
        >
          <option value="asc">{S.library.asc}</option>
          <option value="desc">{S.library.desc}</option>
        </select>
      </div>
    ),
    viewToggle: (
      <div className="toolbar-block segmented" role="group" aria-label={S.library.view} key="view">
        <button
          type="button"
          className="button"
          aria-pressed={view === 'grid'}
          onClick={() => void app.updateSettings({ libraryView: 'grid' })}
        >
          <IconGrid /> {S.library.grid}
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={view === 'list'}
          onClick={() => void app.updateSettings({ libraryView: 'list' })}
        >
          <IconList /> {S.library.list}
        </button>
      </div>
    ),
    statusStrip: <StatusStrip key="strip" query={query} patch={patch} />,
    bulkBar: (
      <BulkBar
        key="bulk"
        selected={selected}
        allIds={items.map((i) => i.id)}
        setSelected={setSelected}
        onDone={() => app.bumpData()}
        readOnly={app.info?.readOnly ?? false}
        toast={toast}
      />
    ),
  };

  const simple = app.level === 'simple';
  return (
    <div className="page library-page">
      <div className="page-header">
        <h1>{S.library.title}</h1>
        <p id="library-count" className="muted" aria-live="polite">
          {loading && items.length === 0 ? S.common.loading : S.library.results(total)}
        </p>
      </div>
      {simple ? (
        <SimpleToolbar query={query} patch={patch} search={blocks['search']} bulkBar={blocks['bulkBar']} />
      ) : (
        <>
          <div className="library-toolbar">{layout.filter((c) => c.visible).map((c) => blocks[c.id])}</div>
          <FullExtras
            query={query}
            setQuery={(q) => (setTextDraft(q.text), setQuery({ ...q, offset: 0, limit: PAGE }))}
            selected={selected}
          />
        </>
      )}
      {!simple && activeFilterCount > 0 && (
        <ActiveChips
          lists={lists.data ?? []}
          query={query}
          patch={patch}
          clearText={() => setTextDraft('')}
          reset={reset}
        />
      )}
      {error && <ErrorBox error={error} onRetry={() => void load(0)} />}
      {!error &&
        !loading &&
        total === 0 &&
        (activeFilterCount > 0 ? (
          <EmptyState
            title={S.library.noMatches}
            action={
              <button type="button" className="button" onClick={reset}>
                {S.library.clearFilters}
              </button>
            }
          />
        ) : (
          <EmptyState
            title={S.library.emptyTitle}
            action={
              <button type="button" className="button button-primary" onClick={() => app.openAdd()}>
                {S.nav.add}
              </button>
            }
          >
            {S.library.emptyBody}
          </EmptyState>
        ))}
      {loading && items.length === 0 && <Loading />}
      {items.length > 0 && (
        <Results
          items={items}
          total={total}
          view={view}
          query={query.text}
          selected={selected}
          toggleSelect={toggleSelect}
          onNeedMore={() => {
            if (!loading && items.length < total) void load(items.length);
          }}
          open={(id) => app.navigate({ name: 'item', id })}
        />
      )}
      {items.length > 0 && items.length < total && (
        <div className="center">
          <button type="button" className="button" onClick={() => void load(items.length)} disabled={loading}>
            {loading ? S.common.loading : `${S.library.loadMore} (${items.length} of ${total})`}
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ filters */

function CheckGroup<T extends string>({
  legend,
  options,
  values,
  onChange,
  label,
}: {
  legend: string;
  options: readonly T[];
  values: T[];
  onChange: (v: T[]) => void;
  label: (v: T) => string;
}) {
  const id = useId();
  return (
    <fieldset className="check-group">
      <legend>{legend}</legend>
      {options.map((o) => (
        <span key={o} className="check-inline">
          <input
            id={`${id}-${o}`}
            type="checkbox"
            checked={values.includes(o)}
            onChange={(e) => onChange(e.target.checked ? [...values, o] : values.filter((v) => v !== o))}
          />
          <label htmlFor={`${id}-${o}`}>{label(o)}</label>
        </span>
      ))}
    </fieldset>
  );
}

function FilterBar({
  lists,
  query,
  patch,
  tags,
}: {
  lists: { id: string; name: string }[];
  query: LibraryQuery;
  patch: (p: Partial<LibraryQuery>) => void;
  tags: TagCount[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="toolbar-block filter-block">
      <button
        type="button"
        className="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((o) => !o)}
      >
        Filters{query.types.length + query.statuses.length + query.tags.length > 0 ? ` (active)` : ''}
      </button>
      <div id={`${id}-panel`} className="filter-panel card" hidden={!open}>
        <CheckGroup
          legend="Type"
          options={MEDIA_TYPES}
          values={query.types}
          onChange={(v) => patch({ types: v })}
          label={typeLabelPlural}
        />
        <CheckGroup
          legend="Status"
          options={STATUSES}
          values={query.statuses}
          onChange={(v) => patch({ statuses: v })}
          label={statusLabel}
        />
        <fieldset className="check-group">
          <legend>Tags</legend>
          {tags.length === 0 ? (
            <p className="muted">No tags yet.</p>
          ) : (
            <>
              <div className="row">
                <label htmlFor={`${id}-tagmode`}>Match</label>
                <select
                  id={`${id}-tagmode`}
                  className="input input-inline"
                  value={query.tagMode}
                  onChange={(e) => patch({ tagMode: e.target.value as 'any' | 'all' })}
                >
                  <option value="any">any selected tag</option>
                  <option value="all">all selected tags</option>
                </select>
              </div>
              <div className="tag-checks">
                {tags.slice(0, 60).map((t) => (
                  <span key={t.tag} className="check-inline">
                    <input
                      id={`${id}-tag-${t.tag}`}
                      type="checkbox"
                      checked={query.tags.some((x) => x.toLowerCase() === t.tag.toLowerCase())}
                      onChange={(e) =>
                        patch({
                          tags: e.target.checked
                            ? [...query.tags, t.tag]
                            : query.tags.filter((x) => x.toLowerCase() !== t.tag.toLowerCase()),
                        })
                      }
                    />
                    <label htmlFor={`${id}-tag-${t.tag}`}>
                      {t.tag} ({t.count})
                    </label>
                  </span>
                ))}
              </div>
            </>
          )}
        </fieldset>
        <fieldset className="check-group">
          <legend>Rating</legend>
          <div className="row">
            <label htmlFor={`${id}-rmin`}>From</label>
            <select
              id={`${id}-rmin`}
              className="input input-inline"
              value={query.ratingMin ?? ''}
              onChange={(e) => patch({ ratingMin: e.target.value ? Number(e.target.value) : null })}
            >
              {RATING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value === '' ? 'Any' : o.label}
                </option>
              ))}
            </select>
            <label htmlFor={`${id}-rmax`}>to</label>
            <select
              id={`${id}-rmax`}
              className="input input-inline"
              value={query.ratingMax ?? ''}
              onChange={(e) => patch({ ratingMax: e.target.value ? Number(e.target.value) : null })}
            >
              {RATING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value === '' ? 'Any' : o.label}
                </option>
              ))}
            </select>
          </div>
        </fieldset>
        <fieldset className="check-group">
          <legend>Date added</legend>
          <div className="row">
            <label htmlFor={`${id}-from`}>From</label>
            <input
              id={`${id}-from`}
              type="date"
              className="input input-inline"
              value={query.addedFrom ?? ''}
              onChange={(e) => patch({ addedFrom: e.target.value || null })}
            />
            <label htmlFor={`${id}-to`}>to</label>
            <input
              id={`${id}-to`}
              type="date"
              className="input input-inline"
              value={query.addedTo ?? ''}
              onChange={(e) => patch({ addedTo: e.target.value || null })}
            />
          </div>
        </fieldset>
        <fieldset className="check-group">
          <legend>Collections</legend>
          <div className="row wrap">
            <label htmlFor={`${id}-list`}>List</label>
            <select
              id={`${id}-list`}
              className="input input-inline"
              value={query.listId ?? ''}
              onChange={(e) => patch({ listId: e.target.value || null })}
            >
              <option value="">Any</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <label className="check-inline">
              <input
                type="checkbox"
                checked={query.upNextOnly}
                onChange={(e) => patch({ upNextOnly: e.target.checked })}
              />{' '}
              Only Up Next
            </label>
            <label htmlFor={`${id}-health`}>Pile Health</label>
            <select
              id={`${id}-health`}
              className="input input-inline"
              value={query.health ?? ''}
              onChange={(e) => patch({ health: (e.target.value || null) as LibraryQuery['health'] })}
            >
              <option value="">Any</option>
              <option value="stale">Stale (needs a look)</option>
              <option value="snoozed">Snoozed</option>
            </select>
          </div>
        </fieldset>
      </div>
    </div>
  );
}

function ActiveChips({
  lists,
  query,
  patch,
  clearText,
  reset,
}: {
  lists: { id: string; name: string }[];
  query: LibraryQuery;
  patch: (p: Partial<LibraryQuery>) => void;
  clearText: () => void;
  reset: () => void;
}) {
  const chips: { key: string; label: string; remove: () => void }[] = [];
  if (query.text)
    chips.push({
      key: 'text',
      label: `Search: “${query.text}”`,
      remove: () => (clearText(), patch({ text: '' })),
    });
  for (const t of query.types)
    chips.push({
      key: `t${t}`,
      label: `Type: ${typeLabel(t)}`,
      remove: () => patch({ types: query.types.filter((x) => x !== t) }),
    });
  for (const s of query.statuses)
    chips.push({
      key: `s${s}`,
      label: `Status: ${statusLabel(s)}`,
      remove: () => patch({ statuses: query.statuses.filter((x) => x !== s) }),
    });
  for (const t of query.tags)
    chips.push({
      key: `g${t}`,
      label: `Tag: ${t}${query.tags.length > 1 ? ` (${query.tagMode})` : ''}`,
      remove: () => patch({ tags: query.tags.filter((x) => x !== t) }),
    });
  if (query.ratingMin !== null)
    chips.push({
      key: 'rmin',
      label: `Rating ≥ ${ratingToStars(query.ratingMin)}★`,
      remove: () => patch({ ratingMin: null }),
    });
  if (query.ratingMax !== null)
    chips.push({
      key: 'rmax',
      label: `Rating ≤ ${ratingToStars(query.ratingMax)}★`,
      remove: () => patch({ ratingMax: null }),
    });
  if (query.addedFrom)
    chips.push({
      key: 'af',
      label: `Added from ${fmtPartialDate(query.addedFrom)}`,
      remove: () => patch({ addedFrom: null }),
    });
  if (query.addedTo)
    chips.push({
      key: 'at',
      label: `Added until ${fmtPartialDate(query.addedTo)}`,
      remove: () => patch({ addedTo: null }),
    });
  if (query.listId)
    chips.push({
      key: 'list',
      label: `List: ${lists.find((l) => l.id === query.listId)?.name ?? '…'}`,
      remove: () => patch({ listId: null }),
    });
  if (query.upNextOnly)
    chips.push({ key: 'up', label: 'Only Up Next', remove: () => patch({ upNextOnly: false }) });
  if (query.health)
    chips.push({
      key: 'health',
      label: query.health === 'stale' ? 'Stale (Pile Health)' : 'Snoozed',
      remove: () => patch({ health: null }),
    });
  return (
    <div className="active-filters">
      <ul className="chip-list" aria-label="Active filters">
        {chips.map((c) => (
          <li key={c.key} className="chip">
            <span>{c.label}</span>
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove filter ${c.label}`}
              onClick={c.remove}
            >
              <IconClose size={12} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="button button-small" onClick={reset}>
        {S.library.clearFilters}
      </button>
    </div>
  );
}

function StatusStrip({ query, patch }: { query: LibraryQuery; patch: (p: Partial<LibraryQuery>) => void }) {
  const app = useApp();
  const d = useAsync(() => call(getApi().items.dashboard()), [app.dataVersion]);
  return (
    <div className="toolbar-block status-strip" role="group" aria-label="Quick status filter">
      {STATUSES.map((s: Status) => {
        const on = query.statuses.length === 1 && query.statuses[0] === s;
        return (
          <button
            key={s}
            type="button"
            className="button button-small"
            aria-pressed={on}
            onClick={() => patch({ statuses: on ? [] : [s] })}
          >
            <StatusBadge status={s} /> <span>{d.data?.countsByStatus[s] ?? '…'}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ bulk */

function BulkBar({
  selected,
  allIds,
  setSelected,
  onDone,
  readOnly,
  toast,
}: {
  selected: Set<string>;
  allIds: string[];
  setSelected: (s: Set<string>) => void;
  onDone: () => void;
  readOnly: boolean;
  toast: ReturnType<typeof useToast>;
}) {
  const [status, setStatus] = useState<Status>('in_progress');
  const [tag, setTag] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const id = useId();
  const ids = [...selected];
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      onDone();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="toolbar-block bulk-bar" role="group" aria-label="Bulk actions">
      <span aria-live="polite">{S.library.selected(selected.size)}</span>
      <button
        type="button"
        className="button button-small"
        onClick={() => setSelected(new Set(allIds))}
        disabled={allIds.length === 0}
      >
        Select all shown
      </button>
      <button
        type="button"
        className="button button-small"
        onClick={() => setSelected(new Set())}
        disabled={selected.size === 0}
      >
        Clear selection
      </button>
      {selected.size > 0 && !readOnly && (
        <>
          <label htmlFor={`${id}-status`} className="visually-hidden">
            New status
          </label>
          <select
            id={`${id}-status`}
            className="input input-inline"
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() =>
              void run(
                () => call(getApi().items.bulk({ action: 'setStatus', ids, status })),
                `Set ${ids.length} item(s) to ${statusLabel(status)}.`,
              )
            }
          >
            Set status
          </button>
          <label htmlFor={`${id}-tag`} className="visually-hidden">
            Tag
          </label>
          <input
            id={`${id}-tag`}
            className="input input-inline"
            placeholder="Tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
          <button
            type="button"
            className="button button-small"
            disabled={busy || !tag.trim()}
            onClick={() =>
              void run(
                () => call(getApi().items.bulk({ action: 'addTag', ids, tag })),
                `Added tag to ${ids.length} item(s).`,
              )
            }
          >
            Add tag
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy || !tag.trim()}
            onClick={() =>
              void run(
                () => call(getApi().items.bulk({ action: 'removeTag', ids, tag })),
                `Removed tag from ${ids.length} item(s).`,
              )
            }
          >
            Remove tag
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() =>
              void run(
                () => call(getApi().items.bulk({ action: 'addUpNext', ids })),
                'Added to Up Next (completed and dropped items are skipped).',
              )
            }
          >
            Add to Up Next
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy || ids.length > 500}
            title={ids.length > 500 ? 'Select up to 500 items' : undefined}
            onClick={() => {
              setBusy(true);
              void call(getApi().artwork.bulkAutoPick({ itemIds: ids, slots: null }))
                .then((r) => {
                  toast.success(
                    `Artwork: ${r.updated} updated, ${r.keptUserChoice} kept your choice, ${r.noCandidates} had nothing new${r.failed ? `, ${r.failed} failed` : ''}.`,
                  );
                  onDone();
                })
                .catch((e: unknown) => toast.error(errorOf(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Working…' : 'Auto-pick artwork'}
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => setListOpen(true)}
          >
            Add to list…
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => setSnoozeOpen(true)}
          >
            Snooze…
          </button>
          <button
            type="button"
            className="button button-small button-danger"
            disabled={busy}
            onClick={() => setConfirm(true)}
          >
            Delete…
          </button>
        </>
      )}
      {listOpen && <AddToListDialog itemIds={ids} onClose={() => setListOpen(false)} onDone={onDone} />}
      {snoozeOpen && (
        <SnoozeDialog
          count={ids.length}
          title={null}
          onCancel={() => setSnoozeOpen(false)}
          onSnooze={(until) => {
            setSnoozeOpen(false);
            void run(
              () => call(getApi().items.bulk({ action: 'snooze', ids, until })),
              `Snoozed ${ids.length} item(s) until ${fmtPartialDate(until)}.`,
            );
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={`Delete ${ids.length} item(s)?`}
          message={
            <p>
              This removes the selected items together with their progress history, notes and cached artwork.
              You can undo for a few seconds afterwards.
            </p>
          }
          confirmLabel={`Delete ${ids.length} item(s)`}
          destructive
          typeToConfirm={ids.length > 1 ? 'DELETE' : undefined}
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void (async () => {
              try {
                const r = await call(getApi().items.remove({ ids }));
                setSelected(new Set());
                onDone();
                toast.show({
                  kind: 'success',
                  message: `Deleted ${r.count} item(s).`,
                  action: {
                    label: 'Undo',
                    run: () =>
                      void call(getApi().items.undoRemove({ ids })).then(onDone, (e: unknown) =>
                        toast.error(errorOf(e)),
                      ),
                  },
                });
              } catch (e) {
                toast.error(errorOf(e));
              }
            })();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ results (virtualized) */

const LIST_ROW = 76;
const GRID_ROW = 370;
const GRID_MIN_COL = 170;
const OVERSCAN = 4;

function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 1000, height: 700 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width || 1000, height: entry.contentRect.height || 700 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function Results({
  items,
  total,
  view,
  query,
  selected,
  toggleSelect,
  onNeedMore,
  open,
}: {
  items: ItemSummary[];
  total: number;
  view: 'grid' | 'list';
  query: string;
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  onNeedMore: () => void;
  open: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useSize(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);
  const cols = view === 'grid' ? Math.max(1, Math.floor(size.width / GRID_MIN_COL)) : 1;
  const rowH = view === 'grid' ? GRID_ROW : LIST_ROW;
  const rows = Math.ceil(items.length / cols);
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + size.height) / rowH) + OVERSCAN);
  const start = firstRow * cols;
  const end = Math.min(items.length, (lastRow + 1) * cols);
  const visible = useMemo(() => items.slice(start, end), [items, start, end]);
  const pendingFocus = useRef<number | null>(null);

  useEffect(() => {
    if (lastRow >= rows - 2) onNeedMore();
  }, [lastRow, rows, onNeedMore]);

  useEffect(() => {
    if (pendingFocus.current === null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-index="${pendingFocus.current}"] .item-link`,
    );
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });

  const moveTo = (idx: number) => {
    const target = Math.max(0, Math.min(items.length - 1, idx));
    const row = Math.floor(target / cols);
    const sc = scrollRef.current;
    if (sc) {
      if (row * rowH < sc.scrollTop) sc.scrollTop = row * rowH;
      else if ((row + 1) * rowH > sc.scrollTop + sc.clientHeight)
        sc.scrollTop = (row + 1) * rowH - sc.clientHeight;
      setScrollTop(sc.scrollTop);
    }
    pendingFocus.current = target;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${target}"] .item-link`);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent, index: number, id: string) => {
    if (isTypingTarget(e.target) && (e.target as HTMLElement).tagName !== 'INPUT') return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveTo(index + cols);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveTo(index - cols);
        break;
      case 'ArrowRight':
        if (view === 'grid') {
          e.preventDefault();
          moveTo(index + 1);
        }
        break;
      case 'ArrowLeft':
        if (view === 'grid') {
          e.preventDefault();
          moveTo(index - 1);
        }
        break;
      case 'Home':
        e.preventDefault();
        moveTo(0);
        break;
      case 'End':
        e.preventDefault();
        moveTo(items.length - 1);
        break;
      case ' ':
      case 'x':
      case 'X':
        if ((e.target as HTMLElement).classList.contains('item-link')) {
          e.preventDefault();
          toggleSelect(id);
        }
        break;
    }
  };

  return (
    <div
      className={`results results-${view}`}
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <ul
        className="results-inner"
        style={{ height: rows * rowH }}
        aria-label={`Library items, ${total} total`}
      >
        {visible.map((it, i) => {
          const index = start + i;
          const row = Math.floor(index / cols);
          const col = index % cols;
          const style =
            view === 'grid'
              ? { top: row * rowH, left: `${(col / cols) * 100}%`, width: `${100 / cols}%`, height: rowH }
              : { top: row * rowH, left: 0, right: 0, height: rowH };
          return (
            <li
              key={it.id}
              className={`result ${selected.has(it.id) ? 'result-selected' : ''}`}
              style={style}
              data-index={index}
              aria-setsize={total}
              aria-posinset={index + 1}
            >
              <ItemCard
                item={it}
                view={view}
                query={query}
                selected={selected.has(it.id)}
                onToggle={() => toggleSelect(it.id)}
                onKeyDown={(e) => onKeyDown(e, index, it.id)}
                open={open}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ItemCard({
  item,
  view,
  query,
  selected,
  onToggle,
  onKeyDown,
  open,
}: {
  item: ItemSummary;
  view: 'grid' | 'list';
  query: string;
  selected: boolean;
  onToggle: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  open: (id: string) => void;
}) {
  const cbId = useId();
  return (
    <div className={`item-card item-card-${view}`}>
      <input
        id={cbId}
        type="checkbox"
        className="item-select"
        checked={selected}
        onChange={onToggle}
        onKeyDown={onKeyDown}
        aria-label={`Select ${item.title}`}
      />
      <a
        className="item-link"
        href={`#/item/${item.id}`}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          e.preventDefault();
          open(item.id);
        }}
      >
        <Cover
          url={item.thumbUrl}
          title={item.title}
          type={item.type}
          size={view === 'grid' ? 'medium' : 'small'}
        />
        <span className="item-text">
          <span className="item-title">
            <Highlight text={item.title} query={query} />
          </span>
          <span className="item-meta">
            <TypeBadge type={item.type} />
            {item.year !== null && <span>{item.year}</span>}
            {item.creators[0] && <span className="muted">{item.creators.slice(0, 2).join(', ')}</span>}
          </span>
          <span className="item-meta">
            <StatusBadge status={item.status} />
            <RatingDisplay rating={item.rating} />
          </span>
          {view === 'list' && item.tags.length > 0 && (
            <span className="muted item-tags">{item.tags.join(' · ')}</span>
          )}
          <ProgressBar percent={item.progressPercent} label={item.progressLabel} />
          {item.nextStep && !item.nextStepSpoiler && (
            <span className="next-step-line">Next: {item.nextStep}</span>
          )}
          {item.checklist && <ChecklistMeter done={item.checklist.done} total={item.checklist.total} />}
          {item.waitingForDetails && <span className="badge">Waiting for details</span>}
        </span>
      </a>
      <QuickActions item={item} compact />
    </div>
  );
}

function ChecklistMeter({ done, total }: { done: number; total: number }) {
  const app = useApp();
  if (app.level !== 'full') return null;
  return (
    <span className="checklist-meter">
      Checklist {done} of {total}
      <span className="meter" aria-hidden="true">
        <span style={{ width: `${Math.round((done / Math.max(1, total)) * 100)}%` }} />
      </span>
    </span>
  );
}

const SIMPLE_SORTS: { value: string; label: string; sort: SortField; direction: 'asc' | 'desc' }[] = [
  { value: 'updated', label: 'Recently updated', sort: 'updatedAt', direction: 'desc' },
  { value: 'title', label: 'Title', sort: 'title', direction: 'asc' },
  { value: 'rating', label: 'Rating', sort: 'rating', direction: 'desc' },
  { value: 'added', label: 'Date added', sort: 'dateAdded', direction: 'desc' },
];

/** Simple Mode: one search box, type tabs (tracked types), one status filter, four sorts. */
function SimpleToolbar({
  query,
  patch,
  search,
  bulkBar,
}: {
  query: LibraryQuery;
  patch: (p: Partial<LibraryQuery>) => void;
  search: ReactNode;
  bulkBar: ReactNode;
}) {
  const app = useApp();
  const counts = useAsync(() => call(getApi().items.dashboard()), [app.dataVersion]);
  const hidden = new Set(app.settings?.interface.hiddenTypes ?? []);
  // Hidden types that still contain items stay visible (hiding never hides data).
  const types = MEDIA_TYPES.filter((t) => !hidden.has(t) || (counts.data?.countsByType[t] ?? 0) > 0);
  const current = query.types.length === 1 ? query.types[0] : null;
  const sortValue =
    SIMPLE_SORTS.find((x) => x.sort === query.sort && x.direction === query.direction)?.value ?? 'updated';
  return (
    <div className="library-toolbar simple-toolbar">
      {search}
      <div role="tablist" aria-label="Type" className="tabs type-tabs">
        {[null, ...types].map((t) => (
          <button
            key={t ?? 'all'}
            type="button"
            role="tab"
            aria-selected={current === t || (t === null && query.types.length === 0)}
            className="tab"
            onClick={() => patch({ types: t ? [t] : [] })}
          >
            {t ? typeLabelPlural(t) : 'All'}
          </button>
        ))}
      </div>
      <div className="toolbar-block row">
        <label htmlFor="simple-status">Status</label>
        <select
          id="simple-status"
          className="input input-inline"
          value={query.statuses.length === 1 ? query.statuses[0] : ''}
          onChange={(e) => patch({ statuses: e.target.value ? [e.target.value as Status] : [] })}
        >
          <option value="">Any status</option>
          {STATUSES.map((st) => (
            <option key={st} value={st}>
              {statusLabel(st)}
            </option>
          ))}
        </select>
        <label htmlFor="simple-sort">Sort</label>
        <select
          id="simple-sort"
          className="input input-inline"
          value={sortValue}
          onChange={(e) => {
            const o = SIMPLE_SORTS.find((x) => x.value === e.target.value);
            if (o) patch({ sort: o.sort, direction: o.direction });
          }}
        >
          {SIMPLE_SORTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {bulkBar}
    </div>
  );
}

/** Full mode: saved views, save current view, bulk edit and share page for the selection. */
function FullExtras({
  query,
  setQuery,
  selected,
}: {
  query: LibraryQuery;
  setQuery: (q: LibraryQuery) => void;
  selected: Set<string>;
}) {
  const app = useApp();
  const toast = useToast();
  const views = useAsync(() => call(getApi().views.list()), [app.dataVersion]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [bulk, setBulk] = useState(false);
  const [share, setShare] = useState(false);
  return (
    <div className="library-extras row-wrap">
      {(views.data ?? []).length > 0 && (
        <div className="toolbar-block row">
          <label htmlFor="views-select">Views</label>
          <select
            id="views-select"
            className="input input-inline"
            value=""
            onChange={(e) => {
              const v = (views.data ?? []).find((x) => x.id === e.target.value);
              if (v) {
                setQuery(v.query);
                if (v.notices.length) toast.show({ kind: 'info', message: v.notices.join(' ') });
              }
            }}
          >
            <option value="">Choose a view…</option>
            {(views.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <button type="button" className="button button-small" onClick={() => setSaving(true)}>
        Save view…
      </button>
      <a className="button button-small" href="#/wall">
        Cover wall
      </a>
      <a className="button button-small" href="#/triage">
        Triage
      </a>
      <a className="button button-small" href="#/trash">
        Recently deleted
      </a>
      {selected.size > 0 && (
        <>
          <button type="button" className="button button-small" onClick={() => setBulk(true)}>
            Edit {selected.size} selected…
          </button>
          <button type="button" className="button button-small" onClick={() => setShare(true)}>
            Share page…
          </button>
        </>
      )}
      {saving && (
        <Dialog
          title="Save this view"
          onClose={() => setSaving(false)}
          size="small"
          footer={
            <button
              type="button"
              className="button button-primary"
              disabled={!name.trim()}
              onClick={() =>
                void call(
                  getApi().views.save({
                    id: null,
                    name,
                    query: { ...query, offset: 0, limit: 200 },
                    viewMode: app.settings?.libraryView ?? 'grid',
                    pinned: false,
                  }),
                )
                  .then(() => {
                    toast.success(`Saved view “${name}”.`);
                    setSaving(false);
                    setName('');
                    views.reload();
                  })
                  .catch((e: unknown) => toast.error(errorOf(e)))
              }
            >
              Save
            </button>
          }
        >
          <TextField
            label="Name"
            value={name}
            onChange={setName}
            maxLength={80}
            hint="Saves the current search, filters, sort and view."
          />
        </Dialog>
      )}
      {bulk && <BulkEditDialog ids={[...selected]} onClose={() => setBulk(false)} />}
      {share && (
        <SharePageDialog source={{ kind: 'items', ids: [...selected] }} onClose={() => setShare(false)} />
      )}
    </div>
  );
}
