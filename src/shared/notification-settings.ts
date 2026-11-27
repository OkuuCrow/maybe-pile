/**
 * Notification + reminder settings (Notifications Pack, 2.1).
 *
 * Shared by the renderer (Settings UI), main (resident mode, IPC), and the
 * headless reminder helper, so this module depends on nothing but zod.
 * Everything is OFF by default: `mode: 'off'` and every category disabled.
 */
import { z } from 'zod';

/** Every category the engine knows. Order = delivery priority (first = most important). */
export const NOTIFICATION_CATEGORIES = [
  'custom',
  'sessionRunning',
  'releases',
  'leavingSoon',
  'getItBack',
  'keepGoing',
  'upNext',
  'dailyTimeGoal',
  'goalsPace',
  'backup',
  'pileHealth',
  'weeklySummary',
  'checkup',
  'offlineQueue',
  'autoRules',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  custom: 'Custom reminders',
  sessionRunning: 'Session still running',
  releases: 'Releases',
  leavingSoon: 'Leaving soon',
  getItBack: 'Get it back (loans)',
  keepGoing: 'Keep going',
  upNext: 'Up Next digest',
  dailyTimeGoal: 'Daily time goal',
  goalsPace: 'Goals pace',
  backup: 'Backup reminder',
  pileHealth: 'Pile health digest',
  weeklySummary: 'Weekly summary',
  checkup: 'Library check-up reminder',
  offlineQueue: 'Offline queue finished',
  autoRules: 'Automatic status changes',
};

/** Plain-language labels used in Simple Mode (no jargon). */
export const CATEGORY_SIMPLE_LABELS: Partial<Record<NotificationCategory, string>> = {
  pileHealth: 'Things not touched in a while',
  checkup: 'Check my library',
};

export const DELIVERY_MODES = ['off', 'whileOpen', 'tray', 'scheduled'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const PRIVACY_LEVELS = ['titles', 'generic', 'count'] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export const PRESETS = ['rarely', 'sometimes', 'often', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];

/** Allowed scheduled-check intervals (minutes). They divide an hour so systemd OnCalendar stays exact. */
export const CHECK_INTERVALS = [5, 10, 15, 20, 30, 60] as const;

export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const HhmmSchema = z.string().regex(HHMM_RE, 'Use a 24-hour time such as 18:00.');
const Weekday = z.number().int().min(0).max(6);

/** IANA zone names only (letters, digits, _ + - /); validated again with Intl at use. */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/, 'Use an IANA time zone such as Europe/Berlin.');

export const CategoryConfigSchema = z.strictObject({
  enabled: z.boolean(),
  frequency: z.enum(['daily', 'weekly']),
  /** Local time the category's schedule fires. */
  time: HhmmSchema,
  /** 0 = Sunday … 6 = Saturday (weekly only). */
  weekday: Weekday,
  /**
   * Category threshold; meaning depends on the category (documented in docs/notifications.md):
   * keepGoing = days without progress, releases = lead days, leavingSoon = days before,
   * backup = days since last backup, sessionRunning = hours, checkup = days since last check-up.
   */
  threshold: z.number().int().min(0).max(365),
  privacy: z.enum(['inherit', ...PRIVACY_LEVELS]),
  /** Max notifications of this category per local day; the overflow is coalesced into one digest. */
  cap: z.number().int().min(1).max(20),
});
export type CategoryConfig = z.infer<typeof CategoryConfigSchema>;

const categoriesShape = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, CategoryConfigSchema])) as {
  [K in NotificationCategory]: typeof CategoryConfigSchema;
};

