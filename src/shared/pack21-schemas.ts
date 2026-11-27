/**
 * Schemas for the 2.1 feature set (§14–§16): templates, saved views,
 * checklists, loans/people, journal, time goals, paste import, bulk edit,
 * auto rules, triage, quick actions, libraries, share page. Strict objects,
 * bounded sizes, whitelisted operators only — nothing is ever evaluated.
 */
import { z } from 'zod';
import { CUSTOM_FIELD_TYPES, STATUSES } from './enums';
import {
  IdSchema,
  IsoDateSchema,
  LibraryQuerySchema,
  MediaTypeSchema,
  StatusSchema,
  nullableText,
  requiredText,
  text,
} from './schemas';

/* ------------------------------------------------------------------ templates (§14.5) */

export const TemplateCustomFieldSchema = z.strictObject({
  name: requiredText(80, 'Field name'),
  type: z.enum(CUSTOM_FIELD_TYPES),
  /** Default value (typed by `type` at apply time; invalid defaults are skipped). */
  defaultValue: z.union([z.string().max(2000), z.number().min(-1e9).max(1e9), z.boolean()]).nullable(),
  options: z.array(requiredText(80, 'Option')).max(50),
});

export const ItemTemplateBodySchema = z.strictObject({
  version: z.literal(1),
  type: MediaTypeSchema,
  status: StatusSchema,
  tags: z.array(requiredText(64, 'Tag')).max(50),
  moodIds: z.array(IdSchema).max(20),
  customFields: z.array(TemplateCustomFieldSchema).max(20),
  checklist: z.array(requiredText(200, 'Checklist item')).max(50),
  listId: IdSchema.nullable(),
  platform: nullableText(80),
});
export type ItemTemplateBody = z.infer<typeof ItemTemplateBodySchema>;

export const TemplateSaveSchema = z.strictObject({
  id: IdSchema.nullable(),
  name: requiredText(80, 'Name'),
  body: ItemTemplateBodySchema,
});
export const TemplateFileSchema = z.strictObject({
  format: z.literal('maybepile-template'),
  version: z.literal(1),
  name: requiredText(80, 'Name'),
  body: ItemTemplateBodySchema,
});
export const TEMPLATE_FILE_MAX_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ saved views (§14.4) */

export const VIEW_MODES = ['grid', 'list', 'wall'] as const;
export const SavedViewSaveSchema = z.strictObject({
  id: IdSchema.nullable(),
  name: requiredText(80, 'Name'),
  query: LibraryQuerySchema,
  viewMode: z.enum(VIEW_MODES),
  pinned: z.boolean(),
});
export const ViewFileSchema = z.strictObject({
  format: z.literal('maybepile-view'),
  version: z.literal(1),
  name: requiredText(80, 'Name'),
  query: LibraryQuerySchema,
  viewMode: z.enum(VIEW_MODES),
});
export const VIEW_FILE_MAX_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ per-item extras (§14.9, §14.10, §16.5, §16.9, §16.10) */

export const NextStepSchema = z.strictObject({
  itemId: IdSchema,
  text: nullableText(140),
  spoiler: z.boolean(),
});

export const ChecklistOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), itemId: IdSchema, text: requiredText(200, 'Checklist item') }),
  z.strictObject({
    op: z.literal('edit'),
    itemId: IdSchema,
    entryId: IdSchema,
    text: requiredText(200, 'Checklist item'),
  }),
  z.strictObject({ op: z.literal('check'), itemId: IdSchema, entryId: IdSchema, checked: z.boolean() }),
  z.strictObject({
    op: z.literal('move'),
    itemId: IdSchema,
    entryId: IdSchema,
    direction: z.enum(['up', 'down']),
  }),
  z.strictObject({ op: z.literal('delete'), itemId: IdSchema, entryId: IdSchema }),
]);

export const PersonNameSchema = requiredText(80, 'Name');
export const LoanSaveSchema = z
  .strictObject({
    id: IdSchema.nullable(),
    itemId: IdSchema,
    person: PersonNameSchema,
    direction: z.enum(['lent', 'borrowed']),
    loanedOn: IsoDateSchema,
    dueOn: IsoDateSchema.nullable(),
    returnedOn: IsoDateSchema.nullable(),
    note: nullableText(500),
  })
  .superRefine((v, ctx) => {
    if (v.dueOn && v.dueOn < v.loanedOn)
      ctx.addIssue({ code: 'custom', path: ['dueOn'], message: 'Due date cannot be before the loan date.' });
    if (v.returnedOn && v.returnedOn < v.loanedOn)
      ctx.addIssue({
        code: 'custom',
        path: ['returnedOn'],
        message: 'Return date cannot be before the loan date.',
      });
  });
export const RecommenderSaveSchema = z.strictObject({
  itemId: IdSchema,
  person: PersonNameSchema.nullable(),
  note: nullableText(500),
  recommendedOn: IsoDateSchema.nullable(),
});
export const PersonRenameSchema = z.strictObject({ id: IdSchema, name: PersonNameSchema });
export const PersonMergeSchema = z.strictObject({ fromId: IdSchema, intoId: IdSchema });

export const JournalSaveSchema = z.strictObject({
  id: IdSchema.nullable(),
  itemId: IdSchema,
  entryDate: IsoDateSchema,
  body: requiredText(20_000, 'Entry'),
  progressLabel: nullableText(40),
  spoiler: z.boolean(),
});

/* ------------------------------------------------------------------ time goals (§14.1) */

