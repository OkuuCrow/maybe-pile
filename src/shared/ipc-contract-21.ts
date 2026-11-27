/** Request schemas + response types for the 2.1 channels (merged into ipc-contract.ts). */
import { z } from 'zod';
import type { NotificationSettings } from './notification-settings';
import * as P from './pack21-schemas';
import { BACKDROP_STYLES, IdSchema, MediaTypeSchema } from './schemas';
import type * as V from './views-21';
import type { ItemSummary } from './types';
import {
  NOTIFY_REQUESTS as N,
  type ApplyResultView,
  type HistoryEntryView,
  type ItemNotifyControlsView,
  type NotifyStatusView,
  type PlannedComponentView,
  type PreviewView,
  type ReminderView,
} from './notification-contract';

const none = z.undefined();
const byItem = z.strictObject({ itemId: IdSchema });
const byId = z.strictObject({ id: IdSchema });

export const REQUEST_SCHEMAS_21 = {
  'notify:status': N.status,
  'notify:plan': N.plan,
  'notify:apply': N.apply,
  'notify:test': N.test,
  'notify:runNow': N.runNow,
  'notify:repair': N.repair,
  'notify:removeBackground': N.removeBackground,
  'notify:history': N.history,
  'notify:clearHistory': N.clearHistory,
  'notify:preview': N.preview,
  'notify:pause': N.pause,
  'notify:itemControls': N.itemControls,
  'notify:setItemMute': N.setItemMute,
  'notify:snoozeItem': N.snoozeItem,
  'reminders:list': N.reminders,
  'reminders:save': N.saveReminder,
  'reminders:delete': N.deleteReminder,
  'reminders:setEnabled': N.setReminderEnabled,

  'quick:act': P.QuickActSchema,
  'quick:undo': P.UndoTokenSchema,
  'quick:omnibox': P.OmniboxSchema,
  'trash:list': none,
  'trash:restore': P.IdsSchema,
  'trash:purge': P.IdsSchema,
  'trash:empty': z.strictObject({ confirmCount: z.number().int().min(0) }),
  'changes:list': z.strictObject({ limit: z.number().int().min(1).max(2000) }),
  'changes:undo': P.ChangeIdSchema,
  'changes:undoBatch': P.BatchIdSchema,
  'changes:clear': none,
  'extras:forItem': byItem,
  'extras:setNextStep': P.NextStepSchema,
  'extras:checklist': P.ChecklistOpSchema,
  'extras:loans': z.strictObject({ openOnly: z.boolean() }),
  'extras:saveLoan': P.LoanSaveSchema,
  'extras:deleteLoan': byId,
  'extras:setRecommender': P.RecommenderSaveSchema,
  'extras:people': none,
  'extras:peopleNames': none,
  'extras:renamePerson': P.PersonRenameSchema,
  'extras:mergePeople': P.PersonMergeSchema,
  'extras:forgetPerson': byId,
  'extras:recommendedBy': byId,
  'extras:journal': byItem,
  'extras:saveJournal': P.JournalSaveSchema,
  'extras:deleteJournal': byId,
  'extras:searchJournal': z.strictObject({ text: z.string().min(1).max(200) }),
  'extras:skipEpisodes': P.SkipEpisodesSchema,
  'extras:ratingPrompt': P.RatingPromptSchema,
  'views:list': none,
  'views:save': P.SavedViewSaveSchema,
  'views:duplicate': byId,
  'views:delete': byId,
  'views:move': z.strictObject({ id: IdSchema, direction: z.enum(['up', 'down']) }),
  'views:starters': none,
  'views:export': byId,
  'views:import': none,
  'templates:list': none,
  'templates:save': P.TemplateSaveSchema,
  'templates:duplicate': byId,
  'templates:delete': byId,
  'templates:starters': none,
  'templates:export': byId,
  'templates:import': none,
  'timeGoals:list': z.strictObject({ includeArchived: z.boolean() }),
  'timeGoals:save': P.TimeGoalSaveSchema,
  'timeGoals:archive': z.strictObject({ id: IdSchema, archived: z.boolean() }),
  'timeGoals:delete': byId,
  'wall:items': z.strictObject({
    year: z.number().int().min(1900).max(2200).nullable(),
    type: MediaTypeSchema.nullable(),
    sort: z.enum(['completed', 'rating', 'title']),
  }),
  'wall:years': none,
  'wall:savePng': z.strictObject({
    rect: z.strictObject({
      x: z.number().int().min(0).max(20_000),
      y: z.number().int().min(0).max(20_000),
      width: z.number().int().min(1).max(20_000),
      height: z.number().int().min(1).max(20_000),
    }),
  }),
  'paste:parse': P.PasteParseSchema,
  'paste:match': P.PasteMatchSchema,
  'paste:apply': P.PasteApplySchema,
  'queue:add': P.OfflineAddSchema,
  'queue:list': none,
  'queue:process': none,
  'queue:retry': P.QueueIdSchema,
  'queue:cancel': P.QueueIdSchema,
  'queue:apply': P.QueueApplySchema,
  'checkup:run': none,
  'checkup:fix': z.strictObject({
    fixes: z
      .array(
        z.enum([
          'reindexFts',
          'clearMissingArtwork',
          'removeUnusedCache',
          'pruneOrphans',
          'recomputeDerived',
          'repairBackground',
        ]),
      )
      .min(1)
      .max(6),
  }),
  'checkup:exportReport': none,
  'bulkEdit:preview': P.BulkEditSchema,
  'bulkEdit:apply': P.BulkEditSchema,
  'rules:preview': none,
  'rules:run': none,
  'triage:queue': P.TriageSourceSchema,
  'triage:act': P.TriageActSchema,
  'triage:undo': z.strictObject({
    undo: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('none'), itemId: IdSchema }),
      z.strictObject({ kind: z.literal('upNext'), itemId: IdSchema }),
      z.strictObject({
        kind: z.literal('snooze'),
        itemId: IdSchema,
        prevUntil: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
      }),
      z.strictObject({ kind: z.literal('batch'), itemId: IdSchema, batchId: z.string().uuid() }),
    ]),
  }),
  'backupCheck:current': none,
  'sharePage:preview': P.SharePageSchema,
  'sharePage:save': P.SharePageSchema,
  'backdrop:forItem': byItem,
  'backdrop:setItemStyle': z.strictObject({
    itemId: IdSchema,
    style: z.enum(['default', ...BACKDROP_STYLES]),
  }),
  'backdrop:storage': none,
  'backdrop:clearCache': none,
  'backdrop:enforceCap': none,
  'libraries:list': none,
  'libraries:create': P.LibraryCreateSchema,
  'libraries:rename': P.LibraryRenameSchema,
  'libraries:duplicate': P.LibraryIdSchema,
  'libraries:delete': P.LibraryIdSchema,
  'libraries:switch': P.LibraryIdSchema,
} as const;

