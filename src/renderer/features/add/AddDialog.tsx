/**
 * Add / Import: one dialog with two paths.
 * - Search online: pick type + provider → search → select a result explicitly →
 *   preview exactly what will be saved → import.
 * - Enter manually: type-aware form.
 * Both paths check for likely duplicates and let the user open the existing
 * item, add anyway, or cancel.
 */
import { useId, useState, type FormEvent } from 'react';
import { MEDIA_TYPES, type MediaType, type Status } from '../../../shared/enums';
import type { DuplicateMatch, ImportPreview, SearchHitView } from '../../../shared/types';
import type { UserSafeError } from '../../../shared/result';
import { defaultPersonal, emptyMeta, releaseDateLabel } from '../../../domain/metadata';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtPartialDate, todayLocal, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Dialog } from '../../components/Dialog';
import { Cover, ErrorBox, Loading, Notice, STATUS_OPTIONS } from '../../components/Bits';
import { ListInput, SelectField } from '../../components/Fields';
import { ItemForm, toSeasonInputs, type ItemFormValue } from '../item/ItemForm';
import { ExternalLink } from '../item/LinksPanel';

type Tab = 'search' | 'manual';

export function AddDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('search');
  const tabsId = useId();
  return (
    <Dialog title="Add an item" onClose={onClose} size="large">
      <div role="tablist" aria-label="How to add" className="tabs">
        {(['search', 'manual'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${tabsId}-${t}`}
            aria-selected={tab === t}
            aria-controls={`${tabsId}-${t}-panel`}
            tabIndex={tab === t ? 0 : -1}
            className="tab"
            onClick={() => setTab(t)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                const next = t === 'search' ? 'manual' : 'search';
                setTab(next);
                document.getElementById(`${tabsId}-${next}`)?.focus();
              }
            }}
          >
            {t === 'search' ? 'Search online' : 'Enter manually'}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
        {tab === 'search' ? (
          <SearchTab onDone={onClose} onManual={() => setTab('manual')} />
        ) : (
          <ManualTab onDone={onClose} />
        )}
      </div>
    </Dialog>
  );
}

function DuplicateChoice({
  matches,
  onAddAnyway,
  onCancel,
  onOpen,
}: {
  matches: DuplicateMatch[];
  onAddAnyway: () => void;
  onCancel: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="notice notice-warning" role="alert">
      <div className="notice-content">
        <p className="notice-title">This looks like something already in your library:</p>
        <ul>
          {matches.map((m) => (
            <li key={m.id}>
              {m.title}
              {m.year ? ` (${m.year})` : ''} —{' '}
              {m.reason === 'provider-id' ? 'same online ID' : 'same title, year and type'}{' '}
              <button type="button" className="button button-tiny" onClick={() => onOpen(m.id)}>
                Open existing
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <button type="button" className="button" onClick={onAddAnyway}>
            Add anyway
          </button>
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ search */

function SearchTab({ onDone, onManual }: { onDone: () => void; onManual: () => void }) {
  const app = useApp();
  const toast = useToast();
  const id = useId();
  const providers = useAsync(() => call(getApi().providers.list()), []);
  const [type, setType] = useState<MediaType>('movie');
  const usable = (providers.data ?? []).filter((p) => p.supports.includes(type) && p.enabled);
  const [providerId, setProviderId] = useState<string>('');
  const chosen = usable.find((p) => p.id === providerId) ?? usable.find((p) => p.configured) ?? usable[0];
  const [query, setQuery] = useState('');
  const [year, setYear] = useState('');
  const [hits, setHits] = useState<SearchHitView[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<UserSafeError | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [status, setStatus] = useState<Status>('planned');
  const [tags, setTags] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [dupes, setDupes] = useState<DuplicateMatch[] | null>(null);

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!chosen || !query.trim()) return;
    setSearching(true);
    setError(null);
    setHits(null);
    try {
      const y = /^\d{4}$/.test(year) ? Number(year) : null;
      setHits(
        await call(getApi().providers.search({ providerId: chosen.id, type, query: query.trim(), year: y })),
      );
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setSearching(false);
    }
  };

  const select = async (h: SearchHitView) => {
    setPreviewing(true);
    setError(null);
    try {
      const p = await call(getApi().providers.preview(h.ref));
      setPreview(p);
      setDupes(p.duplicates.length > 0 ? p.duplicates : null);
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setPreviewing(false);
    }
  };

  const doImport = async (allowDuplicate: boolean) => {
    if (!preview) return;
    setImporting(true);
    try {
      const r = await call(
        getApi().providers.importPreviewed({ previewToken: preview.token, status, tags, allowDuplicate }),
      );
      if (r.kind === 'duplicates') {
        setDupes(r.matches);
        return;
      }
      for (const w of r.warnings) toast.show({ kind: 'info', message: w });
      toast.success(`Added “${r.item.meta.title}”.`);
      app.bumpData();
      onDone();
      app.navigate({ name: 'item', id: r.item.id });
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setImporting(false);
    }
  };

  if (preview) {
    const m = preview.meta;
    return (
      <div className="import-preview">
        <button
          type="button"
          className="button button-small"
          onClick={() => (setPreview(null), setDupes(null))}
        >
          ← Back to results
        </button>
        <h3>Import preview</h3>
        <p className="muted">This is exactly what will be saved. You can edit anything afterwards.</p>
        <div className="preview-grid">
          <Cover url={preview.artworkPreviewUrl} title={m.title} type={type} size="large" />
          <dl className="details-list">
            <div>
              <dt>Title</dt>
              <dd>{m.title}</dd>
            </div>
            {m.altTitles.length > 0 && (
              <div>
                <dt>Alternate titles</dt>
                <dd>{m.altTitles.join(', ')}</dd>
              </div>
            )}
            <div>
              <dt>{releaseDateLabel(type)}</dt>
              <dd>{fmtPartialDate(m.releaseDate)}</dd>
            </div>
            {m.creators.length > 0 && (
              <div>
                <dt>Creators</dt>
                <dd>{m.creators.map((c) => c.name).join(', ')}</dd>
              </div>
            )}
            {m.genres.length > 0 && (
              <div>
                <dt>Genres</dt>
                <dd>{m.genres.join(', ')}</dd>
              </div>
            )}
            {m.pageCount !== null && (
              <div>
                <dt>Pages</dt>
                <dd>{m.pageCount}</dd>
              </div>
            )}
            {m.runtimeMinutes !== null && (
              <div>
                <dt>Runtime</dt>
                <dd>{m.runtimeMinutes} min</dd>
              </div>
            )}
            {preview.seasons.length > 0 && (
              <div>
                <dt>Seasons</dt>
                <dd>
                  {preview.seasons.length} season(s),{' '}
                  {preview.seasons.reduce((n, s) => n + s.episodeCount, 0)} episode(s)
                </dd>
              </div>
            )}
            {m.description && (
              <div>
                <dt>Description</dt>
                <dd className="notes">
                  {m.description.length > 600 ? `${m.description.slice(0, 600)}…` : m.description}
                </dd>
              </div>
            )}
            <div>
              <dt>Artwork</dt>
              <dd>
                {preview.hasArtwork
                  ? preview.artworkPolicy === 'cache-allowed'
                    ? 'Will be saved for offline use'
                    : 'Shown from the web when online (not stored, per provider terms)'
                  : 'None'}
              </dd>
            </div>
          </dl>
        </div>
        {preview.links.length > 0 && (
          <p>
            Links:{' '}
            {preview.links.map((l) => (
              <span key={l.kind} className="link-gap">
                <ExternalLink link={l} />
              </span>
            ))}
          </p>
        )}
        {preview.warnings.map((w) => (
          <Notice key={w}>{w}</Notice>
        ))}
        <p className="attribution">
          Source: {preview.providerName}. {preview.attribution}
        </p>
        <div className="form-grid">
          <SelectField label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        </div>
        <ListInput label="Tags" values={tags} onChange={setTags} />
        {error && <ErrorBox error={error} />}
        {dupes ? (
          <DuplicateChoice
            matches={dupes}
            onAddAnyway={() => void doImport(true)}
            onCancel={() => (setPreview(null), setDupes(null))}
            onOpen={(i) => (onDone(), app.navigate({ name: 'item', id: i }))}
          />
        ) : (
          <div className="form-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={importing}
              onClick={() => void doImport(false)}
            >
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <form onSubmit={(e) => void search(e)} aria-label="Search online sources">
        <fieldset className="segmented">
          <legend>Type</legend>
          {MEDIA_TYPES.map((t) => (
            <label key={t} className="radio-pill">
              <input
                type="radio"
                name={`${id}-type`}
                checked={type === t}
                onChange={() => (setType(t), setHits(null), setProviderId(''))}
              />
              <span>{typeLabel(t)}</span>
            </label>
          ))}
        </fieldset>
        {providers.loading && <Loading />}
        {usable.length === 0 && !providers.loading && (
          <Notice kind="warning">
            No online source is enabled for this type. Turn one on in Settings → Providers, or{' '}
            <button type="button" className="link-button" onClick={onManual}>
              enter it manually
            </button>
            .
          </Notice>
        )}
        {usable.length > 0 && (
          <div className="form-grid">
            <SelectField
              label="Source"
              value={chosen?.id ?? ''}
              onChange={setProviderId}
              options={usable.map((p) => ({
                value: p.id,
                label: `${p.displayName}${p.configured ? '' : ' (needs API key)'}`,
              }))}
            />
            <div className="field">
              <label htmlFor={`${id}-q`}>Title</label>
              <input
                id={`${id}-q`}
                className="input"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-y`}>Year (optional)</label>
              <input
                id={`${id}-y`}
                className="input"
                inputMode="numeric"
                pattern="\d{4}"
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />
            </div>
          </div>
        )}
        {chosen && !chosen.configured && (
          <Notice kind="warning">
            {chosen.displayName} needs an API key.{' '}
            <a href="#/settings/providers" onClick={onDone}>
              Add it in Settings → Providers
            </a>
            , choose another source, or{' '}
            <button type="button" className="link-button" onClick={onManual}>
              enter details manually
            </button>
            .
          </Notice>
        )}
        <div className="form-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={!chosen || !chosen.configured || !query.trim() || searching}
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>
      <div aria-live="polite" aria-busy={searching || previewing}>
        {error && <ErrorBox error={error} onRetry={() => void search()} />}
        {previewing && <Loading label="Loading details…" />}
        {hits && hits.length === 0 && (
          <p>
            No matches. Try a different spelling, remove the year, or{' '}
            <button type="button" className="link-button" onClick={onManual}>
              enter it manually
            </button>
            .
          </p>
        )}
        {hits && hits.length > 0 && (
          <>
            <p className="muted">
              {hits.length} result(s) from {chosen?.displayName}. Select one to preview it before importing.
            </p>
            <ul className="search-results">
              {hits.map((h) => (
                <li key={`${h.providerId}-${h.ref.id}`}>
                  <button
                    type="button"
                    className="search-hit"
                    onClick={() => void select(h)}
                    disabled={previewing}
                  >
                    <Cover url={h.thumbUrl} title={h.title} type={h.type} size="small" />
                    <span className="search-hit-text">
                      <span className="item-title">
                        {h.title}
                        {h.year ? ` (${h.year})` : ''}
                      </span>
                      <span className="muted">
                        {typeLabel(h.type)}
                        {h.creators.length > 0 ? ` · ${h.creators.join(', ')}` : ''} · {chosen?.displayName}
                      </span>
                      {h.synopsis && <span className="synopsis">{h.synopsis}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {chosen && <p className="attribution">{chosen.attribution.text}</p>}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ manual */

function ManualTab({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<UserSafeError | null>(null);
  const [dupes, setDupes] = useState<{ matches: DuplicateMatch[]; value: ItemFormValue } | null>(null);
  const initial: ItemFormValue = {
    type: 'movie',
    meta: emptyMeta(),
    personal: defaultPersonal('movie', todayLocal()),
    seasons: [],
    milestones: [],
  };

  const submit = async (v: ItemFormValue, allowDuplicate: boolean) => {
    setBusy(true);
    setServerError(null);
    try {
      const r = await call(
        getApi().items.create({
          type: v.type,
          meta: v.meta,
          personal: v.personal,
          seasons: toSeasonInputs(v.seasons),
          milestones: v.milestones,
          allowDuplicate,
        }),
      );
      if (r.kind === 'duplicates') {
        setDupes({ matches: r.matches, value: v });
        return;
      }
      toast.success(`Added “${r.item.meta.title}”.`);
      app.bumpData();
      onDone();
      app.navigate({ name: 'item', id: r.item.id });
    } catch (e) {
      setServerError(errorOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {dupes && (
        <DuplicateChoice
          matches={dupes.matches}
          onAddAnyway={() => {
            const v = dupes.value;
            setDupes(null);
            void submit(v, true);
          }}
          onCancel={() => setDupes(null)}
          onOpen={(i) => (onDone(), app.navigate({ name: 'item', id: i }))}
        />
      )}
      <ItemForm
        mode="create"
        initial={initial}
        submitLabel="Add to library"
        busy={busy}
        serverError={serverError}
        onSubmit={(v) => void submit(v, false)}
        onCancel={onDone}
      />
    </>
  );
}
