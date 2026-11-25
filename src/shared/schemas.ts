/**
 * Zod schemas for every value that crosses a trust boundary (renderer → main,
 * file imports, provider responses after mapping). TypeScript types are derived
 * from these schemas so validation and typing cannot drift apart.
 *
 * Schemas are `.strict()` on objects the renderer sends: unknown keys are
 * rejected rather than silently dropped, which makes contract mistakes loud.
 */
import { z } from 'zod';
import {
  AIRING_STATUSES,
  ANIME_FORMATS,
  ANIME_SEASONS,
  ARTWORK_SLOTS,
  AUDIO_PREFS,
  BOOK_FORMATS,
  CREATOR_ROLES,
  CUSTOM_FIELD_TYPES,
  EXTERNAL_ID_KINDS,
  GAME_SCHEMES,
  MEDIA_TYPES,
  SHOW_STATUSES,
  SORT_FIELDS,
  STATUSES,
  TITLE_LANGUAGES,
} from './enums';
import { isValidIsoDate, isValidPartialDate } from '../domain/dates';

export const LIMITS = {
  title: 500,
  altTitles: 20,
  description: 20_000,
  notes: 100_000,
  tag: 64,
  tags: 100,
  genre: 80,
  genres: 50,
  creatorName: 200,
  creators: 100,
  externalIdValue: 300,
  shortText: 200,
  customFieldName: 80,
  customFieldText: 2_000,
  customFieldOptions: 50,
  searchText: 200,
  episodesPerSeason: 2_000,
  seasons: 200,
  milestones: 200,
  pageSize: 500,
  bulkIds: 10_000,
  note: 2_000,
} as const;

/** Strips C0 control characters (except tab/newline) and trims. */
const cleanString = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

export const text = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(cleanString)
    .pipe(z.string().max(max));
export const requiredText = (max: number, label = 'This field') =>
  z
    .string()
    .max(max * 2)
    .transform(cleanString)
    .pipe(z.string().min(1, `${label} is required.`).max(max, `${label} must be at most ${max} characters.`));
export const nullableText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(cleanString)
    .pipe(z.string().max(max))
    .nullable()
    .transform((v) => (v === '' ? null : v));

export const IdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid id.');

export const PartialDateSchema = z
  .string()
  .refine(isValidPartialDate, 'Use YYYY, YYYY-MM or YYYY-MM-DD with a real date.');
export const IsoDateSchema = z.string().refine(isValidIsoDate, 'Use a real date in YYYY-MM-DD form.');
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Rating is stored as an integer 1–10 meaning half-stars: 7 → 3.5 stars. */
export const RatingSchema = z.number().int().min(1).max(10).nullable();

export const MediaTypeSchema = z.enum(MEDIA_TYPES);
export const StatusSchema = z.enum(STATUSES);
export const CreatorRoleSchema = z.enum(CREATOR_ROLES);
export const GameSchemeSchema = z.enum(GAME_SCHEMES);
export const BookFormatSchema = z.enum(BOOK_FORMATS);
export const ShowStatusSchema = z.enum(SHOW_STATUSES);
export const ExternalIdKindSchema = z.enum(EXTERNAL_ID_KINDS);

export const CreatorSchema = z.strictObject({
  name: requiredText(LIMITS.creatorName, 'Name'),
  role: CreatorRoleSchema,
});
export type Creator = z.infer<typeof CreatorSchema>;

export const ExternalIdSchema = z.strictObject({
  kind: ExternalIdKindSchema,
  value: requiredText(LIMITS.externalIdValue, 'Identifier'),
});
export type ExternalId = z.infer<typeof ExternalIdSchema>;

const nonNegInt = (max: number) => z.number().int().min(0).max(max).nullable();

/**
 * Metadata fields: values that can come from a provider and whose origin is
 * tracked in `field_provenance`. Fields not relevant to an item's type are null.
 */
