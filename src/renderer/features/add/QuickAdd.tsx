/**
 * Two-step Add (§13.3): (1) type a title, optionally pick a type chip →
 * (2) choose a search result or "Add without searching" → added as Planned.
 * Offline / source unavailable → "Add now, look up details later" (§16.6):
 * nothing typed is ever lost.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import type { DuplicateMatch, SearchHitView } from '../../../shared/types';
import type { UserSafeError } from '../../../shared/result';
import { defaultPersonal, emptyMeta } from '../../../domain/metadata';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { todayLocal, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { Cover, ErrorBox } from '../../components/Bits';

const OFFLINE_CODES = new Set<string>([
  'PROVIDER_NETWORK',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RATE_LIMITED',
]);

export function QuickAdd({ onDone, initialTitle = '' }: { onDone: () => void; initialTitle?: string }) {
  const app = useApp();
  const toast = useToast();
  const chipName = useId();
  const providers = useAsync(() => call(getApi().providers.list()), []);
  const hidden = new Set(app.settings?.interface.hiddenTypes ?? []);
  const types = MEDIA_TYPES.filter((t) => !hidden.has(t));
  const [title, setTitle] = useState(initialTitle);
  const [type, setType] = useState<MediaType>(types[0] ?? 'movie');
  const [step, setStep] = useState<1 | 2>(1);
  const [hits, setHits] = useState<SearchHitView[] | null>(null);
  const [error, setError] = useState<UserSafeError | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [dupes, setDupes] = useState<DuplicateMatch[] | null>(null);
  useEffect(() => setTitle(initialTitle), [initialTitle]);
  const provider = (providers.data ?? []).find(
    (p) => p.kind === 'metadata' && p.supports.includes(type) && p.enabled && p.configured,
  );

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!title.trim()) return;
    setStep(2);
    setHits(null);
    setError(null);
    setOffline(false);
    if (!provider) {
      setHits([]);
      return;
    }
    setBusy(true);
    try {
      setHits(
        await call(
          getApi().providers.search({ providerId: provider.id, type, query: title.trim(), year: null }),
        ),
      );
    } catch (err) {
      const safe = errorOf(err);
      setError(safe);
      setOffline(
        OFFLINE_CODES.has(safe.code) || (typeof navigator !== 'undefined' && navigator.onLine === false),
      );
    } finally {
      setBusy(false);
    }
  };

  const finish = (msg: string, id?: string) => {
    app.bumpData();
    toast.success(msg);
    onDone();
    if (id) app.navigate({ name: 'item', id });
  };

  const pick = async (h: SearchHitView, allowDuplicate = false) => {
    setBusy(true);
    try {
      const p = await call(getApi().providers.preview(h.ref));
      if (p.duplicates.length > 0 && !allowDuplicate) {
        setDupes(p.duplicates);
        setBusy(false);
        return;
      }
      const r = await call(
        getApi().providers.importPreviewed({
          previewToken: p.token,
          status: 'planned',
          tags: [],
          allowDuplicate: true,
        }),
      );
      if (r.kind === 'created') finish(`Added ${r.item.meta.title} as Planned.`, r.item.id);
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  const addPlain = async () => {
    setBusy(true);
    try {
      const r = await call(
        getApi().items.create({
          type,
          meta: emptyMeta(title.trim()),
          personal: defaultPersonal(type, todayLocal()),
          seasons: [],
          milestones: [],
          allowDuplicate: true,
        }),
      );
      if (r.kind === 'created') finish(`Added ${r.item.meta.title} as Planned.`, r.item.id);
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  const addLater = async () => {
    setBusy(true);
    try {
      const r = await call(getApi().queue.add({ title: title.trim(), type, year: null }));
      finish('Added. Details will be looked up when you are back online.', r.itemId);
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (step === 1)
    return (
      <form onSubmit={(e) => void search(e)} className="quick-add">
        <div className="field">
          <label htmlFor="quick-add-title">What do you want to add?</label>
          <input
            id="quick-add-title"
            className="input"
            value={title}
            maxLength={500}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
          />
        </div>
        <fieldset className="field">
          <legend>Type</legend>
          <div className="chip-row">
            {types.map((t) => (
              <label key={t} className={`chip-choice ${t === type ? 'chip-on' : ''}`}>
                <input type="radio" name={chipName} checked={t === type} onChange={() => setType(t)} />{' '}
                {typeLabel(t)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="button-row">
          <button type="submit" className="button button-primary" disabled={!title.trim()}>
            {provider ? 'Search' : 'Next'}
          </button>
        </div>
      </form>
    );

  return (
    <div className="quick-add">
      <p>
        Results for <strong>{title}</strong> ({typeLabel(type)}){' '}
        <button type="button" className="button button-small" onClick={() => setStep(1)}>
          Change
        </button>
      </p>
      {busy && !hits && <p role="status">Searching…</p>}
      {error && !offline && <ErrorBox error={error} />}
      {offline && (
        <div className="notice notice-info" role="status">
          <p className="notice-content">
            You seem to be offline (or the online source is unavailable). Nothing you typed is lost.
          </p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void addLater()}
            disabled={busy}
          >
            Add now, look up details later
          </button>
        </div>
      )}
      {!provider && (
        <p className="muted">
          Online search for {typeLabel(type)} is not set up (Settings → Data sources). You can still add it.
        </p>
      )}
      {dupes && (
        <div className="notice notice-warning" role="alert">
          <p className="notice-content">
            This looks like something already in your library: {dupes.map((d) => d.title).join(', ')}.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                const first = dupes[0];
                onDone();
                if (first) app.navigate({ name: 'item', id: first.id });
              }}
            >
              Open existing
            </button>
            <button type="button" className="button button-small" onClick={() => setDupes(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {hits && hits.length > 0 && (
        <ul className="search-results" aria-label="Search results">
          {hits.slice(0, 12).map((h) => (
            <li key={`${h.providerId}-${h.ref.id}`}>
              <button type="button" className="search-hit" onClick={() => void pick(h)} disabled={busy}>
                <Cover url={h.thumbUrl} title={h.title} type={h.type} size="small" />
                <span>
                  <strong>{h.title}</strong>
                  {h.year ? ` (${h.year})` : ''}
                  {h.creators.length > 0 && (
                    <span className="muted"> · {h.creators.slice(0, 2).join(', ')}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hits && hits.length === 0 && provider && <p className="muted">No results.</p>}
      <div className="button-row">
        <button type="button" className="button" onClick={() => void addPlain()} disabled={busy}>
          Add without searching
        </button>
      </div>
    </div>
  );
}
