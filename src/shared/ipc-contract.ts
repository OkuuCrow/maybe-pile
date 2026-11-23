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
} from './schemas';
import type { API_SHAPE, Channel, MenuCommand } from './ipc-channels';
import type { Result } from './result';
import type {
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
    entries: z.array(LayoutEntrySchema).max(20),
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

export interface ResponseTypes {
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
  };
};
