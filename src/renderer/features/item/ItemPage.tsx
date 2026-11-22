import { useState } from 'react';
import type { Status } from '../../../shared/enums';
import type { ItemDetail, MutationOutcome, StatusSuggestion } from '../../../shared/types';
import type { MetadataField } from '../../../shared/schemas';
import { ApiError, call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { S, fmtDateTime, fmtPartialDate, statusLabel, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { FIELDS_BY_TYPE, FIELD_LABELS, displayValue, releaseDateLabel } from '../../../domain/metadata';
import { planStatusChange } from '../../../domain/status-rules';
import {
  Cover,
  ErrorBox,
  Loading,
  ProgressBar,
  RATING_OPTIONS,
  STATUS_OPTIONS,
  StatusBadge,
  TypeBadge,
} from '../../components/Bits';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Checkbox } from '../../components/Fields';
import { IconRefresh } from '../../components/Icons';
import { ItemForm, type ItemFormValue } from './ItemForm';
import { ProgressPanel } from './ProgressPanels';
import { HistoryPanel } from './HistoryPanel';
import { RefreshDialog } from './RefreshDialog';
import { LinksPanel } from './LinksPanel';
import { SeriesPanel } from './SeriesPanel';

export function ItemPage({ id }: { id: string }) {
  const app = useApp();
  const toast = useToast();
  const q = useAsync(() => call(getApi().items.get({ id })), [id, app.dataVersion]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<ReturnType<typeof errorOf> | null>(null);
  const [suggestions, setSuggestions] = useState<StatusSuggestion[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusDialog, setStatusDialog] = useState<{
    to: Status;
    confirmations: string[];
    offerFill: boolean;
  } | null>(null);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const readOnly = app.info?.readOnly ?? false;

  if (q.loading && !q.data) return <Loading />;
  if (q.error) {
    return (
      <div className="page">
        <ErrorBox error={q.error} onRetry={q.reload} />
        <a href="#/library">Back to library</a>
      </div>
    );
  }
  const item = q.data;
  if (!item) return null;

  /** Applies a mutation outcome from main: new item state, plus any status suggestions to show. */
  const applyOutcome = (o: MutationOutcome) => {
    q.setData(o.item);
    setSuggestions(o.suggestions);
    setHistoryTick((t) => t + 1);
    for (const a of o.applied) toast.success(`Status changed to ${statusLabel(a.status)} automatically.`);
    app.bumpData();
  };
  const run = async (fn: () => Promise<MutationOutcome | ItemDetail>, ok?: string) => {
    try {
      const r = await fn();
      if ('item' in r && 'suggestions' in r) applyOutcome(r);
      else {
        q.setData(r);
        app.bumpData();
      }
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };

  const startStatusChange = (to: Status) => {
    const plan = planStatusChange(
      {
        type: item.type,
        status: item.personal.status,
        dateStarted: item.personal.dateStarted,
        dateCompleted: item.personal.dateCompleted,
        pass: item.pass,
      },
      { status: to, startNewPass: false, clearDateCompleted: false },
      '',
    );
    if (!plan.changed) return;
    const offerFill = plan.offerFillRemaining && !item.progress.isComplete;
    if (plan.confirmations.length > 0 || offerFill)
      setStatusDialog({ to, confirmations: plan.confirmations, offerFill });
    else
      void run(
        () =>
          call(
            getApi().items.setStatus({
              id: item.id,
              status: to,
              startNewPass: false,
              clearDateCompleted: false,
              fillRemaining: false,
            }),
          ),
        `Status: ${statusLabel(to)}`,
      );
  };

  const save = async (v: ItemFormValue) => {
    setBusy(true);
    setServerError(null);
    try {
      const updated = await call(getApi().items.update({ id: item.id, meta: v.meta, personal: v.personal }));
      q.setData(updated);
      setEditing(false);
      app.bumpData();
      toast.success('Saved.');
    } catch (e) {
      setServerError(e instanceof ApiError ? e.safe : errorOf(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    try {
      await call(getApi().items.remove({ ids: [item.id] }));
      app.bumpData();
      app.navigate({ name: 'library' });
      toast.show({
        kind: 'success',
        message: `Deleted “${item.meta.title}”.`,
        action: {
          label: 'Undo',
          run: () =>
            void call(getApi().items.undoRemove({ ids: [item.id] })).then(
              () => (app.bumpData(), app.navigate({ name: 'item', id: item.id })),
            ),
        },
      });
    } catch (e) {
      toast.error(errorOf(e));
    }
  };

  if (editing) {
    return (
      <div className="page">
        <h1>Edit “{item.meta.title}”</h1>
        <ItemForm
          mode="edit"
          initial={{ type: item.type, meta: item.meta, personal: item.personal, seasons: [], milestones: [] }}
          submitLabel="Save changes"
          busy={busy}
          serverError={serverError}
          onSubmit={(v) => void save(v)}
          onCancel={() => (setEditing(false), setServerError(null))}
        />
      </div>
    );
  }

  const hasSource = item.sources.length > 0;
  return (
    <div className="page item-page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <a href="#/library">{S.nav.library}</a> <span aria-hidden="true">›</span>{' '}
        <span aria-current="page">{item.meta.title}</span>
      </nav>
      <div className="item-hero">
        <div className="item-cover">
          <Cover url={item.artwork?.fullUrl ?? null} title={item.meta.title} type={item.type} size="large" />
          {!readOnly && (
            <div className="row wrap">
              <button
                type="button"
                className="button button-small"
                onClick={() =>
                  void run(
                    async () => (await call(getApi().artwork.chooseLocal({ itemId: item.id }))) ?? item,
                    'Image updated.',
                  )
                }
              >
                {item.artwork ? 'Change image…' : 'Add image…'}
              </button>
              {item.artwork && (
                <button
                  type="button"
                  className="button button-small"
                  onClick={() =>
                    void run(() => call(getApi().artwork.remove({ itemId: item.id })), 'Image removed.')
                  }
                >
                  Remove image
                </button>
              )}
              {item.artwork?.source === 'remote' && (
                <button
                  type="button"
                  className="button button-small"
                  onClick={() =>
                    void run(
                      () => call(getApi().artwork.retry({ itemId: item.id })),
                      'Artwork saved for offline use.',
                    )
                  }
                >
                  Save offline copy
                </button>
              )}
            </div>
          )}
        </div>
        <div className="item-summary">
          <h1>{item.meta.title}</h1>
          {item.meta.altTitles.length > 0 && (
            <p className="muted">Also known as: {item.meta.altTitles.join(' · ')}</p>
          )}
          <p className="item-meta">
            <TypeBadge type={item.type} />
            {item.meta.releaseDate && <span>{fmtPartialDate(item.meta.releaseDate)}</span>}
            {item.meta.creators.slice(0, 3).map((c) => (
              <span key={`${c.role}${c.name}`} className="muted">
                {c.name}
              </span>
            ))}
          </p>
          <div className="row wrap">
            <div className="field field-inline">
              <label htmlFor="item-status">Status</label>
              <select
                id="item-status"
                className="input input-inline"
                value={item.personal.status}
                disabled={readOnly}
                onChange={(e) => startStatusChange(e.target.value as Status)}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <StatusBadge status={item.personal.status} />
            <div className="field field-inline">
              <label htmlFor="item-rating">Rating</label>
              <select
                id="item-rating"
                className="input input-inline"
                value={item.personal.rating === null ? '' : String(item.personal.rating)}
                disabled={readOnly}
                onChange={(e) =>
                  void run(
                    () =>
                      call(
                        getApi().items.setRating({
                          id: item.id,
                          rating: e.target.value === '' ? null : Number(e.target.value),
                        }),
                      ),
                    'Rating saved.',
                  )
                }
              >
                {RATING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <ProgressBar percent={item.progress.percent} label={item.progress.label} />
          {item.pass > 1 && <p className="muted">Pass {item.pass} (re-watch / re-read / replay)</p>}
          <dl className="dates">
            <div>
              <dt>Added</dt>
              <dd>{fmtPartialDate(item.personal.dateAdded)}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{fmtPartialDate(item.personal.dateStarted)}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>{fmtPartialDate(item.personal.dateCompleted)}</dd>
            </div>
          </dl>
          {!readOnly && (
            <div className="row wrap">
              <button type="button" className="button button-primary" onClick={() => setEditing(true)}>
                Edit details
              </button>
              {hasSource && (
                <button type="button" className="button" onClick={() => setRefreshOpen(true)}>
                  <IconRefresh /> Refresh metadata…
                </button>
              )}
              <button type="button" className="button button-danger" onClick={() => setConfirmDelete(true)}>
                Delete…
              </button>
            </div>
          )}
        </div>
      </div>

      {suggestions.length > 0 && (
        <div className="suggestions" role="status">
          {suggestions.map((s) => (
            <div key={s.kind} className="notice notice-info">
              <p className="notice-content">{s.message}</p>
              <button
                type="button"
                className="button button-primary button-small"
                onClick={() =>
                  void run(
                    () => call(getApi().items.acceptSuggestion({ id: item.id, suggestion: s })),
                    `Status: ${statusLabel(s.status)}`,
                  )
                }
              >
                Mark {statusLabel(s.status)}
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => setSuggestions((xs) => xs.filter((x) => x !== s))}
              >
                Not now
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="item-columns">
        <div className="item-main">
          <section className="card" aria-labelledby="sec-progress">
            <h2 id="sec-progress">{S.item.progress}</h2>
            <ProgressPanel item={item} readOnly={readOnly} onOutcome={applyOutcome} />
          </section>
          <section className="card" aria-labelledby="sec-history">
            <h2 id="sec-history">{S.item.history}</h2>
            <HistoryPanel item={item} readOnly={readOnly} tick={historyTick} onOutcome={applyOutcome} />
          </section>
          <section className="card" aria-labelledby="sec-notes">
            <h2 id="sec-notes">{S.item.notes}</h2>
            {item.personal.notes ? (
              <p className="notes">{item.personal.notes}</p>
            ) : (
              <p className="muted">No notes yet.</p>
            )}
            {item.personal.tags.length > 0 && (
              <ul className="chip-list" aria-label="Tags">
                {item.personal.tags.map((t) => (
                  <li key={t} className="chip">
                    {t}
                  </li>
                ))}
              </ul>
            )}
            {item.customFields.some((c) => c.value !== null) && (
              <dl className="details-list">
                {item.customFields
                  .filter((c) => c.value !== null)
                  .map((c) => (
                    <div key={c.defId}>
                      <dt>{c.name}</dt>
                      <dd>{typeof c.value === 'boolean' ? (c.value ? 'Yes' : 'No') : String(c.value)}</dd>
                    </div>
                  ))}
              </dl>
            )}
          </section>
        </div>
        <div className="item-side">
          <section className="card" aria-labelledby="sec-details">
            <h2 id="sec-details">{S.item.details}</h2>
            <DetailsList item={item} />
          </section>
          <section className="card" aria-labelledby="sec-links">
            <h2 id="sec-links">{S.item.links}</h2>
            <LinksPanel item={item} />
          </section>
          {item.type === 'book' && (
            <section className="card" aria-labelledby="sec-series">
              <h2 id="sec-series">Series</h2>
              <SeriesPanel item={item} readOnly={readOnly} onChange={() => (q.reload(), app.bumpData())} />
            </section>
          )}
          <section className="card" aria-labelledby="sec-source">
            <h2 id="sec-source">{S.item.source}</h2>
            <SourcePanel item={item} />
          </section>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${item.meta.title}”?`}
          destructive
          confirmLabel="Delete item"
          message={
            <>
              <p>
                This removes the {typeLabel(item.type).toLowerCase()} <strong>{item.meta.title}</strong> from
                your library, including:
              </p>
              <ul>
                <li>
                  its progress history{item.type === 'tv' ? ' and episode checkmarks' : ''}
                  {item.type === 'movie' ? ' and viewing history' : ''}
                </li>
                <li>your notes, rating, tags and custom fields</li>
                <li>{item.artwork ? 'its cached/added artwork' : 'any artwork'}</li>
              </ul>
              <p>You can undo this for a few seconds afterwards.</p>
            </>
          }
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void doDelete()}
        />
      )}
      {statusDialog && (
        <StatusChangeDialog
          item={item}
          to={statusDialog.to}
          confirmations={statusDialog.confirmations}
          offerFill={statusDialog.offerFill}
          onCancel={() => setStatusDialog(null)}
          onConfirm={(opts) => {
            setStatusDialog(null);
            void run(
              () => call(getApi().items.setStatus({ id: item.id, status: statusDialog.to, ...opts })),
              `Status: ${statusLabel(statusDialog.to)}`,
            );
          }}
        />
      )}
      {refreshOpen && (
        <RefreshDialog
          item={item}
          onClose={() => setRefreshOpen(false)}
          onApplied={(it) => (q.setData(it), app.bumpData(), setHistoryTick((t) => t + 1))}
        />
      )}
    </div>
  );
}

function StatusChangeDialog({
  item,
  to,
  confirmations,
  offerFill,
  onCancel,
  onConfirm,
}: {
  item: ItemDetail;
  to: Status;
  confirmations: string[];
  offerFill: boolean;
  onCancel: () => void;
  onConfirm: (o: { startNewPass: boolean; clearDateCompleted: boolean; fillRemaining: boolean }) => void;
}) {
  const [newPass, setNewPass] = useState(true);
  const [clearDate, setClearDate] = useState(false);
  const [fill, setFill] = useState(false);
  const verb =
    item.type === 'movie' || item.type === 'tv' ? 're-watch' : item.type === 'book' ? 're-read' : 'replay';
  return (
    <Dialog
      title={`Change status to ${statusLabel(to)}`}
      onClose={onCancel}
      size="small"
      footer={
        <>
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() =>
              onConfirm({
                startNewPass: confirmations.includes('newPass') && newPass,
                clearDateCompleted: clearDate,
                fillRemaining: fill,
              })
            }
          >
            Change status
          </button>
        </>
      }
    >
      {confirmations.includes('newPass') && (
        <>
          <p>This item is Completed. Moving it back to In Progress keeps all history.</p>
          <Checkbox
            label={`Start a new ${verb} (pass ${item.pass + 1})`}
            hint={
              item.type === 'tv'
                ? 'Episode checkmarks start fresh for the new pass; earlier history is kept.'
                : 'Progress for the new pass starts fresh; earlier history is kept.'
            }
            checked={newPass}
            onChange={setNewPass}
          />
          <Checkbox
            label={`Clear the completed date (${fmtPartialDate(item.personal.dateCompleted)})`}
            checked={clearDate}
            onChange={setClearDate}
          />
        </>
      )}
      {offerFill && (
        <Checkbox
          label={
            item.type === 'movie'
              ? 'Also log a viewing for today'
              : item.type === 'tv'
                ? 'Also mark all remaining episodes watched'
                : item.type === 'book'
                  ? 'Also record the book as fully read'
                  : 'Also set progress to complete (percentage or final milestone)'
          }
          checked={fill}
          onChange={setFill}
        />
      )}
    </Dialog>
  );
}

function DetailsList({ item }: { item: ItemDetail }) {
  const fields = FIELDS_BY_TYPE[item.type].filter(
    (f) => f !== 'title' && f !== 'altTitles' && f !== 'externalIds',
  );
  const hasAny = fields.some((f) => {
    const v = item.meta[f];
    return v !== null && !(Array.isArray(v) && v.length === 0);
  });
  if (!hasAny) return <p className="muted">No details yet. Use “Edit details” to add some.</p>;
  return (
    <dl className="details-list">
      {fields.map((f: MetadataField) => {
        const prov = item.provenance[f];
        const v = item.meta[f];
        if (v === null || (Array.isArray(v) && v.length === 0)) return null;
        return (
          <div key={f}>
            <dt>
              {f === 'releaseDate' ? releaseDateLabel(item.type) : FIELD_LABELS[f]}
              {prov && (
                <span
                  className={`prov prov-${prov.origin}`}
                  title={`Last set ${fmtDateTime(prov.updatedAt)}`}
                >
                  {prov.origin === 'provider'
                    ? `from ${prov.providerId ?? 'provider'}`
                    : prov.origin === 'user'
                      ? 'edited by you'
                      : 'entered by you'}
                </span>
              )}
            </dt>
            <dd className={f === 'description' ? 'notes' : undefined}>
              {f === 'releaseDate' || f === 'lastAirDate' ? fmtPartialDate(v as string) : displayValue(f, v)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function SourcePanel({ item }: { item: ItemDetail }) {
  const providers = useAsync(() => call(getApi().providers.list()), []);
  const audit = useAsync(() => call(getApi().items.audit({ id: item.id })), [item.updatedAt]);
  if (item.sources.length === 0) return <p className="muted">Entered manually. No online source.</p>;
  return (
    <>
      <ul className="plain-list">
        {item.sources.map((s) => {
          const p = providers.data?.find((x) => x.id === s.providerId);
          return (
            <li key={s.providerId}>
              <strong>{p?.displayName ?? s.providerId}</strong> · fetched {fmtDateTime(s.fetchedAt)}
              {p && <p className="attribution">{p.attribution.text}</p>}
            </li>
          );
        })}
      </ul>
      {audit.data && audit.data.length > 0 && (
        <details>
          <summary>Metadata change log ({audit.data.length})</summary>
          <ul className="plain-list">
            {audit.data.map((a) => (
              <li key={a.id}>
                {fmtDateTime(a.at)} —{' '}
                {a.action === 'refresh' ? 'Refreshed' : a.action === 'import' ? 'Imported' : 'Created'}
                {a.providerId ? ` from ${a.providerId}` : ''}
                {a.changes.length > 0
                  ? `: ${a.changes.map((c) => c.field).join(', ')}`
                  : a.action === 'refresh'
                    ? ': no changes applied'
                    : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
