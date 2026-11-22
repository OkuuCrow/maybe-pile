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
  BOOK_FORMATS,
  CREATOR_ROLES,
  CUSTOM_FIELD_TYPES,
  EXTERNAL_ID_KINDS,
  GAME_SCHEMES,
  MEDIA_TYPES,
  SHOW_STATUSES,
  SORT_FIELDS,
  STATUSES,
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

export const AppSettingsSchema = z.strictObject({
  activeThemeId: z.string().min(1).max(80),
  region: RegionSchema,
  autoApplySuggestions: z.boolean(),
  libraryView: z.enum(['grid', 'list']),
  libraryQuery: LibraryQuerySchema,
  providerEnabled: z.record(z.string().max(40), z.boolean()),
  csvBom: z.boolean(),
  lastSeenSchemaVersion: z.number().int().min(0),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const SettingsPatchSchema = AppSettingsSchema.partial().strict();
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