export const MetadataFieldsSchema = z.strictObject({
  title: requiredText(LIMITS.title, 'Title'),
  altTitles: z.array(requiredText(LIMITS.title, 'Alternate title')).max(LIMITS.altTitles),
  description: nullableText(LIMITS.description),
  releaseDate: PartialDateSchema.nullable(),
  genres: z.array(requiredText(LIMITS.genre, 'Genre')).max(LIMITS.genres),
  creators: z.array(CreatorSchema).max(LIMITS.creators),
  externalIds: z.array(ExternalIdSchema).max(30),
  // movie
  runtimeMinutes: nonNegInt(10_000),
  originalLanguage: nullableText(20),
  ageRating: nullableText(40),
  // tv
  network: nullableText(LIMITS.shortText),
  showStatus: ShowStatusSchema.nullable(),
  episodeRuntime: nonNegInt(10_000),
  lastAirDate: PartialDateSchema.nullable(),
  // book
  publisher: nullableText(LIMITS.shortText),
  pageCount: z.number().int().min(1).max(100_000).nullable(),
  audioMinutes: nonNegInt(100_000),
  isbn10: nullableText(13),
  isbn13: nullableText(17),
  // anime (Expansion Pack 2). Defaults keep pre-2.0 payloads and export files valid.
  animeFormat: z.enum(ANIME_FORMATS).nullable().default(null),
  airingStatus: z.enum(AIRING_STATUSES).nullable().default(null),
  animeSeason: z.enum(ANIME_SEASONS).nullable().default(null),
  seasonYear: z.number().int().min(1900).max(2200).nullable().default(null),
  sourceMaterial: nullableText(40).default(null),
  episodeCount: nonNegInt(100_000).default(null),
  nextEpisode: nonNegInt(100_000).default(null),
  nextAiringAt: IsoDateTimeSchema.nullable().default(null),
  isAdult: z.boolean().default(false),
  titleRomaji: nullableText(LIMITS.title).default(null),
  titleEnglish: nullableText(LIMITS.title).default(null),
  titleNative: nullableText(LIMITS.title).default(null),
});
export type MetadataFields = z.infer<typeof MetadataFieldsSchema>;
export type MetadataField = keyof MetadataFields;

export const PlatformSchema = z.strictObject({
  name: requiredText(80, 'Platform'),
  owned: z.boolean(),
  played: z.boolean(),
});
export type Platform = z.infer<typeof PlatformSchema>;

export const CustomFieldValueInputSchema = z.strictObject({
  defId: IdSchema,
  value: z.union([z.string().max(LIMITS.customFieldText), z.number().finite(), z.boolean(), z.null()]),
});
export type CustomFieldValueInput = z.infer<typeof CustomFieldValueInputSchema>;

export const PersonalFieldsSchema = z.strictObject({
  status: StatusSchema,
  rating: RatingSchema,
  notes: text(LIMITS.notes),
  dateAdded: IsoDateSchema,
  dateStarted: IsoDateSchema.nullable(),
  dateCompleted: IsoDateSchema.nullable(),
  tags: z.array(requiredText(LIMITS.tag, 'Tag')).max(LIMITS.tags),
  gameScheme: GameSchemeSchema.nullable(),
  platforms: z.array(PlatformSchema).max(50),
  bookFormat: BookFormatSchema.nullable(),
  customFields: z.array(CustomFieldValueInputSchema).max(100),
});
export type PersonalFields = z.infer<typeof PersonalFieldsSchema>;

export const EpisodeInputSchema = z.strictObject({
  number: z.number().int().min(0).max(100_000),
  title: nullableText(LIMITS.title),
  airDate: PartialDateSchema.nullable(),
  runtime: nonNegInt(10_000),
});
export type EpisodeInput = z.infer<typeof EpisodeInputSchema>;

export const SeasonInputSchema = z.strictObject({
  number: z.number().int().min(0).max(10_000),
  title: nullableText(LIMITS.title),
  /** Known total episode count, or null when unknown. May exceed listed episodes. */
  episodeCountKnown: z.number().int().min(0).max(100_000).nullable(),
  episodes: z.array(EpisodeInputSchema).max(LIMITS.episodesPerSeason),
});
export type SeasonInput = z.infer<typeof SeasonInputSchema>;

export const ItemCreateSchema = z
  .strictObject({
    type: MediaTypeSchema,
    meta: MetadataFieldsSchema,
    personal: PersonalFieldsSchema,
    seasons: z.array(SeasonInputSchema).max(LIMITS.seasons),
    milestones: z.array(requiredText(LIMITS.shortText, 'Milestone')).max(LIMITS.milestones),
    /** Set when the user chose "add anyway" after a duplicate warning. */
    allowDuplicate: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (
      v.personal.dateStarted &&
      v.personal.dateCompleted &&
      v.personal.dateCompleted < v.personal.dateStarted
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['personal', 'dateCompleted'],
        message: 'Completed date cannot be before the start date.',
      });
    }
  });
export type ItemCreateInput = z.infer<typeof ItemCreateSchema>;

export const ItemUpdateSchema = z
  .strictObject({
    id: IdSchema,
    meta: MetadataFieldsSchema.optional(),
    personal: PersonalFieldsSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const p = v.personal;
    if (p?.dateStarted && p.dateCompleted && p.dateCompleted < p.dateStarted) {
      ctx.addIssue({
        code: 'custom',
        path: ['personal', 'dateCompleted'],
        message: 'Completed date cannot be before the start date.',
      });
    }
  });
export type ItemUpdateInput = z.infer<typeof ItemUpdateSchema>;

