/**
 * Import hub: library sources (Steam, pasted/uploaded game lists), tracker
 * imports (Goodreads, Letterboxd, custom CSV with column mapping) and import
 * history with undo.
 */
import { useEffect, useMemo, useState } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import type {
  ImportBatchView,
  LibrarySourceView,
  MappingProfileView,
  TrackerPreviewView,
  UndoPreviewView,
} from '../../../shared/types';
import {
  FIELD_LABELS_CSV,
  MAPPABLE_FIELDS,
  type CsvMapping,
  type MappableField,
} from '../../../domain/tracker-csv';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp, type ImportTab } from '../../app/context';
import { fmtDateTime, typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { EmptyState, ErrorBox, Loading } from '../../components/Bits';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { SelectField, TextArea, TextField } from '../../components/Fields';
import { ImportPreviewDialog } from '../settings/ImportPreviewDialog';
import { SourceReview } from './SourceReview';
import { SteamSetupForm } from './SteamSetup';

const TAB_LABELS: Record<ImportTab, string> = {
  sources: 'Game libraries',
  trackers: 'Other trackers',
  history: 'Import history & undo',
};

export function ImportPage({ tab }: { tab: ImportTab }) {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Import</h1>
      </div>
      <nav aria-label="Import sections" className="tabs">
        {(Object.keys(TAB_LABELS) as ImportTab[]).map((t) => (
          <a
            key={t}
            href={`#/import/${t}`}
            className={`tab ${t === tab ? 'nav-current' : ''}`}
            aria-current={t === tab ? 'page' : undefined}
          >
            {TAB_LABELS[t]}
          </a>
        ))}
      </nav>
      {tab === 'sources' && <SourcesTab />}
      {tab === 'trackers' && <TrackersTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}

function SourcesTab() {
  const q = useAsync(() => call(getApi().sources.list()), []);
  const [current, setCurrent] = useState<string | null>(null);
  const [adding, setAdding] = useState<'steam' | 'manual' | null>(null);
  const [editingSteam, setEditingSteam] = useState(false);
  const sources = useMemo(() => q.data ?? [], [q.data]);
  useEffect(() => {
    if (!current && sources[0]) setCurrent(sources[0].id);
  }, [current, sources]);
  const selected = sources.find((s) => s.id === current) ?? null;
  return (
    <>
      <p className="muted">
        Bring in games you own. Nothing is added until you select games and confirm. Store pages are never
        scraped: Steam uses the official Web API with your own key; other stores can use a pasted or uploaded
        list.
      </p>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      <div className="row wrap">
        <button type="button" className="button" onClick={() => setAdding('steam')}>
          Add Steam account
        </button>
        <button type="button" className="button" onClick={() => setAdding('manual')}>
          Paste or upload a game list
        </button>
      </div>
      {q.data && sources.length === 0 && !adding && (
        <EmptyState title="No game libraries yet">
          Connect Steam, or paste a list of titles from GOG, Xbox, PlayStation, Epic or your shelf.
        </EmptyState>
      )}
      {sources.length > 0 && (
        <div className="field field-inline">
          <label htmlFor="source-pick">Library</label>
          <select
            id="source-pick"
            className="input input-inline"
            value={current ?? ''}
            onChange={(e) => setCurrent(e.target.value)}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.kind === 'steam' ? 'Steam' : 'List'}: {s.label} ({s.counts.total})
              </option>
            ))}
          </select>
          {selected?.kind === 'steam' && (
            <button type="button" className="button button-small" onClick={() => setEditingSteam(true)}>
              Steam settings
            </button>
          )}
          {selected?.kind === 'manual' && (
            <button type="button" className="button button-small" onClick={() => setAdding('manual')}>
              Update this list
            </button>
          )}
        </div>
      )}
      {selected && (
        <p className="muted">
          {selected.attribution} {selected.rateLimitText}
        </p>
      )}
      {selected && <SourceReview key={selected.id} source={selected} onSourcesChange={(l) => q.setData(l)} />}
      {(adding === 'steam' || editingSteam) && (
        <Dialog
          title={editingSteam ? 'Steam settings' : 'Add Steam account'}
          onClose={() => (setAdding(null), setEditingSteam(false))}
          size="large"
        >
          <SteamSetupForm
            source={editingSteam ? selected : null}
            onSaved={(l) => {
              q.setData(l);
              if (!editingSteam) setCurrent(l.filter((s) => s.kind === 'steam').at(-1)?.id ?? null);
            }}
          />
        </Dialog>
      )}
      {adding === 'manual' && (
        <ManualListDialog
          source={selected?.kind === 'manual' ? selected : null}
          onClose={() => setAdding(null)}
          onSaved={(l) => {
            q.setData(l);
            setAdding(null);
            setCurrent(
              (selected?.kind === 'manual' ? selected.id : l.filter((s) => s.kind === 'manual').at(-1)?.id) ??
                null,
            );
          }}
        />
      )}
    </>
  );
}

