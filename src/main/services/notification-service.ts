/**
 * Notifications + custom reminders (2.1). Electron-free: OS specifics
 * (notifier, installer, tray probe) are injected by main.ts, fakes in tests.
 *
 * - Background components are only created by `apply` after the user
 *   confirmed the exact list returned by `plan`; a failed install leaves the
 *   previous (working) settings in place.
 * - The state DB failing to open never breaks the app: notifications degrade
 *   to off with a visible status.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readSettings, writeSettings } from '../../db/repositories/config-repo';
import type { Notifier } from '../../notifications/adapters/types';
import { GENERATORS } from '../../notifications/engine/categories';
import { nextOccurrence, validateRule } from '../../notifications/engine/repeat';
import { addDays, localDateString, resolveTimeZone, zonedToUtc } from '../../notifications/engine/time';
import type { PlannedNotification, RepeatRule } from '../../notifications/engine/types';
import type { ProtocolCommand } from '../../notifications/protocol';
import type { Installer, PlannedComponent } from '../../notifications/registration/installer';
import { runCheck, lastCheckKey, type RunMode, type RunReport } from '../../notifications/runner';
import { buildSnapshot, maskFromWeekdays, weekdaysFromMask } from '../../notifications/snapshot';
import { DEFAULT_LIBRARY_ID, NotifyState } from '../../notifications/state/notify-state';
import { STATE_FILE } from '../../notifications/helper';
import { appError } from '../../shared/result';
import {
  CATEGORY_LABELS,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationCategory,
  type NotificationSettings,
} from '../../shared/notification-settings';
import {
  OUTCOME_LABELS,
  type ApplyResultView,
  type HistoryEntryView,
  type ItemNotifyControlsView,
  type NotifyStatusView,
  type PreviewView,
  type ReminderInput,
  type ReminderView,
} from '../../shared/notification-contract';
import type { ServiceContext } from './context';

export interface NotificationPlatform {
  os: NodeJS.Platform;
  installer: Installer | null;
  /** OS notifier for in-process delivery (Electron Notification). */
  notifier: Notifier;
  /** In-app banner, used when OS delivery fails while a window is open. */
  inApp: Notifier | null;
  trayAvailable: () => boolean;
  osTimeZone?: () => string;
  portable?: boolean;
  appImage?: boolean;
  /** Main reconfigures tray / timers after a mode change. */
  onModeChanged?: (s: NotificationSettings) => void;
  /** Resident timer's next tick, if running. */
  nextResidentCheck?: () => Date | null;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ruleLabel(rule: RepeatRule | null, time: string): string {
  if (!rule) return `Once at ${time}`;
  const every = (n: number, one: string, many: string) => (n === 1 ? `Every ${one}` : `Every ${n} ${many}`);
  switch (rule.freq) {
    case 'daily':
      return `${every(rule.interval, 'day', 'days')} at ${time}`;
    case 'weekly':
      return `${every(rule.interval, 'week', 'weeks')} at ${time}`;
    case 'monthly':
      return `${every(rule.interval, 'month', 'months')} at ${time}`;
    case 'weekdays':
      return `${rule.weekdays.map((d) => WEEKDAY_SHORT[d]).join(', ')} at ${time}`;
  }
}

