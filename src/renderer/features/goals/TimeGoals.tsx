/** §14.1 Time-based goals: minutes per day/week from sessions (and manual session entries). Never nags. */
import { useState } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import type { TimeGoalView } from '../../../shared/views-21';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { NumberField, SelectField, TextField } from '../../components/Fields';

const fmt = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

export function TimeGoals() {
  const app = useApp();
  const toast = useToast();
  const list = useAsync(() => call(getApi().timeGoals.list({ includeArchived: false })), [app.dataVersion]);
  const lists = useAsync(() => call(getApi().lists.list()), []);
  const moods = useAsync(() => call(getApi().moods.list()), []);
  const [edit, setEdit] = useState<Partial<TimeGoalView> | null>(null);
  const [del, setDel] = useState<TimeGoalView | null>(null);
  const save = async () => {
    if (!edit) return;
    try {
      await call(
        getApi().timeGoals.save({
          id: edit.id ?? null,
          title: edit.title ?? '',
          targetMinutes: edit.targetMinutes ?? 30,
          period: edit.period ?? 'day',
          mediaType: edit.mediaType ?? null,
          listId: edit.listId ?? null,
          moodId: edit.moodId ?? null,
        }),
      );
      setEdit(null);
      list.reload();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <section className="card" aria-labelledby="tg-h">
      <h2 id="tg-h">Time goals</h2>
      <p className="muted">
        From your play/watch/read timers and logged sessions. Skipped episodes never count as time.
      </p>
      <ul className="plain-list">
        {(list.data ?? []).map((g) => (
          <li key={g.id} className="time-goal">
            <p>
              <strong>{g.title}</strong>: {fmt(g.minutes)} of {fmt(g.targetMinutes)}{' '}
              {g.period === 'day' ? 'today' : 'this week'} · <span>{g.paceLabel}</span>
            </p>
            <div
              className="meter"
              role="img"
              aria-label={`${Math.min(100, Math.round((g.minutes / g.targetMinutes) * 100))} percent of the target`}
            >
              <span style={{ width: `${Math.min(100, Math.round((g.minutes / g.targetMinutes) * 100))}%` }} />
            </div>
            <p className="muted">
              Last {g.period === 'day' ? '7 days' : '7 weeks'}:{' '}
              {g.history.map((h) => fmt(Math.round(h.minutes))).join(' · ')}
            </p>
            <div className="button-row">
              <button
                type="button"
                className="button button-small"
                onClick={() => setEdit(g)}
                aria-label={`Edit ${g.title}`}
              >
                Edit
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() =>
                  void call(getApi().timeGoals.archive({ id: g.id, archived: true })).then(() =>
                    list.reload(),
                  )
                }
                aria-label={`Archive ${g.title}`}
              >
                Archive
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => setDel(g)}
                aria-label={`Delete ${g.title}`}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button"
        onClick={() => setEdit({ title: 'Reading time', targetMinutes: 30, period: 'day' })}
      >
        New time goal…
      </button>
      {edit && (
        <Dialog
          title={edit.id ? 'Edit time goal' : 'New time goal'}
          onClose={() => setEdit(null)}
          size="small"
          footer={
            <button
              type="button"
              className="button button-primary"
              onClick={() => void save()}
              disabled={!edit.title?.trim()}
            >
              Save
            </button>
          }
        >
          <TextField
            label="Name"
            value={edit.title ?? ''}
            onChange={(title) => setEdit({ ...edit, title })}
            maxLength={120}
          />
          <div className="field-row">
            <NumberField
              label="Minutes"
              value={edit.targetMinutes ?? 30}
              min={1}
              max={10080}
              onChange={(v) => setEdit({ ...edit, targetMinutes: v ?? 30 })}
            />
            <SelectField
              label="Per"
              value={edit.period ?? 'day'}
              onChange={(period) => setEdit({ ...edit, period })}
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
              ]}
            />
          </div>
          <SelectField
            label="Only count"
            value={edit.mediaType ?? ''}
            onChange={(v) => setEdit({ ...edit, mediaType: (v || null) as MediaType | null })}
            options={[
              { value: '', label: 'Everything' },
              ...MEDIA_TYPES.map((t) => ({ value: t, label: typeLabelPlural(t) })),
            ]}
          />
          <SelectField
            label="Only this list"
            value={edit.listId ?? ''}
            onChange={(v) => setEdit({ ...edit, listId: v || null })}
            options={[
              { value: '', label: 'Any list' },
              ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
          <SelectField
            label="Only this mood"
            value={edit.moodId ?? ''}
            onChange={(v) => setEdit({ ...edit, moodId: v || null })}
            options={[
              { value: '', label: 'Any mood' },
              ...(moods.data ?? []).map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        </Dialog>
      )}
      {del && (
        <ConfirmDialog
          title="Delete time goal?"
          message={`“${del.title}” will be deleted. Your sessions are not affected.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDel(null)}
          onConfirm={() => {
            const d = del;
            setDel(null);
            void call(getApi().timeGoals.remove({ id: d.id })).then(() => list.reload());
          }}
        />
      )}
    </section>
  );
}