function ManualListDialog({
  source,
  onClose,
  onSaved,
}: {
  source: LibrarySourceView | null;
  onClose: () => void;
  onSaved: (l: LibrarySourceView[]) => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(source?.label ?? 'My game list');
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = async () => {
    try {
      onSaved(await call(getApi().sources.loadManual({ sourceId: source?.id ?? null, label, text })));
      toast.success('List loaded. Review it below.');
    } catch (e) {
      const err = errorOf(e);
      setErrors(err.fieldErrors ?? { text: err.message });
    }
  };
  const fromFile = async () => {
    try {
      const l = await call(getApi().sources.loadManualFile({ sourceId: source?.id ?? null, label }));
      if (l) {
        onSaved(l);
        toast.success('List loaded. Review it below.');
      }
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <Dialog
      title={source ? `Update “${source.label}”` : 'Paste or upload a game list'}
      onClose={onClose}
      size="large"
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button" onClick={() => void fromFile()}>
            Choose a file…
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void save()}
            disabled={!text.trim()}
          >
            Use pasted list
          </button>
        </>
      }
    >
      <TextField
        label="Label"
        value={label}
        onChange={setLabel}
        error={errors['label']}
        hint="For example “GOG library” or “PS5 shelf”."
      />
      <TextArea
        label="Titles"
        value={text}
        onChange={setText}
        error={errors['text']}
        hint="One title per line, or a CSV/TSV with a header row containing “title” and optionally “platform”. Nothing is looked up online."
      />
    </Dialog>
  );
}

/* ------------------------------------------------------------------ tracker imports */

function TrackersTab() {
  const app = useApp();
  const toast = useToast();
  const profiles = useAsync(() => call(getApi().tracker.profiles()), []);
  const [profileId, setProfileId] = useState('');
  const [preview, setPreview] = useState<TrackerPreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async (kind: 'goodreads' | 'letterboxd' | 'csv' | 'mal') => {
    setBusy(true);
    try {
      const p = await call(
        getApi().tracker.preview({ kind, profileId: kind === 'csv' && profileId ? profileId : null }),
      );
      if (p) setPreview(p);
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="muted">
        Import files you exported yourself. Maybe Pile never signs in to other sites, never fetches links
        found in files, and shows a full preview before anything changes. Imports can be undone (items you
        haven’t touched).
      </p>
      <div className="stats-grid">
        <section className="card">
          <h2>Goodreads</h2>
          <p>
            On Goodreads: <strong>My Books → Import and export → Export Library</strong>. Choose the
            downloaded CSV. Shelves become statuses (read → Completed, currently-reading → In Progress,
            to-read → Planned) and other shelves become tags.
          </p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void start('goodreads')}
            disabled={busy}
          >
            Choose Goodreads CSV…
          </button>
        </section>
        <section className="card">
          <h2>Letterboxd</h2>
          <p>
            On Letterboxd: <strong>Settings → Data → Export your data</strong>. Choose the .zip (or one of its
            CSVs). Watchlist → Planned, watched → Completed, diary dates → viewings, ratings → ratings.
          </p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void start('letterboxd')}
            disabled={busy}
          >
            Choose Letterboxd export…
          </button>
        </section>
        <section className="card">
          <h2>MyAnimeList</h2>
          <p>
            On MyAnimeList: <strong>Profile → Export lists → Export My Anime List</strong>. Choose the
            downloaded .xml.gz (or the .xml inside). Statuses, scores, watched episodes, dates, tags and
            rewatch counts come across; manga entries are skipped (track manga as Books). Imports can be
            undone from History.
          </p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void start('mal')}
            disabled={busy}
          >
            Choose MyAnimeList export…
          </button>
        </section>
        <section className="card">
          <h2>Custom CSV</h2>
          <p>
            Any CSV/TSV: map its columns to Maybe Pile fields with a live preview, and save the mapping for
            next time.
          </p>
          {(profiles.data ?? []).length > 0 && (
            <SelectField<string>
              label="Start from a saved mapping"
              value={profileId}
              onChange={setProfileId}
              options={[
                { value: '', label: 'Guess from the header' },
                ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          )}
          <button
            type="button"
            className="button button-primary"
            onClick={() => void start('csv')}
            disabled={busy}
          >
            Choose CSV file…
          </button>
        </section>
      </div>
      {preview && (
        <ImportPreviewDialog
          preview={preview}
          title={`Import from ${preview.tracker === 'csv' ? 'CSV' : preview.tracker === 'goodreads' ? 'Goodreads' : 'Letterboxd'} — review`}
          onClose={() => setPreview(null)}
          apply={(input) => call(getApi().tracker.apply(input))}
          onApplied={(r) => {
            setPreview(null);
            app.bumpData();
            toast.success(
              `Imported ${r.added + r.duplicated} item(s), skipped ${r.skipped}. ${r.batchId ? 'You can undo this under Import history.' : ''}`,
            );
          }}
        >
          {preview.tracker === 'csv' && (
            <ColumnMapper
              preview={preview}
              profiles={profiles.data ?? []}
              onRemapped={setPreview}
              onProfilesChange={(p) => profiles.setData(p)}
            />
          )}
        </ImportPreviewDialog>
      )}
    </>
  );
}

