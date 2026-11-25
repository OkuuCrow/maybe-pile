import { useState } from 'react';
import type { ItemDetail, MutationOutcome, ProgressEventView, ViewingView } from '../../../shared/types';
import { formatHours, formatMinutes } from '../../../domain/progress';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { fmtDateTime, isoToLocalInput, localInputToIso } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { NumberField, TextField } from '../../components/Fields';
import { Loading } from '../../components/Bits';

function describe(e: ProgressEventView): string {
  switch (e.kind) {
    case 'percent':
      return `${e.value ?? 0}%`;
    case 'hours':
      return formatHours(e.value ?? 0);
    case 'pages':
      return `Page ${e.value ?? 0}${e.totalAtTime ? ` (of ${e.totalAtTime} at the time)` : ''}`;
    case 'audio':
      return `${formatMinutes(e.value ?? 0)} listened`;
    case 'milestone':
      return `Reached “${e.milestoneTitle ?? 'milestone'}”`;
    case 'text':
      return e.text ?? '';
    case 'episode':
      return `${e.watched ? 'Watched' : 'Un-watched'} ${e.episodeLabel ?? 'episode'}`;
    case 'season':
      return e.text ?? `${e.watched ? 'Watched' : 'Un-watched'} ${e.value ?? 0} episode(s)`;
  }
}

