/** Builders for reminder-engine tests: empty snapshot, settings with categories on, fake state. */
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationCategory,
  type NotificationSettings,
} from '../../src/shared/notification-settings';
import type { LibrarySnapshot, SnapshotItem, StateView } from '../../src/notifications/engine/types';
import type { ExecFn } from '../../src/notifications/adapters/types';
import { Installer, type FsOps } from '../../src/notifications/registration/installer';

export function emptySnapshot(over: Partial<LibrarySnapshot> = {}): LibrarySnapshot {
  return {
    libraryLabel: null,
    inProgress: [],
    upNext: [],
    releases: [],
    airing: [],
    leaving: [],
    goals: [],
    timeGoals: [],
    stale: { count: 0, months: 12 },
    lastBackupAt: null,
    backupSameDrive: false,
    lastCheckupAt: null,
    sessions: [],
    week: { completed: 0, inProgress: 0, nextUp: null },
    loans: [],
    reminders: [],
    offlineQueue: { finishedAt: null, count: 0 },
    autoRuleChanges: 0,
    ...over,
  };
}

export function item(id: string, title: string, over: Partial<SnapshotItem> = {}): SnapshotItem {
  return { id, title, type: 'tv', adult: false, shielded: false, ...over };
}

export const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
] as const;

/** Settings with the given categories enabled, quiet hours OFF unless overridden, generous caps. */
export function settingsWith(
  cats: NotificationCategory[],
  over: Partial<NotificationSettings> = {},
): NotificationSettings {
  const categories = { ...DEFAULT_NOTIFICATION_SETTINGS.categories };
  for (const c of cats) categories[c] = { ...categories[c], enabled: true };
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    mode: 'whileOpen',
    quietHours: { ...DEFAULT_NOTIFICATION_SETTINGS.quietHours, enabled: false },
    dailyCap: 20,
    ...over,
    categories: { ...categories, ...(over.categories ?? {}) },
  };
}

export interface FakeState extends StateView {
  claimed: Set<string>;
  delivered: { category: NotificationCategory; itemId: string | null; at: Date }[];
  snoozes: Map<string, Date>;
  mutes: Set<string>;
}

export function fakeState(): FakeState {
  const s: FakeState = {
    claimed: new Set(),
    delivered: [],
    snoozes: new Map(),
    mutes: new Set(),
    isClaimed: (k) => s.claimed.has(k),
    lastDeliveredFor: (c, id) => {
      const hits = s.delivered.filter((d) => d.category === c && d.itemId === id).map((d) => d.at.getTime());
      return hits.length ? new Date(Math.max(...hits)) : null;
    },
    deliveredSince: (since) => {
      const byCategory: Partial<Record<NotificationCategory, number>> = {};
      let total = 0;
      for (const d of s.delivered) {
        if (d.at.getTime() < since.getTime()) continue;
        byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
        total++;
      }
      return { total, byCategory };
    },
    snoozedUntil: (scope, target) => s.snoozes.get(`${scope}:${target}`) ?? null,
    isMuted: (scope, target) => s.mutes.has(`${scope}:${target}`),
    reminderSnoozes: () =>
      [...s.snoozes.entries()]
        .filter(([k]) => k.startsWith('reminder:'))
        .map(([k, until]) => ({ target: k.slice('reminder:'.length), until })),
  };
  return s;
}

/** In-memory filesystem for installer tests (never touches the real disk). */
export function memFs(): FsOps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d) => void files.set(p, typeof d === 'string' ? d : Buffer.from(d).toString('latin1')),
    mkdir: () => undefined,
    remove: (p) => void files.delete(p),
    copy: (s, d) => void files.set(d, files.get(s) ?? ''),
  };
}

/** A Linux installer over a fake filesystem and fake systemctl (for UI/integration tests). */
export function fakeLinuxInstaller() {
  const fs = memFs();
  fs.files.set('/opt/app/helper.cjs', 'HELPER');
  const calls: string[][] = [];
  let enabled = false;
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'systemctl') {
      if (args.includes('is-system-running')) return { code: 0, stdout: 'running', stderr: '' };
      if (args.includes('enable')) enabled = true;
      if (args.includes('disable')) enabled = false;
      if (args.includes('is-enabled')) return { code: enabled ? 0 : 1, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const installer = new Installer({
    platform: 'linux',
    exec,
    fs,
    paths: {
      userData: '/home/ann/.config/MaybePile',
      home: '/home/ann',
      exePath: '/opt/Maybe Pile/maybe-pile',
      isAppImage: false,
      isPortable: false,
      helperSource: '/opt/app/helper.cjs',
      tempDir: '/tmp/mp',
      startMenuDir: '',
    },
    appUserModelId: 'app.maybepile.desktop',
    author: 'Maybe Pile',
  });
  return { installer, fs, calls };
}
