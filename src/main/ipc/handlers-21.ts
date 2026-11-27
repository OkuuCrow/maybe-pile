/**
 * 2.1 channel handlers: notifications/reminders, Simple Mode quick actions,
 * and the §14–§16 features. File access only through native dialogs run in
 * main; imported files are size-capped and schema-validated (never evaluated).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { z } from 'zod';
import type { ResponseTypes21, REQUEST_SCHEMAS_21 } from '../../shared/ipc-contract-21';
import { appError } from '../../shared/result';
import type { FileOpResult } from '../../shared/types';
import {
  TEMPLATE_FILE_MAX_BYTES,
  TemplateFileSchema,
  VIEW_FILE_MAX_BYTES,
  ViewFileSchema,
} from '../../shared/pack21-schemas';
import { DEFAULT_LIBRARY_QUERY } from '../../shared/schemas';
import { STATUS_LABELS, TYPE_LABELS } from '../../shared/enums';
import { buildSharePage, type ShareRow } from '../../domain/share-page';
import { readSettings } from '../../db/repositories/config-repo';
import * as itemsRepo from '../../db/repositories/items-repo';
import { atomicWrite, mapFsError } from '../services/fs-safe';
import { imageDimensions, sniffImage } from '../services/artwork-service';
import type { NotificationService } from '../services/notification-service';
import type { Pack21Services } from '../services/pack21-services';
import { STARTER_TEMPLATES, STARTER_VIEWS } from '../services/organize-service';
import type { ServiceContext } from '../services/context';
import type { LibraryService } from '../services/library-service';
import type { ArtworkService } from '../services/artwork-service';

type Req<C extends keyof typeof REQUEST_SCHEMAS_21> = z.output<(typeof REQUEST_SCHEMAS_21)[C]>;
export type Handlers21 = {
  [C in keyof typeof REQUEST_SCHEMAS_21]: (p: Req<C>) => Promise<ResponseTypes21[C]> | ResponseTypes21[C];
};

interface DialogPlatform {
  saveDialog(opts: {
    title: string;
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  openDialog(opts: {
    title: string;
    filters: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  capturePng?(rect: { x: number; y: number; width: number; height: number }): Promise<Uint8Array | null>;
}

export interface Deps21 {
  notifications: NotificationService;
  pack21: Pack21Services;
  ctx: ServiceContext;
  library: LibraryService;
  artwork: ArtworkService;
  platform: DialogPlatform;
  getExportDir: () => string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'export';

function readCapped(path: string, max: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    throw mapFsError(e, basename(path));
  }
  if (size > max) throw appError('TOO_LARGE', `"${basename(path)}" is too large.`);
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw mapFsError(e, basename(path));
  }
}

function parseJsonFile(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw appError('VALIDATION', 'That file is not valid JSON.');
  }
}

export function buildHandlers21(d: Deps21): Handlers21 {
  const n = d.notifications;
  const p = d.pack21;
  const h = p.history;

  async function saveVia(
    title: string,
    defaultName: string,
    filters: { name: string; extensions: string[] }[],
    data: () => Uint8Array | string,
  ): Promise<FileOpResult | null> {
    const path = await d.platform.saveDialog({
      title,
      defaultPath: join(d.getExportDir(), defaultName),
      filters,
    });
    if (!path) return null;
    const bytes = data();
    atomicWrite(path, bytes, { overwrite: existsSync(path) });
    return {
      fileLabel: basename(path),
      bytes: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength,
    };
  }

  /** Rows for a share page — only the chosen public fields; adult items and provider art excluded unless opted in. */
  function shareRows(input: Req<'sharePage:preview'>): ShareRow[] {
    const db = d.ctx.db();
    let summaries;
    if (input.source.kind === 'items') {
      const ids = input.source.ids;
      summaries = itemsRepo.summariesWhere(db, `i.id IN (${ids.map(() => '?').join(',')})`, ids, '');
    } else if (input.source.kind === 'list') {
      summaries = d.library.query({
        ...DEFAULT_LIBRARY_QUERY,
        listId: input.source.id,
        limit: 500,
        offset: 0,
      }).items;
    } else {
      const v = p.organize.views().find((x) => x.id === (input.source as { id: string }).id);
      if (!v) throw appError('NOT_FOUND', 'That view no longer exists.');
      summaries = d.library.query({ ...v.query, limit: 500, offset: 0 }).items;
    }
    const rows: ShareRow[] = [];
    for (const s of summaries.slice(0, 5000)) {
      const adult =
        db.get<{ a: number }>('SELECT is_adult AS a FROM anime_details WHERE item_id = ?', [s.id])?.a === 1;
      if (adult && !input.includeAdult) continue;
      let cover: string | null = null;
      if (input.fields.includes('cover')) {
        const art = db.get<{
          thumb_name: string | null;
          source: string;
          provider_id: string | null;
          adult: number;
        }>(
          'SELECT a.thumb_name, a.source, a.provider_id, a.adult FROM items i JOIN artwork a ON a.id = i.artwork_id WHERE i.id = ?',
          [s.id],
        );
        const providerArt = art && art.source !== 'user' && art.provider_id !== null;
        if (
          art?.thumb_name &&
          (!providerArt || input.includeProviderArt) &&
          !(art.adult && !input.includeAdult)
        ) {
          const file = d.artwork.resolveFile(art.thumb_name);
          if (file) {
            const bytes = new Uint8Array(readFileSync(file));
            const kind = sniffImage(bytes);
            if (kind === 'jpeg' || kind === 'png' || kind === 'webp')
              cover = `data:image/${kind};base64,${Buffer.from(bytes).toString('base64')}`;
          }
        }
      }
      rows.push({
        title: s.title,
        type: TYPE_LABELS[s.type],
        status: STATUS_LABELS[s.status],
        rating: s.rating,
        year: s.year,
        cover,
      });
    }
    return rows;
  }

  function sharePage(input: Req<'sharePage:preview'>): string {
    return buildSharePage({
      title: input.title,
      generatedOn: d.library.today(),
      rows: shareRows(input),
      fields: input.fields,
    });
  }

  return {
    /* ---------------------------------------------------------------- notifications */
    'notify:status': () => n.status(),
    'notify:plan': ({ settings }) => n.plan(settings),
    'notify:apply': ({ settings, confirmed }) => n.apply(settings, confirmed),
    'notify:test': () => n.test(),
    'notify:runNow': async () => {
      const r = await n.runCheck('open');
      return {
        delivered: r?.delivered ?? 0,
        failed: r?.failed ?? 0,
        deferred: r?.deferred ?? 0,
        paused: r?.skipped === 'paused',
      };
    },
    'notify:repair': () => n.repair(),
    'notify:removeBackground': () => n.removeBackground(),
    'notify:history': ({ days }) => n.history(days),
    'notify:clearHistory': () => ({ removed: n.clearHistory() }),
    'notify:preview': ({ category, settings }) => n.preview(category, settings),
    'notify:pause': ({ duration }) => ({ pausedUntil: n.pause(duration) }),
    'notify:itemControls': ({ itemId }) => n.itemControls(itemId),
    'notify:setItemMute': ({ itemId, muted }) => n.setItemMute(itemId, muted),
    'notify:snoozeItem': ({ itemId, duration }) => n.snoozeItem(itemId, duration),
    'reminders:list': ({ itemId }) => n.reminders(itemId),
    'reminders:save': (input) => n.saveReminder(input),
    'reminders:delete': ({ id }) => {
      n.deleteReminder(id);
      return null;
    },
    'reminders:setEnabled': ({ id, enabled }) => n.setReminderEnabled(id, enabled),

    /* ---------------------------------------------------------------- quick actions */
    'quick:act': ({ itemId, action, value }) =>
      h.logged([itemId], 'user', () => p.quick.act(itemId, action, value)),
    'quick:undo': ({ token }) => p.quick.undoAction(token),
    'quick:omnibox': ({ text }) => p.quick.search(text),

    /* ---------------------------------------------------------------- trash + change log */
    'trash:list': () => h.trash(),
    'trash:restore': ({ ids }) => ({ count: h.restore(ids) }),
    'trash:purge': ({ ids }) => ({ count: h.purge(ids) }),
    'trash:empty': ({ confirmCount }) => {
      const current = h.trash().length;
      if (confirmCount !== current)
        throw appError('CONFLICT', 'Recently deleted changed. Review it and try again.');
      return { count: h.emptyTrash() };
    },
    'changes:list': ({ limit }) => h.changes(limit),
    'changes:undo': ({ id }) => h.undoChange(id),
    'changes:undoBatch': ({ batchId }) => h.undoBatch(batchId),
    'changes:clear': () => ({ removed: h.clearLog() }),

    /* ---------------------------------------------------------------- per-item extras */
    'extras:forItem': ({ itemId }) => p.extras21.forItem(itemId),
    'extras:setNextStep': (input) => p.extras21.setNextStep(input),
    'extras:checklist': (op) => p.extras21.checklistOp(op),
    'extras:loans': ({ openOnly }) => p.extras21.loans({ open: openOnly }),
    'extras:saveLoan': (input) => p.extras21.saveLoan(input),
    'extras:deleteLoan': ({ id }) => {
      p.extras21.deleteLoan(id);
      return null;
    },
    'extras:setRecommender': (input) => p.extras21.setRecommender(input),
    'extras:people': () => p.extras21.people(),
    'extras:peopleNames': () => p.extras21.peopleNames(),
    'extras:renamePerson': ({ id, name }) => p.extras21.renamePerson(id, name),
    'extras:mergePeople': ({ fromId, intoId }) => p.extras21.mergePeople(fromId, intoId),
    'extras:forgetPerson': ({ id }) => p.extras21.forgetPerson(id),
    'extras:recommendedBy': ({ id }) => {
      const ids = p.extras21.recommendedBy(id);
      return ids.length === 0
        ? []
        : itemsRepo.summariesWhere(d.ctx.db(), `i.id IN (${ids.map(() => '?').join(',')})`, ids, '');
    },
    'extras:journal': ({ itemId }) => p.extras21.journal(itemId),
    'extras:saveJournal': (input) => p.extras21.saveJournal(input),
    'extras:deleteJournal': ({ id }) => {
      p.extras21.deleteJournal(id);
      return null;
    },
    'extras:searchJournal': ({ text }) =>
      p.extras21.searchJournal(text).map((r) => ({
        ...r,
        itemTitle:
          d.ctx.db().get<{ title: string }>('SELECT title FROM items WHERE id = ?', [r.itemId])?.title ?? '',
      })),
    'extras:skipEpisodes': ({ itemId, episodeIds, skipped }) => ({
      changed: p.extras21.skipEpisodes(itemId, episodeIds, skipped),
    }),
    'extras:ratingPrompt': (input) => {
      p.extras21.saveRatingPrompt(input);
      return null;
    },

    /* ---------------------------------------------------------------- views + templates */
    'views:list': () => p.organize.views(),
    'views:save': (input) => p.organize.saveView(input),
    'views:duplicate': ({ id }) => p.organize.duplicateView(id),
    'views:delete': ({ id }) => p.organize.deleteView(id),
    'views:move': ({ id, direction }) => p.organize.moveView(id, direction),
    'views:starters': () => STARTER_VIEWS,
    'views:export': async ({ id }) => {
      const v = p.organize.views().find((x) => x.id === id);
      if (!v) throw appError('NOT_FOUND', 'That view no longer exists.');
      const file = ViewFileSchema.parse({
        format: 'maybepile-view',
        version: 1,
        name: v.name,
        query: v.query,
        viewMode: v.viewMode,
      });
      return saveVia(
        'Export view',
        `${slug(v.name)}.mpview.json`,
        [{ name: 'Maybe Pile view', extensions: ['json'] }],
        () => JSON.stringify(file, null, 2),
      );
    },
    'views:import': async () => {
      const path = await d.platform.openDialog({
        title: 'Import a view',
        filters: [{ name: 'Maybe Pile view', extensions: ['json'] }],
      });
      if (!path) return null;
      const r = ViewFileSchema.safeParse(parseJsonFile(readCapped(path, VIEW_FILE_MAX_BYTES)));
      if (!r.success)
        throw appError(
          'VALIDATION',
          'That file is not a Maybe Pile view (or uses filters this version does not support).',
        );
      let name = r.data.name;
      for (let i = 2; p.organize.views().some((v) => v.name.toLowerCase() === name.toLowerCase()); i++)
        name = `${r.data.name} (${i})`;
      return p.organize.saveView({
        id: null,
        name: name.slice(0, 80),
        query: r.data.query,
        viewMode: r.data.viewMode,
        pinned: false,
      });
    },
    'templates:list': () => p.organize.templates(),
    'templates:save': ({ id, name, body }) => p.organize.saveTemplate(id, name, body),
    'templates:duplicate': ({ id }) => p.organize.duplicateTemplate(id),
    'templates:delete': ({ id }) => p.organize.deleteTemplate(id),
    'templates:starters': () => STARTER_TEMPLATES,
    'templates:export': async ({ id }) => {
      const t = p.organize.templates().find((x) => x.id === id);
      if (!t) throw appError('NOT_FOUND', 'That template no longer exists.');
      const file = TemplateFileSchema.parse({
        format: 'maybepile-template',
        version: 1,
        name: t.name,
        body: t.body,
      });
      return saveVia(
        'Export template',
        `${slug(t.name)}.mptemplate.json`,
        [{ name: 'Maybe Pile template', extensions: ['json'] }],
        () => JSON.stringify(file, null, 2),
      );
    },
    'templates:import': async () => {
      const path = await d.platform.openDialog({
        title: 'Import a template',
        filters: [{ name: 'Maybe Pile template', extensions: ['json'] }],
      });
      if (!path) return null;
      const r = TemplateFileSchema.safeParse(parseJsonFile(readCapped(path, TEMPLATE_FILE_MAX_BYTES)));
      if (!r.success) throw appError('VALIDATION', 'That file is not a valid Maybe Pile template.');
      let name = r.data.name;
      for (let i = 2; p.organize.templates().some((t) => t.name.toLowerCase() === name.toLowerCase()); i++)
        name = `${r.data.name} (${i})`;
      return p.organize.saveTemplate(null, name.slice(0, 80), r.data.body);
    },

    /* ---------------------------------------------------------------- time goals + cover wall */
    'timeGoals:list': ({ includeArchived }) => p.organize.timeGoals(includeArchived),
    'timeGoals:save': (input) => p.organize.saveTimeGoal(input),
    'timeGoals:archive': ({ id, archived }) => p.organize.archiveTimeGoal(id, archived),
    'timeGoals:delete': ({ id }) => p.organize.deleteTimeGoal(id),
    'wall:items': (opts) => p.organize.wall(opts),
    'wall:years': () => p.organize.wallYears(),
    'wall:savePng': async ({ rect }) => {
      if (!d.platform.capturePng) throw appError('INTERNAL', 'Saving an image is not available here.');
      const png = await d.platform.capturePng(rect);
      if (!png) throw appError('INTERNAL', 'The cover wall could not be captured.');
      const dims = sniffImage(png) === 'png' ? imageDimensions(png, 'png') : null;
      if (!dims) throw appError('INTERNAL', 'The cover wall could not be captured.');
      return saveVia(
        'Save cover wall',
        `maybe-pile-cover-wall-${d.library.today()}.png`,
        [{ name: 'PNG image', extensions: ['png'] }],
        () => png,
      );
    },

    /* ---------------------------------------------------------------- paste + offline queue */
    'paste:parse': ({ text, defaultType }) => p.import21.parse(text, defaultType),
    'paste:match': ({ token, lineIds }) => p.import21.match(token, lineIds),
    'paste:apply': (input) => p.import21.apply(input),
    'queue:add': (input) => p.import21.addOffline(input),
    'queue:list': () => p.import21.queue(),
    'queue:process': () => p.import21.processQueue({ force: true }),
    'queue:retry': ({ id }) => {
      p.import21.retry(id);
      return null;
    },
    'queue:cancel': ({ id }) => {
      p.import21.cancel(id);
      return null;
    },
    'queue:apply': ({ id, candidate }) =>
      h.loggedAsync([], 'user', () => p.import21.applyCandidate(id, candidate)),

    /* ---------------------------------------------------------------- maintenance */
    'checkup:run': () => p.maintenance.checkup(),
    'checkup:fix': ({ fixes }) => p.maintenance.fix(fixes),
    'checkup:exportReport': () =>
      saveVia(
        'Save check-up report',
        `maybe-pile-checkup-${d.library.today()}.txt`,
        [{ name: 'Text', extensions: ['txt'] }],
        () => p.maintenance.reportText(),
      ),
    'bulkEdit:preview': ({ ids, change }) => p.maintenance.bulkPreview(ids, change),
    'bulkEdit:apply': ({ ids, change }) => p.maintenance.bulkApply(ids, change),
    'rules:preview': () => p.maintenance.rulePreview(),
    'rules:run': () => p.maintenance.runRules(),
    'triage:queue': ({ source, id }) => p.maintenance.triageQueue(source, id, p.organize.views()),
    'triage:act': ({ itemId, action, snoozeDays }) => p.maintenance.triageAct(itemId, action, snoozeDays),
    'triage:undo': ({ undo }) => {
      p.maintenance.triageUndo(undo);
      return null;
    },
    'backupCheck:current': () => {
      const dir = d.getExportDir();
      return { ...p.maintenance.checkBackupDestination(dir), folderLabel: basename(dir) || dir };
    },
    'sharePage:preview': (input) => {
      const html = sharePage(input);
      return { rows: (html.match(/<tr>/g)?.length ?? 1) - 1, bytes: Buffer.byteLength(html), html };
    },
    'sharePage:save': (input) =>
      saveVia(
        'Save share page',
        `${slug(input.title)}.html`,
        [{ name: 'Web page', extensions: ['html'] }],
        () => sharePage(input),
      ),

    /* ---------------------------------------------------------------- backdrops + storage */
    'backdrop:forItem': ({ itemId }) => p.backdrops.forItem(itemId),
    'backdrop:setItemStyle': ({ itemId, style }) => p.backdrops.setItemStyle(itemId, style),
    'backdrop:storage': () => p.backdrops.storage(),
    'backdrop:clearCache': () => p.backdrops.clearCache(),
    'backdrop:enforceCap': () => p.backdrops.enforceCap(),

    /* ---------------------------------------------------------------- libraries */
    'libraries:list': () => p.libraries.list(),
    'libraries:create': ({ name }) => p.libraries.create(name),
    'libraries:rename': ({ id, name }) => p.libraries.rename(id, name),
    'libraries:duplicate': ({ id }) => p.libraries.duplicate(id),
    'libraries:delete': ({ id }) => p.libraries.remove(id),
    'libraries:switch': ({ id }) => {
      p.libraries.switchTo(id);
      return null;
    },
  };
}

export { readSettings };