export const LibraryQuerySchema = z.strictObject({
  text: text(LIMITS.searchText),
  types: z.array(MediaTypeSchema).max(4),
  statuses: z.array(StatusSchema).max(5),
  tags: z.array(requiredText(LIMITS.tag, 'Tag')).max(50),
  tagMode: z.enum(['any', 'all']),
  ratingMin: RatingSchema,
  ratingMax: RatingSchema,
  addedFrom: IsoDateSchema.nullable(),
  addedTo: IsoDateSchema.nullable(),
  sort: z.enum(SORT_FIELDS),
  direction: z.enum(['asc', 'desc']),
  offset: z.number().int().min(0).max(10_000_000),
  limit: z.number().int().min(1).max(LIMITS.pageSize),
  /* Added in 1.2; defaults keep older saved queries valid. */
  listId: IdSchema.nullable().default(null),
  upNextOnly: z.boolean().default(false),
  health: z.enum(['stale', 'snoozed']).nullable().default(null),
});
export type LibraryQuery = z.infer<typeof LibraryQuerySchema>;

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = {
  text: '',
  types: [],
  statuses: [],
  tags: [],
  tagMode: 'any',
  ratingMin: null,
  ratingMax: null,
  addedFrom: null,
  addedTo: null,
  sort: 'dateAdded',
  direction: 'desc',
  offset: 0,
  limit: 200,
  listId: null,
  upNextOnly: false,
  health: null,
};

export const DuplicateCheckSchema = z.strictObject({
  type: MediaTypeSchema,
  title: requiredText(LIMITS.title, 'Title'),
  releaseDate: PartialDateSchema.nullable(),
  externalIds: z.array(ExternalIdSchema).max(30),
  excludeId: IdSchema.nullable(),
});
export type DuplicateCheckInput = z.infer<typeof DuplicateCheckSchema>;

export const BulkActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('setStatus'),
    ids: z.array(IdSchema).min(1).max(LIMITS.bulkIds),
    status: StatusSchema,
  }),
  z.strictObject({
    action: z.literal('addTag'),
    ids: z.array(IdSchema).min(1).max(LIMITS.bulkIds),
    tag: requiredText(LIMITS.tag, 'Tag'),
  }),
  z.strictObject({
    action: z.literal('removeTag'),
    ids: z.array(IdSchema).min(1).max(LIMITS.bulkIds),
    tag: requiredText(LIMITS.tag, 'Tag'),
  }),
  z.strictObject({ action: z.literal('delete'), ids: z.array(IdSchema).min(1).max(LIMITS.bulkIds) }),
  z.strictObject({ action: z.literal('addUpNext'), ids: z.array(IdSchema).min(1).max(LIMITS.bulkIds) }),
  z.strictObject({
    action: z.literal('addToList'),
    ids: z.array(IdSchema).min(1).max(LIMITS.bulkIds),
    listId: IdSchema,
  }),
  z.strictObject({
    action: z.literal('snooze'),
    ids: z.array(IdSchema).min(1).max(LIMITS.bulkIds),
    until: IsoDateSchema,
  }),
]);
export type BulkActionInput = z.infer<typeof BulkActionSchema>;

/* ---------- progress ---------- */

export const ProgressEntryInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('percent'), value: z.number().min(0).max(100) }),
  z.strictObject({ kind: z.literal('hours'), value: z.number().min(0).max(100_000) }),
  z.strictObject({ kind: z.literal('text'), text: requiredText(LIMITS.note, 'Progress') }),
  z.strictObject({ kind: z.literal('milestone'), milestoneId: IdSchema }),
  z.strictObject({ kind: z.literal('pages'), value: z.number().int().min(0).max(100_000) }),
  z.strictObject({ kind: z.literal('audio'), value: z.number().int().min(0).max(100_000) }),
]);
export type ProgressEntryInput = z.infer<typeof ProgressEntryInputSchema>;

export const AddProgressSchema = z.strictObject({
  itemId: IdSchema,
  entry: ProgressEntryInputSchema,
  occurredAt: IsoDateTimeSchema.nullable(),
  note: nullableText(LIMITS.note),
});
export type AddProgressInput = z.infer<typeof AddProgressSchema>;

export const EditProgressSchema = z.strictObject({
  eventId: IdSchema,
  occurredAt: IsoDateTimeSchema.nullable(),
  note: nullableText(LIMITS.note),
  /** New numeric value for numeric kinds; ignored otherwise. */
  value: z.number().min(0).max(100_000).nullable(),
  text: nullableText(LIMITS.note),
});
export type EditProgressInput = z.infer<typeof EditProgressSchema>;

export const ViewingInputSchema = z.strictObject({
  itemId: IdSchema,
  watchedAt: IsoDateTimeSchema.nullable(),
  note: nullableText(LIMITS.note),
});
export const ViewingEditSchema = z.strictObject({
  viewingId: IdSchema,
  watchedAt: IsoDateTimeSchema.nullable(),
  note: nullableText(LIMITS.note),
});

