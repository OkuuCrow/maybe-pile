/**
 * Settings → Notifications (Full mode). Everything is off by default; the
 * delivery mode decides what runs when (see docs/notifications.md).
 */
import { useEffect, useId, useState } from 'react';
import {
  CATEGORY_LABELS,
  CATEGORY_SIMPLE_LABELS,
  CHECK_INTERVALS,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CATEGORIES,
  type CategoryConfig,
  type DeliveryMode,
  type NotificationCategory,
  type NotificationSettings,
  type PrivacyLevel,
} from '../../../shared/notification-settings';
import type { HistoryEntryView, PreviewView } from '../../../shared/notification-contract';
import { call, errorOf, getApi, useAsync } from '../../app/api';
import { useApp } from '../../app/context';
import { fmtDateTime } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ConfirmDialog } from '../../components/Dialog';
import { ErrorBox, Loading, Notice } from '../../components/Bits';
import { NumberField, SelectField, TextField } from '../../components/Fields';
import { RemindersManager } from './Reminders';
import {
  ConfirmComponentsDialog,
  LiveRegion,
  StatusPanel,
  Toggle,
  useNotifications,
  type NotifyCtl,
} from './shared';

export const MODE_TEXT: Record<DeliveryMode, { label: string; help: string }> = {
  off: { label: 'Off', help: 'No notifications at all. Nothing runs in the background.' },
  whileOpen: {
    label: 'While the app is open',
    help: 'Reminders arrive only while Maybe Pile is running. Nothing is installed.',
  },
  tray: {
    label: 'Keep running in the background (tray)',
    help: 'Closing the window keeps Maybe Pile in the tray so reminders still arrive, and clicking one opens the item instantly. Uses a small always-on process. Optional: start hidden at login.',
  },
  scheduled: {
    label: 'Wake on schedule (no background process)',
    help: 'Your system checks for due reminders every few minutes, even when Maybe Pile is completely closed, and nothing stays running in between. Needs a per-user scheduled task (Windows) or systemd timer (Linux). Snooze buttons may not be available everywhere.',
  },
};

const PRIVACY_OPTIONS: { value: PrivacyLevel; label: string }[] = [
  { value: 'titles', label: 'Show titles' },
  { value: 'generic', label: 'Hide titles (generic text)' },
  { value: 'count', label: 'Count only' },
];

const THRESHOLD_LABEL: Partial<
  Record<NotificationCategory, { label: string; min: number; max: number; hint?: string }>
> = {
  keepGoing: { label: 'Nudge after this many days without progress', min: 1, max: 60 },
  releases: { label: 'Also remind this many days before (0 = only on the day)', min: 0, max: 30 },
  leavingSoon: {
    label: 'First reminder this many days before it leaves',
    min: 1,
    max: 60,
    hint: 'A second reminder comes the day before.',
  },
  backup: { label: 'Remind when the last backup is older than (days)', min: 1, max: 365 },
  sessionRunning: { label: 'Remind when a timer has run this many hours', min: 1, max: 48 },
  checkup: { label: 'Remind when the last check-up is older than (days)', min: 7, max: 365 },
};

const UNSCHEDULED: ReadonlySet<NotificationCategory> = new Set(['custom', 'sessionRunning', 'offlineQueue']);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function NotificationsSettings() {
  const app = useApp();
  const ctl = useNotifications(app.settings?.notifications ?? null, () => app.reloadSettings());
  if (!ctl.settings) return <Loading />;
  return (
    <div className="notifications-settings">
      <LiveRegion message={ctl.liveMessage} />
      <ModeSection ctl={ctl} />
      <StatusPanel ctl={ctl} />
      <GlobalSection ctl={ctl} />
      <section className="subsection" aria-labelledby="ns-cats">
        <h3 id="ns-cats">What to remind you about</h3>
        <p className="muted">
          Every category is off until you turn it on. Digests are preferred over many separate notifications.
        </p>
        <div className="category-cards">
          {NOTIFICATION_CATEGORIES.map((c) => (
            <CategoryCard key={c} ctl={ctl} category={c} />
          ))}
        </div>
      </section>
      <section className="subsection" aria-labelledby="ns-rem">
        <h3 id="ns-rem">Custom reminders</h3>
        <RemindersManager />
      </section>
      <HistorySection />
      <ConfirmComponentsDialog ctl={ctl} />
    </div>
  );
}

