/** Custom reminders: list + editor (structured repeat rules only). */
import { useEffect, useId, useMemo, useState } from 'react';
import type { ReminderInput, ReminderView } from '../../../shared/notification-contract';
import type { CommandTarget } from '../../../shared/types';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { fmtDateTime, todayLocal, typeLabel } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { ErrorBox, Loading } from '../../components/Bits';
import { NumberField, SelectField, TextField } from '../../components/Fields';
import { Toggle } from './shared';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function nowHhmm(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}

export function ReminderEditor({
  initial,
  fixedItem,
  onClose,
  onSaved,
}: {
  initial: ReminderView | null;
  /** Item detail "Remind me…": the item is preset and not changeable. */
  fixedItem?: { id: string; title: string } | null;
  onClose: () => void;
  onSaved: (r: ReminderView) => void;
}) {
  const toast = useToast();
  const [message, setMessage] = useState(initial?.message ?? (fixedItem ? `Pick up ${fixedItem.title}` : ''));
  const [itemId, setItemId] = useState<string | null>(initial?.itemId ?? fixedItem?.id ?? null);
  const [itemQuery, setItemQuery] = useState('');
  const [kind, setKind] = useState<'once' | 'repeat'>(initial?.kind ?? 'once');
  const [date, setDate] = useState(initial?.date ?? todayLocal());
  const [time, setTime] = useState(initial?.time ?? nowHhmm());
  const [freq, setFreq] = useState<'daily' | 'weekly' | 'monthly' | 'weekdays'>(
    initial?.rule?.freq ?? 'weekly',
  );
  const [interval, setInterval] = useState<number | null>(initial?.rule?.interval ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(initial?.rule?.weekdays ?? [1, 3, 5]);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const titles = useAsync(
    () => (fixedItem ? Promise.resolve([] as CommandTarget[]) : call(getApi().items.titles())),
    [],
  );
  const matches = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    if (!q || !titles.data) return [];
    return titles.data.filter((t) => t.title.toLowerCase().includes(q)).slice(0, 8);
  }, [itemQuery, titles.data]);
  const chosen =
    fixedItem ??
    (itemId
      ? (titles.data?.find((t) => t.id === itemId) ??
        (initial?.itemTitle ? { id: itemId, title: initial.itemTitle } : null))
      : null);
  const groupId = useId();

  const save = async () => {
    const input: ReminderInput = {
      id: initial?.id ?? null,
      itemId,
      message,
      kind,
      date,
      time,
      rule:
        kind === 'repeat'
          ? { freq, interval: interval ?? 1, weekdays: freq === 'weekdays' ? [...weekdays].sort() : [] }
          : null,
      enabled,
    };
    setSaving(true);
    try {
      const r = await call(getApi().reminders.save(input));
      toast.success(initial ? 'Reminder updated.' : 'Reminder saved.');
      onSaved(r);
    } catch (e) {
      const err = errorOf(e);
      setErrors(err.fieldErrors ?? { _: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={initial ? 'Edit reminder' : 'New reminder'}
      onClose={onClose}
      size="medium"
      dismissible={!saving}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void save()}
            disabled={saving || message.trim() === ''}
          >
            {saving ? 'Saving…' : 'Save reminder'}
          </button>
        </>
      }
    >
      {errors['_'] && <ErrorBox error={{ code: 'VALIDATION', message: errors['_'] }} />}
      <TextField
        label="Message"
        hint="Shown in the notification. Don't put private notes here — notifications can appear on the lock screen."
        value={message}
        onChange={setMessage}
        maxLength={140}
        required
        error={errors['message']}
      />
      {fixedItem ? (
        <p>
          For: <strong>{fixedItem.title}</strong>
        </p>
      ) : (
        <div className="field">
          <TextField
            label="Item (optional)"
            hint="Clicking the reminder opens this item."
            value={chosen ? chosen.title : itemQuery}
            onChange={(v) => {
              setItemId(null);
              setItemQuery(v);
            }}
            placeholder="Search your library…"
          />
          {!chosen && matches.length > 0 && (
            <ul className="picker-list" aria-label="Matching items">
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => (setItemId(m.id), setItemQuery(''))}
                  >
                    {m.title} <span className="muted">({typeLabel(m.type)})</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {chosen && (
            <button
              type="button"
              className="button button-small"
              onClick={() => (setItemId(null), setItemQuery(''))}
            >
              Clear item
            </button>
          )}
        </div>
      )}
      <fieldset className="field">
        <legend>How often</legend>
        <div className="radio-row">
          <label>
            <input
              type="radio"
              name={`${groupId}-kind`}
              checked={kind === 'once'}
              onChange={() => setKind('once')}
            />{' '}
            Once
          </label>
          <label>
            <input
              type="radio"
              name={`${groupId}-kind`}
              checked={kind === 'repeat'}
              onChange={() => setKind('repeat')}
            />{' '}
            Repeat
          </label>
        </div>
      </fieldset>
      <div className="field-row">
        <TextField
          label={kind === 'once' ? 'Date' : 'Starting'}
          type="date"
          value={date}
          onChange={setDate}
          error={errors['date']}
        />
        <TextField label="Time" type="time" value={time} onChange={setTime} error={errors['time']} />
      </div>
      {kind === 'repeat' && (
        <>
          <div className="field-row">
            <SelectField
              label="Repeat"
              value={freq}
              onChange={setFreq}
              options={[
                { value: 'daily', label: 'Every N days' },
                { value: 'weekly', label: 'Every N weeks' },
                { value: 'monthly', label: 'Every N months' },
                { value: 'weekdays', label: 'On these days' },
              ]}
            />
            {freq !== 'weekdays' && (
              <NumberField
                label="Every"
                value={interval}
                onChange={setInterval}
                min={1}
                max={freq === 'monthly' ? 12 : 30}
                error={errors['rule.interval'] ?? errors['rule']}
              />
            )}
          </div>
          {freq === 'weekdays' && (
            <fieldset className="field">
              <legend>Days</legend>
              <div className="day-row">
                {DAYS.map((d, i) => (
                  <label key={d}>
                    <input
                      type="checkbox"
                      checked={weekdays.includes(i)}
                      onChange={(e) =>
                        setWeekdays((w) => (e.target.checked ? [...w, i] : w.filter((x) => x !== i)))
                      }
                      aria-label={DAY_NAMES[i]}
                    />{' '}
                    {d}
                  </label>
                ))}
              </div>
              {errors['rule'] && <p className="field-error">⚠ {errors['rule']}</p>}
            </fieldset>
          )}
          <p className="field-hint">
            Repeats follow the scheduled time: a reminder you snooze or see late does not shift the next one.
          </p>
        </>
      )}
      <Toggle label="Enabled" checked={enabled} onChange={setEnabled} />
    </Dialog>
  );
}

export function RemindersManager({
  itemId = null,
  fixedItem = null,
}: {
  itemId?: string | null;
  fixedItem?: { id: string; title: string } | null;
}) {
  const toast = useToast();
  const list = useAsync(() => call(getApi().reminders.list({ itemId })), [itemId]);
  const [editing, setEditing] = useState<ReminderView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ReminderView | null>(null);
  useEffect(() => undefined, []);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  const rows = list.data ?? [];
  const toggle = async (r: ReminderView) => {
    try {
      await call(getApi().reminders.setEnabled({ id: r.id, enabled: !r.enabled }));
      list.reload();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <div className="reminders-manager">
      {rows.length === 0 ? (
        <p className="muted">No custom reminders yet.</p>
      ) : (
        <table className="table">
          <caption className="visually-hidden">Custom reminders</caption>
          <thead>
            <tr>
              <th scope="col">Reminder</th>
              <th scope="col">When</th>
              <th scope="col">Next</th>
              <th scope="col">State</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.message}
                  {r.itemTitle && !itemId && <span className="muted"> · {r.itemTitle}</span>}
                </td>
                <td>{r.kind === 'once' ? `${r.date} at ${r.time}` : r.ruleLabel}</td>
                <td>{r.nextFireAt ? fmtDateTime(r.nextFireAt) : '—'}</td>
                <td>{r.enabled ? 'On' : 'Off'}</td>
                <td className="row-actions">
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setEditing(r)}
                    aria-label={`Edit reminder: ${r.message}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => void toggle(r)}
                    aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} reminder: ${r.message}`}
                  >
                    {r.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setDeleting(r)}
                    aria-label={`Delete reminder: ${r.message}`}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="button" onClick={() => setEditing('new')}>
        New reminder…
      </button>
      {editing && (
        <ReminderEditor
          initial={editing === 'new' ? null : editing}
          fixedItem={fixedItem}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete reminder?"
          message={`“${deleting.message}” will be deleted.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting;
            setDeleting(null);
            void call(getApi().reminders.remove({ id: d.id }))
              .then(() => {
                toast.success('Reminder deleted.');
                list.reload();
              })
              .catch((e: unknown) => toast.error(errorOf(e)));
          }}
        />
      )}
    </div>
  );
}