export const EpisodeToggleSchema = z.strictObject({
  itemId: IdSchema,
  episodeIds: z.array(IdSchema).min(1).max(100_000),
  watched: z.boolean(),
  /** 'episode' for a single toggle, 'season'/'upTo' for bulk actions (affects history labels). */
  scope: z.enum(['episode', 'season', 'upTo']),
});
export type EpisodeToggleInput = z.infer<typeof EpisodeToggleSchema>;

export const SeasonUpsertSchema = z.strictObject({
  itemId: IdSchema,
  seasonId: IdSchema.nullable(),
  number: z.number().int().min(0).max(10_000),
  title: nullableText(LIMITS.title),
  episodeCountKnown: z.number().int().min(0).max(100_000).nullable(),
});
export const EpisodeUpsertSchema = z.strictObject({
  itemId: IdSchema,
  seasonId: IdSchema,
  episodeId: IdSchema.nullable(),
  number: z.number().int().min(0).max(100_000),
  title: nullableText(LIMITS.title),
  airDate: PartialDateSchema.nullable(),
  runtime: nonNegInt(10_000),
});
export const MilestonesSetSchema = z.strictObject({
  itemId: IdSchema,
  milestones: z
    .array(z.strictObject({ id: IdSchema.nullable(), title: requiredText(LIMITS.shortText, 'Milestone') }))
    .max(LIMITS.milestones),
});

export const StatusChangeSchema = z.strictObject({
  id: IdSchema,
  status: StatusSchema,
  /** Confirmed by the user: start a new pass when re-opening a Completed item. */
  startNewPass: z.boolean(),
  /** Confirmed by the user: clear date_completed when re-opening. */
  clearDateCompleted: z.boolean(),
  /** Fill remaining progress when completing (TV episodes, book pages, game 100%). */
  fillRemaining: z.boolean(),
});
export type StatusChangeInput = z.infer<typeof StatusChangeSchema>;

/* ---------- custom fields ---------- */

export const CustomFieldDefInputSchema = z
  .strictObject({
    id: IdSchema.nullable(),
    name: requiredText(LIMITS.customFieldName, 'Field name'),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(requiredText(LIMITS.shortText, 'Option')).max(LIMITS.customFieldOptions),
  })
  .refine((d) => d.type !== 'select' || d.options.length > 0, {
    message: 'A single-select field needs at least one option.',
    path: ['options'],
  });
export type CustomFieldDefInput = z.infer<typeof CustomFieldDefInputSchema>;

/* ---------- series ---------- */

export const SeriesUpsertSchema = z.strictObject({
  id: IdSchema.nullable(),
  name: requiredText(LIMITS.shortText, 'Series name'),
  description: nullableText(LIMITS.description),
  totalKnown: z.number().int().min(1).max(10_000).nullable(),
});
export const SeriesMembershipSchema = z.strictObject({
  seriesId: IdSchema,
  itemId: IdSchema,
  position: z.number().min(0).max(10_000).nullable(),
});

/* ---------- settings ---------- */

export const RegionSchema = z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter region code such as US or GB.');

export const PickSettingsSchema = z.strictObject({
  favor: z.enum(['neutral', 'older', 'newer']),
  favorInProgress: z.boolean(),
  includeInProgress: z.boolean(),
  includeOnHold: z.boolean(),
  /** Days a "Not now" keeps an item out of picks. */
  skipDays: z.number().int().min(1).max(365),
});
export type PickSettings = z.infer<typeof PickSettingsSchema>;

export const PileHealthSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  plannedStaleMonths: z.number().int().min(1).max(120),
  inProgressStaleDays: z.number().int().min(7).max(3650),
});
export type PileHealthSettings = z.infer<typeof PileHealthSettingsSchema>;

export const ReleaseRadarSettingsSchema = z.strictObject({
  includeOnHold: z.boolean(),
  notifications: z.boolean(),
  refreshOnStart: z.boolean(),
});
export type ReleaseRadarSettings = z.infer<typeof ReleaseRadarSettingsSchema>;

/** Electron accelerator; validated against a strict pattern (modifiers + one key). */
export const AcceleratorSchema = z
  .string()
  .max(60)
  .regex(
    /^(?:(?:CommandOrControl|CmdOrCtrl|Control|Ctrl|Alt|Option|Shift|Super|Command|Cmd)\+){1,3}(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space)$/,
    'Use modifiers plus one key, for example CommandOrControl+Shift+Space.',
  );

export const QuickCaptureSettingsSchema = z.strictObject({
  globalShortcut: z.boolean(),
  accelerator: AcceleratorSchema,
});

