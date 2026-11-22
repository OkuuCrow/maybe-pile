/**
 * JSON export/import envelope ("maybepile-export", formatVersion 1).
 * The schema here is the single source of truth for what an export contains;
 * imports are validated against it before anything is written.
 */
import { z } from 'zod';
import {
  CUSTOM_FIELD_TYPES,
  GAME_SCHEMES,
  MEDIA_TYPES,
  PROGRESS_KINDS,
  PROVENANCE_ORIGINS,
} from '../../shared/enums';
import {
  IdSchema,
  IsoDateTimeSchema,
  MetadataFieldsSchema,
  PartialDateSchema,
  PersonalFieldsSchema,
} from '../../shared/schemas';
import { ThemeTokensSchema } from '../../domain/themes';
import { LayoutFileSchema } from '../../domain/layouts';

export const EXPORT_FORMAT = 'maybepile-export';
export const EXPORT_FORMAT_VERSION = 1;
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
export const MAX_IMPORT_ITEMS = 100_000;

const ts = z.string().max(40);

export const ExportItemSchema = z.object({
  id: IdSchema,
  type: z.enum(MEDIA_TYPES),
  meta: MetadataFieldsSchema,
  personal: PersonalFieldsSchema,
  pass: z.number().int().min(1).max(1000),
  createdAt: ts,
  updatedAt: ts,
  provenance: z.record(
    z.string().max(40),
    z.object({
      origin: z.enum(PROVENANCE_ORIGINS),
      providerId: z.string().max(40).nullable(),
      providerValue: z.string().max(200_000).nullable(),
      updatedAt: ts,
    }),
  ),
  sources: z
    .array(
      z.object({
        providerId: z.string().max(40),
        providerRef: z.string().max(100),
        url: z.string().max(2048).nullable(),
        fetchedAt: ts,
      }),
    )
    .max(10),
  seasons: z
    .array(
      z.object({
        number: z.number().int().min(0).max(10_000),
        title: z.string().max(500).nullable(),
        episodeCountKnown: z.number().int().min(0).max(100_000).nullable(),
        episodes: z
          .array(
            z.object({
              number: z.number().int().min(0).max(100_000),
              title: z.string().max(500).nullable(),
              airDate: PartialDateSchema.nullable(),
              runtime: z.number().int().min(0).max(10_000).nullable(),
              watched: z.boolean(),
              watchedAt: ts.nullable(),
              source: z.enum(['provider', 'user']),
            }),
          )
          .max(5_000),
      }),
    )
    .max(500),
  milestones: z
    .array(z.object({ id: IdSchema, position: z.number().int().min(0), title: z.string().min(1).max(200) }))
    .max(500),
  progress: z
    .array(
      z.object({
        id: IdSchema,
        kind: z.enum(PROGRESS_KINDS),
        value: z.number().finite().nullable(),
        text: z.string().max(2_000).nullable(),
        totalAtTime: z.number().int().nullable(),
        milestoneId: IdSchema.nullable(),
        milestoneTitle: z.string().max(200).nullable(),
        episodeLabel: z.string().max(200).nullable(),
        watched: z.boolean().nullable(),
        scheme: z.enum(GAME_SCHEMES).nullable(),
        pass: z.number().int().min(1),
        occurredAt: ts.nullable(),
        recordedAt: ts,
        note: z.string().max(2_000).nullable(),
      }),
    )
    .max(100_000),
  viewings: z
    .array(
      z.object({
        watchedAt: ts.nullable(),
        note: z.string().max(2_000).nullable(),
        pass: z.number().int().min(1),
        createdAt: ts,
      }),
    )
    .max(10_000),
  artwork: z
    .object({
      source: z.enum(['cache', 'user', 'remote']),
      remoteUrl: z.string().max(2048).nullable(),
      providerId: z.string().max(40).nullable(),
      /** Content-addressed file name (artwork binaries are NOT embedded in JSON exports). */
      file: z.string().max(80).nullable(),
    })
    .nullable(),
  audit: z
    .array(
      z.object({
        at: ts,
        action: z.enum(['refresh', 'import', 'create']),
        providerId: z.string().max(40).nullable(),
        changes: z
          .array(
            z.object({
              field: z.string().max(40),
              oldValue: z.string().max(20_000).nullable(),
              newValue: z.string().max(20_000).nullable(),
            }),
          )
          .max(100),
      }),
    )
    .max(1_000),
  /** Custom field values keyed by definition *name* so they survive across libraries. */
  customFieldsByName: z.record(z.string().max(80), z.union([z.string().max(2_000), z.number(), z.boolean()])),
});
export type ExportItem = z.infer<typeof ExportItemSchema>;

export const ExportEnvelopeSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.number().int(),
  exportedAt: IsoDateTimeSchema,
  appVersion: z.string().max(40),
  schemaVersion: z.number().int(),
  counts: z.record(z.string(), z.number()),
  data: z.object({
    items: z.array(z.unknown()).max(MAX_IMPORT_ITEMS),
    customFieldDefs: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          type: z.enum(CUSTOM_FIELD_TYPES),
          options: z.array(z.string().max(200)).max(50),
        }),
      )
      .max(500),
    series: z
      .array(
        z.object({
          id: IdSchema,
          name: z.string().min(1).max(200),
          description: z.string().max(20_000).nullable(),
          totalKnown: z.number().int().min(1).nullable(),
          members: z.array(z.object({ itemId: IdSchema, position: z.number().nullable() })).max(10_000),
        }),
      )
      .max(5_000),
    themes: z
      .array(z.object({ id: z.string().max(80), name: z.string().min(1).max(60), tokens: ThemeTokensSchema }))
      .max(200),
    layouts: LayoutFileSchema.nullable(),
    settings: z.record(z.string(), z.unknown()),
  }),
});
export type ExportEnvelope = z.infer<typeof ExportEnvelopeSchema>;

export const CSV_COLUMNS = [
  'id',
  'type',
  'title',
  'alt_titles',
  'status',
  'rating_stars',
  'date_added',
  'date_started',
  'date_completed',
  'release_date',
  'tags',
  'genres',
  'creators',
  'imdb_id',
  'tmdb_id',
  'tvmaze_id',
  'igdb_id',
  'openlibrary_id',
  'isbn13',
  'isbn10',
  'steam',
  'xbox',
  'playstation',
  'runtime_minutes',
  'network',
  'show_status',
  'page_count',
  'publisher',
  'book_format',
  'platforms',
  'game_progress_scheme',
  'progress',
  'progress_percent',
  'notes',
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];
