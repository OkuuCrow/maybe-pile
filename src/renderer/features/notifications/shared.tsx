/**
 * Shared notification UI: the settings hook (apply with confirmation), the
 * confirmation dialog listing exactly what will be created, the status panel
 * and a labelled on/off switch.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import type { NotificationSettings } from '../../../shared/notification-settings';
import type { NotifyStatusView, PlannedComponentView } from '../../../shared/notification-contract';
import { call, errorOf, getApi } from '../../app/api';
import { fmtDateTime } from '../../app/strings';
import { useToast } from '../../app/toast';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Bits';

/** On/off switch with a visible text state (never color alone). */
export function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={`switch ${checked ? 'switch-on' : ''}`}
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span className="switch-label">{label}</span>
        <span className="switch-state">{checked ? 'On' : 'Off'}</span>
      </button>
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

export interface NotifyCtl {
  status: NotifyStatusView | null;
  settings: NotificationSettings | null;
  busy: boolean;
  /** Saves; asks for confirmation (dialog) when background components change. */
  apply: (next: NotificationSettings) => Promise<boolean>;
  reloadStatus: () => void;
  pending: { settings: NotificationSettings; components: PlannedComponentView[] } | null;
  confirmPending: () => Promise<void>;
  cancelPending: () => void;
  liveMessage: string;
  setLiveMessage: (m: string) => void;
}