/* ---- Expansion Pack 2 settings ---- */
const ProviderIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9-]+$/);

export const AnimeSettingsSchema = z.strictObject({
  titleLanguage: z.enum(TITLE_LANGUAGES),
  /** Adult titles hidden from search/import unless enabled. */
  showAdult: z.boolean(),
  /** Adult artwork is blurred until revealed (even when showAdult is on). */
  blurAdultArt: z.boolean(),
  audioPref: z.enum(AUDIO_PREFS),
  /** Provider order for anime search ("All sources" uses this order to rank/merge). */
  providerOrder: z.array(ProviderIdSchema).max(12),
});
export type AnimeSettings = z.infer<typeof AnimeSettingsSchema>;

export const ArtworkSettingsSchema = z.strictObject({
  /** Per media type: art source ids in priority order for bulk auto-pick. */
  priority: z.record(MediaTypeSchema, z.array(ProviderIdSchema).max(12)),
  /** Slots auto-filled on import/bulk auto-pick (cover is always filled when available). */
  autoSlots: z.array(z.enum(ARTWORK_SLOTS)).max(5),
});
export type ArtworkSettings = z.infer<typeof ArtworkSettingsSchema>;

export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, e.g. USD.');

export const AppSettingsSchema = z.strictObject({
  activeThemeId: z.string().min(1).max(80),
  region: RegionSchema,
  autoApplySuggestions: z.boolean(),
  libraryView: z.enum(['grid', 'list']),
  libraryQuery: LibraryQuerySchema,
  providerEnabled: z.record(z.string().max(40), z.boolean()),
  csvBom: z.boolean(),
  lastSeenSchemaVersion: z.number().int().min(0),
  /* ---- feature pack (1.2) ---- */
  upNextMax: z.number().int().min(3).max(25),
  pick: PickSettingsSchema,
  pileHealth: PileHealthSettingsSchema,
  releaseRadar: ReleaseRadarSettingsSchema,
  quickCapture: QuickCaptureSettingsSchema,
  stats: z.strictObject({ showStreaks: z.boolean() }),
  importUndoRetentionDays: z.number().int().min(1).max(365),
  /* ---- expansion pack 2 ---- */
  anime: AnimeSettingsSchema,
  artwork: ArtworkSettingsSchema,
  spoilers: z.strictObject({
    /** Default for items whose spoiler mode is "default". */
    shieldByDefault: z.boolean(),
    shieldNotes: z.boolean(),
  }),
  value: z.strictObject({ currency: CurrencyCodeSchema }),
  sessions: z.strictObject({
    /** Sessions longer than this are flagged for review instead of silently counted. */
    maxSessionHours: z.number().int().min(1).max(48),
  }),
  availability: z.strictObject({
    leavingSoonDays: z.number().int().min(1).max(90),
    notifications: z.boolean(),
  }),
  recommendations: z.strictObject({ enabled: z.boolean() }),
  sync: z.strictObject({
    enabled: z.boolean(),
    /** Absolute folder path chosen with the OS dialog (never sent to the renderer unvalidated). */
    folder: z.string().max(1000).nullable(),
    deviceName: z.string().min(1).max(60),
  }),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

/** `sync` is excluded: the folder may only be chosen through main's native dialog (sync:chooseFolder). */
export const SettingsPatchSchema = AppSettingsSchema.omit({ sync: true }).partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/* ---------- provider requests ---------- */

export const ProviderSearchSchema = z.strictObject({
  providerId: z.string().min(1).max(40),
  type: MediaTypeSchema,
  query: requiredText(LIMITS.searchText, 'Search text'),
  year: z.number().int().min(1800).max(2200).nullable(),
});
export type ProviderSearchInput = z.infer<typeof ProviderSearchSchema>;

export const ProviderRefSchema = z.strictObject({
  providerId: z.string().min(1).max(40),
  id: z.string().min(1).max(100),
  type: MediaTypeSchema,
});
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

export const ImportFromProviderSchema = z.strictObject({
  previewToken: z.string().min(1).max(100),
  status: StatusSchema,
  tags: z.array(requiredText(LIMITS.tag, 'Tag')).max(LIMITS.tags),
  allowDuplicate: z.boolean(),
});
export type ImportFromProviderInput = z.infer<typeof ImportFromProviderSchema>;

export const RefreshApplySchema = z.strictObject({
  token: z.string().min(1).max(100),
  choices: z.record(z.string().max(40), z.enum(['keep', 'update'])),
});
export type RefreshApplyInput = z.infer<typeof RefreshApplySchema>;

export const ProviderKeySchema = z.strictObject({
  providerId: z.string().min(1).max(40),
  /** e.g. 'apiKey', 'clientId', 'clientSecret' */
  field: z.enum(['apiKey', 'clientId', 'clientSecret']),
  value: z.string().max(2_000).transform(cleanString),
});

export const OpenExternalSchema = z.strictObject({ url: z.string().min(1).max(2_048) });

export const ImportApplySchema = z.strictObject({
  token: z.string().min(1).max(100),
  /** Global default for conflicts; per-conflict overrides keyed by conflict id. */
  defaultResolution: z.enum(['skip', 'duplicate', 'update']),
  resolutions: z.record(z.string().max(100), z.enum(['skip', 'duplicate', 'update'])),
  /** Restore requires the user to have typed this exact confirmation word. */
  confirmation: z.string().max(40),
});
export type ImportApplyInput = z.infer<typeof ImportApplySchema>;

/* ---------- feature pack (1.2) ---------- */

export const LIST_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink'] as const;
export const LIST_ICONS = ['list', 'star', 'heart', 'ghost', 'users', 'plane', 'flame', 'leaf'] as const;

export const ListInputSchema = z.strictObject({
  id: IdSchema.nullable(),
  name: requiredText(80, 'List name'),
  description: nullableText(2_000),
  color: z.enum(LIST_COLORS).nullable(),
  icon: z.enum(LIST_ICONS).nullable(),
});
export type ListInput = z.infer<typeof ListInputSchema>;

export const PickConstraintsSchema = z.strictObject({
  types: z.array(MediaTypeSchema).max(4),
  genres: z.array(requiredText(LIMITS.genre, 'Genre')).max(20),
  tags: z.array(requiredText(LIMITS.tag, 'Tag')).max(20),
  listIds: z.array(IdSchema).max(20),
  onlyUpNext: z.boolean(),
  includeInProgress: z.boolean(),
  includeOnHold: z.boolean(),
  availableMinutes: z.number().int().min(5).max(1_440).nullable(),
  ratingFloor: RatingSchema,
  excludeSkipped: z.boolean(),
  /* Expansion Pack 2 */
  moodIds: z.array(IdSchema).max(5).default([]),
  finishWithinMinutes: z.number().int().min(5).max(100_000).nullable().default(null),
  respectSeriesOrder: z.boolean().default(false),
});

export const PickRequestSchema = z.strictObject({
  constraints: PickConstraintsSchema,
  /** Ids not to repeat immediately (e.g. the previous pick). */
  avoid: z.array(IdSchema).max(20),
  /** Optional seed for reproducible picks (tests, "same again"). */
  seed: z.number().int().min(0).max(4_294_967_295).nullable(),
});
export type PickRequest = z.infer<typeof PickRequestSchema>;
/** Callers may omit the Expansion Pack 2 constraint fields (they default). */
export type PickRequestInput = z.input<typeof PickRequestSchema>;

export const PickRespondSchema = z.strictObject({
  historyId: IdSchema,
  outcome: z.enum(['started', 'skipped', 'queued']),
});

export const SnoozeSchema = z.strictObject({
  ids: z.array(IdSchema).min(1).max(LIMITS.bulkIds),
  until: IsoDateSchema,
});

export const GoalInputSchema = z
  .strictObject({
    id: IdSchema.nullable(),
    title: requiredText(120, 'Goal name'),
    mediaType: MediaTypeSchema.nullable(),
    metric: z.enum(['items', 'pages', 'episodes', 'hours']),
    period: z.enum(['year', 'month', 'custom']),
    /** For year/month: any date inside the period. For custom: the start. */
    startDate: IsoDateSchema,
    /** Only for custom periods. */
    endDate: IsoDateSchema.nullable(),
    target: z.number().int().min(1).max(1_000_000),
    listId: IdSchema.nullable(),
    tag: nullableText(LIMITS.tag),
  })
  .superRefine((g, ctx) => {
    if (g.period === 'custom' && !g.endDate)
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Choose an end date for a custom period.' });
    if (g.period === 'custom' && g.endDate && g.endDate < g.startDate)
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'The end date must be after the start date.',
      });
    if (g.metric === 'pages' && g.mediaType !== null && g.mediaType !== 'book')
      ctx.addIssue({ code: 'custom', path: ['metric'], message: 'Pages can only be counted for books.' });
    if (g.metric === 'episodes' && g.mediaType !== null && g.mediaType !== 'tv' && g.mediaType !== 'anime')
      ctx.addIssue({
        code: 'custom',
        path: ['metric'],
        message: 'Episodes can only be counted for TV shows and anime.',
      });
    if (g.metric === 'hours' && g.mediaType !== null && g.mediaType !== 'game')
      ctx.addIssue({ code: 'custom', path: ['metric'], message: 'Hours can only be counted for games.' });
  });
