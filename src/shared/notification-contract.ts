/**
 * IPC request schemas + view types for notifications and reminders (2.1).
 * Every request is a strict object validated in main.
 */
import { z } from 'zod';
import { IdSchema, IsoDateSchema, requiredText } from './schemas';
import {
  CATEGORY_LABELS,
  HhmmSchema,
  NOTIFICATION_CATEGORIES,
  NotificationSettingsSchema,
  type NotificationCategory,
  type NotificationSettings,
} from './notification-settings';

export const RepeatRuleSchema = z
  .strictObject({
    freq: z.enum(['daily', 'weekly', 'monthly', 'weekdays']),
    interval: z.number().int().min(1).max(30),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  })
  .superRefine((r, ctx) => {
    if (r.freq === 'monthly' && r.interval > 12)
      ctx.addIssue({ code: 'custom', message: 'Monthly repeats can be at most every 12 months.' });
    if (r.freq === 'weekdays' && r.weekdays.length === 0)
      ctx.addIssue({ code: 'custom', message: 'Choose at least one day.' });
    if (r.freq !== 'weekdays' && r.weekdays.length > 0)
      ctx.addIssue({ code: 'custom', message: 'Days only apply to "on these days".' });
    if (new Set(r.weekdays).size !== r.weekdays.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate day.' });
  });
export type RepeatRuleInput = z.infer<typeof RepeatRuleSchema>;

export const ReminderInputSchema = z
  .strictObject({
    id: IdSchema.nullable(),
    itemId: IdSchema.nullable(),
    message: requiredText(140, 'Message'),
    kind: z.enum(['once', 'repeat']),
    /** Local date + time of the (first) reminder. */
    date: IsoDateSchema,
    time: HhmmSchema,
    rule: RepeatRuleSchema.nullable(),
    enabled: z.boolean(),
  })
  .superRefine((r, ctx) => {
    if ((r.kind === 'repeat') !== (r.rule !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['rule'],
        message: 'Repeating reminders need a repeat rule; one-time reminders must not have one.',
      });
  });
export type ReminderInput = z.infer<typeof ReminderInputSchema>;

export const CategorySchema = z.enum(NOTIFICATION_CATEGORIES);

export const NOTIFY_REQUESTS = {
  status: z.undefined(),
  plan: z.strictObject({ settings: NotificationSettingsSchema }),
  apply: z.strictObject({ settings: NotificationSettingsSchema, confirmed: z.boolean() }),
  test: z.undefined(),
  runNow: z.undefined(),
  repair: z.undefined(),
  removeBackground: z.undefined(),
  history: z.strictObject({ days: z.number().int().min(1).max(365) }),
  clearHistory: z.undefined(),
  preview: z.strictObject({ category: CategorySchema, settings: NotificationSettingsSchema }),
  pause: z.strictObject({ duration: z.enum(['1h', 'tomorrow', 'indefinite', 'resume']) }),
  itemControls: z.strictObject({ itemId: IdSchema }),
  setItemMute: z.strictObject({ itemId: IdSchema, muted: z.boolean() }),
  snoozeItem: z.strictObject({ itemId: IdSchema, duration: z.enum(['1h', 'tomorrow', 'week', 'clear']) }),
  reminders: z.strictObject({ itemId: IdSchema.nullable() }),
  saveReminder: ReminderInputSchema,
  deleteReminder: z.strictObject({ id: IdSchema }),
  setReminderEnabled: z.strictObject({ id: IdSchema, enabled: z.boolean() }),
} as const;

export interface PlannedComponentView {
  id: string;
  label: string;
  location: string;
  detail: string;
  undo: string;
}

export interface NotifyStatusView {
  mode: NotificationSettings['mode'];
  os: 'windows' | 'linux' | 'macos' | 'other';
  /** macOS: in-app/while-open only, untested. */
  backgroundSupported: boolean;
  trayAvailable: boolean;
  stateAvailable: boolean;
  stateError: string | null;
  service: {
    state:
      | 'not_installed'
      | 'healthy'
      | 'path_changed'
      | 'disabled_by_os'
      | 'error'
      | 'unsupported'
      | 'not_needed';
    message: string;
    components: { id: string; present: boolean; ok: boolean; problem: string | null }[];
  };
  adapter: { id: string; available: boolean; reason: string | null; actions: boolean };
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  pausedUntil: string | null;
  notices: string[];
  portable: boolean;
  appImage: boolean;
}

export interface ApplyResultView {
  ok: boolean;
  needsConfirmation: boolean;
  components: PlannedComponentView[];
  settings: NotificationSettings;
  error: string | null;
}

export interface HistoryEntryView {
  id: number;
  category: NotificationCategory;
  categoryLabel: string;
  kind: 'single' | 'digest' | 'member' | 'record';
  itemTitle: string | null;
  plannedFor: string;
  at: string;
  outcome: string;
  outcomeLabel: string;
  reason: string | null;
  mode: string | null;
  adapter: string | null;
  clickedAt: string | null;
}

export interface PreviewView {
  title: string;
  body: string;
  example: boolean;
}

export interface ReminderView {
  id: string;
  itemId: string | null;
  itemTitle: string | null;
  message: string;
  kind: 'once' | 'repeat';
  date: string;
  time: string;
  rule: RepeatRuleInput | null;
  ruleLabel: string;
  enabled: boolean;
  nextFireAt: string | null;
}

export interface ItemNotifyControlsView {
  muted: boolean;
  snoozedUntil: string | null;
  reminders: ReminderView[];
}

export const OUTCOME_LABELS: Record<string, string> = {
  claimed: 'Sending…',
  delivered: 'Delivered',
  coalesced: 'Included in a digest',
  failed: 'Failed',
  unsupported: 'Could not be shown here',
  quiet_dropped: 'Skipped (quiet hours)',
  capped: 'Skipped (daily limit reached)',
  missed: 'Skipped (computer was off or asleep)',
};

export const categoryLabel = (c: NotificationCategory) => CATEGORY_LABELS[c];
