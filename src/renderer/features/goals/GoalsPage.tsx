/**
 * Goals: simple targets with plain-text pace ("On pace", "Behind pace") and
 * the math shown. Suggestions, never nags: no notifications.
 */
import { useState } from 'react';
import { MEDIA_TYPES, type MediaType } from '../../../shared/enums';
import type { GoalView } from '../../../shared/types';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtPartialDate, todayLocal, typeLabelPlural } from '../../app/strings';
import { useToast } from '../../app/toast';
import { EmptyState, ErrorBox, Loading, ProgressBar } from '../../components/Bits';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { NumberField, SelectField, TextField } from '../../components/Fields';

const METRIC_UNIT: Record<GoalView['metric'], string> = {
  items: 'finished',
  pages: 'pages',
  episodes: 'episodes',
  hours: 'hours',
};
const PACE_ICON: Record<GoalView['pace']['status'], string> = {
  done: '✓',
  ahead: '↑',
  'on-pace': '→',
  behind: '↓',
  'not-started': '…',
  'ended-short': '■',
};

export function GoalCard({ g, compact }: { g: GoalView; compact: boolean }) {
  return (
    <div className={`goal goal-${g.pace.status}`}>
      <p className="goal-title">
        <strong>{g.title}</strong>
        {!compact && (
          <span className="muted">
            {' '}
            · {fmtPartialDate(g.startDate)} – {fmtPartialDate(g.endDate)}
            {g.mediaType ? ` · ${typeLabelPlural(g.mediaType)}` : ''}
            {g.listName ? ` · list: ${g.listName}` : ''}
            {g.tag ? ` · tag: ${g.tag}` : ''}
          </span>
        )}
      </p>
      <ProgressBar
        percent={Math.min(100, (g.progress / g.target) * 100)}
        label={`${g.progress} of ${g.target} ${METRIC_UNIT[g.metric]}`}
      />
      <p>
        {g.progress} of {g.target} {METRIC_UNIT[g.metric]} ·{' '}
        <span className={`pace pace-${g.pace.status}`}>
          <span aria-hidden="true">{PACE_ICON[g.pace.status]} </span>
          {g.pace.label}
        </span>
      </p>
      {!compact && (
        <details>
          <summary>How is this calculated?</summary>
          <p className="muted">{g.pace.math}</p>
          {g.pace.neededPerWeek !== null && (
            <p className="muted">
              To finish on time: about {g.pace.neededPerWeek} {METRIC_UNIT[g.metric]} per week.
            </p>
          )}
        </details>
      )}
    </div>
  );
}