export type GoalInput = z.infer<typeof GoalInputSchema>;

/* ---- library sources ---- */

export const SourceEntryFilterSchema = z.strictObject({
  sourceId: IdSchema,
  view: z.enum(['unplayed', 'played', 'all', 'inPile', 'ignored', 'new', 'removed']),
  search: text(LIMITS.searchText),
  showNonGames: z.boolean(),
  sort: z.enum(['name', 'playtime', 'lastPlayed', 'appid']),
  direction: z.enum(['asc', 'desc']),
});
export type SourceEntryFilter = z.infer<typeof SourceEntryFilterSchema>;

export const SteamSourceInputSchema = z.strictObject({
  sourceId: IdSchema.nullable(),
  label: requiredText(120, 'Label'),
  /** SteamID64, profile URL or vanity name; parsed and host-checked in main. */
  account: requiredText(200, 'Steam account'),
  /** New API key; empty string keeps the stored key. Never echoed back. */
  apiKey: z.string().max(200).transform(cleanString),
});

export const SourceImportSchema = z.strictObject({
  sourceId: IdSchema,
  externalIds: z.array(z.string().min(1).max(200)).min(1).max(20_000),
  status: StatusSchema,
  tags: z.array(requiredText(LIMITS.tag, 'Tag')).max(20),
  listId: IdSchema.nullable(),
  importPlaytime: z.boolean(),
  enrich: z.boolean(),
});
export type SourceImportInput = z.infer<typeof SourceImportSchema>;