export function useNotifications(
  initial: NotificationSettings | null,
  onSaved?: (s: NotificationSettings) => void,
): NotifyCtl {
  const toast = useToast();
  const [settings, setSettings] = useState<NotificationSettings | null>(initial);
  const [status, setStatus] = useState<NotifyStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<NotifyCtl['pending']>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (initial && !settings) setSettings(initial);
  }, [initial, settings]);
  useEffect(() => {
    let alive = true;
    void call(getApi().notify.status())
      .then((s) => alive && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tick]);
  const reloadStatus = useCallback(() => setTick((t) => t + 1), []);

  const run = useCallback(
    async (next: NotificationSettings, confirmed: boolean): Promise<boolean> => {
      setBusy(true);
      try {
        const r = await call(getApi().notify.apply({ settings: next, confirmed }));
        if (r.needsConfirmation) {
          setPending({ settings: next, components: r.components });
          return false;
        }
        if (!r.ok) {
          toast.error(r.error ?? 'Could not save notification settings.');
          setLiveMessage(r.error ?? 'Could not save.');
          setSettings(r.settings);
          return false;
        }
        setSettings(r.settings);
        onSaved?.(r.settings);
        setLiveMessage('Notification settings saved.');
        reloadStatus();
        return true;
      } catch (e) {
        toast.error(errorOf(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast, onSaved, reloadStatus],
  );

  return {
    status,
    settings,
    busy,
    apply: (n) => run(n, false),
    reloadStatus,
    pending,
    confirmPending: async () => {
      if (!pending) return;
      const p = pending;
      setPending(null);
      await run(p.settings, true);
    },
    cancelPending: () => {
      setPending(null);
      setLiveMessage('Nothing was created.');
    },
    liveMessage,
    setLiveMessage,
  };
}

/** Lists exactly what will be created and where, with the undo for each item. */
export function ConfirmComponentsDialog({ ctl }: { ctl: NotifyCtl }) {
  if (!ctl.pending) return null;
  const c = ctl.pending.components;
  return (
    <Dialog
      title="Set up background reminders?"
      onClose={ctl.cancelPending}
      size="large"
      role="alertdialog"
      footer={
        <>
          <button type="button" className="button" onClick={ctl.cancelPending}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void ctl.confirmPending()}
            disabled={ctl.busy}
          >
            Create {c.length === 1 ? 'it' : `these ${c.length}`}
          </button>
        </>
      }
    >
      <p>
        Maybe Pile will create the following for <strong>your account only</strong>. No administrator rights
        are needed, and you can remove everything later with <strong>Remove background components</strong>.
      </p>
      <ul className="component-list" aria-label="What will be created">
        {c.map((x) => (
          <li key={x.id}>
            <p className="component-label">{x.label}</p>
            <dl className="component-meta">
              <dt>Where</dt>
              <dd>
                <code>{x.location}</code>
              </dd>
              <dt>Runs</dt>
              <dd>
                <code>{x.detail}</code>
              </dd>
              <dt>Undo</dt>
              <dd>
                <code>{x.undo}</code>
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

const STATE_TEXT: Record<NotifyStatusView['service']['state'], string> = {
  not_installed: 'Not installed',
  healthy: 'Installed and healthy',
  path_changed: 'Installed, but points to an old copy (repair)',
  disabled_by_os: 'Installed, but disabled by the system',
  error: 'Error',
  unsupported: 'Not supported here',
  not_needed: 'Not needed for this mode',
};

/** Reminder service status + Test / Run check now / Repair / Remove. */
export function StatusPanel({ ctl, compact = false }: { ctl: NotifyCtl; compact?: boolean }) {
  const toast = useToast();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const s = ctl.status;
  if (!s) return <p className="muted">Checking reminder status…</p>;
  const bad = ['path_changed', 'disabled_by_os', 'error'].includes(s.service.state);
  const test = async () => {
    try {
      const r = await call(getApi().notify.test());
      const msg = r.delivered
        ? r.adapter === 'in-app'
          ? 'The system could not show it, so it appeared inside Maybe Pile instead.'
          : 'Test notification sent. If you did not see it, check the troubleshooting tips below.'
        : `The test notification could not be shown${r.reason ? ` (${r.reason})` : ''}.`;
      ctl.setLiveMessage(msg);
      (r.delivered ? toast.success : toast.error)(msg);
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const runNow = async () => {
    try {
      const r = await call(getApi().notify.runNow());
      const msg = r.paused
        ? 'Notifications are paused.'
        : r.delivered > 0
          ? `${r.delivered} reminder${r.delivered === 1 ? '' : 's'} sent.`
          : r.deferred > 0
            ? `${r.deferred} reminder${r.deferred === 1 ? ' is' : 's are'} waiting for quiet hours to end.`
            : 'Nothing is due right now.';
      ctl.setLiveMessage(msg);
      toast.show({ kind: 'info', message: msg });
      ctl.reloadStatus();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const repair = async () => {
    try {
      await call(getApi().notify.repair());
      ctl.setLiveMessage('Background components repaired.');
      toast.success('Background components repaired.');
      ctl.reloadStatus();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  const remove = async () => {
    setConfirmRemove(false);
    try {
      const r = await call(getApi().notify.removeBackground());
      const msg = r.verified
        ? 'All background components were removed (checked again to be sure).'
        : `Some components could not be removed: ${r.remaining.join(', ')}. See the troubleshooting guide for manual steps.`;
      ctl.setLiveMessage(msg);
      (r.verified ? toast.success : toast.error)(msg);
      ctl.reloadStatus();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  return (
    <section className="status-panel" aria-labelledby="notify-status-h">
      <h4 id="notify-status-h">Reminder service status</h4>
      {!s.stateAvailable && (
        <Notice kind="warning">{s.stateError ?? 'Notifications are unavailable.'}</Notice>
      )}
      {s.notices.map((n) => (
        <Notice key={n} kind="info">
          {n}
        </Notice>
      ))}
      <dl className="status-grid">
        <dt>Background components</dt>
        <dd>
          <span
            className={`status-pill ${bad ? 'status-bad' : s.service.state === 'healthy' ? 'status-good' : ''}`}
          >
            {bad ? '⚠ ' : s.service.state === 'healthy' ? '✓ ' : ''}
            {STATE_TEXT[s.service.state]}
          </span>
          {!compact && s.service.message && <span className="muted"> — {s.service.message}</span>}
        </dd>
        <dt>Notifications on this computer</dt>
        <dd>
          {s.adapter.available
            ? 'Available'
            : `Not available${s.adapter.reason ? ` — ${s.adapter.reason}` : ''}`}
        </dd>
        <dt>Last check</dt>
        <dd>{s.lastCheckAt ? fmtDateTime(s.lastCheckAt) : 'Not yet'}</dd>
        <dt>Next check</dt>
        <dd>
          {s.nextCheckAt
            ? fmtDateTime(s.nextCheckAt)
            : s.mode === 'off'
              ? '—'
              : 'When the app or the scheduler next runs'}
        </dd>
        {s.pausedUntil && (
          <>
            <dt>Paused</dt>
            <dd>
              {new Date(s.pausedUntil).getFullYear() > 9000
                ? 'Until you resume'
                : `Until ${fmtDateTime(s.pausedUntil)}`}
            </dd>
          </>
        )}
      </dl>
      {!compact && s.service.components.length > 0 && (
        <ul className="component-status">
          {s.service.components.map((c) => (
            <li key={c.id}>
              {c.ok ? '✓' : '⚠'} {c.id}
              {c.problem ? ` — ${c.problem}` : ''}
            </li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button type="button" className="button" onClick={() => void test()}>
          Test notification
        </button>
        {!compact && (
          <button type="button" className="button" onClick={() => void runNow()} disabled={s.mode === 'off'}>
            Run check now
          </button>
        )}
        {bad && (
          <button type="button" className="button button-primary" onClick={() => void repair()}>
            Repair
          </button>
        )}
        <button
          type="button"
          className="button"
          onClick={() => setConfirmRemove(true)}
          disabled={!s.backgroundSupported}
        >
          Remove background components
        </button>
      </div>
      {confirmRemove && (
        <ConfirmDialog
          title="Remove background components?"
          message="This deletes the scheduled task / timer and the start-at-login entry Maybe Pile created. Reminders then only arrive while the app is open. Your reminders and settings are kept."
          confirmLabel="Remove"
          destructive
          onConfirm={() => void remove()}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </section>
  );
}

/** Polite live region for status changes. */
export function LiveRegion({ message }: { message: string }) {
  return (
    <p className="visually-hidden" role="status" aria-live="polite">
      {message}
    </p>
  );
}
