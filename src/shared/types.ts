/**
 * Output DTOs returned from main to renderer. These are produced by trusted
 * main-process code, so they are plain TypeScript types (no runtime schema);
 * the renderer only type-guards the `Result` envelope.
 */
import type {
  AudioPref,
  AvailabilityKind,
  ServiceKind,
  HoursSource,
  MoodColor,
  MoodIcon,
  RelationInput,
  SpoilerMode,
  ArtworkSlot,
  ArtworkSource,
  CustomFieldType,
  GameScheme,
  MediaType,
  ProgressKind,
  ProvenanceOrigin,
  Status,
} from './enums';
import type { MetadataField, MetadataFields, PersonalFields } from './schemas';
import type { UserSafeError } from './result';

export interface ArtworkView {
  id: string;
  source: ArtworkSource;
  /** `maybepile-art://` URL for the grid thumbnail. */
  thumbUrl: string;
  /** `maybepile-art://` URL for the full-size image. */
  fullUrl: string;
  providerId: string | null;
}

export interface ProvenanceView {
  origin: ProvenanceOrigin;
  providerId: string | null;
  /** JSON-encoded value the provider supplied when last fetched. */
  providerValue: string | null;
  updatedAt: string;
}

export interface SourceView {
  providerId: string;
  providerRef: string;
  url: string | null;
  fetchedAt: string;
}

export interface CustomFieldView {
  defId: string;
  name: string;
  type: CustomFieldType;
  options: string[];
  value: string | number | boolean | null;
}

export interface SeriesMembershipView {
  seriesId: string;
  name: string;
  position: number | null;
}

export interface EpisodeView {
  id: string;
  seasonId: string;
  number: number;
  title: string | null;
  airDate: string | null;
  runtime: number | null;
  watched: boolean;
  watchedAt: string | null;
  source: 'provider' | 'user';
  /** 2.1 §16.8: skipped (counts toward "caught up", never as watched or watch time). */
  skipped?: boolean;
}

export interface SeasonView {
  id: string;
  number: number;
  title: string | null;
  episodeCountKnown: number | null;
  episodes: EpisodeView[];
  watchedCount: number;
}

export interface MilestoneView {
  id: string;
  position: number;
  title: string;
}

export interface ProgressEventView {
  id: string;
  kind: ProgressKind;
  occurredAt: string | null;
  recordedAt: string;
  value: number | null;
  text: string | null;
  /** Page count in effect when a 'pages' entry was recorded. */
  totalAtTime: number | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  episodeLabel: string | null;
  watched: boolean | null;
  pass: number;
  note: string | null;
  scheme: GameScheme | null;
}

export interface ViewingView {
  id: string;
  watchedAt: string | null;
  note: string | null;
  pass: number;
  createdAt: string;
}