export const ManualListInputSchema = z.strictObject({
  sourceId: IdSchema.nullable(),
  label: requiredText(120, 'Label'),
  /** Pasted text: one title per line, or CSV with a title column and optional platform column. */
  text: z.string().max(5_000_000),
});

/* ======================================================================
 * Expansion Pack 2 — IPC request schemas (validated in main).
 * ==================================================================== */

export const ArtworkSlotSchema = z.enum(ARTWORK_SLOTS);
export const ArtworkChooseSchema = z.strictObject({
  itemId: IdSchema,
  token: z.string().regex(/^[0-9a-f]{32}$/),
});
export const ArtworkSlotRequestSchema = z.strictObject({ itemId: IdSchema, slot: ArtworkSlotSchema });
export const ArtworkAutoPickSchema = z.strictObject({
  itemId: IdSchema,
  slots: z.array(ArtworkSlotSchema).max(5).nullable(),
});
export const ArtworkBulkSchema = z.strictObject({
  itemIds: z.array(IdSchema).min(1).max(500),
  slots: z.array(ArtworkSlotSchema).max(5).nullable(),
});

export const AnimeSearchAllSchema = z.strictObject({
  query: requiredText(LIMITS.searchText, 'Search text'),
  year: z.number().int().min(1900).max(2200).nullable(),
});

export const PileTimeManualSchema = z.strictObject({
  itemId: IdSchema,
  /** null clears the estimate. */
  minutes: z.number().int().min(1).max(600_000).nullable(),
});
export const PileTimeFitsSchema = z.strictObject({
  budgetMinutes: z.number().int().min(5).max(100_000),
  types: z.array(MediaTypeSchema).max(5).nullable(),
  /** Items must have ALL these moods. */
  moodIds: z.array(IdSchema).max(5),
});