export const QuietHoursSchema = z.strictObject({
  enabled: z.boolean(),
  start: HhmmSchema,
  end: HhmmSchema,
  /** Weekdays on which quiet hours START (a 22:00–08:00 window started Friday covers Saturday morning). */
  days: z.array(Weekday).max(7),
});
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const NotificationSettingsSchema = z.strictObject({
  mode: z.enum(DELIVERY_MODES),
  /** Resident (tray) mode may additionally register the scheduled helper. */
  alsoScheduled: z.boolean(),
  intervalMinutes: z
    .number()
    .int()
    .refine(
      (n) => (CHECK_INTERVALS as readonly number[]).includes(n),
      'Choose 5, 10, 15, 20, 30 or 60 minutes.',
    ),
  closeToTray: z.boolean(),
  startAtLogin: z.boolean(),
  quietHours: QuietHoursSchema,
  /** Weekdays notifications may arrive at all (others behave like an all-day quiet period). */
  allowedDays: z.array(Weekday).min(1).max(7),
  dailyCap: z.number().int().min(1).max(50),
  privacy: z.enum(PRIVACY_LEVELS),
  sound: z.boolean(),
  catchUp: z.enum(['catchUp', 'skip']),
  /** null = follow the OS zone. */
  timeZone: TimeZoneSchema.nullable(),
  preset: z.enum(PRESETS),
  /** Allow "next: S1E12" in texts (Spoiler Shield still wins for shielded items). */
  showNextEpisode: z.boolean(),
  /** Loans / Recommended-by: third-party names stay out of notifications unless allowed. */
  showPeopleNames: z.boolean(),
  historyDays: z.number().int().min(7).max(365),
  categories: z.strictObject(categoriesShape),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

const cat = (p: Partial<CategoryConfig>): CategoryConfig => ({
  enabled: false,
  frequency: 'daily',
  time: '18:00',
  weekday: 0,
  threshold: 0,
  privacy: 'inherit',
  cap: 3,
  ...p,
});

export const DEFAULT_CATEGORY_CONFIG: Record<NotificationCategory, CategoryConfig> = {
  custom: cat({ cap: 10 }),
  sessionRunning: cat({ threshold: 4, cap: 2 }),
  releases: cat({ time: '09:00', threshold: 1, cap: 3 }),
  leavingSoon: cat({ time: '10:00', threshold: 7, cap: 2 }),
  getItBack: cat({ time: '10:00', cap: 1 }),
  keepGoing: cat({ time: '18:00', threshold: 3, cap: 1 }),
  upNext: cat({ time: '09:00', frequency: 'weekly', weekday: 6, cap: 1 }),
  dailyTimeGoal: cat({ time: '20:00', cap: 1 }),
  goalsPace: cat({ time: '17:00', frequency: 'weekly', weekday: 0, cap: 1 }),
  backup: cat({ time: '12:00', frequency: 'weekly', weekday: 0, threshold: 30, cap: 1 }),
  pileHealth: cat({ time: '11:00', frequency: 'weekly', weekday: 0, cap: 1 }),
  weeklySummary: cat({ time: '19:00', frequency: 'weekly', weekday: 0, cap: 1 }),
  checkup: cat({ time: '13:00', frequency: 'weekly', weekday: 0, threshold: 30, cap: 1 }),
  offlineQueue: cat({ cap: 1 }),
  autoRules: cat({ time: '19:00', cap: 1 }),
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  mode: 'off',
  alsoScheduled: false,
  intervalMinutes: 15,
  closeToTray: true,
  startAtLogin: false,
  quietHours: { enabled: true, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] },
  allowedDays: [0, 1, 2, 3, 4, 5, 6],
  dailyCap: 5,
  privacy: 'titles',
  sound: true,
  catchUp: 'catchUp',
  timeZone: null,
  preset: 'sometimes',
  showNextEpisode: true,
  showPeopleNames: false,
  historyDays: 90,
  categories: DEFAULT_CATEGORY_CONFIG,
};

/**
 * Simple-Mode "How often" presets. Each maps to documented category toggles + caps
 * (docs/notifications.md). Thresholds/times stay at their defaults.
 */
export const PRESET_CATEGORIES: Record<
  Exclude<Preset, 'custom'>,
  { enabled: NotificationCategory[]; dailyCap: number; keepGoingDays: number }
> = {
  rarely: { enabled: ['custom', 'releases', 'keepGoing', 'backup'], dailyCap: 2, keepGoingDays: 7 },
  sometimes: {
    enabled: [
      'custom',
      'releases',
      'keepGoing',
      'backup',
      'upNext',
      'leavingSoon',
      'goalsPace',
      'sessionRunning',
      'getItBack',
    ],
    dailyCap: 4,
    keepGoingDays: 3,
  },
  often: {
    enabled: [
      'custom',
      'releases',
      'keepGoing',
      'backup',
      'upNext',
      'leavingSoon',
      'goalsPace',
      'sessionRunning',
      'getItBack',
      'pileHealth',
      'weeklySummary',
      'dailyTimeGoal',
    ],
    dailyCap: 6,
    keepGoingDays: 2,
  },
};

/** Applies a preset. Categories not listed are switched off; per-category times/privacy are kept. */
export function applyPreset(
  s: NotificationSettings,
  preset: Exclude<Preset, 'custom'>,
): NotificationSettings {
  const p = PRESET_CATEGORIES[preset];
  const categories = { ...s.categories };
  for (const c of NOTIFICATION_CATEGORIES) {
    categories[c] = { ...categories[c], enabled: p.enabled.includes(c) };
  }
  categories.keepGoing = { ...categories.keepGoing, threshold: p.keepGoingDays };
  return { ...s, preset, dailyCap: p.dailyCap, categories };
}

/** True when the category toggles no longer match the stored preset (the user customized them). */
export function presetDiverged(s: NotificationSettings): boolean {
  if (s.preset === 'custom') return true;
  const expected = applyPreset(s, s.preset);
  return (
    NOTIFICATION_CATEGORIES.some((c) => expected.categories[c].enabled !== s.categories[c].enabled) ||
    expected.dailyCap !== s.dailyCap
  );
}

/** Categories whose notifications are dropped (not deferred) during quiet hours. */
export const DROP_IN_QUIET: ReadonlySet<NotificationCategory> = new Set(['sessionRunning', 'offlineQueue']);
