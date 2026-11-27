/**
 * Request schemas and response types for every IPC channel. Main validates
 * every request with these schemas (regardless of renderer validation); the
 * renderer's typed API is derived from the same definitions.
 */
import { z } from 'zod';
import {
  AddProgressSchema,
  BulkActionSchema,
  CustomFieldDefInputSchema,
  DuplicateCheckSchema,
  EditProgressSchema,
  EpisodeToggleSchema,
  EpisodeUpsertSchema,
  GameSchemeSchema,
  IdSchema,
  ImportApplySchema,
  ImportFromProviderSchema,
  ItemCreateSchema,
  ItemUpdateSchema,
  LibraryQuerySchema,
  MediaTypeSchema,
  MilestonesSetSchema,
  OpenExternalSchema,
  ProviderKeySchema,
  ProviderRefSchema,
  ProviderSearchSchema,
  RatingSchema,
  RefreshApplySchema,
  RegionSchema,
  SeasonUpsertSchema,
  SeriesMembershipSchema,
  SeriesUpsertSchema,
  SettingsPatchSchema,
  StatusChangeSchema,
  StatusSchema,
  ViewingEditSchema,
  ViewingInputSchema,
  GoalInputSchema,
  ImportApplySchema as TrackerApplySchema,
  ListInputSchema,
  ManualListInputSchema,
  PickRequestSchema,
  PickRespondSchema,
  SnoozeSchema,
  SourceEntryFilterSchema,
  SourceImportSchema,
  SteamSourceInputSchema,
  requiredText,
} from './schemas';
import { CsvMappingSchema } from '../domain/tracker-csv';
import * as S from './schemas';
import type * as T from './types';
import type { API_SHAPE, Channel, MenuCommand } from './ipc-channels';
import type { Result } from './result';
import { REQUEST_SCHEMAS_21, type ResponseTypes21 } from './ipc-contract-21';
import type {
  BatchImportResultView,
  CommandTarget,
  FetchJobView,
  GoalView,
  HealthOverview,
  ImportBatchView,
  LibrarySourceView,
  ListDetailView,
  ListSummaryView,
  MappingProfileView,
  PickHistoryView,
  PickResultView,
  RadarRefreshView,
  SourceDiffView,
  SourceEntriesPage,
  StatsView,
  TrackerPreviewView,
  UndoPreviewView,
  UpcomingItemView,
  YearInReviewView,
  AppInfo,
  AuditEntryView,
  CustomFieldDefView,
  DashboardData,
  DuplicateMatch,
  FileOpResult,
  ImportPreview,
  ImportPreviewView,
  ImportResultView,
  ItemDetail,
  ItemSummary,
  LayoutsView,
  LibraryPage,
  MutationOutcome,
  ProgressEventView,
  ProviderInfo,
  RefreshPreview,
  SearchHitView,
  SeriesView,
  TagCount,
  ThemeSummary,
  ViewingView,
  WatchAvailability,
} from './types';
import type { AppSettings } from './schemas';
import type { ThemeTokens, ContrastWarning } from '../domain/themes';