const MoodColorSchema = z.enum(['slate', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink']);
const MoodIconSchema = z.enum([
  'sofa',
  'clock',
  'cloud',
  'bolt',
  'heart',
  'laugh',
  'users',
  'repeat',
  'mountain',
  'star',
  'leaf',
  'moon',
  'sun',
  'music',
  'ghost',
  'flame',
]);
export const MoodCreateSchema = z.strictObject({
  name: requiredText(40, 'Mood name'),
  icon: MoodIconSchema,
  color: MoodColorSchema.nullable(),
});
export const MoodUpdateSchema = z.strictObject({
  id: IdSchema,
  name: requiredText(40, 'Mood name').optional(),
  icon: MoodIconSchema.optional(),
  color: MoodColorSchema.nullable().optional(),
  hidden: z.boolean().optional(),
});
export const MoodReorderSchema = z.strictObject({ ids: z.array(IdSchema).max(60) });
export const ItemMoodsSchema = z.strictObject({ itemId: IdSchema, moodIds: z.array(IdSchema).max(12) });
export const BulkMoodSchema = z.strictObject({
  itemIds: z.array(IdSchema).min(1).max(5000),
  moodId: IdSchema,
  add: z.boolean(),
});

export const ItemPrefsPatchSchema = z.strictObject({
  itemId: IdSchema,
  spoilerMode: z.enum(['default', 'shield', 'show']).optional(),
  notesSpoiler: z.boolean().optional(),
  hoursSource: z.enum(['manual', 'sessions', 'steam']).optional(),
  audioPref: z.enum(AUDIO_PREFS).nullable().optional(),
});

export const RunUpdateSchema = z.strictObject({
  itemId: IdSchema,
  runNumber: z.number().int().min(1).max(1000),
  dateStarted: IsoDateSchema.nullable().optional(),
  dateCompleted: IsoDateSchema.nullable().optional(),
  rating: RatingSchema.optional(),
  notes: z.string().max(20_000).optional(),
});

const RelationInputSchema = z.enum([
  'prequel',
  'sequel',
  'spin_off',
  'side_story',
  'adaptation_of',
  'adapted_as',
  'remake_of',
  'same_franchise',
]);
export const RelationAddSchema = z.strictObject({
  itemId: IdSchema,
  otherId: IdSchema,
  relation: RelationInputSchema,
});
export const RelationRemoveSchema = z.strictObject({ itemId: IdSchema, relationId: IdSchema });
export const SuggestionResolveSchema = z.strictObject({
  itemId: IdSchema,
  suggestionId: IdSchema,
  accept: z.boolean(),
});
export const FranchiseCreateSchema = z.strictObject({
  name: requiredText(120, 'Series name'),
  itemIds: z.array(IdSchema).max(500),
});
export const FranchiseUpdateSchema = z.strictObject({
  id: IdSchema,
  name: requiredText(120, 'Series name').optional(),
  respectOrder: z.boolean().optional(),
});
export const FranchiseEntriesSchema = z.strictObject({
  id: IdSchema,
  entries: z.array(z.strictObject({ itemId: IdSchema, mainline: z.boolean() })).max(500),
});

export const PurchaseInputSchema = z.strictObject({
  amountMinor: z.number().int().min(0).max(100_000_000_000),
  currency: CurrencyCodeSchema,
  purchasedOn: IsoDateSchema.nullable(),
  store: nullableText(120),
  edition: nullableText(200),
  notes: nullableText(2000),
});
export const PurchaseAddSchema = z.strictObject({ itemId: IdSchema, purchase: PurchaseInputSchema });
export const PurchaseUpdateSchema = z.strictObject({ id: IdSchema, purchase: PurchaseInputSchema });

export const SessionStopSchema = z.strictObject({
  id: IdSchema,
  adjustedSeconds: z.number().int().min(0).max(2_592_000).nullable(),
  note: nullableText(2000),
});
export const SessionLogSchema = z.strictObject({
  itemId: IdSchema,
  startedAt: IsoDateTimeSchema,
  seconds: z.number().int().min(60).max(2_592_000),
  note: nullableText(2000),
});
export const SessionEditSchema = z.strictObject({
  id: IdSchema,
  seconds: z.number().int().min(0).max(2_592_000).optional(),
  note: nullableText(2000).optional(),
});

const AvailabilityKindSchema = z.enum([
  'owned_digital',
  'owned_physical',
  'subscription',
  'library_loan',
  'borrowed',
  'wishlist',
]);
const ServiceKindSchema = z.enum(['subscription', 'store', 'library', 'other']);
export const AvailabilityInputSchema = z.strictObject({
  kind: AvailabilityKindSchema,
  serviceId: IdSchema.nullable(),
  platform: nullableText(80),
  availableUntil: IsoDateSchema.nullable(),
  remindDays: z.number().int().min(0).max(365).nullable(),
  notes: nullableText(2000),
});
export const AvailabilityAddSchema = z.strictObject({ itemId: IdSchema, entry: AvailabilityInputSchema });
export const AvailabilityUpdateSchema = z.strictObject({ id: IdSchema, entry: AvailabilityInputSchema });
export const ServiceAddSchema = z.strictObject({
  name: requiredText(80, 'Service name'),
  kind: ServiceKindSchema,
});
export const ServiceUpdateSchema = z.strictObject({
  id: IdSchema,
  name: requiredText(80, 'Service name').optional(),
  kind: ServiceKindSchema.optional(),
  active: z.boolean().optional(),
});

export const RecListSchema = z.strictObject({
  limit: z.number().int().min(1).max(50),
  types: z.array(MediaTypeSchema).max(5).nullable(),
});
export const RecFeedbackSchema = z.strictObject({
  itemId: IdSchema,
  kind: z.enum(['dismissed', 'not_interested']),
});

export const MergePairSchema = z.strictObject({ keepId: IdSchema, removeId: IdSchema });
export const MergeApplySchema = MergePairSchema.extend({
  fields: z.record(z.string().max(40), z.enum(['a', 'b', 'both'])),
});

/** Share card PNG produced locally by the renderer (canvas). Base64, ≤ 6 MB decoded. */
export const ShareCardSaveSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]{1,60}$/),
  pngBase64: z
    .string()
    .max(8_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export const HeatmapSchema = z.strictObject({ year: z.number().int().min(1900).max(2200) });