export interface AuditChangeView {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface AuditEntryView {
  id: string;
  at: string;
  action: 'refresh' | 'import' | 'create';
  providerId: string | null;
  changes: AuditChangeView[];
}

/** Derived progress for display, list sorting and dashboard. */
export interface ProgressSummary {
  /** 0–100, or null when no meaningful percentage exists (unknown totals, free text). */
  percent: number | null;
  /** Short human summary, e.g. "S2E4 · 12 of 30 episodes" or "120 pages · total unknown". */
  label: string;
  /** Next action for the Continue widget, e.g. "Next: S1E5 – Pilot". */
  nextAction: string | null;
  isComplete: boolean;
  hasAnyProgress: boolean;
}

export interface ExternalLinkView {
  kind:
    | 'imdb'
    | 'watch'
    | 'steam'
    | 'xbox'
    | 'playstation'
    | 'tmdb'
    | 'tvmaze'
    | 'openlibrary'
    | 'igdb'
    | 'wikidata'
    | 'anilist'
    | 'mal'
    | 'kitsu'
    | 'streaming';
  label: string;
  url: string;
}

export interface ItemDetail {
  id: string;
  type: MediaType;
  meta: MetadataFields;
  personal: PersonalFields;
  pass: number;
  /** Position in the Up Next queue (0 = first), or null when not queued. */
  upNextPosition: number | null;
  createdAt: string;
  updatedAt: string;
  artwork: ArtworkView | null;
  provenance: Partial<Record<MetadataField, ProvenanceView>>;
  sources: SourceView[];
  customFields: CustomFieldView[];
  series: SeriesMembershipView[];
  seasons: SeasonView[];
  milestones: MilestoneView[];
  progress: ProgressSummary;
  links: ExternalLinkView[];
  /** Custom lists containing this item (added in 1.2). */
  lists: { id: string; name: string }[];
  /** Pile Health snooze end date (inclusive), or null. */
  snoozedUntil: string | null;
  /** Library sources that imported this item and no longer list it (e.g. refunded on Steam). */
  goneFromSources: string[];
}

export interface ItemSummary {
  id: string;
  type: MediaType;
  title: string;
  year: number | null;
  status: Status;
  rating: number | null;
  tags: string[];
  creators: string[];
  dateAdded: string;
  updatedAt: string;
  releaseDate: string | null;
  thumbUrl: string | null;
  progressPercent: number | null;
  progressLabel: string;
  /** 2.1 §16.5: optional one-line "Next step". */
  nextStep?: string | null;
  nextStepSpoiler?: boolean;
  /** 2.1 §14.9: checklist progress ("3 of 5"), null when the item has no checklist. */
  checklist?: { done: number; total: number } | null;
  /** 2.1 §16.6: added offline; online details still pending review. */
  waitingForDetails?: boolean;
}

export interface LibraryPage {
  total: number;
  items: ItemSummary[];
}

export interface DuplicateMatch {
  id: string;
  title: string;
  type: MediaType;
  year: number | null;
  reason: 'provider-id' | 'title-year-type';
}

export interface StatusSuggestion {
  kind: 'start' | 'complete' | 'reopen';
  status: Status;
  message: string;
  /** When accepting: also set this start date if empty. */
  setDateStarted: string | null;
}

export interface MutationOutcome {
  item: ItemDetail;
  suggestions: StatusSuggestion[];
  /** Suggestions already applied because auto-apply is enabled. */
  applied: StatusSuggestion[];
}

export interface DashboardData {
  countsByType: Record<MediaType, number>;
  countsByStatus: Record<Status, number>;
  total: number;
  continueItems: (ItemSummary & { nextAction: string | null })[];
  recentlyUpdated: ItemSummary[];
  recentlyAdded: ItemSummary[];
  recentlyCompleted: (ItemSummary & { dateCompleted: string | null })[];
  /** Progress entries per ISO week (Monday start), last 12 weeks, oldest first. */
  activityByWeek: { weekStart: string; entries: number; completed: number }[];
  tagCounts: { tag: string; count: number }[];
  /** The user's ordered "Up Next" queue. */
  upNext: (ItemSummary & { nextAction: string | null })[];
  yearStats: {
    year: number;
    completedByType: Record<MediaType, number>;
    completedTotal: number;
    added: number;
    episodesWatched: number;
    viewings: number;
    progressEntries: number;
  };
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface CustomFieldDefView {
  id: string;
  name: string;
  type: CustomFieldType;
  options: string[];
  usageCount: number;
}

export interface SeriesView {
  id: string;
  name: string;
  description: string | null;
  totalKnown: number | null;
  members: { itemId: string; title: string; position: number | null; status: Status }[];
}

/* ---------- providers ---------- */

export interface ProviderInfo {
  id: string;
  displayName: string;
  supports: MediaType[];
  attribution: { text: string; url: string; required: boolean };
  requiresApiKey: boolean;
  keyFields: ('apiKey' | 'clientId' | 'clientSecret')[];
  keysSet: Partial<Record<'apiKey' | 'clientId' | 'clientSecret', boolean>>;
  configured: boolean;
  enabled: boolean;
  cachingPolicy: 'cache-allowed' | 'remote-only';
  rateLimitText: string;
  signupUrl: string | null;
  termsNote: string | null;
  /** 'art' = Artwork Picker source only (no metadata search). */
  kind: 'metadata' | 'art';
  /** Optional per-field label overrides (e.g. fanart.tv "Personal key"). */
  keyLabels: Partial<Record<'apiKey' | 'clientId' | 'clientSecret', string>>;
}

export interface SearchHitView {
  providerId: string;
  ref: { providerId: string; id: string; type: MediaType };
  title: string;
  year: number | null;
  type: MediaType;
  creators: string[];
  synopsis: string | null;
  /** maybepile-art://preview/... URL proxied by main, or null. */
  thumbUrl: string | null;
}

export interface ImportPreview {
  token: string;
  providerId: string;
  providerName: string;
  attribution: string;
  meta: MetadataFields;
  seasons: { number: number; title: string | null; episodeCount: number }[];
  hasArtwork: boolean;
  artworkPreviewUrl: string | null;
  artworkPolicy: 'cache-allowed' | 'remote-only';
  links: ExternalLinkView[];
  duplicates: DuplicateMatch[];
  warnings: string[];
}

export interface RefreshFieldRow {
  field: string;
  label: string;
  current: string;
  incoming: string;
  origin: ProvenanceOrigin | null;
  lastEdited: string | null;
  /** True when the current value was set by the user or diverges from the last provider value. */
  userEdited: boolean;
  defaultChoice: 'keep' | 'update';
}

export interface RefreshPreview {
  token: string;
  providerId: string;
  providerName: string;
  rows: RefreshFieldRow[];
  unchangedCount: number;
  newEpisodes: number;
  updatedEpisodes: number;
}

export interface WatchAvailability {
  status: 'available' | 'unavailable' | 'not-configured' | 'error' | 'not-applicable';
  region: string;
  link: ExternalLinkView | null;
  providers: { name: string; kind: 'stream' | 'rent' | 'buy' | 'free' | 'ads' }[];
  attribution: string | null;
  message: string;
}

/* ---------- themes & layouts ---------- */

export interface ThemeSummary {
  id: string;
  name: string;
  builtIn: boolean;
}

export interface LayoutComponentView {
  id: string;
  visible: boolean;
  span: 1 | 2;
}

export interface LayoutsView {
  dashboard: LayoutComponentView[];
  library: LayoutComponentView[];
  notices: string[];
}

/* ---------- import / export / backup ---------- */

export interface ImportConflictView {
  id: string;
  reason: 'local-id' | 'provider-id' | 'title-year-type';
  importedTitle: string;
  existingTitle: string;
  existingId: string;
  importIsNewer: boolean | null;
}

export interface ValidationMessage {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface CountsView {
  items: Record<MediaType, number>;
  episodes: number;
  progressEntries: number;
  viewings: number;
  tags: number;
  themes: number;
  layouts: number;
  artwork: number;
  /* Added in 1.2 */
  lists: number;
  upNext: number;
  snoozes: number;
  goals: number;
  librarySources: number;
  sourceEntries: number;
  importBatches: number;
  mappingProfiles: number;
}

export interface ImportPreviewView {
  token: string;
  kind: 'json' | 'csv' | 'backup';
  fileLabel: string;
  formatVersion: string;
  mode: 'merge' | 'replace';
  incoming: CountsView;
  current: CountsView;
  messages: ValidationMessage[];
  conflicts: ImportConflictView[];
  canApply: boolean;
  /** Plain description of what applying will do. */
  summary: string;
  /** Word the user must type for destructive modes, or null. */
  confirmationWord: string | null;
  /** Conflict resolutions offered (tracker imports never replace existing items). */
  allowedResolutions?: ('skip' | 'duplicate' | 'update')[];
}

export interface ImportResultView {
  added: number;
  updated: number;
  skipped: number;
  duplicated: number;
  snapshotLabel: string | null;
  /** Import batch id when the import can be undone (tracker imports). */
  batchId?: string | null;
}

export interface FileOpResult {
  /** Display-safe label (file name only), never the full path. */
  fileLabel: string;
  bytes: number;
}

export interface AppInfo {
  name: string;
  version: string;
  tagline: string;
  electron: string;
  chrome: string;
  node: string;
  sqlite: string;
  schemaVersion: number;
  platform: string;
  portable: boolean;
  dataLocationLabel: string;
  dataLocationNotice: string | null;
  secretStorage: 'os-encrypted' | 'plaintext-fallback';
  upgradeNotice: string | null;
  recoveryNotice: string | null;
  backupLocationLabel: string;
  readOnly: boolean;
  /** 2.1: one-off notices (e.g. background reminders repaired after the app moved). */
  extraNotices?: string[];
  /** 2.1: active library name when more than one library exists. */
  libraryName?: string | null;
}

/* ---------- feature pack (1.2) ---------- */

export type ListColor = 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'teal' | 'pink';
export type ListIcon = 'list' | 'star' | 'heart' | 'ghost' | 'users' | 'plane' | 'flame' | 'leaf';

export interface ListSummaryView {
  id: string;
  name: string;
  description: string | null;
  color: ListColor | null;
  icon: ListIcon | null;
  position: number;
  total: number;
  completed: number;
  updatedAt: string;
}

export interface ListDetailView extends ListSummaryView {
  items: (ItemSummary & { dateCompleted: string | null })[];
}

export interface PickResultView {
  historyId: string | null;
  pick: ItemSummary | null;
  reasons: string[];
  eligibleCount: number;
  /** When the pool is empty: the constraint that removed the last items. */
  emptiedBy: string | null;
  emptiedByLabel: string | null;
}

export interface PickHistoryView {
  id: string;
  itemId: string;
  title: string;
  type: MediaType;
  pickedAt: string;
  outcome: 'shown' | 'started' | 'skipped' | 'queued';
  skipUntil: string | null;
}

export interface HealthItemView extends ItemSummary {
  reason: string;
  kind: 'planned-old' | 'in-progress-idle';
  days: number;
}

export interface SnoozedItemView extends ItemSummary {
  snoozedUntil: string;
  snoozeReason: 'manual' | 'pile-health' | 'keep';
}

export interface HealthOverview {
  enabled: boolean;
  thresholds: { plannedStaleMonths: number; inProgressStaleDays: number };
  stale: HealthItemView[];
  staleTotal: number;
  snoozed: SnoozedItemView[];
  stats: {
    sizeByType: Record<MediaType, number>;
    total: number;
    plannedCount: number;
    medianPlannedAgeDays: number | null;
    windows: { days: 30 | 90; added: number; completed: number }[];
    trend: { month: string; size: number }[];
    smallSample: boolean;
  };
}

export interface StatsView {
  year: number | null;
  years: number[];
  completedTotal: number;
  completedByMonth: { month: string; byType: Record<MediaType, number>; total: number }[];
  completedByYear: { year: number; byType: Record<MediaType, number>; total: number }[];
  avgRatingByType: { type: MediaType; average: number | null; rated: number; completed: number }[];
  topGenres: { name: string; count: number }[];
  topCreators: { name: string; count: number }[];
  timeToComplete: { bucket: string; count: number }[];
  timeToCompleteUnknown: number;
  pages: { total: number; booksWithPages: number; booksWithoutPages: number };
  episodesByMonth: { month: string; count: number }[];
  gameHours: { total: number; gamesTracked: number };
  streaks: { current: number; longest: number } | null;
}

export interface YearInReviewView {
  year: number;
  finished: number;
  finishedByType: Record<MediaType, number>;
  favorites: { id: string; title: string; type: MediaType; rating: number }[];
  longestBook: { id: string; title: string; pages: number } | null;
  longestGame: { id: string; title: string; hours: number } | null;
  longestShow: { id: string; title: string; episodes: number } | null;
  busiestMonth: { month: string; count: number } | null;
  topTags: { name: string; count: number }[];
  missing: { unrated: number; noStartDate: number; booksWithoutPages: number };
}

export interface UpcomingItemView extends ItemSummary {
  releaseDate: string;
  precision: 'year' | 'month' | 'day';
  relative: string;
  /** Where the date came from: a provider name, "you" or "unknown". */
  dateSource: string;
  /** When the provider data was last fetched (ISO), or null. */
  fetchedAt: string | null;
  userEdited: boolean;
}

export interface RadarDiffRow {
  itemId: string;
  title: string;
  current: string | null;
  incoming: string | null;
  userEdited: boolean;
  defaultChoice: 'keep' | 'update';
}

export interface RadarRefreshView {
  token: string;
  rows: RadarDiffRow[];
  checked: number;
  failures: { itemId: string; title: string; message: string }[];
  skippedNoSource: number;
}

export interface LibrarySourceView {
  id: string;
  kind: 'steam' | 'manual';
  label: string;
  /** Account as typed (vanity/profile URL/SteamID), shown back to the user. */
  accountInput: string | null;
  /** Redacted SteamID64 (last 3 digits) when resolved. */
  accountHint: string | null;
  keySet: boolean;
  lastSyncedAt: string | null;
  lastSyncStatus: 'ok' | 'private' | 'error' | 'cancelled' | 'empty' | null;
  counts: {
    total: number;
    unplayed: number;
    inPile: number;
    ignored: number;
    removed: number;
    newSinceSync: number;
  };
  attribution: string;
  rateLimitText: string;
}

export interface SourceEntryView {
  externalId: string;
  name: string;
  platform: string | null;
  playtimeMinutes: number | null;
  prevPlaytimeMinutes: number | null;
  lastPlayedAt: string | null;
  nonGameReason: string | null;
  ignored: boolean;
  removed: boolean;
  isNew: boolean;
  itemId: string | null;
  /** Title-only duplicate warning (same normalized title already in the pile). */
  possibleDuplicateOf: { id: string; title: string } | null;
  storeUrl: string | null;
}

export interface SourceEntriesPage {
  total: number;
  /** All matching rows. The renderer virtualizes the list. */
  rows: SourceEntryView[];
}

export interface FetchJobView {
  jobId: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  phase: string;
  progress: number | null;
  error: UserSafeError | null;
  diff: { added: number; playtimeChanged: number; removed: number } | null;
}

export interface SourceDiffView {
  added: { externalId: string; name: string }[];
  playtimeChanged: {
    externalId: string;
    name: string;
    before: number | null;
    after: number | null;
    itemId: string | null;
    /** Hours currently recorded in the pile (for the "keep mine" comparison). */
    pileHours: number | null;
  }[];
  removed: { externalId: string; name: string; itemId: string | null }[];
}

export interface ImportBatchView {
  id: string;
  kind: 'steam' | 'manual-list' | 'goodreads' | 'letterboxd' | 'csv-mapped' | 'mal-xml';
  label: string;
  createdAt: string;
  undoneAt: string | null;
  itemCount: number;
  canUndo: boolean;
}

export interface BatchImportResultView {
  batchId: string | null;
  added: number;
  skippedDuplicates: { externalId: string; title: string; existingId: string }[];
  failed: { externalId: string; title: string; reason: string }[];
  enrichment: { attempted: number; enriched: number; note: string | null } | null;
}

export interface UndoPreviewView {
  batchId: string;
  label: string;
  removable: { itemId: string; title: string }[];
  kept: { itemId: string; title: string; reason: string }[];
  alreadyGone: number;
}

export interface GoalView {
  id: string;
  title: string;
  mediaType: MediaType | null;
  metric: 'items' | 'pages' | 'episodes' | 'hours';
  period: 'year' | 'month' | 'custom';
  startDate: string;
  endDate: string;
  target: number;
  listId: string | null;
  listName: string | null;
  tag: string | null;
  archived: boolean;
  progress: number;
  pace: {
    status: 'done' | 'ahead' | 'on-pace' | 'behind' | 'not-started' | 'ended-short';
    label: string;
    expected: number;
    math: string;
    neededPerWeek: number | null;
  };
}

export interface MappingProfileView {
  id: string;
  name: string;
  mapping: unknown;
  updatedAt: string;
}

export interface TrackerPreviewView extends ImportPreviewView {
  tracker: 'goodreads' | 'letterboxd' | 'csv' | 'mal';
  /** For the generic mapper: header and first rows for the live preview. */
  header: string[];
  sample: string[][];
  delimiter: string;
  /** Mapping in effect (generic mapper only). */
  mapping: unknown;
  /** Handle for re-mapping the same file (generic mapper only). */
  mapToken: string | null;
}

export interface CommandTarget {
  id: string;
  title: string;
  type: MediaType;
  year: number | null;
}

/* ---------------------------------------------------------------- Expansion Pack 2: artwork */

export interface ArtworkSlotView {
  slot: ArtworkSlot;
  artworkId: string | null;
  /** maybepile-art:// URL (never a raw remote URL). */
  url: string | null;
  thumbUrl: string | null;
  origin: string | null;
  attribution: string | null;
  licenseNote: string | null;
  width: number | null;
  height: number | null;
  language: string | null;
  cacheState: 'cached' | 'remote-only' | 'unavailable' | null;
  userSelected: boolean;
  adult: boolean;
}

export interface ArtworkCandidateView {
  /** Opaque token; the remote URL itself never reaches the renderer. */
  token: string;
  sourceId: string;
  sourceName: string;
  slot: ArtworkSlot;
  thumbUrl: string;
  previewUrl: string;
  width: number | null;
  height: number | null;
  language: string | null;
  attribution: string | null;
  licenseNote: string | null;
  cachePolicy: 'cache-allowed' | 'remote-only';
  adult: boolean;
}

export interface ArtworkSourceStatus {
  sourceId: string;
  sourceName: string;
  state: 'ok' | 'not-configured' | 'error' | 'not-applicable';
  message: string | null;
  count: number;
}

export interface ArtworkGallery {
  itemId: string;
  candidates: ArtworkCandidateView[];
  sources: ArtworkSourceStatus[];
}

/* ---------------------------------------------------------------- Expansion Pack 2: features */

export type { PileTimeEstimate, PileTimeTotals } from '../domain/pile-time';
import type { PileTimeEstimate as PileTimeEstimateT } from '../domain/pile-time';
export type { CurrencyTotals } from '../domain/value';
export type { Recommendation, RecReason } from '../domain/recommendations';

export interface MoodView {
  id: string;
  name: string;
  icon: MoodIcon;
  color: MoodColor | null;
  hidden: boolean;
  position: number;
  builtin: boolean;
  itemCount: number;
}

export interface ItemPrefsView {
  spoilerMode: SpoilerMode;
  notesSpoiler: boolean;
  hoursSource: HoursSource;
  audioPref: AudioPref | null;
  /** Resolved: is the spoiler shield on for this item right now? */
  shieldActive: boolean;
}

export interface RunView {
  runNumber: number;
  status: string;
  dateStarted: string | null;
  dateCompleted: string | null;
  rating: number | null;
  notes: string;
  episodesWatched: number;
  current: boolean;
}

export interface StreamingLinkView {
  providerId: string;
  service: string;
  url: string;
  subs: string[];
  dubs: string[];
  matchesPref: boolean;
}

export interface RelationView {
  id: string;
  otherItemId: string;
  otherTitle: string;
  otherType: string;
  otherStatus: string;
  /** Relation from this item's point of view (prequel = the other item is a prequel of this). */
  relation: RelationInput | 'adapted_as';
  origin: 'user' | 'provider';
}

export interface SuggestionView {
  id: string;
  providerId: string;
  title: string;
  year: number | null;
  type: string;
  relation: RelationInput | 'adapted_as';
  targetItemId: string | null;
}

export interface FranchiseView {
  id: string;
  name: string;
  respectOrder: boolean;
  entries: {
    itemId: string;
    title: string;
    type: string;
    status: string;
    position: number;
    mainline: boolean;
  }[];
  nextItemId: string | null;
}

export interface PurchaseView {
  id: string;
  itemId: string;
  amountMinor: number;
  currency: string;
  purchasedOn: string | null;
  store: string | null;
  edition: string | null;
  notes: string | null;
}

export interface PurchaseInput {
  amountMinor: number;
  currency: string;
  purchasedOn: string | null;
  store: string | null;
  edition: string | null;
  notes: string | null;
}

export interface SessionView {
  id: string;
  itemId: string;
  itemTitle: string;
  kind: 'play' | 'watch' | 'read';
  state: 'running' | 'paused' | 'done';
  source: 'timer' | 'manual';
  startedAt: string;
  endedAt: string | null;
  seconds: number;
  note: string | null;
  needsReview: boolean;
}

export interface ServiceView {
  id: string;
  name: string;
  kind: ServiceKind;
  active: boolean;
  entryCount: number;
}

export interface AvailabilityView {
  id: string;
  itemId: string;
  kind: AvailabilityKind;
  serviceId: string | null;
  serviceName: string | null;
  platform: string | null;
  availableUntil: string | null;
  remindDays: number | null;
  notes: string | null;
}

export interface LeavingSoonView extends AvailabilityView {
  itemTitle: string;
  itemType: string;
  itemStatus: string;
  daysLeft: number;
}

export interface AvailabilityInput {
  kind: AvailabilityKind;
  serviceId: string | null;
  platform: string | null;
  availableUntil: string | null;
  remindDays: number | null;
  notes: string | null;
}

export interface DuplicatePair {
  a: { id: string; title: string; type: MediaType; year: number | null; status: Status };
  b: { id: string; title: string; type: MediaType; year: number | null; status: Status };
  reason: string;
}

export interface MergeFieldRow {
  field: string;
  label: string;
  a: string | null;
  b: string | null;
}

export interface MergePreview {
  keepId: string;
  removeId: string;
  rows: MergeFieldRow[];
  moves: string[];
}

export interface PileTimeRow {
  id: string;
  title: string;
  type: MediaType;
  status: Status;
  estimate: PileTimeEstimateT;
}

export interface BulkAutoPickResult {
  processed: number;
  updated: number;
  keptUserChoice: number;
  noCandidates: number;
  failed: number;
  cancelled: boolean;
}

export interface HeatmapView {
  year: number;
  days: { date: string; count: number; titles: string[] }[];
  total: number;
  maxPerDay: number;
}

export interface AnimeSearchAllView {
  hits: (SearchHitView & { alsoOn: string[] })[];
  failures: { providerId: string; message: string }[];
}

/* ---------------------------------------------------------------- Expansion Pack 2: sync */

export interface SyncStatusView {
  enabled: boolean;
  folderLabel: string | null;
  deviceId: string;
  deviceName: string;
  otherDevices: { deviceId: string; deviceName: string; lastSeq: number; readSeq: number }[];
  openConflicts: number;
}

export interface SyncPreviewView {
  outgoing: number;
  incoming: { apply: number; creates: number; deletes: number; noop: number };
  conflicts: { key: string; title: string; field: string; local: string; remote: string; device: string }[];
  warnings: string[];
}

export interface SyncConflictView {
  id: string;
  itemId: string | null;
  itemTitle: string;
  field: string;
  local: string;
  remote: string;
  remoteDevice: string;
  remoteAt: string;
}