function ColumnMapper({
  preview,
  profiles,
  onRemapped,
  onProfilesChange,
}: {
  preview: TrackerPreviewView;
  profiles: MappingProfileView[];
  onRemapped: (p: TrackerPreviewView) => void;
  onProfilesChange: (p: MappingProfileView[]) => void;
}) {
  const toast = useToast();
  const mapping = preview.mapping as CsvMapping;
  const [profileName, setProfileName] = useState('');
  const remap = async (next: CsvMapping) => {
    if (!preview.mapToken) return;
    try {
      onRemapped(
        await call(
          getApi().tracker.remap({ mapToken: preview.mapToken, previousToken: preview.token, mapping: next }),
        ),
      );
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const setCol = (f: MappableField, col: string) =>
    void remap({ ...mapping, columns: { ...mapping.columns, [f]: col || null } });
  const colOptions = [
    { value: '', label: '— not imported —' },
    ...preview.header.map((h) => ({ value: h, label: h || '(blank header)' })),
  ];
  return (
    <section aria-label="Column mapping" className="mapper">
      <h3>Map columns</h3>
      <p className="muted">
        Detected separator: {preview.delimiter === '\t' ? 'tab' : `“${preview.delimiter}”`}. The preview below
        updates as you change the mapping.
      </p>
      <div className="form-grid">
        {MAPPABLE_FIELDS.map((f) => (
          <SelectField<string>
            key={f}
            label={FIELD_LABELS_CSV[f]}
            value={mapping.columns[f] ?? ''}
            onChange={(v) => setCol(f, v)}
            options={colOptions}
          />
        ))}
        <SelectField<MediaType>
          label="Type when not in the file"
          value={mapping.defaultType}
          onChange={(v) => void remap({ ...mapping, defaultType: v })}
          options={MEDIA_TYPES.map((t) => ({ value: t, label: typeLabelPlural(t) }))}
        />
        <SelectField<CsvMapping['ratingScale']>
          label="Rating scale in the file"
          value={mapping.ratingScale}
          onChange={(v) => void remap({ ...mapping, ratingScale: v })}
          options={[
            { value: 'stars5', label: '0–5 stars (whole)' },
            { value: 'stars5half', label: '0.5–5 stars (halves)' },
            { value: 'ten', label: '1–10' },
            { value: 'hundred', label: '1–100' },
          ]}
        />
        <SelectField<CsvMapping['dateOrder']>
          label="Date format"
          value={mapping.dateOrder}
          onChange={(v) => void remap({ ...mapping, dateOrder: v })}
          options={[
            { value: 'ymd', label: 'Year-month-day (2026-03-15)' },
            { value: 'mdy', label: 'Month/day/year (03/15/2026)' },
            { value: 'dmy', label: 'Day/month/year (15/03/2026)' },
          ]}
        />
        <SelectField<CsvMapping['tagSeparator']>
          label="Tag separator inside a cell"
          value={mapping.tagSeparator}
          onChange={(v) => void remap({ ...mapping, tagSeparator: v })}
          options={[
            { value: ';', label: 'Semicolon ;' },
            { value: ',', label: 'Comma ,' },
            { value: '|', label: 'Pipe |' },
          ]}
        />
      </div>
      {preview.sample.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <caption>First rows of the file (as text — nothing in it is run or opened)</caption>
            <thead>
              <tr>
                {preview.header.map((h, i) => (
                  <th scope="col" key={i}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((r, i) => (
                <tr key={i}>
                  {preview.header.map((_, j) => (
                    <td key={j}>{(r[j] ?? '').slice(0, 80)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row wrap">
        <TextField label="Save this mapping as" value={profileName} onChange={setProfileName} />
        <button
          type="button"
          className="button button-small"
          disabled={!profileName.trim()}
          onClick={() =>
            void call(getApi().tracker.saveProfile({ name: profileName, mapping }))
              .then((p) => (onProfilesChange(p), toast.success(`Saved mapping “${profileName}”.`)))
              .catch((e: unknown) => toast.error(errorOf(e)))
          }
        >
          Save mapping
        </button>
        {profiles.length > 0 && <span className="muted">{profiles.length} saved mapping(s).</span>}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ history & undo */

const KIND_LABEL: Record<ImportBatchView['kind'], string> = {
  steam: 'Steam',
  'manual-list': 'Game list',
  goodreads: 'Goodreads',
  letterboxd: 'Letterboxd',
  'csv-mapped': 'CSV',
  'mal-xml': 'MyAnimeList',
};

function HistoryTab() {
  const app = useApp();
  const toast = useToast();
  const q = useAsync(() => call(getApi().batches.list()), [app.dataVersion]);
  const [preview, setPreview] = useState<UndoPreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const retention = app.settings?.importUndoRetentionDays ?? 30;
  return (
    <>
      <p className="muted">
        Imports can be undone for {retention} days. Undo removes only items you haven’t changed since the
        import; anything you edited, rated, tracked or moved is kept.
      </p>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && (
        <EmptyState title="No imports yet">Steam, game-list and tracker imports appear here.</EmptyState>
      )}
      {q.data && q.data.length > 0 && (
        <table className="table">
          <caption className="visually-hidden">Import history</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Source</th>
              <th scope="col">What</th>
              <th scope="col">Items</th>
              <th scope="col">Undo</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((b) => (
              <tr key={b.id}>
                <td>{fmtDateTime(b.createdAt)}</td>
                <td>{KIND_LABEL[b.kind]}</td>
                <td>{b.label}</td>
                <td>{b.itemCount}</td>
                <td>
                  {b.undoneAt ? (
                    <span className="muted">Undone {fmtDateTime(b.undoneAt)}</span>
                  ) : (
                    <button
                      type="button"
                      className="button button-small"
                      disabled={!b.canUndo}
                      onClick={() =>
                        void call(getApi().batches.undoPreview({ batchId: b.id }))
                          .then(setPreview)
                          .catch((e: unknown) => toast.error(errorOf(e)))
                      }
                      aria-label={`Undo… ${b.label}`}
                    >
                      Undo…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview && (
        <ConfirmDialog
          title="Undo this import?"
          busy={busy}
          message={
            <>
              <p>
                <strong>{preview.removable.length}</strong> untouched item(s) will be removed.
                {preview.alreadyGone > 0 && ` ${preview.alreadyGone} were already deleted.`}
              </p>
              {preview.kept.length > 0 && (
                <>
                  <p>
                    <strong>{preview.kept.length}</strong> item(s) will be kept because you changed them:
                  </p>
                  <ul>
                    {preview.kept.slice(0, 30).map((k) => (
                      <li key={k.itemId}>
                        {k.title} — {k.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          }
          confirmLabel={`Remove ${preview.removable.length} item(s)`}
          destructive
          onCancel={() => setPreview(null)}
          onConfirm={() => {
            setBusy(true);
            void call(getApi().batches.undo({ batchId: preview.batchId }))
              .then((r) => {
                toast.success(`Removed ${r.removable.length} item(s). Kept ${r.kept.length}.`);
                setPreview(null);
                app.bumpData();
              })
              .catch((e: unknown) => toast.error(errorOf(e)))
              .finally(() => setBusy(false));
          }}
        />
      )}
    </>
  );
}