export function ModeSection({ ctl }: { ctl: NotifyCtl }) {
  const s = ctl.settings ?? DEFAULT_NOTIFICATION_SETTINGS;
  const st = ctl.status;
  const name = useId();
  const bgUnsupported = st ? !st.backgroundSupported : false;
  const set = (patch: Partial<NotificationSettings>) => void ctl.apply({ ...s, ...patch });
  return (
    <section className="subsection" aria-labelledby="ns-mode">
      <h3 id="ns-mode">Delivery mode</h3>
      <p className="muted">
        We recommend <strong>Keep running in the background</strong> (instant, click to open) or{' '}
        <strong>Wake on schedule</strong> (works when the app is fully closed, nothing runs in between). You
        can change this any time; the old mode is cleaned up.
      </p>
      <fieldset className="mode-picker">
        <legend className="visually-hidden">Delivery mode</legend>
        {(Object.keys(MODE_TEXT) as DeliveryMode[]).map((m) => {
          const disabled = (m === 'tray' || m === 'scheduled') && bgUnsupported;
          return (
            <label key={m} className={`mode-option ${s.mode === m ? 'mode-selected' : ''}`}>
              <input
                type="radio"
                name={name}
                checked={s.mode === m}
                disabled={disabled || ctl.busy}
                onChange={() => set({ mode: m })}
              />
              <span>
                <strong>{MODE_TEXT[m].label}</strong>
                {s.mode === m && <span className="visually-hidden"> (selected)</span>}
                <span className="mode-help">{MODE_TEXT[m].help}</span>
                {disabled && <span className="mode-help">Needs the installed Windows or Linux app.</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      {st?.os === 'macos' && (
        <Notice kind="info">
          macOS: only “While the app is open” and the tray mode are available, and they are untested.
        </Notice>
      )}
      {st && !st.trayAvailable && s.mode === 'tray' && (
        <Notice kind="warning">
          Your desktop has no tray area, so closing the window minimizes Maybe Pile instead of hiding it.
          “Wake on schedule” works better here.
        </Notice>
      )}
      {st?.portable && (s.mode === 'tray' || s.mode === 'scheduled') && (
        <Notice kind="info">
          Portable copy: if you move this folder, open Maybe Pile once so it can repair its background task.
        </Notice>
      )}
      {st?.appImage && (s.mode === 'tray' || s.mode === 'scheduled') && (
        <Notice kind="info">
          AppImage: keep the file in one place. If you move it, open it once so it can repair its background
          task.
        </Notice>
      )}
      {s.mode === 'tray' && (
        <div className="indent">
          <Toggle
            label="Closing the window keeps Maybe Pile in the tray"
            checked={s.closeToTray}
            onChange={(v) => set({ closeToTray: v })}
          />
          <Toggle
            label="Start at login (hidden in the tray)"
            checked={s.startAtLogin}
            onChange={(v) => set({ startAtLogin: v })}
          />
          <Toggle
            label="Also wake on schedule when the app is closed"
            hint="Both together never cause duplicates."
            checked={s.alsoScheduled}
            onChange={(v) => set({ alsoScheduled: v })}
            disabled={bgUnsupported || st?.os === 'macos'}
          />
        </div>
      )}
      {(s.mode === 'scheduled' || (s.mode === 'tray' && s.alsoScheduled)) && (
        <div className="indent">
          <SelectField
            label="Check every"
            value={String(s.intervalMinutes)}
            onChange={(v) => set({ intervalMinutes: Number(v) })}
            options={CHECK_INTERVALS.map((m) => ({ value: String(m), label: `${m} minutes` }))}
          />
        </div>
      )}
    </section>
  );
}

function GlobalSection({ ctl }: { ctl: NotifyCtl }) {
  const s = ctl.settings ?? DEFAULT_NOTIFICATION_SETTINGS;
  const toast = useToast();
  const set = (patch: Partial<NotificationSettings>) => void ctl.apply({ ...s, ...patch });
  const [tzDraft, setTzDraft] = useState(s.timeZone ?? '');
  const pause = async (duration: '1h' | 'tomorrow' | 'indefinite' | 'resume') => {
    try {
      const r = await call(getApi().notify.pause({ duration }));
      const msg = r.pausedUntil ? 'Notifications paused.' : 'Notifications resumed.';
      ctl.setLiveMessage(msg);
      toast.success(msg);
      ctl.reloadStatus();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const days = (key: 'allowedDays', label: string) => (
    <fieldset className="field">
      <legend>{label}</legend>
      <div className="day-row">
        {WEEKDAYS.map((d, i) => (
          <label key={d}>
            <input
              type="checkbox"
              checked={s[key].includes(i)}
              onChange={(e) => {
                const next = e.target.checked ? [...s[key], i] : s[key].filter((x) => x !== i);
                if (next.length > 0) set({ [key]: next.sort() } as Partial<NotificationSettings>);
              }}
            />{' '}
            {d.slice(0, 3)}
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <section className="subsection" aria-labelledby="ns-global">
      <h3 id="ns-global">General</h3>
      <SelectField
        label="What notifications may show"
        hint="Titles can appear on your lock screen. Choose “Hide titles” if others can see your screen. Notes, ratings and prices are never shown."
        value={s.privacy}
        onChange={(v) => set({ privacy: v })}
        options={PRIVACY_OPTIONS}
      />
      {s.privacy === 'titles' && (
        <button type="button" className="button button-small" onClick={() => set({ privacy: 'generic' })}>
          Hide titles instead
        </button>
      )}
      <Toggle
        label="Quiet hours"
        hint="Reminders due during quiet hours wait until they end (one summary); timer alerts are skipped."
        checked={s.quietHours.enabled}
        onChange={(v) => set({ quietHours: { ...s.quietHours, enabled: v } })}
      />
      {s.quietHours.enabled && (
        <div className="indent">
          <div className="field-row">
            <TextField
              label="From"
              type="time"
              value={s.quietHours.start}
              onChange={(v) => v && set({ quietHours: { ...s.quietHours, start: v } })}
            />
            <TextField
              label="Until"
              type="time"
              value={s.quietHours.end}
              onChange={(v) => v && set({ quietHours: { ...s.quietHours, end: v } })}
            />
          </div>
          <fieldset className="field">
            <legend>Quiet hours start on</legend>
            <div className="day-row">
              {WEEKDAYS.map((d, i) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    checked={s.quietHours.days.includes(i)}
                    onChange={(e) =>
                      set({
                        quietHours: {
                          ...s.quietHours,
                          days: (e.target.checked
                            ? [...s.quietHours.days, i]
                            : s.quietHours.days.filter((x) => x !== i)
                          ).sort(),
                        },
                      })
                    }
                  />{' '}
                  {d.slice(0, 3)}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
      {days('allowedDays', 'Days notifications may arrive')}
      <NumberField
        label="At most this many notifications per day"
        value={s.dailyCap}
        min={1}
        max={50}
        onChange={(v) => v && v >= 1 && v <= 50 && set({ dailyCap: v })}
        hint="Anything beyond this is combined into one summary."
      />
      <SelectField
        label="If the computer was off or asleep"
        value={s.catchUp}
        onChange={(v) => set({ catchUp: v })}
        options={[
          { value: 'catchUp', label: 'Catch up: one “while you were away” summary (last 24 h)' },
          { value: 'skip', label: 'Skip missed reminders' },
        ]}
      />
      <Toggle label="Sound" checked={s.sound} onChange={(v) => set({ sound: v })} />
      <Toggle
        label="Show the next episode (e.g. “next: S1E12”)"
        hint="Spoiler Shield still hides it for shielded items."
        checked={s.showNextEpisode}
        onChange={(v) => set({ showNextEpisode: v })}
      />
      <Toggle
        label="Show people's names in loan reminders"
        checked={s.showPeopleNames}
        onChange={(v) => set({ showPeopleNames: v })}
      />
      <div className="field-row">
        <TextField
          label="Time zone"
          hint="Leave empty to follow your computer. Example: Europe/Berlin."
          value={tzDraft}
          onChange={setTzDraft}
          maxLength={64}
        />
        <button
          type="button"
          className="button"
          onClick={() => set({ timeZone: tzDraft.trim() === '' ? null : tzDraft.trim() })}
        >
          Apply time zone
        </button>
      </div>
      <NumberField
        label="Keep notification history for (days)"
        value={s.historyDays}
        min={7}
        max={365}
        onChange={(v) => v && v >= 7 && v <= 365 && set({ historyDays: v })}
      />
      <div className="button-row" role="group" aria-label="Pause notifications">
        <span>Pause all:</span>
        <button type="button" className="button button-small" onClick={() => void pause('1h')}>
          1 hour
        </button>
        <button type="button" className="button button-small" onClick={() => void pause('tomorrow')}>
          Until tomorrow 08:00
        </button>
        <button type="button" className="button button-small" onClick={() => void pause('indefinite')}>
          Until I resume
        </button>
        <button type="button" className="button button-small" onClick={() => void pause('resume')}>
          Resume
        </button>
      </div>
    </section>
  );
}

function CategoryCard({ ctl, category }: { ctl: NotifyCtl; category: NotificationCategory }) {
  const app = useApp();
  const s = ctl.settings ?? DEFAULT_NOTIFICATION_SETTINGS;
  const c = s.categories[category];
  const simple = app.settings?.interface.level === 'simple';
  const label = (simple ? CATEGORY_SIMPLE_LABELS[category] : undefined) ?? CATEGORY_LABELS[category];
  const set = (patch: Partial<CategoryConfig>) =>
    void ctl.apply({
      ...s,
      preset: 'custom',
      categories: { ...s.categories, [category]: { ...c, ...patch } },
    });
  const th = THRESHOLD_LABEL[category];
  const headingId = useId();
  return (
    <section className={`category-card ${c.enabled ? 'card-on' : ''}`} aria-labelledby={headingId}>
      <h4 id={headingId}>{label}</h4>
      <Toggle label={`Notify me: ${label}`} checked={c.enabled} onChange={(v) => set({ enabled: v })} />
      {c.enabled && (
        <>
          {!UNSCHEDULED.has(category) && (
            <div className="field-row">
              {(category === 'upNext' ||
                category === 'goalsPace' ||
                category === 'pileHealth' ||
                category === 'weeklySummary' ||
                category === 'backup' ||
                category === 'checkup') && (
                <SelectField
                  label="How often"
                  value={c.frequency}
                  onChange={(v) => set({ frequency: v })}
                  options={[
                    { value: 'daily', label: 'Daily' },
                    { value: 'weekly', label: 'Weekly' },
                  ]}
                />
              )}
              {c.frequency === 'weekly' && (
                <SelectField
                  label="On"
                  value={String(c.weekday)}
                  onChange={(v) => set({ weekday: Number(v) })}
                  options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
                />
              )}
              <TextField label="At" type="time" value={c.time} onChange={(v) => v && set({ time: v })} />
            </div>
          )}
          {th && (
            <NumberField
              label={th.label}
              hint={th.hint}
              value={c.threshold}
              min={th.min}
              max={th.max}
              onChange={(v) => v !== null && v >= th.min && v <= th.max && set({ threshold: v })}
            />
          )}
          <div className="field-row">
            <SelectField
              label="Privacy for this category"
              value={c.privacy}
              onChange={(v) => set({ privacy: v })}
              options={[{ value: 'inherit', label: 'Same as General' }, ...PRIVACY_OPTIONS]}
            />
            <NumberField
              label="At most per day"
              value={c.cap}
              min={1}
              max={20}
              onChange={(v) => v && v >= 1 && v <= 20 && set({ cap: v })}
            />
          </div>
          <Preview category={category} settings={s} />
        </>
      )}
    </section>
  );
}

export function Preview({
  category,
  settings,
}: {
  category: NotificationCategory;
  settings: NotificationSettings;
}) {
  const [p, setP] = useState<PreviewView | null>(null);
  const key = JSON.stringify([
    category,
    settings.privacy,
    settings.categories[category],
    settings.showNextEpisode,
    settings.showPeopleNames,
  ]);
  useEffect(() => {
    let alive = true;
    void call(getApi().notify.preview({ category, settings }))
      .then((r) => alive && setP(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!p) return null;
  return (
    <figure className="notify-preview">
      <figcaption>
        {p.example
          ? 'Preview (example — nothing is due right now)'
          : 'Preview (exactly what it would say now)'}
      </figcaption>
      <div className="notify-preview-box">
        <strong>{p.title}</strong>
        <span>{p.body}</span>
      </div>
    </figure>
  );
}

function HistorySection() {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const h = useAsync(() => call(getApi().notify.history({ days })), [days]);
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="subsection" aria-labelledby="ns-hist">
      <h3 id="ns-hist">Notification history</h3>
      <p className="muted">Helps answer “why didn't I get X?”. Titles are shown here only, inside the app.</p>
      <SelectField
        label="Show"
        value={String(days)}
        onChange={(v) => setDays(Number(v))}
        options={[
          { value: '7', label: 'Last 7 days' },
          { value: '30', label: 'Last 30 days' },
          { value: '90', label: 'Last 90 days' },
        ]}
      />
      {h.loading && !h.data ? (
        <Loading />
      ) : h.error ? (
        <ErrorBox error={h.error} onRetry={h.reload} />
      ) : (h.data ?? []).length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <table className="table">
          <caption className="visually-hidden">Notification history</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Category</th>
              <th scope="col">About</th>
              <th scope="col">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {(h.data ?? []).map((e: HistoryEntryView) => (
              <tr key={e.id}>
                <td>{fmtDateTime(e.at)}</td>
                <td>
                  {e.categoryLabel}
                  {e.kind === 'digest' ? ' (summary)' : ''}
                </td>
                <td>{e.itemTitle ?? '—'}</td>
                <td>
                  {e.outcomeLabel}
                  {e.reason ? ` — ${e.reason}` : ''}
                  {e.clickedAt ? ' · clicked' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="button" onClick={() => setConfirm(true)}>
        Clear history
      </button>
      {confirm && (
        <ConfirmDialog
          title="Clear notification history?"
          message="Entries older than two days are deleted (newer ones are kept so nothing is sent twice)."
          confirmLabel="Clear history"
          destructive
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void call(getApi().notify.clearHistory())
              .then((r) => {
                toast.success(`Removed ${r.removed} entries.`);
                h.reload();
              })
              .catch((e: unknown) => toast.error(errorOf(e)));
          }}
        />
      )}
    </section>
  );
}