export function HistoryPanel({
  item,
  readOnly,
  tick,
  onOutcome,
}: {
  item: ItemDetail;
  readOnly: boolean;
  tick: number;
  onOutcome: (o: MutationOutcome) => void;
}) {
  const toast = useToast();
  const events = useAsync(() => call(getApi().progress.history({ itemId: item.id })), [item.id, tick]);
  const viewings = useAsync(
    () =>
      item.type === 'movie'
        ? call(getApi().progress.viewings({ itemId: item.id }))
        : Promise.resolve([] as ViewingView[]),
    [item.id, tick],
  );
  const [editing, setEditing] = useState<ProgressEventView | null>(null);
  const [editingViewing, setEditingViewing] = useState<ViewingView | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'event' | 'viewing'; id: string; label: string } | null>(
    null,
  );

  const run = async (fn: () => Promise<MutationOutcome>, ok: string) => {
    try {
      onOutcome(await fn());
      toast.success(ok);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };

  if (events.loading && !events.data) return <Loading />;
  const list = events.data ?? [];
  const vlist = viewings.data ?? [];
  if (list.length === 0 && vlist.length === 0) return <p className="muted">No progress recorded yet.</p>;
  return (
    <>
      {(item.type === 'tv' || item.type === 'anime') && (
        <p className="field-hint">
          Episode history is a log; editing or deleting an entry does not change episode checkmarks.
        </p>
      )}
      <ol className="timeline">
        {vlist.map((v) => (
          <li key={v.id} className="timeline-item">
            <span className="timeline-when">
              {v.watchedAt ? fmtDateTime(v.watchedAt) : 'Date not recorded'}
            </span>
            <span className="timeline-what">
              Watched{v.pass > 1 ? ` (pass ${v.pass})` : ''}
              {v.note && <span className="muted"> — {v.note}</span>}
            </span>
            {!readOnly && (
              <span className="timeline-actions">
                <button type="button" className="button button-tiny" onClick={() => setEditingViewing(v)}>
                  Edit<span className="visually-hidden"> viewing</span>
                </button>
                <button
                  type="button"
                  className="button button-tiny"
                  onClick={() => setDeleting({ kind: 'viewing', id: v.id, label: 'this viewing' })}
                >
                  Delete<span className="visually-hidden"> viewing</span>
                </button>
              </span>
            )}
          </li>
        ))}
        {list.map((e) => (
          <li key={e.id} className="timeline-item">
            <span className="timeline-when">{fmtDateTime(e.occurredAt ?? e.recordedAt)}</span>
            <span className="timeline-what">
              {describe(e)}
              {e.pass > 1 && <span className="muted"> (pass {e.pass})</span>}
              {e.scheme && item.type === 'game' && e.scheme !== item.personal.gameScheme && (
                <span className="muted"> · recorded under “{e.scheme}”</span>
              )}
              {e.note && <span className="muted"> — {e.note}</span>}
            </span>
            {!readOnly && (
              <span className="timeline-actions">
                <button type="button" className="button button-tiny" onClick={() => setEditing(e)}>
                  Edit<span className="visually-hidden"> entry {describe(e)}</span>
                </button>
                <button
                  type="button"
                  className="button button-tiny"
                  onClick={() => setDeleting({ kind: 'event', id: e.id, label: describe(e) })}
                >
                  Delete<span className="visually-hidden"> entry {describe(e)}</span>
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {editing && (
        <EditEventDialog
          event={editing}
          onClose={() => setEditing(null)}
          onSave={(p) =>
            void run(
              () => call(getApi().progress.edit({ eventId: editing.id, ...p })),
              'History entry updated.',
            ).then(() => setEditing(null))
          }
        />
      )}
      {editingViewing && (
        <EditViewingDialog
          viewing={editingViewing}
          onClose={() => setEditingViewing(null)}
          onSave={(p) =>
            void run(
              () => call(getApi().progress.editViewing({ viewingId: editingViewing.id, ...p })),
              'Viewing updated.',
            ).then(() => setEditingViewing(null))
          }
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete history entry?"
          message={
            <p>Delete “{deleting.label}”? Current progress is recalculated from the remaining entries.</p>
          }
          confirmLabel="Delete entry"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting;
            setDeleting(null);
            void run(
              () =>
                d.kind === 'event'
                  ? call(getApi().progress.remove({ eventId: d.id }))
                  : call(getApi().progress.removeViewing({ viewingId: d.id })),
              'Entry deleted.',
            );
          }}
        />
      )}
    </>
  );
}

function EditEventDialog({
  event,
  onClose,
  onSave,
}: {
  event: ProgressEventView;
  onClose: () => void;
  onSave: (p: {
    occurredAt: string | null;
    note: string | null;
    value: number | null;
    text: string | null;
  }) => void;
}) {
  const [when, setWhen] = useState(isoToLocalInput(event.occurredAt ?? event.recordedAt));
  const [note, setNote] = useState(event.note ?? '');
  const [value, setValue] = useState<number | null>(event.value);
  const [text, setText] = useState(event.text ?? '');
  const numeric = ['percent', 'hours', 'pages', 'audio'].includes(event.kind);
  return (
    <Dialog
      title="Edit history entry"
      onClose={onClose}
      size="small"
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() =>
              onSave({
                occurredAt: localInputToIso(when),
                note: note || null,
                value: numeric ? value : null,
                text: event.kind === 'text' ? text || null : null,
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <TextField type="datetime-local" label="When" value={when} onChange={setWhen} />
      {numeric && (
        <NumberField
          label={
            event.kind === 'percent'
              ? 'Percent'
              : event.kind === 'hours'
                ? 'Hours'
                : event.kind === 'pages'
                  ? 'Page'
                  : 'Minutes'
          }
          value={value}
          onChange={setValue}
          min={0}
          max={event.kind === 'percent' ? 100 : 100000}
          step={event.kind === 'hours' || event.kind === 'percent' ? 0.5 : 1}
        />
      )}
      {event.kind === 'text' && <TextField label="Progress" value={text} onChange={setText} />}
      <TextField label="Note" value={note} onChange={setNote} />
    </Dialog>
  );
}

function EditViewingDialog({
  viewing,
  onClose,
  onSave,
}: {
  viewing: ViewingView;
  onClose: () => void;
  onSave: (p: { watchedAt: string | null; note: string | null }) => void;
}) {
  const [when, setWhen] = useState(isoToLocalInput(viewing.watchedAt));
  const [note, setNote] = useState(viewing.note ?? '');
  return (
    <Dialog
      title="Edit viewing"
      onClose={onClose}
      size="small"
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => onSave({ watchedAt: localInputToIso(when), note: note || null })}
          >
            Save
          </button>
        </>
      }
    >
      <TextField type="datetime-local" label="Watched at (optional)" value={when} onChange={setWhen} />
      <TextField label="Note" value={note} onChange={setNote} />
    </Dialog>
  );
}
