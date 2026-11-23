/**
 * Review screen for a library source snapshot (Steam or a pasted list):
 * filter (Unplayed by default), search, sort, keyboard + mouse multi-select,
 * ignore / open-on-Steam for the focused row, import options, confirmation,
 * result (with undo) and the re-sync diff.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { STATUSES, type Status } from '../../../shared/enums';
import type {
  BatchImportResultView,
  FetchJobView,
  LibrarySourceView,
  SourceDiffView,
  SourceEntriesPage,
  SourceEntryView,
} from '../../../shared/types';
import { call, errorOf, getApi } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtDateTime, statusLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ErrorBox, Loading, Notice } from '../../components/Bits';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Checkbox, SelectField, TextField } from '../../components/Fields';
import { VirtualList } from './VirtualList';

type View = 'unplayed' | 'played' | 'all' | 'inPile' | 'ignored' | 'new' | 'removed';
const VIEW_LABELS: Record<View, string> = {
  unplayed: 'Unplayed (not in pile, not ignored)',
  played: 'Played',
  all: 'All (not ignored)',
  inPile: 'Already in pile',
  ignored: 'Ignored',
  new: 'New since last sync',
  removed: 'No longer in library',
};

function playtime(m: number | null, isSteam: boolean): string {
  if (!isSteam) return '';
  if (!m) return 'Never played (per Steam)';
  return m < 60 ? `${m} min` : `${Math.round((m / 60) * 10) / 10} h`;
}

export function SourceReview({
  source,
  onSourcesChange,
}: {
  source: LibrarySourceView;
  onSourcesChange: (l: LibrarySourceView[]) => void;
}) {
  const app = useApp();
  const toast = useToast();
  const uid = useId();
  const isSteam = source.kind === 'steam';
  const [view, setView] = useState<View>('unplayed');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'name' | 'playtime' | 'lastPlayed' | 'appid'>('name');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [showNonGames, setShowNonGames] = useState(false);
  const [page, setPage] = useState<SourceEntriesPage | null>(null);
  const [loadError, setLoadError] = useState<ReturnType<typeof errorOf> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(-1);
  const [job, setJob] = useState<FetchJobView | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [options, setOptions] = useState(false);
  const [result, setResult] = useState<BatchImportResultView | null>(null);
  const [diff, setDiff] = useState<SourceDiffView | null>(null);
  const [announce, setAnnounce] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      if (timer.current) window.clearInterval(timer.current);
    };
  }, []);

  const load = async () => {
    try {
      const p = await call(
        getApi().sources.entries({ sourceId: source.id, view, search, showNonGames, sort, direction }),
      );
      setPage(p);
      setLoadError(null);
      setAnnounce(`${p.total} game(s) shown.`);
      setActive((a) => Math.min(a, p.rows.length - 1));
    } catch (e) {
      setLoadError(errorOf(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.lastSyncedAt, view, search, showNonGames, sort, direction, app.dataVersion]);

  const rows = useMemo(() => page?.rows ?? [], [page]);
  const activeRow: SourceEntryView | undefined = rows[active];
  const selectedInView = useMemo(
    () => rows.filter((r) => selected.has(r.externalId)).length,
    [rows, selected],
  );

  const refreshSources = async () => onSourcesChange(await call(getApi().sources.list()));

  const startFetch = async () => {
    try {
      const j = await call(getApi().sources.startFetch({ sourceId: source.id }));
      setJob(j);
      timer.current = window.setInterval(() => {
        void call(getApi().sources.fetchStatus({ jobId: j.jobId }))
          .then(async (s) => {
            setJob(s);
            if (s.state !== 'running') {
              if (timer.current) window.clearInterval(timer.current);
              timer.current = null;
              await refreshSources();
              if (s.state === 'done') {
                setAnnounce(
                  `Library loaded. ${s.diff?.added ?? 0} new, ${s.diff?.playtimeChanged ?? 0} playtime changes, ${s.diff?.removed ?? 0} removed.`,
                );
                if (
                  source.lastSyncedAt &&
                  s.diff &&
                  (s.diff.added || s.diff.playtimeChanged || s.diff.removed)
                )
                  setDiff(await call(getApi().sources.diff({ sourceId: source.id })));
              }
            }
          })
          .catch(() => undefined);
      }, 400);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const cancel = async () => {
    if (!job) return;
    setJob(await call(getApi().sources.cancelFetch({ jobId: job.jobId })));
    if (timer.current) window.clearInterval(timer.current);
  };

  const setIgnored = async (ids: string[], ignored: boolean) => {
    try {
      const r = await call(getApi().sources.setIgnored({ sourceId: source.id, externalIds: ids, ignored }));
      toast.success(`${ignored ? 'Ignored' : 'Restored'} ${r.changed} game(s).`);
      setSelected((s) => new Set([...s].filter((x) => !ids.includes(x))));
      await load();
      await refreshSources();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const openOnSteam = (r: SourceEntryView) => {
    if (!r.storeUrl) return;
    void call(getApi().app.openExternal({ url: r.storeUrl })).catch((e: unknown) => toast.error(errorOf(e)));
  };

  const running = job?.state === 'running';
  const syncedText = source.lastSyncedAt
    ? `Last synced ${fmtDateTime(source.lastSyncedAt)}`
    : 'Not synced yet';
  return (
    <section aria-labelledby={`${uid}-h`} className="source-review">
      <h2 id={`${uid}-h`}>{source.label}</h2>
      <p className="muted">
        {syncedText}
        {source.lastSyncStatus === 'private' && ' · game details were private at the last attempt'}
        {!online && <strong> · Offline — showing the last snapshot (read-only)</strong>}
      </p>
      {isSteam && (
        <div className="row wrap">
          <button
            type="button"
            className="button button-primary"
            onClick={() => void startFetch()}
            disabled={running || !online || !source.keySet}
          >
            {source.lastSyncedAt ? 'Sync again' : 'Load my Steam library'}
          </button>
          {running && (
            <button type="button" className="button" onClick={() => void cancel()}>
              Cancel
            </button>
          )}
          {source.lastSyncedAt && (
            <button
              type="button"
              className="button"
              onClick={() => void call(getApi().sources.diff({ sourceId: source.id })).then(setDiff)}
            >
              What changed?
            </button>
          )}
          {!source.keySet && <span className="warning-text">Add your Steam Web API key first.</span>}
        </div>
      )}
      <div aria-live="polite" className="job-status">
        {running && (
          <p>
            <span className="spinner" aria-hidden="true" /> {job?.phase}
          </p>
        )}
        {job?.state === 'failed' && job.error && (
          <Notice kind="warning">
            <strong>{job.error.message}</strong> {job.error.recovery}
          </Notice>
        )}
        {job?.state === 'cancelled' && <p>{job.phase}</p>}
      </div>

      <div className="library-toolbar">
        <SelectField<View>
          label="Show"
          value={view}
          onChange={(v) => (setView(v), setActive(-1))}
          options={(Object.keys(VIEW_LABELS) as View[]).map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
        />
        <TextField label="Search names" value={search} onChange={setSearch} type="search" />
        <SelectField<typeof sort>
          label="Sort by"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'name', label: 'Name' },
            ...(isSteam
              ? ([
                  { value: 'playtime', label: 'Playtime' },
                  { value: 'lastPlayed', label: 'Last played' },
                  { value: 'appid', label: 'App id' },
                ] as const)
              : []),
          ]}
        />
        <SelectField<'asc' | 'desc'>
          label="Order"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'asc', label: 'Ascending' },
            { value: 'desc', label: 'Descending' },
          ]}
        />
        {isSteam && (
          <Checkbox
            label="Show non-game items (soundtracks, tools, demos, servers)"
            checked={showNonGames}
            onChange={setShowNonGames}
          />
        )}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
      {loadError && <ErrorBox error={loadError} onRetry={() => void load()} />}
      {!page && !loadError && <Loading />}
      {page && (
        <>
          <div className="bulk-bar" role="region" aria-label="Selection">
            <span aria-live="polite">
              <strong>{selected.size}</strong> selected
              {selectedInView !== selected.size ? ` (${selectedInView} in this view)` : ''} · {page.total}{' '}
              shown
            </span>
            <button
              type="button"
              className="button button-small"
              onClick={() => setSelected(new Set(rows.map((r) => r.externalId)))}
              disabled={rows.length === 0}
            >
              Select all shown
            </button>
            {view === 'unplayed' && (
              <button
                type="button"
                className="button button-small"
                onClick={() => setSelected(new Set(rows.filter((r) => !r.itemId).map((r) => r.externalId)))}
                disabled={rows.length === 0}
              >
                Select all unplayed
              </button>
            )}
            <button
              type="button"
              className="button button-small"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
            >
              Clear selection
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => void setIgnored([...selected], view !== 'ignored')}
              disabled={selected.size === 0}
            >
              {view === 'ignored' ? 'Un-ignore selected' : 'Ignore selected'}
            </button>
            <button
              type="button"
              className="button button-small button-primary"
              onClick={() => setOptions(true)}
              disabled={selected.size === 0}
            >
              Import selected…
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="muted">
              {view === 'unplayed'
                ? source.lastSyncedAt
                  ? 'No unplayed games left to review. Try “All” or “Played”.'
                  : isSteam
                    ? 'Load your Steam library to start.'
                    : 'This list is empty.'
                : 'Nothing matches.'}
            </p>
          ) : (
            <>
              <p className="field-hint" id={`${uid}-kbd`}>
                Keyboard: ↑/↓ move, Space selects, Shift+↑/↓ extends, Ctrl/⌘+A selects all shown, I ignores, O
                opens on Steam.
              </p>
              <VirtualList
                id={`${uid}-list`}
                label={`${source.label} games`}
                rows={rows}
                rowKey={(r) => r.externalId}
                rowLabel={(r) =>
                  `${r.name}. ${playtime(r.playtimeMinutes, isSteam)}${r.itemId ? '. In pile' : ''}${r.ignored ? '. Ignored' : ''}${r.isNew ? '. New' : ''}${r.nonGameReason ? `. Looks like: ${r.nonGameReason}` : ''}${r.possibleDuplicateOf ? `. Possible duplicate of ${r.possibleDuplicateOf.title}` : ''}`
                }
                selected={selected}
                onSelectedChange={setSelected}
                active={active}
                onActiveChange={setActive}
                onRowKey={(e, r) => {
                  if (e.key === 'i' || e.key === 'I') {
                    void setIgnored([r.externalId], !r.ignored);
                    return true;
                  }
                  if ((e.key === 'o' || e.key === 'O') && r.storeUrl) {
                    openOnSteam(r);
                    return true;
                  }
                  return false;
                }}
                renderRow={(r) => (
                  <span className="vrow-body">
                    <span className="cover-placeholder vrow-icon" aria-hidden="true">
                      🎮
                    </span>
                    <span className="vrow-text">
                      <span className="vrow-name">{r.name}</span>
                      <span className="muted">
                        {r.platform ?? ''}
                        {isSteam ? ` · ${playtime(r.playtimeMinutes, true)}` : ''}
                        {r.lastPlayedAt ? ` · last played ${fmtDateTime(r.lastPlayedAt).split(',')[0]}` : ''}
                      </span>
                    </span>
                    <span className="vrow-badges">
                      {r.itemId && <span className="badge badge-in-pile">✓ In pile</span>}
                      {r.ignored && <span className="badge badge-ignored">⊘ Ignored</span>}
                      {r.isNew && !r.itemId && <span className="badge badge-new">★ New</span>}
                      {r.removed && <span className="badge">Not in library anymore</span>}
                      {r.nonGameReason && <span className="badge">{r.nonGameReason}?</span>}
                      {r.possibleDuplicateOf && (
                        <span className="badge badge-warning">⚠ Possible duplicate</span>
                      )}
                    </span>
                  </span>
                )}
              />
              <div className="row wrap" role="group" aria-label="Actions for the focused game">
                <span className="muted">Focused: {activeRow ? activeRow.name : 'none'}</span>
                <button
                  type="button"
                  className="button button-small"
                  disabled={!activeRow}
                  onClick={() => activeRow && void setIgnored([activeRow.externalId], !activeRow.ignored)}
                >
                  {activeRow?.ignored ? 'Un-ignore' : 'Ignore'}
                </button>
                {isSteam && (
                  <button
                    type="button"
                    className="button button-small"
                    disabled={!activeRow?.storeUrl}
                    onClick={() => activeRow && openOnSteam(activeRow)}
                  >
                    Open on Steam
                  </button>
                )}
                {activeRow?.itemId && (
                  <a className="button button-small" href={`#/item/${activeRow.itemId}`}>
                    Open in pile
                  </a>
                )}
                {activeRow?.possibleDuplicateOf && (
                  <a className="button button-small" href={`#/item/${activeRow.possibleDuplicateOf.id}`}>
                    View possible duplicate
                  </a>
                )}
              </div>
            </>
          )}
        </>
      )}
      {options && (
        <ImportOptionsDialog
          source={source}
          count={selected.size}
          onClose={() => setOptions(false)}
          onImport={async (opts) => {
            try {
              const r = await call(
                getApi().sources.importSelected({ sourceId: source.id, externalIds: [...selected], ...opts }),
              );
              setOptions(false);
              setResult(r);
              setSelected(new Set());
              app.bumpData();
              await load();
              await refreshSources();
            } catch (e) {
              toast.error(errorOf(e));
            }
          }}
        />
      )}
      {result && <ImportResultDialog result={result} onClose={() => setResult(null)} />}
      {diff && (
        <DiffDialog sourceId={source.id} diff={diff} isSteam={isSteam} onClose={() => setDiff(null)} />
      )}
    </section>
  );
}

function ImportOptionsDialog({
  source,
  count,
  onClose,
  onImport,
}: {
  source: LibrarySourceView;
  count: number;
  onClose: () => void;
  onImport: (o: {
    status: Status;
    tags: string[];
    listId: string | null;
    importPlaytime: boolean;
    enrich: boolean;
  }) => Promise<void>;
}) {
  const lists = useAsyncLists();
  const [status, setStatus] = useState<Status>('planned');
  const [tags, setTags] = useState(source.kind === 'steam' ? 'steam' : '');
  const [listId, setListId] = useState('');
  const [importPlaytime, setImportPlaytime] = useState(false);
  const [enrich, setEnrich] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const tagList = tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const summary = `Add ${count} game(s) as ${statusLabel(status)}${tagList.length ? `, tag ${tagList.map((t) => `“${t}”`).join(', ')}` : ''}${listId ? `, in list “${lists.find((l) => l.id === listId)?.name ?? ''}”` : ''}.`;
  if (confirm)
    return (
      <ConfirmDialog
        title="Import these games?"
        message={
          <>
            <p>{summary}</p>
            <p className="muted">
              Games already in your pile are skipped. You can undo this import later (untouched items only).
            </p>
          </>
        }
        confirmLabel={busy ? 'Importing…' : 'Import'}
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setBusy(true);
          void onImport({ status, tags: tagList, listId: listId || null, importPlaytime, enrich }).finally(
            () => setBusy(false),
          );
        }}
      />
    );
  return (
    <Dialog
      title={`Import ${count} game(s)`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button-primary" onClick={() => setConfirm(true)}>
            Review…
          </button>
        </>
      }
    >
      <SelectField<Status>
        label="Status"
        value={status}
        onChange={setStatus}
        options={STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
      />
      <TextField label="Tags (comma-separated)" value={tags} onChange={setTags} />
      <SelectField<string>
        label="Add to list"
        value={listId}
        onChange={setListId}
        options={[{ value: '', label: 'No list' }, ...lists.map((l) => ({ value: l.id, label: l.name }))]}
      />
      {source.kind === 'steam' && (
        <Checkbox
          label="Import Steam playtime as progress (hours)"
          checked={importPlaytime}
          onChange={setImportPlaytime}
          hint="Only affects games with recorded playtime: sets progress tracking to hours and adds one history entry."
        />
      )}
      <Checkbox
        label="Also fetch richer metadata from my configured game provider (slower; respects rate limits)"
        checked={enrich}
        onChange={setEnrich}
        hint="Only exact title matches are used, and only empty fields are filled. At most 25 games per import."
      />
    </Dialog>
  );
}

function useAsyncLists() {
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void call(getApi().lists.list())
      .then(setLists)
      .catch(() => undefined);
  }, []);
  return lists;
}

function ImportResultDialog({ result, onClose }: { result: BatchImportResultView; onClose: () => void }) {
  const toast = useToast();
  const app = useApp();
  const [undone, setUndone] = useState<string | null>(null);
  const undo = async () => {
    if (!result.batchId) return;
    try {
      const r = await call(getApi().batches.undo({ batchId: result.batchId }));
      setUndone(
        `Removed ${r.removable.length} item(s).${r.kept.length ? ` Kept ${r.kept.length} you already changed.` : ''}`,
      );
      app.bumpData();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <Dialog
      title="Import finished"
      onClose={onClose}
      footer={
        <>
          {result.batchId && !undone && (
            <button type="button" className="button" onClick={() => void undo()}>
              Undo this import
            </button>
          )}
          <a className="button" href="#/library" onClick={onClose}>
            View in Library
          </a>
          <button type="button" className="button button-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div aria-live="polite">
        <ul className="plain-list">
          <li>
            <strong>{result.added}</strong> added
          </li>
          <li>
            <strong>{result.skippedDuplicates.length}</strong> skipped (already in your pile)
          </li>
          <li>
            <strong>{result.failed.length}</strong> not added
          </li>
        </ul>
        {result.failed.length > 0 && (
          <details>
            <summary>Why some were not added</summary>
            <ul>
              {result.failed.slice(0, 100).map((f) => (
                <li key={f.externalId}>
                  {f.title}: {f.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        {result.enrichment && (
          <p>
            Metadata found for {result.enrichment.enriched} of {result.enrichment.attempted} game(s).{' '}
            {result.enrichment.note}
          </p>
        )}
        {undone && <Notice kind="success">{undone}</Notice>}
      </div>
    </Dialog>
  );
}

function DiffDialog({
  sourceId,
  diff,
  isSteam,
  onClose,
}: {
  sourceId: string;
  diff: SourceDiffView;
  isSteam: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const app = useApp();
  const inPile = diff.playtimeChanged.filter((p) => p.itemId);
  const [update, setUpdate] = useState<Set<string>>(new Set());
  const apply = async () => {
    try {
      const r = await call(getApi().sources.applyPlaytime({ sourceId, externalIds: [...update] }));
      toast.success(`Recorded Steam playtime for ${r.updated} game(s).`);
      app.bumpData();
      onClose();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <Dialog
      title="Changes since the last sync"
      onClose={onClose}
      size="large"
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
          {inPile.length > 0 && (
            <button
              type="button"
              className="button button-primary"
              disabled={update.size === 0}
              onClick={() => void apply()}
            >
              Record playtime for {update.size} game(s)
            </button>
          )}
        </>
      }
    >
      <p>Nothing in your pile changes unless you choose it below.</p>
      <h3>New since last sync ({diff.added.length})</h3>
      {diff.added.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <p>
          {diff.added
            .slice(0, 20)
            .map((a) => a.name)
            .join(', ')}
          {diff.added.length > 20 ? '…' : ''}
        </p>
      )}
      {isSteam && (
        <>
          <h3>Playtime changed ({diff.playtimeChanged.length})</h3>
          {inPile.length === 0 ? (
            <p className="muted">No playtime changes for games in your pile.</p>
          ) : (
            <table className="table compare-table">
              <caption className="visually-hidden">Playtime changes for games in your pile</caption>
              <thead>
                <tr>
                  <th scope="col">Game</th>
                  <th scope="col">Yours (pile)</th>
                  <th scope="col">Steam</th>
                  <th scope="col">Choice</th>
                </tr>
              </thead>
              <tbody>
                {inPile.map((p) => (
                  <tr key={p.externalId}>
                    <th scope="row">{p.name}</th>
                    <td>{p.pileHours === null ? 'No hours recorded' : `${p.pileHours} h`}</td>
                    <td>{p.after === null ? '—' : `${Math.round((p.after / 60) * 10) / 10} h`}</td>
                    <td>
                      <fieldset className="radio-row">
                        <legend className="visually-hidden">Playtime for {p.name}</legend>
                        <label className="radio-pill">
                          <input
                            type="radio"
                            name={`pt-${p.externalId}`}
                            checked={!update.has(p.externalId)}
                            onChange={() =>
                              setUpdate((u) => new Set([...u].filter((x) => x !== p.externalId)))
                            }
                          />{' '}
                          Keep mine
                        </label>
                        <label className="radio-pill">
                          <input
                            type="radio"
                            name={`pt-${p.externalId}`}
                            checked={update.has(p.externalId)}
                            onChange={() => setUpdate((u) => new Set([...u, p.externalId]))}
                          />{' '}
                          Add Steam’s as a new entry
                        </label>
                      </fieldset>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <h3>No longer in the library ({diff.removed.length})</h3>
      {diff.removed.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul>
          {diff.removed.slice(0, 50).map((r) => (
            <li key={r.externalId}>
              {r.name}
              {r.itemId && (
                <>
                  {' '}
                  — <a href={`#/item/${r.itemId}`}>in your pile</a> (kept, marked “Not in Steam library
                  anymore”)
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