const none = z.undefined();
const byId = z.strictObject({ id: IdSchema });
const byItem = z.strictObject({ itemId: IdSchema });
const byToken = z.strictObject({ token: z.string().min(1).max(100) });
/** Theme ids: built-ins or UUIDs only. */
const ThemeIdSchema = z
  .string()
  .regex(
    /^(?:system|pile-light|pile-dark|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    'Unknown theme.',
  );

const SuggestionSchema = z.strictObject({
  kind: z.enum(['start', 'complete', 'reopen']),
  status: StatusSchema,
  message: z.string().max(500),
  setDateStarted: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

const ExternalIdList = z.array(z.string().min(1).max(200)).min(1).max(20_000);
const YearSchema = z.number().int().min(1900).max(2200);
export const STATS_CHART_IDS = [
  'completedByMonth',
  'completedByYear',
  'avgRatingByType',
  'topGenres',
  'topCreators',
  'timeToComplete',
  'episodesByMonth',
] as const;

const LayoutEntrySchema = z.strictObject({
  id: z.string().max(40),
  visible: z.boolean(),
  span: z.union([z.literal(1), z.literal(2)]),
});

export const REQUEST_SCHEMAS = {
  'app:info': none,
  'app:openDataFolder': none,
  'app:openExternal': OpenExternalSchema,
  'app:exportLog': none,
  'app:chooseBackupFolder': none,
  'app:acknowledgeNotices': none,

  'settings:get': none,
  'settings:update': SettingsPatchSchema,

  'items:query': LibraryQuerySchema,
  'items:get': byId,
  'items:create': ItemCreateSchema,
  'items:update': ItemUpdateSchema,
  'items:setStatus': StatusChangeSchema,
  'items:acceptSuggestion': z.strictObject({ id: IdSchema, suggestion: SuggestionSchema }),
  'items:setRating': z.strictObject({ id: IdSchema, rating: RatingSchema }),
  'items:delete': z.strictObject({ ids: z.array(IdSchema).min(1).max(10_000) }),
  'items:undoDelete': z.strictObject({ ids: z.array(IdSchema).min(1).max(10_000) }),
  'items:bulk': BulkActionSchema,
  'items:checkDuplicates': DuplicateCheckSchema,
  'items:dashboard': none,
  'items:tags': none,
  'items:audit': byId,
  'items:setUpNext': z.strictObject({ id: IdSchema, queued: z.boolean() }),
  'items:moveUpNext': z.strictObject({ id: IdSchema, direction: z.enum(['up', 'down']) }),
  'items:pickRandom': z.strictObject({
    types: z.array(MediaTypeSchema).max(4),
    excludeId: IdSchema.nullable(),
  }),
  'items:titles': none,
  'items:quickCapture': z.strictObject({
    title: requiredText(500, 'Title'),
    type: MediaTypeSchema,
    allowDuplicate: z.boolean(),
  }),

  'pick:roll': PickRequestSchema,
  'pick:respond': PickRespondSchema,
  'pick:history': none,
  'pick:clearSkips': none,

  'health:overview': none,
  'health:snooze': SnoozeSchema,
  'health:unsnooze': z.strictObject({ ids: z.array(IdSchema).min(1).max(10_000) }),
  'health:keep': z.strictObject({ ids: z.array(IdSchema).min(1).max(10_000) }),

  'lists:list': none,
  'lists:get': byId,
  'lists:save': ListInputSchema,
  'lists:delete': byId,
  'lists:move': z.strictObject({ id: IdSchema, direction: z.enum(['up', 'down']) }),
  'lists:setMembership': z.strictObject({
    listId: IdSchema,
    itemIds: z.array(IdSchema).min(1).max(10_000),
    member: z.boolean(),
  }),
  'lists:moveItem': z.strictObject({ listId: IdSchema, itemId: IdSchema, direction: z.enum(['up', 'down']) }),

  'stats:get': z.strictObject({ year: YearSchema.nullable() }),
  'stats:yearInReview': z.strictObject({ year: YearSchema }),
  'stats:exportCsv': z.strictObject({ chart: z.enum(STATS_CHART_IDS), year: YearSchema.nullable() }),
  'stats:saveImage': z.strictObject({
    name: z.string().regex(/^[a-z0-9-]{1,40}$/),
    rect: z.strictObject({
      x: z.number().int().min(0).max(20_000),
      y: z.number().int().min(0).max(20_000),
      width: z.number().int().min(1).max(8_000),
      height: z.number().int().min(1).max(8_000),
    }),
  }),

  'radar:upcoming': none,
  'radar:refreshPreview': none,
  'radar:refreshApply': z.strictObject({
    token: z.string().min(1).max(100),
    choices: z.record(IdSchema, z.enum(['keep', 'update'])),
  }),
  'radar:exportIcs': none,

  'sources:list': none,
  'sources:saveSteam': SteamSourceInputSchema,
  'sources:clearSteamKey': none,
  'sources:delete': z.strictObject({ sourceId: IdSchema }),
  'sources:testSteam': z.strictObject({ sourceId: IdSchema }),
  'sources:startFetch': z.strictObject({ sourceId: IdSchema }),
  'sources:fetchStatus': z.strictObject({ jobId: z.string().min(1).max(100) }),
  'sources:cancelFetch': z.strictObject({ jobId: z.string().min(1).max(100) }),
  'sources:entries': SourceEntryFilterSchema,
  'sources:setIgnored': z.strictObject({
    sourceId: IdSchema,
    externalIds: ExternalIdList,
    ignored: z.boolean(),
  }),
  'sources:import': SourceImportSchema,
  'sources:diff': z.strictObject({ sourceId: IdSchema }),
  'sources:applyPlaytime': z.strictObject({ sourceId: IdSchema, externalIds: ExternalIdList }),
  'sources:loadManual': ManualListInputSchema,
  'sources:loadManualFile': z.strictObject({
    sourceId: IdSchema.nullable(),
    label: requiredText(120, 'Label'),
  }),

  'batches:list': none,
  'batches:undoPreview': z.strictObject({ batchId: IdSchema }),
  'batches:undo': z.strictObject({ batchId: IdSchema }),

  'tracker:preview': z.strictObject({
    kind: z.enum(['goodreads', 'letterboxd', 'csv', 'mal']),
    profileId: IdSchema.nullable(),
  }),
  'tracker:remap': z.strictObject({
    mapToken: IdSchema,
    previousToken: z.string().max(100),
    mapping: CsvMappingSchema,
  }),
  'tracker:apply': TrackerApplySchema,
  'tracker:profiles': none,
  'tracker:saveProfile': z.strictObject({
    name: requiredText(80, 'Profile name'),
    mapping: CsvMappingSchema,
  }),
  'tracker:deleteProfile': byId,

  'goals:list': z.strictObject({ includeArchived: z.boolean() }),
  'goals:save': GoalInputSchema,
  'goals:archive': z.strictObject({ id: IdSchema, archived: z.boolean() }),
  'goals:delete': byId,

  'progress:add': AddProgressSchema,
  'progress:edit': EditProgressSchema,
  'progress:remove': z.strictObject({ eventId: IdSchema }),
  'progress:history': byItem,
  'progress:addViewing': ViewingInputSchema,
  'progress:editViewing': ViewingEditSchema,
  'progress:removeViewing': z.strictObject({ viewingId: IdSchema }),
  'progress:viewings': byItem,
  'progress:toggleEpisodes': EpisodeToggleSchema,
  'progress:upsertSeason': SeasonUpsertSchema,
  'progress:deleteSeason': z.strictObject({ itemId: IdSchema, seasonId: IdSchema }),
  'progress:upsertEpisode': EpisodeUpsertSchema,
  'progress:deleteEpisode': z.strictObject({ itemId: IdSchema, episodeId: IdSchema }),
  'progress:setMilestones': MilestonesSetSchema,
  'progress:setScheme': z.strictObject({ itemId: IdSchema, scheme: GameSchemeSchema }),

  'customFields:list': none,
  'customFields:save': CustomFieldDefInputSchema,
  'customFields:delete': byId,
  'series:list': none,
  'series:save': SeriesUpsertSchema,
  'series:delete': byId,
  'series:setMembership': SeriesMembershipSchema.extend({ member: z.boolean() }),

  'providers:list': none,
  'providers:search': ProviderSearchSchema,
  'providers:preview': ProviderRefSchema,
  'providers:import': ImportFromProviderSchema,
  'providers:refreshPreview': byItem,
  'providers:refreshApply': RefreshApplySchema,
  'providers:setKey': ProviderKeySchema,
  'providers:setEnabled': z.strictObject({ providerId: z.string().min(1).max(40), enabled: z.boolean() }),
  'providers:watch': z.strictObject({ itemId: IdSchema, region: RegionSchema }),

  'artwork:chooseLocal': byItem,
  'artwork:remove': byItem,
  'artwork:retry': byItem,

  'themes:list': none,
  'themes:get': z.strictObject({ id: ThemeIdSchema }),
  'themes:active': none,
  'themes:save': z.strictObject({
    id: ThemeIdSchema.nullable(),
    name: z.string().max(200),
    tokens: z.unknown(),
  }),
  'themes:duplicate': z.strictObject({ id: ThemeIdSchema }),
  'themes:delete': z.strictObject({ id: ThemeIdSchema }),
  'themes:import': none,
  'themes:export': z.strictObject({ id: ThemeIdSchema }),
  'themes:reset': z.strictObject({ deleteCustom: z.boolean() }),

  'layouts:get': none,
  'layouts:set': z.strictObject({
    surface: z.enum(['dashboard', 'library']),
    entries: z.array(LayoutEntrySchema).max(40),
  }),
  'layouts:reset': z.strictObject({ surface: z.enum(['dashboard', 'library', 'both']) }),
  'layouts:import': none,
  'layouts:export': none,

  'data:exportJson': none,
  'data:exportCsv': none,
  'data:importPreview': z.strictObject({ kind: z.enum(['json', 'csv', 'backup']) }),
  'data:importApply': ImportApplySchema.extend({ kind: z.enum(['json', 'csv', 'backup']) }),
  'data:importCancel': byToken.extend({ kind: z.enum(['json', 'csv', 'backup']) }),
  'data:backupCreate': none,
  'data:backupList': none,
  'data:restoreInternalPreview': z.strictObject({
    label: z.string().regex(/^pre-[a-z]+-[0-9TZ-]+(?:-\d+)?\.mpbackup$/),
  }),

  /* ---------------------------------------------------------------- Expansion Pack 2 */
  'stats:heatmap': S.HeatmapSchema,
  'artwork:slots': byItem,
  'artwork:gallery': byItem,
  'artwork:choose': S.ArtworkChooseSchema,
  'artwork:revert': S.ArtworkSlotRequestSchema,
  'artwork:clearSlot': S.ArtworkSlotRequestSchema,
  'artwork:autoPick': S.ArtworkAutoPickSchema,
  'artwork:bulkAutoPick': S.ArtworkBulkSchema,
  'anime:searchAll': S.AnimeSearchAllSchema,
  'pileTime:item': byItem,
  'pileTime:totals': none,
  'pileTime:fits': S.PileTimeFitsSchema,
  'pileTime:setManual': S.PileTimeManualSchema,
  'pileTime:fetchIgdb': byItem,
  'moods:list': none,
  'moods:create': S.MoodCreateSchema,
  'moods:update': S.MoodUpdateSchema,
  'moods:delete': byId,
  'moods:reorder': S.MoodReorderSchema,
  'moods:forItem': byItem,
  'moods:setForItem': S.ItemMoodsSchema,
  'moods:bulk': S.BulkMoodSchema,
  'itemExtras:prefs': byItem,
  'itemExtras:setPrefs': S.ItemPrefsPatchSchema,
  'itemExtras:runs': byItem,
  'itemExtras:updateRun': S.RunUpdateSchema,
  'itemExtras:streaming': byItem,
  'itemExtras:relations': byItem,
  'itemExtras:addRelation': S.RelationAddSchema,
  'itemExtras:removeRelation': S.RelationRemoveSchema,
  'itemExtras:suggestions': byItem,
  'itemExtras:resolveSuggestion': S.SuggestionResolveSchema,
  'itemExtras:franchisesForItem': byItem,
  'franchises:list': none,
  'franchises:get': byId,
  'franchises:create': S.FranchiseCreateSchema,
  'franchises:update': S.FranchiseUpdateSchema,
  'franchises:setEntries': S.FranchiseEntriesSchema,
  'franchises:delete': byId,
  'value:list': byItem,
  'value:add': S.PurchaseAddSchema,
  'value:update': S.PurchaseUpdateSchema,
  'value:delete': byId,
  'value:summary': none,
  'sessions:open': none,
  'sessions:forItem': byItem,
  'sessions:start': byItem,
  'sessions:pause': byId,
  'sessions:resume': byId,
  'sessions:stop': S.SessionStopSchema,
  'sessions:log': S.SessionLogSchema,
  'sessions:edit': S.SessionEditSchema,
  'sessions:delete': byId,
  'availability:services': none,
  'availability:addService': S.ServiceAddSchema,
  'availability:updateService': S.ServiceUpdateSchema,
  'availability:removeService': byId,
  'availability:forItem': byItem,
  'availability:add': S.AvailabilityAddSchema,
  'availability:update': S.AvailabilityUpdateSchema,
  'availability:delete': byId,
  'availability:leavingSoon': none,
  'recs:list': S.RecListSchema,
  'recs:feedback': S.RecFeedbackSchema,
  'recs:clearFeedback': none,
  'merge:pairs': none,
  'merge:dismiss': S.MergePairSchema,
  'merge:preview': S.MergePairSchema,
  'merge:apply': S.MergeApplySchema,
  'merge:lastUndoable': none,
  'merge:undo': byId,
  'share:saveCard': S.ShareCardSaveSchema,
  'sync:status': none,
  'sync:chooseFolder': none,
  'sync:disable': none,
  'sync:setDeviceName': z.strictObject({ name: requiredText(60, 'Device name') }),
  'sync:preview': none,
  'sync:apply': none,
  'sync:conflicts': none,
  'sync:resolve': z.strictObject({ id: IdSchema, choice: z.enum(['mine', 'theirs']) }),
  ...REQUEST_SCHEMAS_21,
} as const satisfies Record<Channel, z.ZodType>;

export interface ThemeDetailView {
  id: string;
  name: string;
  builtIn: boolean;
  tokens: ThemeTokens;
  warnings: ContrastWarning[];
}

export interface ActiveThemeView {
  selectedId: string;
  light: ThemeTokens;
  dark: ThemeTokens;
  followSystem: boolean;
  notice: string | null;
}

export type CreateResultView =
  { kind: 'created'; item: ItemDetail } | { kind: 'duplicates'; matches: DuplicateMatch[] };

export interface ResponseTypes extends ResponseTypes21 {
  'app:info': AppInfo;
  'app:openDataFolder': null;
  'app:openExternal': null;
  'app:exportLog': FileOpResult | null;
  'app:chooseBackupFolder': { label: string } | null;
  'app:acknowledgeNotices': null;
  'settings:get': AppSettings;
  'settings:update': AppSettings;
  'items:query': LibraryPage;
  'items:get': ItemDetail;
  'items:create': CreateResultView;
  'items:update': ItemDetail;
  'items:setStatus': MutationOutcome;
  'items:acceptSuggestion': MutationOutcome;
  'items:setRating': ItemDetail;
  'items:delete': { count: number };
  'items:undoDelete': { count: number };
  'items:bulk': { affected: number };
  'items:checkDuplicates': DuplicateMatch[];
  'items:dashboard': DashboardData;
  'items:tags': TagCount[];
  'items:audit': AuditEntryView[];
  'items:setUpNext': ItemDetail;
  'items:moveUpNext': DashboardData['upNext'];
  'items:pickRandom': ItemSummary | null;
  'items:titles': CommandTarget[];
  'items:quickCapture': CreateResultView;
  'pick:roll': PickResultView;
  'pick:respond': PickHistoryView[];
  'pick:history': PickHistoryView[];
  'pick:clearSkips': { cleared: number };
  'health:overview': HealthOverview;
  'health:snooze': HealthOverview;
  'health:unsnooze': HealthOverview;
  'health:keep': HealthOverview;
  'lists:list': ListSummaryView[];
  'lists:get': ListDetailView;
  'lists:save': ListSummaryView[];
  'lists:delete': ListSummaryView[];
  'lists:move': ListSummaryView[];
  'lists:setMembership': { changed: number; lists: ListSummaryView[] };
  'lists:moveItem': ListDetailView;
  'stats:get': StatsView;
  'stats:yearInReview': YearInReviewView;
  'stats:exportCsv': FileOpResult | null;
  'stats:saveImage': FileOpResult | null;
  'radar:upcoming': UpcomingItemView[];
  'radar:refreshPreview': RadarRefreshView;
  'radar:refreshApply': { updated: number };
  'radar:exportIcs': (FileOpResult & { included: number; skipped: number }) | null;
  'sources:list': LibrarySourceView[];
  'sources:saveSteam': LibrarySourceView[];
  'sources:clearSteamKey': LibrarySourceView[];
  'sources:delete': LibrarySourceView[];
  'sources:testSteam': { message: string };
  'sources:startFetch': FetchJobView;
  'sources:fetchStatus': FetchJobView;
  'sources:cancelFetch': FetchJobView;
  'sources:entries': SourceEntriesPage;
  'sources:setIgnored': { changed: number };
  'sources:import': BatchImportResultView;
  'sources:diff': SourceDiffView;
  'sources:applyPlaytime': { updated: number };
  'sources:loadManual': LibrarySourceView[];
  'sources:loadManualFile': LibrarySourceView[] | null;
  'batches:list': ImportBatchView[];
  'batches:undoPreview': UndoPreviewView;
  'batches:undo': UndoPreviewView;
  'tracker:preview': TrackerPreviewView | null;
  'tracker:remap': TrackerPreviewView;
  'tracker:apply': ImportResultView;
  'tracker:profiles': MappingProfileView[];
  'tracker:saveProfile': MappingProfileView[];
  'tracker:deleteProfile': MappingProfileView[];
  'goals:list': GoalView[];
  'goals:save': GoalView[];
  'goals:archive': GoalView[];
  'goals:delete': GoalView[];
  'progress:add': MutationOutcome;
  'progress:edit': MutationOutcome;
  'progress:remove': MutationOutcome;
  'progress:history': ProgressEventView[];
  'progress:addViewing': MutationOutcome;
  'progress:editViewing': MutationOutcome;
  'progress:removeViewing': MutationOutcome;
  'progress:viewings': ViewingView[];
  'progress:toggleEpisodes': MutationOutcome;
  'progress:upsertSeason': MutationOutcome;
  'progress:deleteSeason': MutationOutcome;
  'progress:upsertEpisode': MutationOutcome;
  'progress:deleteEpisode': MutationOutcome;
  'progress:setMilestones': MutationOutcome;
  'progress:setScheme': MutationOutcome;
  'customFields:list': CustomFieldDefView[];
  'customFields:save': CustomFieldDefView[];
  'customFields:delete': CustomFieldDefView[];
  'series:list': SeriesView[];
  'series:save': SeriesView[];
  'series:delete': SeriesView[];
  'series:setMembership': SeriesView[];
  'providers:list': ProviderInfo[];
  'providers:search': SearchHitView[];
  'providers:preview': ImportPreview;
  'providers:import': CreateResultView & { warnings: string[] };
  'providers:refreshPreview': RefreshPreview;
  'providers:refreshApply': ItemDetail;
  'providers:setKey': ProviderInfo[];
  'providers:setEnabled': ProviderInfo[];
  'providers:watch': WatchAvailability;
  'artwork:chooseLocal': ItemDetail | null;
  'artwork:remove': ItemDetail;
  'artwork:retry': ItemDetail;
  'themes:list': ThemeSummary[];
  'themes:get': ThemeDetailView;
  'themes:active': ActiveThemeView;
  'themes:save': ThemeDetailView;
  'themes:duplicate': ThemeDetailView;
  'themes:delete': null;
  'themes:import': ThemeDetailView | null;
  'themes:export': FileOpResult | null;
  'themes:reset': null;
  'layouts:get': LayoutsView;
  'layouts:set': LayoutsView;
  'layouts:reset': LayoutsView;
  'layouts:import': LayoutsView | null;
  'layouts:export': FileOpResult | null;
  'data:exportJson': FileOpResult | null;
  'data:exportCsv': FileOpResult | null;
  'data:importPreview': ImportPreviewView | null;
  'data:importApply': ImportResultView;
  'data:importCancel': null;
  'data:backupCreate': FileOpResult | null;
  'data:backupList': { label: string; bytes: number; kind: 'pre-restore' | 'pre-migration' | 'other' }[];
  'data:restoreInternalPreview': ImportPreviewView;

  /* ---------------------------------------------------------------- Expansion Pack 2 */
  'stats:heatmap': T.HeatmapView;
  'artwork:slots': T.ArtworkSlotView[];
  'artwork:gallery': T.ArtworkGallery;
  'artwork:choose': { slots: T.ArtworkSlotView[]; warning: string | null };
  'artwork:revert': T.ArtworkSlotView[];
  'artwork:clearSlot': T.ArtworkSlotView[];
  'artwork:autoPick': { slots: T.ArtworkSlotView[]; updated: string[]; kept: string[]; empty: string[] };
  'artwork:bulkAutoPick': T.BulkAutoPickResult;
  'anime:searchAll': T.AnimeSearchAllView;
  'pileTime:item': T.PileTimeEstimate & { manualMinutes: number | null; providerMinutes: number | null };
  'pileTime:totals': T.PileTimeTotals;
  'pileTime:fits': T.PileTimeRow[];
  'pileTime:setManual': T.PileTimeEstimate;
  'pileTime:fetchIgdb': T.PileTimeEstimate & { manualMinutes: number | null; providerMinutes: number | null };
  'moods:list': T.MoodView[];
  'moods:create': T.MoodView[];
  'moods:update': T.MoodView[];
  'moods:delete': T.MoodView[];
  'moods:reorder': T.MoodView[];
  'moods:forItem': string[];
  'moods:setForItem': string[];
  'moods:bulk': { changed: number };
  'itemExtras:prefs': T.ItemPrefsView;
  'itemExtras:setPrefs': T.ItemPrefsView;
  'itemExtras:runs': T.RunView[];
  'itemExtras:updateRun': T.RunView[];
  'itemExtras:streaming': T.StreamingLinkView[];
  'itemExtras:relations': T.RelationView[];
  'itemExtras:addRelation': T.RelationView[];
  'itemExtras:removeRelation': T.RelationView[];
  'itemExtras:suggestions': T.SuggestionView[];
  'itemExtras:resolveSuggestion': { relations: T.RelationView[]; suggestions: T.SuggestionView[] };
  'itemExtras:franchisesForItem': T.FranchiseView[];
  'franchises:list': T.FranchiseView[];
  'franchises:get': T.FranchiseView;
  'franchises:create': T.FranchiseView;
  'franchises:update': T.FranchiseView;
  'franchises:setEntries': T.FranchiseView;
  'franchises:delete': null;
  'value:list': T.PurchaseView[];
  'value:add': T.PurchaseView[];
  'value:update': T.PurchaseView[];
  'value:delete': T.PurchaseView[];
  'value:summary': T.CurrencyTotals[];
  'sessions:open': T.SessionView[];
  'sessions:forItem': T.SessionView[];
  'sessions:start': T.SessionView;
  'sessions:pause': T.SessionView;
  'sessions:resume': T.SessionView;
  'sessions:stop': T.SessionView;
  'sessions:log': T.SessionView;
  'sessions:edit': T.SessionView;
  'sessions:delete': null;
  'availability:services': T.ServiceView[];
  'availability:addService': T.ServiceView[];
  'availability:updateService': T.ServiceView[];
  'availability:removeService': T.ServiceView[];
  'availability:forItem': T.AvailabilityView[];
  'availability:add': T.AvailabilityView[];
  'availability:update': T.AvailabilityView[];
  'availability:delete': T.AvailabilityView[];
  'availability:leavingSoon': T.LeavingSoonView[];
  'recs:list': T.Recommendation[];
  'recs:feedback': null;
  'recs:clearFeedback': { cleared: number };
  'merge:pairs': T.DuplicatePair[];
  'merge:dismiss': T.DuplicatePair[];
  'merge:preview': T.MergePreview;
  'merge:apply': { snapshotId: string };
  'merge:lastUndoable': {
    snapshotId: string;
    keptTitle: string;
    removedTitle: string;
    createdAt: string;
  } | null;
  'merge:undo': null;
  'share:saveCard': FileOpResult | null;
  'sync:status': T.SyncStatusView;
  'sync:chooseFolder': T.SyncStatusView | null;
  'sync:disable': T.SyncStatusView;
  'sync:setDeviceName': T.SyncStatusView;
  'sync:preview': T.SyncPreviewView;
  'sync:apply': { applied: number; created: number; conflicts: number; sent: number; snapshot: string };
  'sync:conflicts': T.SyncConflictView[];
  'sync:resolve': T.SyncConflictView[];
}

export type RequestOf<C extends Channel> = z.input<(typeof REQUEST_SCHEMAS)[C]>;
export type ParsedRequestOf<C extends Channel> = z.output<(typeof REQUEST_SCHEMAS)[C]>;

/* ---------- typed renderer API (derived from API_SHAPE + schemas) ---------- */

type Shape = typeof API_SHAPE;
type Method<C extends Channel> =
  undefined extends RequestOf<C>
    ? (payload?: RequestOf<C>) => Promise<Result<ResponseTypes[C]>>
    : (payload: RequestOf<C>) => Promise<Result<ResponseTypes[C]>>;

export type MaybePileApi = {
  readonly [N in keyof Shape]: {
    readonly [M in keyof Shape[N]]: Shape[N][M] extends Channel ? Method<Shape[N][M]> : never;
  };
} & {
  readonly events: {
    onMenuCommand(cb: (command: MenuCommand) => void): () => void;
    /** In-app banner for a reminder that could not be shown by the OS (2.1). */
    onInAppNotification(cb: (n: { title: string; body: string; itemId: string | null }) => void): () => void;
    /** A notification click / maybepile://item link asks the app to open an item (2.1). */
    onOpenItem(cb: (itemId: string) => void): () => void;
  };
};