export class NotificationService {
  private state: NotifyState | null = null;
  private stateError: string | null = null;
  readonly notices: string[] = [];
  readonly libraryId: string;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly platform: NotificationPlatform,
    opts: { libraryId?: string; statePath?: string } = {},
  ) {
    this.libraryId = opts.libraryId ?? DEFAULT_LIBRARY_ID;
    const statePath = opts.statePath ?? join(ctx.paths.userData, STATE_FILE);
    try {
      this.state = NotifyState.open(statePath);
    } catch (e) {
      this.stateError = 'The notification state file could not be opened, so notifications are off.';
      ctx.log.error('notify.stateOpenFailed', { error: e });
    }
  }

  private get db() {
    return this.ctx.db();
  }
  private now() {
    return this.ctx.clock.now();
  }
  get settings(): NotificationSettings {
    return readSettings(this.db).settings.notifications;
  }
  get tz(): string {
    return resolveTimeZone(this.settings.timeZone, this.platform.osTimeZone?.());
  }
  get stateDb(): NotifyState | null {
    return this.state;
  }

  private requireState(): NotifyState {
    if (!this.state)
      throw appError('INTERNAL', this.stateError ?? 'Notifications are unavailable.', {
        recovery: 'Restart Maybe Pile.',
      });
    return this.state;
  }

  close(): void {
    this.state?.close();
    this.state = null;
  }

  /**
   * One-time upgrade of the 1.x/2.0 opt-in notifiers (Release Radar, Leaving Soon), which only
   * worked while the app was open: users who had them on get "While the app is open" + the same categories.
   */
  migrateLegacyFlags(): void {
    const s = readSettings(this.db).settings;
    const stored = this.db.get('SELECT 1 AS x FROM settings WHERE key = ?', ['notifications']);
    if (stored) return;
    const radar = s.releaseRadar.notifications;
    const leaving = s.availability.notifications;
    if (!radar && !leaving) return;
    const next: NotificationSettings = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      mode: 'whileOpen',
      preset: 'custom',
      categories: {
        ...DEFAULT_NOTIFICATION_SETTINGS.categories,
        releases: { ...DEFAULT_NOTIFICATION_SETTINGS.categories.releases, enabled: radar },
        leavingSoon: {
          ...DEFAULT_NOTIFICATION_SETTINGS.categories.leavingSoon,
          enabled: leaving,
          threshold: s.availability.leavingSoonDays > 7 ? 7 : s.availability.leavingSoonDays,
        },
      },
    };
    writeSettings(this.db, { notifications: next });
    this.notices.push(
      'Your release and leaving-soon notifications moved to Settings → Notifications (still only while the app is open).',
    );
  }

  /* ---------------------------------------------------------------- status / apply */

  async status(): Promise<NotifyStatusView> {
    const s = this.settings;
    const os =
      this.platform.os === 'win32'
        ? 'windows'
        : this.platform.os === 'linux'
          ? 'linux'
          : this.platform.os === 'darwin'
            ? 'macos'
            : 'other';
    const needs = s.mode === 'tray' || s.mode === 'scheduled';
    let service: NotifyStatusView['service'] = {
      state: 'not_needed',
      message: 'No background components are needed for this mode.',
      components: [],
    };
    if (this.platform.installer && (needs || os === 'windows' || os === 'linux')) {
      try {
        const st = await this.platform.installer.status(s);
        service = {
          state: !needs && st.state === 'not_installed' ? 'not_needed' : st.state,
          message: st.message,
          components: st.components,
        };
      } catch {
        service = {
          state: 'error',
          message: 'Could not read the background component status.',
          components: [],
        };
      }
    } else if (!this.platform.installer && needs) {
      service = {
        state: 'unsupported',
        message: 'Background reminders are available on Windows and Linux only.',
        components: [],
      };
    }
    let adapter: NotifyStatusView['adapter'] = {
      id: this.platform.notifier.id,
      available: false,
      reason: null,
      actions: false,
    };
    try {
      const p = await this.platform.notifier.probe();
      adapter = {
        id: this.platform.notifier.id,
        available: p.available,
        reason: p.reason,
        actions: p.capabilities.actions,
      };
    } catch {
      adapter = { ...adapter, reason: 'Could not check the notification service.' };
    }
    const last = this.state?.getMeta(lastCheckKey(this.libraryId)) ?? null;
    const now = this.now();
    let next: string | null = null;
    if (s.mode === 'tray' || s.mode === 'whileOpen')
      next = this.platform.nextResidentCheck?.()?.toISOString() ?? null;
    else if (s.mode === 'scheduled' && last)
      next = new Date(Math.max(now.getTime(), Date.parse(last) + s.intervalMinutes * 60_000)).toISOString();
    return {
      mode: s.mode,
      os,
      backgroundSupported: !!this.platform.installer,
      trayAvailable: this.platform.trayAvailable(),
      stateAvailable: !!this.state,
      stateError: this.stateError,
      service,
      adapter,
      lastCheckAt: last,
      nextCheckAt: next,
      pausedUntil: this.state?.pausedUntil(now)?.toISOString() ?? null,
      notices: [...this.notices],
      portable: !!this.platform.portable,
      appImage: !!this.platform.appImage,
    };
  }

  plan(next: NotificationSettings): PlannedComponent[] {
    if (!this.platform.installer) return [];
    return this.platform.installer.plan(next);
  }

  /**
   * Saves notification settings. If background components change, the caller must
   * first show `components` and call again with confirmed = true.
   */
  async apply(next: NotificationSettings, confirmed: boolean): Promise<ApplyResultView> {
    const prev = this.settings;
    if (!this.state && next.mode !== 'off')
      return { ok: false, needsConfirmation: false, components: [], settings: prev, error: this.stateError };
    if (
      !this.platform.installer &&
      (next.mode === 'tray' || next.mode === 'scheduled') &&
      this.platform.os !== 'darwin'
    )
      return {
        ok: false,
        needsConfirmation: false,
        components: [],
        settings: prev,
        error: 'Background reminders are not available on this system.',
      };
    if (this.platform.os === 'darwin' && (next.mode === 'scheduled' || next.alsoScheduled))
      return {
        ok: false,
        needsConfirmation: false,
        components: [],
        settings: prev,
        error: 'Wake-on-schedule is not supported on macOS.',
      };
    let components: PlannedComponent[] = [];
    try {
      components = this.plan(next);
    } catch (e) {
      return {
        ok: false,
        needsConfirmation: false,
        components: [],
        settings: prev,
        error: e instanceof Error ? e.message : 'Unsupported path.',
      };
    }
    const bgKey = (s: NotificationSettings) =>
      JSON.stringify([s.mode, s.alsoScheduled, s.intervalMinutes, s.startAtLogin]);
    const bgChanged = bgKey(prev) !== bgKey(next);
    if (bgChanged && components.length > 0 && !confirmed)
      return { ok: false, needsConfirmation: true, components, settings: prev, error: null };
    if (bgChanged && this.platform.installer) {
      const r = await this.platform.installer.install(next);
      if (!r.ok) {
        this.ctx.log.warn('notify.installFailed');
        return { ok: false, needsConfirmation: false, components, settings: prev, error: r.error };
      }
    }
    writeSettings(this.db, { notifications: next });
    this.ctx.log.info('notify.settingsSaved', { mode: next.mode, alsoScheduled: next.alsoScheduled });
    this.platform.onModeChanged?.(next);
    return { ok: true, needsConfirmation: false, components, settings: next, error: null };
  }

  async repair(): Promise<NotifyStatusView> {
    if (this.platform.installer) {
      const r = await this.platform.installer.repair(this.settings);
      if (!r.ok)
        throw appError('INTERNAL', r.error ?? 'Repair failed.', {
          recovery: 'Try “Remove background components”, then turn the mode on again.',
        });
    }
    return this.status();
  }

  /** Removes every background component and switches the mode off if it needed them. */
  async removeBackground(): Promise<{ removed: string[]; verified: boolean; remaining: string[] }> {
    if (!this.platform.installer) return { removed: [], verified: true, remaining: [] };
    const r = await this.platform.installer.removeAll();
    const s = this.settings;
    if (s.mode === 'tray' || s.mode === 'scheduled') {
      const next = { ...s, mode: 'whileOpen' as const, alsoScheduled: false, startAtLogin: false };
      writeSettings(this.db, { notifications: next });
      this.platform.onModeChanged?.(next);
    }
    return r;
  }

  /**
   * Self-healing on launch: if the registered components point at an old executable
   * (updated/moved portable or AppImage), re-register and leave a visible note. A task
   * the user/OS disabled is *not* re-enabled silently.
   */
  async selfHeal(): Promise<void> {
    const s = this.settings;
    if (!this.platform.installer || (s.mode !== 'tray' && s.mode !== 'scheduled')) return;
    const st = await this.platform.installer.status(s);
    if (st.state === 'path_changed' || (st.state === 'error' && st.components.some((c) => c.present))) {
      const r = await this.platform.installer.repair(s);
      this.notices.push(
        r.ok
          ? 'Background reminders were updated to use this copy of Maybe Pile.'
          : 'Background reminders point to an old copy of Maybe Pile and could not be repaired. Open Settings → Notifications.',
      );
      this.ctx.log.info('notify.selfHeal', { ok: r.ok });
    } else if (st.state === 'not_installed') {
      // Settings came from a backup/another computer: registrations are never restored silently.
      const next = { ...s, mode: 'whileOpen' as const, alsoScheduled: false, startAtLogin: false };
      writeSettings(this.db, { notifications: next });
      this.platform.onModeChanged?.(next);
      this.notices.push(
        'Background reminders are not set up on this computer, so reminders now arrive only while the app is open. Turn them on again in Settings → Notifications.',
      );
    } else if (st.state === 'disabled_by_os') {
      this.notices.push(
        'Your reminder task was disabled outside Maybe Pile. Repair it in Settings → Notifications if you want it back.',
      );
    }
  }

  /* ---------------------------------------------------------------- delivery */

  async runCheck(mode: RunMode): Promise<RunReport | null> {
    if (!this.state) return null;
    return runCheck({
      libraryDb: this.db,
      state: this.state,
      notifier: this.platform.notifier,
      fallback: this.platform.inApp,
      now: () => this.now(),
      mode,
      libraryId: this.libraryId,
      log: this.ctx.log,
      ...(this.platform.osTimeZone ? { osTimeZone: this.platform.osTimeZone() } : {}),
    });
  }

  /** Sends a test notification (never claimed; recorded in the log as a test only). */
  async test(): Promise<{ delivered: boolean; adapter: string; reason: string | null }> {
    const n: PlannedNotification = {
      key: `test:${this.now().toISOString()}`,
      category: 'custom',
      kind: 'single',
      title: 'Maybe Pile',
      body: 'This is how your reminders will look.',
      itemId: null,
      urgency: 'normal',
      scheduledFor: this.now().toISOString(),
      actions: [{ id: 'open', label: 'Open', url: 'maybepile://open' }],
      memberKeys: [],
      members: [],
      openUrl: 'maybepile://open',
    };
    const r = await this.platform.notifier.show(n, { sound: this.settings.sound });
    this.ctx.log.info('notify.test', { adapter: this.platform.notifier.id, status: r.status });
    if (r.status === 'delivered')
      return { delivered: true, adapter: this.platform.notifier.id, reason: null };
    if (this.platform.inApp) {
      const f = await this.platform.inApp.show(n, { sound: false });
      if (f.status === 'delivered')
        return { delivered: true, adapter: this.platform.inApp.id, reason: r.reason };
    }
    return { delivered: false, adapter: this.platform.notifier.id, reason: r.reason };
  }

  history(days: number): HistoryEntryView[] {
    const st = this.requireState();
    const rows = st.history(this.libraryId, days, this.now());
    const titles = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.itemId).filter((x): x is string => !!x))) {
      const t = this.db.get<{ title: string }>('SELECT title FROM items WHERE id = ?', [id]);
      if (t) titles.set(id, t.title);
    }
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      categoryLabel: CATEGORY_LABELS[r.category] ?? r.category,
      kind: r.kind,
      itemTitle: r.itemId ? (titles.get(r.itemId) ?? null) : null,
      plannedFor: r.plannedFor,
      at: r.at,
      outcome: r.outcome,
      outcomeLabel: OUTCOME_LABELS[r.outcome] ?? r.outcome,
      reason: r.reason,
      mode: r.deliveryMode,
      adapter: r.adapter,
      clickedAt: r.clickedAt,
    }));
  }

  clearHistory(): number {
    return this.requireState().clearHistory(this.libraryId, this.now());
  }

  /** Exactly what a category would say right now (or a labelled example if nothing is due). */
  preview(category: NotificationCategory, settings: NotificationSettings): PreviewView {
    const now = this.now();
    const tz = resolveTimeZone(settings.timeZone, this.platform.osTimeZone?.());
    const cats = { ...settings.categories, [category]: { ...settings.categories[category], enabled: true } };
    const s = { ...settings, categories: cats };
    const empty = {
      isClaimed: () => false,
      lastDeliveredFor: () => null,
      deliveredSince: () => ({ total: 0, byCategory: {} }),
      snoozedUntil: () => null,
      isMuted: () => false,
      reminderSnoozes: () => [],
    };
    // Evaluate at the category's next scheduled time so the preview shows the real text.
    const c = s.categories[category];
    const today = localDateString(now, tz);
    let at = zonedToUtc(today, c.time, tz);
    if (at.getTime() < now.getTime()) at = zonedToUtc(addDays(today, 1), c.time, tz);
    for (const when of [now, at]) {
      const snap = buildSnapshot(this.db, { now: when, timeZone: tz });
      const got = GENERATORS[category]({ now: when, tz, settings: s, snapshot: snap, state: empty });
      if (got[0]) return { title: got[0].title, body: got[0].body, example: false };
    }
    const sample = buildSampleSnapshot(when(now));
    const got = GENERATORS[category]({
      now: sampleNow(now, s, category, tz),
      tz,
      settings: s,
      snapshot: sample,
      state: empty,
    });
    if (got[0]) return { title: got[0].title, body: got[0].body, example: true };
    return {
      title: CATEGORY_LABELS[category],
      body: 'Nothing to remind you about right now.',
      example: true,
    };
  }

  /* ---------------------------------------------------------------- pause, per-item controls, protocol */

  pause(duration: '1h' | 'tomorrow' | 'indefinite' | 'resume'): string | null {
    const st = this.requireState();
    const now = this.now();
    if (duration === 'resume') {
      st.resume();
      return null;
    }
    const until =
      duration === '1h'
        ? new Date(now.getTime() + 3_600_000)
        : duration === 'tomorrow'
          ? zonedToUtc(addDays(localDateString(now, this.tz), 1), '08:00', this.tz)
          : new Date('9999-01-01T00:00:00.000Z');
    st.pause(until);
    return until.toISOString();
  }

  itemControls(itemId: string): ItemNotifyControlsView {
    const st = this.state;
    const now = this.now();
    const snoozed = st?.snoozedUntil(this.libraryId, 'item', itemId) ?? null;
    return {
      muted: st?.isMuted(this.libraryId, 'item', itemId) ?? false,
      snoozedUntil: snoozed && snoozed.getTime() > now.getTime() ? snoozed.toISOString() : null,
      reminders: this.reminders(itemId),
    };
  }

  setItemMute(itemId: string, muted: boolean): ItemNotifyControlsView {
    const st = this.requireState();
    if (muted) st.mute(this.libraryId, 'item', itemId, this.now());
    else st.unmute(this.libraryId, 'item', itemId);
    return this.itemControls(itemId);
  }

  snoozeItem(itemId: string, duration: '1h' | 'tomorrow' | 'week' | 'clear'): ItemNotifyControlsView {
    const st = this.requireState();
    if (duration === 'clear') st.unsnooze(this.libraryId, 'item', itemId);
    else st.snooze(this.libraryId, 'item', itemId, this.snoozeUntil(duration));
    return this.itemControls(itemId);
  }

  private snoozeUntil(d: '1h' | 'tomorrow' | 'week'): Date {
    const now = this.now();
    if (d === '1h') return new Date(now.getTime() + 3_600_000);
    const days = d === 'tomorrow' ? 1 : 7;
    return zonedToUtc(addDays(localDateString(now, this.tz), days), '09:00', this.tz);
  }

  /** Silent protocol actions (snooze/mute). Navigation commands are handled by main. */
  applyProtocol(cmd: ProtocolCommand): boolean {
    if (cmd.kind !== 'snooze' && cmd.kind !== 'mute') return false;
    const st = this.requireState();
    const t = cmd.target;
    if (cmd.kind === 'mute') st.mute(this.libraryId, t.scope, t.id, this.now());
    else st.snooze(this.libraryId, t.scope, t.id, this.snoozeUntil(cmd.duration));
    this.ctx.log.info('notify.protocolAction', { kind: cmd.kind, scope: t.scope });
    return true;
  }

  /* ---------------------------------------------------------------- custom reminders */

  reminders(itemId: string | null = null): ReminderView[] {
    const rows = this.db.all<{
      id: string;
      item_id: string | null;
      title: string | null;
      message: string;
      kind: 'once' | 'repeat';
      anchor_at: string;
      anchor_date: string;
      local_time: string;
      repeat_freq: RepeatRule['freq'] | null;
      repeat_interval: number;
      repeat_weekdays: number;
      enabled: number;
    }>(
      `SELECT r.*, i.title FROM reminders r LEFT JOIN items i ON i.id = r.item_id
        WHERE (? IS NULL OR r.item_id = ?) ORDER BY r.enabled DESC, r.anchor_at`,
      [itemId, itemId],
    );
    return rows.map((r) => {
      const rule: RepeatRule | null = r.repeat_freq
        ? {
            freq: r.repeat_freq,
            interval: r.repeat_interval,
            weekdays: r.repeat_freq === 'weekdays' ? weekdaysFromMask(r.repeat_weekdays) : [],
          }
        : null;
      return {
        id: r.id,
        itemId: r.item_id,
        itemTitle: r.title,
        message: r.message,
        kind: r.kind,
        date: r.anchor_date,
        time: r.local_time,
        rule,
        ruleLabel: ruleLabel(rule, r.local_time),
        enabled: r.enabled === 1,
        nextFireAt:
          r.enabled === 1 ? this.nextFire(r.kind, r.anchor_at, rule, r.anchor_date, r.local_time) : null,
      };
    });
  }

  private nextFire(
    kind: 'once' | 'repeat',
    anchorAt: string,
    rule: RepeatRule | null,
    date: string,
    time: string,
  ): string | null {
    const now = this.now();
    if (kind === 'once') return Date.parse(anchorAt) > now.getTime() ? anchorAt : null;
    return rule ? (nextOccurrence(rule, date, time, now, this.tz)?.toISOString() ?? null) : null;
  }

  saveReminder(input: ReminderInput): ReminderView {
    const rule = input.rule ? { ...input.rule, weekdays: [...input.rule.weekdays].sort() } : null;
    if (rule) {
      const problem = validateRule(rule);
      if (problem) throw appError('VALIDATION', problem);
    }
    if (
      input.itemId &&
      !this.db.get('SELECT 1 AS x FROM items WHERE id = ? AND deleted_at IS NULL', [input.itemId])
    )
      throw appError('NOT_FOUND', 'That item no longer exists.');
    const anchorAt = zonedToUtc(input.date, input.time, this.tz).toISOString();
    const nowIso = this.now().toISOString();
    const id = input.id ?? randomUUID();
    const next = this.nextFire(input.kind, anchorAt, rule, input.date, input.time);
    const params = [
      input.itemId,
      input.message,
      input.kind,
      anchorAt,
      input.date,
      input.time,
      rule?.freq ?? null,
      rule?.interval ?? 1,
      rule ? maskFromWeekdays(rule.weekdays) : 0,
      next,
      input.enabled ? 1 : 0,
      nowIso,
    ];
    if (input.id) {
      const n = this.db.run(
        `UPDATE reminders SET item_id = ?, message = ?, kind = ?, anchor_at = ?, anchor_date = ?, local_time = ?, repeat_freq = ?,
           repeat_interval = ?, repeat_weekdays = ?, next_fire_at = ?, enabled = ?, updated_at = ? WHERE id = ?`,
        [...params, id],
      ).changes;
      if (n === 0) throw appError('NOT_FOUND', 'That reminder no longer exists.');
    } else {
      this.db.run(
        `INSERT INTO reminders (item_id, message, kind, anchor_at, anchor_date, local_time, repeat_freq, repeat_interval,
           repeat_weekdays, next_fire_at, enabled, updated_at, id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...params, id, nowIso],
      );
    }
    // A re-enabled/edited reminder is no longer muted from an earlier notification.
    this.state?.unmute(this.libraryId, 'reminder', id);
    const view = this.reminders().find((r) => r.id === id);
    if (!view) throw appError('INTERNAL', 'The reminder could not be saved.');
    return view;
  }

  deleteReminder(id: string): void {
    this.db.run('DELETE FROM reminders WHERE id = ?', [id]);
    this.state?.unmute(this.libraryId, 'reminder', id);
    this.state?.unsnooze(this.libraryId, 'reminder', id);
  }

  setReminderEnabled(id: string, enabled: boolean): ReminderView {
    const n = this.db.run('UPDATE reminders SET enabled = ?, updated_at = ? WHERE id = ?', [
      enabled ? 1 : 0,
      this.now().toISOString(),
      id,
    ]).changes;
    if (n === 0) throw appError('NOT_FOUND', 'That reminder no longer exists.');
    if (enabled) this.state?.unmute(this.libraryId, 'reminder', id);
    const v = this.reminders().find((r) => r.id === id);
    if (!v) throw appError('NOT_FOUND', 'That reminder no longer exists.');
    return v;
  }
}

/* ------------------------------------------------------------------ preview samples */

const when = (d: Date) => d;

function sampleNow(now: Date, s: NotificationSettings, c: NotificationCategory, tz: string): Date {
  const cfg = s.categories[c];
  const today = localDateString(now, tz);
  // For weekly categories, jump to the configured weekday so the sample fires.
  for (let i = 0; i < 8; i++) {
    const d = addDays(today, i);
    const at = zonedToUtc(d, cfg.time, tz);
    if (cfg.frequency === 'weekly' && new Date(`${d}T12:00:00Z`).getUTCDay() !== cfg.weekday) continue;
    return new Date(at.getTime() + 60_000);
  }
  return now;
}

function buildSampleSnapshot(now: Date) {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const item = (n: number, title: string, type: 'tv' | 'movie' | 'game' | 'book' | 'anime') => ({
    id: id(n),
    title,
    type,
    adult: false,
    shielded: false,
  });
  const iso = now.toISOString();
  const later = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return {
    libraryLabel: null,
    inProgress: [
      {
        ...item(1, 'Frieren', 'anime'),
        lastActivityAt: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
        nextEpisode: 'S1E12',
        nextStep: null,
        nextStepSpoiler: false,
      },
    ],
    upNext: [item(2, 'Hades II', 'game'), item(3, 'Dune', 'book'), item(4, 'Severance', 'tv')],
    releases: [{ ...item(5, 'Dune: Part Three', 'movie'), releaseDate: later(1) }],
    airing: [],
    leaving: [
      { ...item(4, 'Severance', 'tv'), entryId: id(6), serviceName: 'Apple TV+', availableUntil: later(7) },
    ],
    goals: [
      {
        id: 'g',
        title: 'Reading goal',
        metric: 'items' as const,
        target: 24,
        progress: 2,
        start: `${iso.slice(0, 4)}-01-01`,
        end: `${iso.slice(0, 4)}-12-31`,
      },
    ],
    timeGoals: [
      { id: 't', title: 'Reading time', targetMinutes: 30, minutesInPeriod: 10, period: 'day' as const },
    ],
    stale: { count: 5, months: 2 },
    lastBackupAt: new Date(now.getTime() - 34 * 86_400_000).toISOString(),
    backupSameDrive: false,
    lastCheckupAt: null,
    sessions: [{ ...item(7, 'Elden Ring', 'game'), sessionId: id(8), elapsedSeconds: 4 * 3600 + 60 }],
    week: { completed: 2, inProgress: 3, nextUp: item(2, 'Hades II', 'game') },
    loans: [
      {
        ...item(3, 'Dune', 'book'),
        loanId: id(9),
        direction: 'lent' as const,
        person: 'Sam',
        dueDate: iso.slice(0, 10),
      },
    ],
    reminders: [
      {
        id: id(5),
        itemId: null,
        item: null,
        message: 'Start Disco Elysium',
        kind: 'once' as const,
        anchorAt: new Date(now.getTime() - 60_000).toISOString(),
        anchorDate: iso.slice(0, 10),
        localTime: '00:00',
        rule: null,
      },
    ],
    offlineQueue: { finishedAt: new Date(now.getTime() - 60_000).toISOString(), count: 3 },
    autoRuleChanges: 2,
  };
}
