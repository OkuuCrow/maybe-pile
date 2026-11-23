/**
 * Output DTOs returned from main to renderer. These are produced by trusted
 * main-process code, so they are plain TypeScript types (no runtime schema);
 * the renderer only type-guards the `Result` envelope.
 */
import type {
  ArtworkSource,
  CustomFieldType,
  GameScheme,
  MediaType,
  ProgressKind,
  ProvenanceOrigin,
  Status,
} from './enums';
import type { MetadataField, MetadataFields, PersonalFields } from './schemas';

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
    | 'mal';
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
}

export interface ImportResultView {
  added: number;
  updated: number;
  skipped: number;
  duplicated: number;
  snapshotLabel: string | null;
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
}