export const TimeGoalSaveSchema = z.strictObject({
  id: IdSchema.nullable(),
  title: requiredText(120, 'Title'),
  targetMinutes: z.number().int().min(1).max(10_080),
  period: z.enum(['day', 'week']),
  mediaType: MediaTypeSchema.nullable(),
  listId: IdSchema.nullable(),
  moodId: IdSchema.nullable(),
});
export const ManualTimeSchema = z.strictObject({
  itemId: IdSchema,
  minutes: z.number().int().min(1).max(1440),
  date: IsoDateSchema,
});

/* ------------------------------------------------------------------ quick actions + omnibox (§13.4) */

export const QuickActSchema = z.strictObject({
  itemId: IdSchema,
  action: z.enum(['watched', 'nextEpisode', 'pages10', 'setPage', 'setPercent', 'start', 'done', 'hold']),
  value: z.number().min(0).max(100_000).nullable(),
});
export const UndoTokenSchema = z.strictObject({ token: z.string().uuid() });
export const OmniboxSchema = z.strictObject({ text: text(200) });

/* ------------------------------------------------------------------ paste a list (§14.6) */

export const PASTE_MAX_CHARS = 100_000;
export const PASTE_MAX_LINES = 500;
export const PasteParseSchema = z.strictObject({
  text: z.string().max(PASTE_MAX_CHARS * 2),
  defaultType: MediaTypeSchema.nullable(),
});
export const PasteMatchSchema = z.strictObject({
  token: z.string().min(1).max(100),
  lineIds: z.array(z.number().int().min(0).max(PASTE_MAX_LINES)).max(PASTE_MAX_LINES),
});
export const PasteApplySchema = z.strictObject({
  token: z.string().min(1).max(100),
  decisions: z
    .array(
      z.strictObject({
        lineId: z.number().int().min(0).max(PASTE_MAX_LINES),
        /** 'match' = import the chosen candidate; 'manual' = add title only; 'skip'. */
        action: z.enum(['match', 'manual', 'skip']),
        candidate: z.number().int().min(0).max(20).nullable(),
        type: MediaTypeSchema,
        title: requiredText(500, 'Title'),
      }),
    )
    .max(PASTE_MAX_LINES),
  status: StatusSchema,
});

/* ------------------------------------------------------------------ offline add queue (§16.6) */

export const OfflineAddSchema = z.strictObject({
  title: requiredText(500, 'Title'),
  type: MediaTypeSchema,
  year: z.number().int().min(1800).max(2200).nullable(),
});
export const QueueIdSchema = z.strictObject({ id: IdSchema });
export const QueueApplySchema = z.strictObject({ id: IdSchema, candidate: z.number().int().min(0).max(20) });

/* ------------------------------------------------------------------ bulk edit (§16.4) */

export const BulkEditChangeSchema = z.strictObject({
  status: StatusSchema.nullable(),
  rating: z.union([z.literal('clear'), z.number().int().min(1).max(10)]).nullable(),
  tags: z
    .strictObject({
      mode: z.enum(['add', 'remove', 'replace']),
      values: z.array(requiredText(64, 'Tag')).max(50),
    })
    .nullable(),
  moods: z.strictObject({ mode: z.enum(['add', 'remove']), ids: z.array(IdSchema).max(20) }).nullable(),
  list: z.strictObject({ mode: z.enum(['add', 'remove']), listId: IdSchema }).nullable(),
  platform: nullableText(80),
});
export const BulkEditSchema = z.strictObject({
  ids: z.array(IdSchema).min(1).max(10_000),
  change: BulkEditChangeSchema,
});

/* ------------------------------------------------------------------ triage (§16.3) */

export const TriageSourceSchema = z.strictObject({
  source: z.enum(['planned', 'list', 'view', 'batch']),
  id: IdSchema.nullable(),
});
export const TriageActSchema = z.strictObject({
  itemId: IdSchema,
  action: z.enum(['keep', 'upNext', 'snooze', 'hold', 'drop', 'skip']),
  snoozeDays: z.number().int().min(1).max(365).nullable(),
});

/* ------------------------------------------------------------------ libraries (§16.11) */

export const LibraryCreateSchema = z.strictObject({ name: requiredText(60, 'Name') });
export const LibraryIdSchema = z.strictObject({ id: z.string().regex(/^[a-z0-9-]{1,40}$/) });
export const LibraryRenameSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: requiredText(60, 'Name'),
});

/* ------------------------------------------------------------------ share page (§14.8) */

export const SHARE_FIELDS = ['type', 'status', 'rating', 'year', 'cover'] as const;
export const SharePageSchema = z.strictObject({
  title: requiredText(120, 'Page title'),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('list'), id: IdSchema }),
    z.strictObject({ kind: z.literal('view'), id: IdSchema }),
    z.strictObject({ kind: z.literal('items'), ids: z.array(IdSchema).min(1).max(5_000) }),
  ]),
  fields: z.array(z.enum(SHARE_FIELDS)).max(SHARE_FIELDS.length),
  includeAdult: z.boolean(),
  includeProviderArt: z.boolean(),
});

/* ------------------------------------------------------------------ misc */

export const SkipEpisodesSchema = z.strictObject({
  itemId: IdSchema,
  episodeIds: z.array(IdSchema).min(1).max(10_000),
  skipped: z.boolean(),
});
export const ChangeIdSchema = z.strictObject({ id: z.number().int().min(1) });
export const BatchIdSchema = z.strictObject({ batchId: z.string().uuid() });
export const IdsSchema = z.strictObject({ ids: z.array(IdSchema).min(1).max(10_000) });
export const RatingPromptSchema = z.strictObject({
  itemId: IdSchema,
  rating: z.number().int().min(1).max(10).nullable(),
  note: nullableText(200),
  moodIds: z.array(IdSchema).max(10),
});
export const StatusListSchema = z.array(z.enum(STATUSES));