export function GoalsPage() {
  const app = useApp();
  const toast = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const q = useAsync(() => call(getApi().goals.list({ includeArchived: true })), [app.dataVersion]);
  const [editing, setEditing] = useState<GoalView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<GoalView | null>(null);
  const goals = (q.data ?? []).filter((g) => showArchived || !g.archived);
  return (
    <div className="page">
      <div className="page-header">
        <h1>Goals</h1>
        <button type="button" className="button button-primary" onClick={() => setEditing('new')}>
          New goal
        </button>
      </div>
      <p className="muted">Goals are gentle targets. Maybe Pile never sends notifications about them.</p>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && (
        <EmptyState
          title="No goals yet"
          action={
            <button type="button" className="button button-primary" onClick={() => setEditing('new')}>
              Create a goal
            </button>
          }
        >
          For example “Read 24 books this year” or “Watch 4 movies this month”.
        </EmptyState>
      )}
      {q.data && q.data.some((g) => g.archived) && (
        <label className="check-inline">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />{' '}
          Show archived goals
        </label>
      )}
      <ul className="plain-list goal-list">
        {goals.map((g) => (
          <li key={g.id} className="card">
            {g.archived && <span className="badge">Archived</span>}
            <GoalCard g={g} compact={false} />
            <div className="row wrap">
              <button
                type="button"
                className="button button-small"
                onClick={() => setEditing(g)}
                aria-label={`Edit ${g.title}`}
              >
                Edit
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() =>
                  void call(getApi().goals.archive({ id: g.id, archived: !g.archived }))
                    .then(
                      (l) => (q.setData(l), toast.success(g.archived ? 'Goal restored.' : 'Goal archived.')),
                    )
                    .catch((e: unknown) => toast.error(errorOf(e)))
                }
                aria-label={`${g.archived ? 'Unarchive' : 'Archive'} ${g.title}`}
              >
                {g.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => setDeleting(g)}
                aria-label={`Delete ${g.title}`}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editing && (
        <GoalEditor
          goal={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(l) => (q.setData(l), setEditing(null))}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.title}”?`}
          message={
            <p>
              The goal is removed. Your items and history are not affected. You can archive it instead to keep
              it.
            </p>
          }
          confirmLabel="Delete goal"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const g = deleting;
            setDeleting(null);
            void call(getApi().goals.remove({ id: g.id }))
              .then((l) => (q.setData(l), toast.success('Goal deleted.')))
              .catch((e: unknown) => toast.error(errorOf(e)));
          }}
        />
      )}
    </div>
  );
}

function GoalEditor({
  goal,
  onClose,
  onSaved,
}: {
  goal: GoalView | null;
  onClose: () => void;
  onSaved: (l: GoalView[]) => void;
}) {
  const lists = useAsync(() => call(getApi().lists.list()), []);
  const [title, setTitle] = useState(goal?.title ?? '');
  const [mediaType, setMediaType] = useState<MediaType | ''>(goal?.mediaType ?? '');
  const [metric, setMetric] = useState<GoalView['metric']>(goal?.metric ?? 'items');
  const [period, setPeriod] = useState<GoalView['period']>(goal?.period ?? 'year');
  const [startDate, setStartDate] = useState(goal?.startDate ?? todayLocal());
  const [endDate, setEndDate] = useState(goal?.endDate ?? '');
  const [target, setTarget] = useState<number | null>(goal?.target ?? 12);
  const [listId, setListId] = useState(goal?.listId ?? '');
  const [tag, setTag] = useState(goal?.tag ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(
        await call(
          getApi().goals.save({
            id: goal?.id ?? null,
            title,
            mediaType: mediaType || null,
            metric,
            period,
            startDate,
            endDate: period === 'custom' ? endDate || null : null,
            target: target ?? 0,
            listId: listId || null,
            tag: tag || null,
          }),
        ),
      );
    } catch (e) {
      const err = errorOf(e);
      setErrors(err.fieldErrors ?? { title: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={goal ? 'Edit goal' : 'New goal'}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button-primary" onClick={() => void save()} disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <TextField
        label="Goal name"
        required
        value={title}
        onChange={setTitle}
        error={errors['title']}
        hint="For example “Read 24 books in 2027”."
      />
      <div className="form-grid">
        <NumberField label="Target" required value={target} onChange={setTarget} error={errors['target']} />
        <SelectField<GoalView['metric']>
          label="Count"
          value={metric}
          onChange={setMetric}
          error={errors['metric']}
          options={[
            { value: 'items', label: 'Items finished' },
            { value: 'pages', label: 'Pages (finished books)' },
            { value: 'episodes', label: 'Episodes watched' },
            { value: 'hours', label: 'Game hours logged' },
          ]}
        />
        <SelectField<MediaType | ''>
          label="Media type"
          value={mediaType}
          onChange={setMediaType}
          options={[
            { value: '', label: 'All types' },
            ...MEDIA_TYPES.map((t) => ({ value: t, label: typeLabelPlural(t) })),
          ]}
        />
        <SelectField<GoalView['period']>
          label="Period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: 'year', label: 'Calendar year' },
            { value: 'month', label: 'Calendar month' },
            { value: 'custom', label: 'Custom dates' },
          ]}
        />
        <TextField
          label={
            period === 'custom'
              ? 'Start date'
              : period === 'year'
                ? 'Any date in the year'
                : 'Any date in the month'
          }
          type="date"
          value={startDate}
          onChange={setStartDate}
          error={errors['startDate']}
        />
        {period === 'custom' && (
          <TextField
            label="End date"
            type="date"
            value={endDate}
            onChange={setEndDate}
            error={errors['endDate']}
          />
        )}
        <SelectField<string>
          label="Only items in list (optional)"
          value={listId}
          onChange={setListId}
          error={errors['listId']}
          options={[
            { value: '', label: 'Any list' },
            ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name })),
          ]}
        />
        <TextField
          label="Only items with tag (optional)"
          value={tag}
          onChange={setTag}
          error={errors['tag']}
        />
      </div>
    </Dialog>
  );
}

export function GoalsWidget({ headingId }: { headingId: string }) {
  const app = useApp();
  const q = useAsync(() => call(getApi().goals.list({ includeArchived: false })), [app.dataVersion]);
  return (
    <>
      <h2 id={headingId}>Goals</h2>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && (
        <p className="muted">
          No goals. <a href="#/goals">Set one</a> — e.g. “24 books this year”.
        </p>
      )}
      {q.data?.slice(0, 4).map((g) => (
        <GoalCard key={g.id} g={g} compact />
      ))}
      {q.data && q.data.length > 0 && <a href="#/goals">All goals</a>}
    </>
  );
}
