/**
 * Reminder engine types. The engine is pure: it receives a read-only library
 * snapshot, the notification state (claims, snoozes, mutes, history) and an
 * injected clock, and returns what to deliver and what to record.
 */
import type { MediaType } from '../../shared/enums';
import type {
  NotificationCategory,
  NotificationSettings,
  PrivacyLevel,
} from '../../shared/notification-settings';
import type { ActionTarget } from '../protocol';

export interface SnapshotItem {
  id: string;
  title: string;
  type: MediaType;
  /** Adult-flagged items are always rendered with generic text. */
  adult: boolean;
  /** Spoiler Shield active for this item (authoritative). */
  shielded: boolean;
}

export interface InProgressSnap extends SnapshotItem {
  /** Last progress/session/status activity (ISO instant) or null if never. */
  lastActivityAt: string | null;
  /** e.g. "S1E12" — only rendered when allowed by settings + Spoiler Shield. */
  nextEpisode: string | null;
  /** User-written "Next step" line (§16.5). */
  nextStep: string | null;
  nextStepSpoiler: boolean;
}

export interface ReleaseSnap extends SnapshotItem {
  /** Full date YYYY-MM-DD (partial dates are not notified). */
  releaseDate: string;
}

export interface AiringSnap extends SnapshotItem {
  episode: number;
  /** ISO instant of the next episode's airing. */
  airingAt: string;
}

export interface LeavingSnap extends SnapshotItem {
  entryId: string;
  serviceName: string | null;
  availableUntil: string;
}

export interface GoalSnap {
  id: string;
  title: string;
  metric: 'items' | 'pages' | 'episodes' | 'hours';
  target: number;
  progress: number;
  start: string;
  end: string;
}

export interface TimeGoalSnap {
  id: string;
  title: string;
  targetMinutes: number;
  /** Minutes logged in the goal's current period (today for daily goals). */
  minutesInPeriod: number;
  period: 'day' | 'week';
}

export interface SessionSnap extends SnapshotItem {
  sessionId: string;
  elapsedSeconds: number;
}

export interface LoanSnap extends SnapshotItem {
  loanId: string;
  direction: 'lent' | 'borrowed';
  person: string;
  dueDate: string;
}

export type RepeatFreq = 'daily' | 'weekly' | 'monthly' | 'weekdays';
export interface RepeatRule {
  freq: RepeatFreq;
  /** Every N days/weeks/months (1–30; monthly ≤ 12). Ignored for 'weekdays'. */
  interval: number;
  /** For 'weekdays': which days (0 = Sunday). */
  weekdays: number[];
}

export interface ReminderSnap {
  id: string;
  itemId: string | null;
  item: SnapshotItem | null;
  message: string;
  kind: 'once' | 'repeat';
  /** Once: the exact instant. Repeat: first occurrence (its local date + time anchor the rule). */
  anchorAt: string;
  /** Local date + time the rule repeats at (evaluated in the current zone). */
  anchorDate: string;
  localTime: string;
  rule: RepeatRule | null;
}

export interface LibrarySnapshot {
  /** Set only when more than one library has reminders enabled (§16.11). */
  libraryLabel: string | null;
  inProgress: InProgressSnap[];
  upNext: SnapshotItem[];
  releases: ReleaseSnap[];
  airing: AiringSnap[];
  leaving: LeavingSnap[];
  goals: GoalSnap[];
  timeGoals: TimeGoalSnap[];
  stale: { count: number; months: number };
  lastBackupAt: string | null;
  backupSameDrive: boolean;
  lastCheckupAt: string | null;
  sessions: SessionSnap[];
  week: { completed: number; inProgress: number; nextUp: SnapshotItem | null };
  loans: LoanSnap[];
  reminders: ReminderSnap[];
  offlineQueue: { finishedAt: string | null; count: number };
  autoRuleChanges: number;
}

export type SnoozeScope = 'item' | 'category' | 'reminder' | 'global';

export interface StateView {
  isClaimed(key: string): boolean;
  /** Last delivery for a category+item (per-item cooldowns). */
  lastDeliveredFor(category: NotificationCategory, itemId: string): Date | null;
  /** Deliveries since an instant (daily caps). */
  deliveredSince(since: Date): { total: number; byCategory: Partial<Record<NotificationCategory, number>> };
  snoozedUntil(scope: SnoozeScope, target: string): Date | null;
  isMuted(scope: Exclude<SnoozeScope, 'global'>, target: string): boolean;
  /** Active reminder snoozes ("remind me again in 1 h"). */
  reminderSnoozes(): { target: string; until: Date }[];
}

export interface NotificationAction {
  id: 'open' | 'snooze1h' | 'snoozeTomorrow' | 'mute';
  label: string;
  url: string;
}

export interface PlannedNotification {
  key: string;
  category: NotificationCategory;
  kind: 'single' | 'digest';
  title: string;
  body: string;
  itemId: string | null;
  urgency: 'low' | 'normal';
  scheduledFor: string;
  actions: NotificationAction[];
  /** All dedupe keys claimed together with this notification (includes `key`). */
  memberKeys: string[];
  /** Per-member metadata for the history log. */
  members: { key: string; category: NotificationCategory; itemId: string | null; scheduledFor: string }[];
  /** Plain-text "open" URL for click handling. */
  openUrl: string;
}

export type RecordReason = 'quiet_dropped' | 'capped' | 'missed';

export interface RecordedSuppression {
  key: string;
  category: NotificationCategory;
  itemId: string | null;
  scheduledFor: string;
  reason: RecordReason;
}

export interface EngineInput {
  now: Date;
  timeZone: string;
  settings: NotificationSettings;
  snapshot: LibrarySnapshot;
  state: StateView;
  /** Freshness window in minutes (≥ 2 × the check interval); older due items count as "missed". */
  freshMinutes?: number;
}

export interface EnginePlan {
  deliver: PlannedNotification[];
  record: RecordedSuppression[];
  /** Held back because it is quiet time now (will be delivered after quiet time ends). */
  deferred: number;
  paused: boolean;
}

/** A due candidate before quiet-hours/cap/digest processing. */
export interface Candidate {
  key: string;
  category: NotificationCategory;
  dueAt: Date;
  expiresAt: Date;
  itemId: string | null;
  /** Snooze/mute target for action buttons. */
  target: ActionTarget | null;
  /** Rendered single-notification text at the effective privacy level. */
  title: string;
  body: string;
  /** One-line summary for digests (already privacy-rendered). */
  line: string;
  privacy: PrivacyLevel;
}
