/**
 * JSON export/import envelope ("maybepile-export").
 *
 * formatVersion history:
 *   1 — app 1.0/1.1: items, custom fields, series, themes, layouts, settings.
 *   2 — app 1.2: adds lists, goals, snoozes, library sources (snapshots and
 *       ignore flags), import batches and CSV mapping profiles. All new
 *       sections are optional so version-1 files still import unchanged.
 *   3 — Expansion Pack 2: anime fields inside item meta, plus the optional
 *       `pack2` section (src/main/services/pack2-portable.ts). Version 1/2
 *       files import unchanged.
 * The schema here is the single source of truth for what an export contains;
 * imports are validated against it before anything is written.
 */
import { Pack2SectionSchema } from './pack2-portable';
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
import { LIST_COLORS, LIST_ICONS } from '../../shared/schemas';
import { LayoutFileSchema } from '../../domain/layouts';

export const EXPORT_FORMAT = 'maybepile-export';
export const EXPORT_FORMAT_VERSION = 3;
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
export const MAX_IMPORT_ITEMS = 100_000;

const ts = z.string().max(40);

export const ExportItemSchema = z.object({
  id: IdSchema,
  type: z.enum(MEDIA_TYPES),
  meta: MetadataFieldsSchema,
  personal: PersonalFieldsSchema,
  /** Up Next queue position (added in app 1.1; optional so older exports still import). */
  upNextPosition: z.number().int().min(0).nullable().optional(),
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
    /* ---- formatVersion 2 ---- */
    lists: z
      .array(
        z.object({
          id: IdSchema,
          name: z.string().min(1).max(80),
          description: z.string().max(2_000).nullable(),
          color: z.enum(LIST_COLORS).nullable(),
          icon: z.enum(LIST_ICONS).nullable(),
          position: z.number().int().min(0),
          items: z.array(z.object({ itemId: IdSchema, position: z.number().int().min(0) })).max(100_000),
        }),
      )
      .max(5_000)
      .optional(),
    goals: z
      .array(
        z.object({
          id: IdSchema,
          title: z.string().min(1).max(120),
          mediaType: z.enum(MEDIA_TYPES).nullable(),
          metric: z.enum(['items', 'pages', 'episodes', 'hours']),
          period: z.enum(['year', 'month', 'custom']),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          target: z.number().int().min(1).max(1_000_000),
          listId: IdSchema.nullable(),
          tag: z.string().max(64).nullable(),
          archivedAt: ts.nullable(),
          createdAt: ts,
        }),
      )
      .max(5_000)
      .optional(),
    snoozes: z
      .array(
        z.object({
          itemId: IdSchema,
          until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          reason: z.enum(['manual', 'pile-health', 'keep']),
          createdAt: ts,
        }),
      )
      .max(MAX_IMPORT_ITEMS)
      .optional(),
    librarySources: z
      .array(
        z.object({
          id: IdSchema,
          kind: z.enum(['steam', 'manual']),
          label: z.string().min(1).max(120),
          accountRef: z
            .string()
            .regex(/^\d{1,20}$/)
            .nullable(),
          accountInput: z.string().max(200).nullable(),
          lastSyncedAt: ts.nullable(),
          lastSyncStatus: z.enum(['ok', 'private', 'error', 'cancelled', 'empty']).nullable(),
          createdAt: ts,
          entries: z
            .array(
              z.object({
                externalId: z.string().min(1).max(200),
                name: z.string().max(500),
                platform: z.string().max(80).nullable(),
                playtimeMinutes: z.number().int().min(0).nullable(),
                prevPlaytimeMinutes: z.number().int().min(0).nullable(),
                lastPlayedAt: ts.nullable(),
                nonGameReason: z.string().max(80).nullable(),
                firstSeenAt: ts,
                seenAt: ts,
                removedAt: ts.nullable(),
                ignored: z.boolean(),
                itemId: IdSchema.nullable(),
              }),
            )
            .max(100_000),
        }),
      )
      .max(100)
      .optional(),
    importBatches: z
      .array(
        z.object({
          id: IdSchema,
          kind: z.enum(['steam', 'manual-list', 'goodreads', 'letterboxd', 'csv-mapped', 'mal-xml']),
          sourceId: IdSchema.nullable(),
          label: z.string().max(200),
          createdAt: ts,
          undoneAt: ts.nullable(),
          items: z
            .array(
              z.object({
                itemId: IdSchema,
                title: z.string().max(500),
                /** "<updated_at>|<content fingerprint>" (older files: timestamp only). */
                baselineUpdatedAt: z.string().max(100),
                baselineEvents: z.number().int().min(0),
              }),
            )
            .max(100_000),
        }),
      )
      .max(10_000)
      .optional(),
    mappingProfiles: z
      .array(z.object({ name: z.string().min(1).max(80), mapping: z.unknown() }))
      .max(500)
      .optional(),
    /* ---- formatVersion 3 ---- */
    pack2: Pack2SectionSchema.optional(),
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
  'lists',
  'up_next_position',
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];
