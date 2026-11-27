/**
 * Simple Mode reminders: one card. On/Off, How often (presets), Quiet hours,
 * Works when the app is closed. Presets never silently overwrite categories
 * the user customized: switching then asks first.
 */
import { useId, useState } from 'react';
import {
  applyPreset,
  DEFAULT_NOTIFICATION_SETTINGS,
  presetDiverged,
  type NotificationSettings,
  type Preset,
} from '../../../shared/notification-settings';
import { switchToFull, useApp } from '../../app/context';
import { ConfirmDialog } from '../../components/Dialog';
import { Loading, Notice } from '../../components/Bits';
import { ConfirmComponentsDialog, LiveRegion, StatusPanel, Toggle, useNotifications } from './shared';

const PRESET_HELP: Record<Exclude<Preset, 'custom'>, string> = {
  rarely:
    'Only the important things: your own reminders, releases, a nudge after a week, backups. At most 2 a day.',
  sometimes: 'Adds Up Next, leaving-soon dates, goal check-ins and long-running timers. At most 4 a day.',
  often: 'Everything, including weekly summaries. At most 6 a day.',
};

export function SimpleReminders() {
  const app = useApp();
  const ctl = useNotifications(app.settings?.notifications ?? null, () => app.reloadSettings());
  const [askPreset, setAskPreset] = useState<Exclude<Preset, 'custom'> | null>(null);
  const name = useId();
  const closedName = useId();
  if (!ctl.settings) return <Loading />;
  const s = ctl.settings;
  const on = s.mode !== 'off';
  const closedMode = s.mode === 'tray' || s.mode === 'scheduled';
  const set = (next: NotificationSettings) => void ctl.apply(next);
  const dontAsk = app.settings?.interface.dontAsk ?? [];

  const choosePreset = (p: Exclude<Preset, 'custom'>) => {
    if (presetDiverged(s) && s.preset !== p && !dontAsk.includes('notify.preset-overwrite')) setAskPreset(p);
    else set(applyPreset(s, p));
  };
  const turnOn = (v: boolean) => {
    if (!v) return set({ ...s, mode: 'off', alsoScheduled: false, startAtLogin: false });
    const anyOn = Object.values(s.categories).some((c) => c.enabled);
    const base = anyOn ? s : applyPreset(s, 'sometimes');
    set({ ...base, mode: 'whileOpen' });
  };

  return (
    <div className="simple-card">
      <LiveRegion message={ctl.liveMessage} />
      <h3>Reminders</h3>
      <p className="muted">
        Gentle nudges about what you're watching, playing or reading. Off until you turn them on.
      </p>
      <Toggle label="Reminders" checked={on} onChange={turnOn} disabled={ctl.busy} />
      {on && (
        <>
          <fieldset className="field">
            <legend>How often</legend>
            {(['rarely', 'sometimes', 'often'] as const).map((p) => (
              <label key={p} className="mode-option">
                <input type="radio" name={name} checked={s.preset === p} onChange={() => choosePreset(p)} />
                <strong>{p.charAt(0).toUpperCase() + p.slice(1)}</strong>
                <span className="mode-help">{PRESET_HELP[p]}</span>
              </label>
            ))}
            {s.preset === 'custom' && (
              <p className="field-hint">You customized individual reminders in Advanced.</p>
            )}
          </fieldset>
          <Toggle
            label={`Quiet hours (${s.quietHours.start}–${s.quietHours.end})`}
            hint="Nothing arrives during quiet hours; anything due waits until they end."
            checked={s.quietHours.enabled}
            onChange={(v) =>
              set({
                ...s,
                quietHours: v
                  ? { ...DEFAULT_NOTIFICATION_SETTINGS.quietHours, ...s.quietHours, enabled: true }
                  : { ...s.quietHours, enabled: false },
              })
            }
          />
          <fieldset className="field">
            <legend>Works when the app is closed</legend>
            <label className="mode-option">
              <input
                type="radio"
                name={closedName}
                checked={!closedMode}
                onChange={() => set({ ...s, mode: 'whileOpen', alsoScheduled: false, startAtLogin: false })}
              />
              <strong>No</strong>
              <span className="mode-help">
                Reminders arrive only while Maybe Pile is open. Nothing is installed.
              </span>
            </label>
            <label className="mode-option">
              <input
                type="radio"
                name={closedName}
                checked={s.mode === 'tray'}
                disabled={ctl.status ? !ctl.status.backgroundSupported : false}
                onChange={() => set({ ...s, mode: 'tray', closeToTray: true, startAtLogin: true })}
              />
              <strong>Yes — keep Maybe Pile running in the tray</strong>
              <span className="mode-help">
                Closing the window hides it near the clock. It starts hidden when you log in.
              </span>
            </label>
            <label className="mode-option">
              <input
                type="radio"
                name={closedName}
                checked={s.mode === 'scheduled'}
                disabled={ctl.status ? !ctl.status.backgroundSupported || ctl.status.os === 'macos' : false}
                onChange={() => set({ ...s, mode: 'scheduled' })}
              />
              <strong>Yes — let my computer check every 15 minutes</strong>
              <span className="mode-help">
                Nothing stays running. Your computer starts a tiny check now and then, even when Maybe Pile is
                closed.
              </span>
            </label>
            {ctl.status && !ctl.status.backgroundSupported && (
              <p className="field-hint">“Yes” needs the installed Windows or Linux app.</p>
            )}
          </fieldset>
          {ctl.status && !ctl.status.trayAvailable && s.mode === 'tray' && (
            <Notice kind="warning">
              Your desktop has no tray area. “Let my computer check” works better here.
            </Notice>
          )}
        </>
      )}
      <StatusPanel ctl={ctl} compact />
      <p>
        {app.settings?.interface.level === 'full' ? (
          <a href="#/settings/notifications">Advanced reminder settings…</a>
        ) : (
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              void switchToFull(app).then(() => app.navigate({ name: 'settings', tab: 'notifications' }))
            }
          >
            Advanced… (switches to Full mode)
          </button>
        )}
      </p>
      {askPreset && (
        <ConfirmDialog
          title="Replace your custom reminder choices?"
          message={
            <>
              <p>
                You changed individual reminder types in Advanced settings. “{askPreset}” will switch reminder
                types on and off to match the preset (times and privacy stay as you set them).
              </p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  onChange={(e) =>
                    app.settings &&
                    void app.updateSettings({
                      interface: {
                        ...app.settings.interface,
                        dontAsk: e.target.checked
                          ? [...dontAsk, 'notify.preset-overwrite']
                          : dontAsk.filter((d) => d !== 'notify.preset-overwrite'),
                      },
                    })
                  }
                />{' '}
                Don't ask again
              </label>
            </>
          }
          confirmLabel={`Use “${askPreset}”`}
          onCancel={() => setAskPreset(null)}
          onConfirm={() => {
            const p = askPreset;
            setAskPreset(null);
            set(applyPreset(s, p));
          }}
        />
      )}
      <ConfirmComponentsDialog ctl={ctl} />
    </div>
  );
}