export interface ResponseTypes21 {
  'notify:status': NotifyStatusView;
  'notify:plan': PlannedComponentView[];
  'notify:apply': ApplyResultView;
  'notify:test': { delivered: boolean; adapter: string; reason: string | null };
  'notify:runNow': { delivered: number; failed: number; deferred: number; paused: boolean };
  'notify:repair': NotifyStatusView;
  'notify:removeBackground': { removed: string[]; verified: boolean; remaining: string[] };
  'notify:history': HistoryEntryView[];
  'notify:clearHistory': { removed: number };
  'notify:preview': PreviewView;
  'notify:pause': { pausedUntil: string | null };
  'notify:itemControls': ItemNotifyControlsView;
  'notify:setItemMute': ItemNotifyControlsView;
  'notify:snoozeItem': ItemNotifyControlsView;
  'reminders:list': ReminderView[];
  'reminders:save': ReminderView;
  'reminders:delete': null;
  'reminders:setEnabled': ReminderView;

  'quick:act': V.QuickResultView;
  'quick:undo': ItemSummary;
  'quick:omnibox': ItemSummary[];
  'trash:list': V.TrashEntryView[];
  'trash:restore': { count: number };
  'trash:purge': { count: number };
  'trash:empty': { count: number };
  'changes:list': V.ChangeView[];
  'changes:undo': V.ChangeView;
  'changes:undoBatch': { undone: number; skipped: number };
  'changes:clear': { removed: number };
  'extras:forItem': V.ItemExtrasView;
  'extras:setNextStep': V.ItemExtrasView;
  'extras:checklist': V.ChecklistView;
  'extras:loans': V.LoanView[];
  'extras:saveLoan': V.LoanView[];
  'extras:deleteLoan': null;
  'extras:setRecommender': V.ItemExtrasView;
  'extras:people': V.PersonView[];
  'extras:peopleNames': string[];
  'extras:renamePerson': V.PersonView[];
  'extras:mergePeople': V.PersonView[];
  'extras:forgetPerson': V.PersonView[];
  'extras:recommendedBy': ItemSummary[];
  'extras:journal': V.JournalEntryView[];
  'extras:saveJournal': V.JournalEntryView[];
  'extras:deleteJournal': null;
  'extras:searchJournal': { itemId: string; entryId: string; itemTitle: string }[];
  'extras:skipEpisodes': { changed: number };
  'extras:ratingPrompt': null;
  'views:list': V.SavedViewView[];
  'views:save': V.SavedViewView[];
  'views:duplicate': V.SavedViewView[];
  'views:delete': V.SavedViewView[];
  'views:move': V.SavedViewView[];
  'views:starters': V.StarterView[];
  'views:export': V.FileOpView | null;
  'views:import': V.SavedViewView[] | null;
  'templates:list': V.TemplateView[];
  'templates:save': V.TemplateView[];
  'templates:duplicate': V.TemplateView[];
  'templates:delete': V.TemplateView[];
  'templates:starters': V.StarterTemplate[];
  'templates:export': V.FileOpView | null;
  'templates:import': V.TemplateView[] | null;
  'timeGoals:list': V.TimeGoalView[];
  'timeGoals:save': V.TimeGoalView[];
  'timeGoals:archive': V.TimeGoalView[];
  'timeGoals:delete': V.TimeGoalView[];
  'wall:items': (ItemSummary & { dateCompleted: string | null })[];
  'wall:years': number[];
  'wall:savePng': V.FileOpView | null;
  'paste:parse': V.PasteParseView;
  'paste:match': V.MatchedLineView[];
  'paste:apply': { added: number; skipped: number; failed: number; batchId: string | null };
  'queue:add': { itemId: string };
  'queue:list': V.QueueEntryView[];
  'queue:process': { finished: number; waiting: number };
  'queue:retry': null;
  'queue:cancel': null;
  'queue:apply': { ok: boolean; reason: string | null };
  'checkup:run': V.CheckupReportView;
  'checkup:fix': { snapshot: string; applied: string[] };
  'checkup:exportReport': V.FileOpView | null;
  'bulkEdit:preview': V.BulkPreviewView;
  'bulkEdit:apply': { batchId: string | null; changed: number; exceptions: V.BulkPreviewView['exceptions'] };
  'rules:preview': V.RulePreviewView[];
  'rules:run': V.RulesRunView;
  'triage:queue': ItemSummary[];
  'triage:act': { undo: V.TriageUndoView };
  'triage:undo': null;
  'backupCheck:current': V.BackupDirCheckView & { folderLabel: string };
  'sharePage:preview': { rows: number; bytes: number; html: string };
  'sharePage:save': V.FileOpView | null;
  'backdrop:forItem': V.ItemBackdropView;
  'backdrop:setItemStyle': V.ItemBackdropView;
  'backdrop:storage': V.StorageView;
  'backdrop:clearCache': { evicted: number; freedBytes: number };
  'backdrop:enforceCap': { evicted: number; freedBytes: number };
  'libraries:list': V.LibraryView[];
  'libraries:create': V.LibraryView[];
  'libraries:rename': V.LibraryView[];
  'libraries:duplicate': V.LibraryView[];
  'libraries:delete': { snapshot: string | null; libraries: V.LibraryView[] };
  'libraries:switch': null;
}

export type { NotificationSettings };
