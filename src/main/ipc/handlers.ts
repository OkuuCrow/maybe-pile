/**
 * Channel → service mapping. Filesystem access from IPC only happens through
 * native dialogs run here in main (the renderer never supplies a path) or
 * through app-managed folders.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { appError } from '../../shared/result';
import type { AppInfo, FileOpResult } from '../../shared/types';
import type { LayoutEntry } from '../../domain/layouts';
import { THEME_MAX_BYTES } from '../../domain/themes';
import { LAYOUT_MAX_BYTES } from '../../domain/layouts';
import type { ArtworkService } from '../services/artwork-service';
import type { BackupService } from '../services/backup-service';
import type { CatalogService } from '../services/catalog-service';
import type { CustomizationService } from '../services/customization-service';
import type { ServiceContext } from '../services/context';
import { buildCsvExport, buildJsonExport } from '../services/export-service';
import { atomicWrite, mapFsError } from '../services/fs-safe';
import type { ImportService } from '../services/import-service';
import type { LibraryService } from '../services/library-service';
import type { ProgressService } from '../services/progress-service';
import type { ProviderService } from '../services/provider-service';
import type { SecretsService } from '../services/secrets-service';
import { MAX_IMPORT_BYTES } from '../services/portable-format';
import { getProvider } from '../../providers/registry';
import { getArtSource } from '../../providers/art-registry';
import { checkOpenExternal } from '../security/policy';
import type { Handlers } from './register';
import type { AppSettings } from '../../shared/schemas';
import type { GoalsService } from '../services/goals-service';
import type { ImportBatchService } from '../services/import-batch-service';
import type { LibrarySourceService } from '../services/library-source-service';
import type { ListsService } from '../services/lists-service';
import type { PickService } from '../services/pick-service';
import type { PileHealthService } from '../services/pile-health-service';
import type { ReleaseRadarService } from '../services/release-radar-service';
import type { StatsService } from '../services/stats-service';
import type { TrackerImportService } from '../services/tracker-import-service';
import type { ArtworkPickerService } from '../services/artwork-picker-service';
import type { AvailabilityService } from '../services/availability-service';
import type { ItemExtrasService } from '../services/item-extras-service';
import type { MergeService } from '../services/merge-service';
import type { SyncService } from '../services/sync-service';
import type { MoodsService } from '../services/moods-service';
import type { PileTimeService } from '../services/pile-time-service';
import type { RecommendationsService } from '../services/recommendations-service';
import type { SessionsService } from '../services/sessions-service';
import type { ValueService } from '../services/value-service';
import { igdbProvider, igdbTimeToBeat } from '../../providers/igdb';
import { imageDimensions, sniffImage } from '../services/artwork-service';
import { TRACKER_MAX_BYTES } from '../../domain/tracker-csv';
import { defaultPersonal, emptyMeta } from '../../domain/metadata';
import { localDate } from '../../domain/dates';
import { timestampForFile } from '../services/db-manager';

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Platform adapters (Electron dialog/shell in production, fakes in tests). */
export interface Platform {
  saveDialog(opts: { title: string; defaultPath: string; filters: FileFilter[] }): Promise<string | null>;
  openDialog(opts: { title: string; filters: FileFilter[] }): Promise<string | null>;
  folderDialog(opts: { title: string; defaultPath: string }): Promise<string | null>;
  openPath(dir: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Captures a region of the app window as PNG (Stats "Save as image"), or null when unavailable. */
  capturePng?(rect: { x: number; y: number; width: number; height: number }): Promise<Uint8Array | null>;
}

export interface HandlerDeps {
  ctx: ServiceContext;
  library: LibraryService;
  progress: ProgressService;
  catalog: CatalogService;
  custom: CustomizationService;
  providers: ProviderService;
  artwork: ArtworkService;
  importer: ImportService;
  backup: BackupService;
  secrets: SecretsService;
  platform: Platform;
  lists: ListsService;
  health: PileHealthService;
  pick: PickService;
  stats: StatsService;
  radar: ReleaseRadarService;
  sources: LibrarySourceService;
  batches: ImportBatchService;
  tracker: TrackerImportService;
  goals: GoalsService;
  /* Expansion Pack 2 */
  artworkPicker: ArtworkPickerService;
  pileTime: PileTimeService;
  moods: MoodsService;
  extras: ItemExtrasService;
  value: ValueService;
  sessions: SessionsService;
  availability: AvailabilityService;
  recommendations: RecommendationsService;
  merge: MergeService;
  sync: SyncService;
  /** Called after settings change (main re-registers the Quick Capture shortcut). */
  onSettingsChanged?: (s: AppSettings) => void;
  appInfo: () => AppInfo;
  acknowledgeNotices: () => void;
  exportLogText: () => string;
  /** Default folder for exports/backups (main-owned, never set directly by the renderer). */
  getExportDir: () => string;
  setExportDir: (dir: string) => void;
}

/** Decodes imported text: UTF-8 (with/without BOM), UTF-16 LE/BE by BOM, else Windows-1252 fallback. */
export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function readLimited(path: string, max: number): Uint8Array {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    throw mapFsError(e, basename(path));
  }
  if (size > max)
    throw appError(
      'TOO_LARGE',
      `"${basename(path)}" is too large (limit ${Math.round(max / 1024 / 1024) || 1} MB).`,
    );
  try {
    return readFileSync(path);
  } catch (e) {
    throw mapFsError(e, basename(path));
  }
}

const JSON_FILTER: FileFilter = { name: 'Maybe Pile export (JSON)', extensions: ['json'] };
const CSV_FILTER: FileFilter = { name: 'CSV', extensions: ['csv'] };
const BACKUP_FILTER: FileFilter = { name: 'Maybe Pile backup', extensions: ['mpbackup'] };
const THEME_FILTER: FileFilter = { name: 'Maybe Pile theme', extensions: ['json'] };
const LAYOUT_FILTER: FileFilter = { name: 'Maybe Pile layout', extensions: ['json'] };

export function buildHandlers(d: HandlerDeps): Handlers {
  const stamp = () => timestampForFile(d.ctx.clock.now()).slice(0, 19);

  /** Save dialog → atomic write. Overwrite only if the user confirmed it in the native dialog. */
  async function saveVia(
    title: string,
    defaultName: string,
    filters: FileFilter[],
    data: () => Uint8Array | string,
  ): Promise<FileOpResult | null> {
    const path = await d.platform.saveDialog({
      title,
      defaultPath: join(d.getExportDir(), defaultName),
      filters,
    });
    if (!path) return null;
    const confirmedOverwrite = existsSync(path);
    const bytes = data();
    atomicWrite(path, bytes, { overwrite: confirmedOverwrite });
    return {
      fileLabel: basename(path),
      bytes: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength,
    };
  }

  return {
    'app:info': () => d.appInfo(),
    'app:openDataFolder': async () => {
      await d.platform.openPath(d.ctx.paths.userData);
      return null;
    },
    'app:openExternal': async ({ url }) => {
      const check = checkOpenExternal(url);
      if (!check.ok) throw appError('FORBIDDEN', check.reason);
      await d.platform.openExternal(check.url);
      return null;
    },
    'app:exportLog': () =>
      saveVia(
        'Export diagnostic log',
        `maybe-pile-log-${stamp()}.jsonl`,
        [{ name: 'Log', extensions: ['jsonl', 'txt'] }],
        d.exportLogText,
      ),
    'app:chooseBackupFolder': async () => {
      const dir = await d.platform.folderDialog({
        title: 'Choose default folder for exports and backups',
        defaultPath: d.getExportDir(),
      });
      if (!dir) return null;
      d.setExportDir(dir);
      return { label: basename(dir) || dir };
    },
    'app:acknowledgeNotices': () => {
      d.acknowledgeNotices();
      return null;
    },

    'settings:get': () => d.custom.getSettings(),
    'settings:update': (p) => {
      const next = d.custom.patchSettings(p);
      d.onSettingsChanged?.(next);
      return next;
    },

    'items:query': (q) => d.library.query(q),
    'items:get': ({ id }) => d.library.get(id),
    'items:create': (input) => d.library.create(input),
    'items:update': (input) => d.library.update(input),
    'items:setStatus': (input) => d.library.setStatus(input),
    'items:acceptSuggestion': ({ id, suggestion }) => d.library.acceptSuggestion(id, suggestion),
    'items:setRating': ({ id, rating }) => d.library.setRating(id, rating),
    'items:delete': ({ ids }) => ({ count: d.library.softDelete(ids) }),
    'items:undoDelete': ({ ids }) => ({ count: d.library.undoDelete(ids) }),
    'items:bulk': (input) => d.library.bulk(input),
    'items:checkDuplicates': (input) => d.library.checkDuplicates(input),
    'items:dashboard': () => d.library.dashboard(),
    'items:tags': () => d.catalog.tags(),
    'items:audit': ({ id }) => d.catalog.audit(id),
    'items:setUpNext': ({ id, queued }) => d.library.setUpNext(id, queued),
    'items:moveUpNext': ({ id, direction }) => d.library.moveUpNext(id, direction),
    'items:pickRandom': ({ types, excludeId }) => d.library.pickRandom(types, excludeId),
    'items:titles': () =>
      d.ctx
        .db()
        .all<{
          id: string;
          title: string;
          type: 'movie' | 'tv' | 'game' | 'book';
          release_year: number | null;
        }>(
          'SELECT id, title, type, release_year FROM items WHERE deleted_at IS NULL ORDER BY sort_title LIMIT 100000',
        )
        .map((r) => ({ id: r.id, title: r.title, type: r.type, year: r.release_year })),
    'items:quickCapture': ({ title, type, allowDuplicate }) => {
      // Same validated path as the Add dialog; never touches the network.
      const today = localDate(d.ctx.clock.now());
      return d.library.create({
        type,
        meta: emptyMeta(title),
        personal: defaultPersonal(type, today),
        seasons: [],
        milestones: [],
        allowDuplicate,
      });
    },

    'pick:roll': (req) => d.pick.roll(req),
    'pick:respond': ({ historyId, outcome }) => d.pick.respond(historyId, outcome),
    'pick:history': () => d.pick.history(),
    'pick:clearSkips': () => ({ cleared: d.pick.clearSkips() }),

    'health:overview': () => d.health.overview(),
    'health:snooze': ({ ids, until }) => (d.health.snooze(ids, until), d.health.overview()),
    'health:unsnooze': ({ ids }) => (d.health.unsnooze(ids), d.health.overview()),
    'health:keep': ({ ids }) => (d.health.keep(ids), d.health.overview()),

    'lists:list': () => d.lists.list(),
    'lists:get': ({ id }) => d.lists.get(id),
    'lists:save': (input) => d.lists.save(input),
    'lists:delete': ({ id }) => d.lists.remove(id),
    'lists:move': ({ id, direction }) => d.lists.move(id, direction),
    'lists:setMembership': ({ listId, itemIds, member }) => ({
      changed: d.lists.setMembership(listId, itemIds, member),
      lists: d.lists.list(),
    }),
    'lists:moveItem': ({ listId, itemId, direction }) => d.lists.moveItem(listId, itemId, direction),

    'stats:get': ({ year }) => d.stats.get(year),
    'stats:yearInReview': ({ year }) => d.stats.yearInReview(year),
    'stats:exportCsv': ({ chart, year }) =>
      saveVia(
        'Export chart data (CSV)',
        `maybe-pile-${chart}${year ? `-${year}` : ''}.csv`,
        [CSV_FILTER],
        () => d.stats.chartCsv(chart, year, d.custom.getSettings().csvBom),
      ),
    'stats:saveImage': async ({ name, rect }) => {
      if (!d.platform.capturePng) throw appError('INTERNAL', 'Saving images is not available here.');
      const png = await d.platform.capturePng(rect);
      if (!png || png.byteLength === 0)
        throw appError('IO', 'The chart could not be captured.', {
          recovery: 'Scroll the chart fully into view and try again.',
        });
      return saveVia(
        'Save chart as image',
        `maybe-pile-${name}.png`,
        [{ name: 'PNG image', extensions: ['png'] }],
        () => png,
      );
    },

    'stats:heatmap': ({ year }) => d.stats.heatmap(year),

    /* ---------------------------------------------------------------- Expansion Pack 2 */
    'artwork:slots': ({ itemId }) => d.artworkPicker.slots(itemId),
    'artwork:gallery': ({ itemId }) => d.artworkPicker.gallery(itemId),
    'artwork:choose': ({ itemId, token }) => d.artworkPicker.choose(itemId, token),
    'artwork:revert': ({ itemId, slot }) => d.artworkPicker.revert(itemId, slot),
    'artwork:clearSlot': ({ itemId, slot }) => d.artworkPicker.clear(itemId, slot),
    'artwork:autoPick': async ({ itemId, slots }) => {
      const r = await d.artworkPicker.autoPick(itemId, slots ?? undefined);
      return { ...r, slots: d.artworkPicker.slots(itemId) };
    },
    'artwork:bulkAutoPick': ({ itemIds, slots }) => d.artworkPicker.bulkAutoPick(itemIds, slots ?? undefined),
    'anime:searchAll': ({ query, year }) => d.providers.searchAllAnime(query, year),

    'pileTime:item': ({ itemId }) => d.pileTime.forItem(itemId),
    'pileTime:totals': () => d.pileTime.totals(),
    'pileTime:fits': ({ budgetMinutes, types, moodIds }) => {
      const rows = d.pileTime.fits(budgetMinutes, types, moodIds.length ? 500 : 50);
      if (!moodIds.length) return rows;
      const ok = d.moods.itemsWithMoods(moodIds);
      return rows.filter((r) => ok.has(r.id)).slice(0, 50);
    },
    'pileTime:setManual': ({ itemId, minutes }) => d.pileTime.setManual(itemId, minutes),
    'pileTime:fetchIgdb': async ({ itemId }) => {
      const item = d.library.get(itemId);
      if (item.type !== 'game')
        throw appError('VALIDATION', 'Typical play time is only available for games.');
      const igdbId = item.meta.externalIds.find((e) => e.kind === 'igdb')?.value;
      if (!igdbId)
        throw appError('VALIDATION', 'This game has no IGDB ID to look up.', {
          recovery: 'Refresh it from IGDB or add the IGDB ID in the editor.',
        });
      const ctx = d.providers.sourceContext('igdb', igdbProvider.rateLimit);
      const r = await igdbTimeToBeat(igdbId, ctx);
      if (r.kind !== 'ok')
        throw appError(
          r.kind === 'notConfigured' ? 'PROVIDER_NOT_CONFIGURED' : 'PROVIDER_UNAVAILABLE',
          r.kind === 'notConfigured'
            ? 'IGDB needs a Twitch client ID and secret.'
            : "IGDB couldn't provide a time estimate right now.",
          { recovery: r.kind === 'notConfigured' ? 'Add them in Settings → Providers.' : 'Try again later.' },
        );
      if (!r.value)
        throw appError('NOT_FOUND', 'IGDB has no time-to-beat data for this game yet.', {
          recovery: 'Add your own estimate instead.',
        });
      d.pileTime.setProvider(itemId, r.value.minutes, 'igdb', r.value.detail);
      return d.pileTime.forItem(itemId);
    },

    'moods:list': () => d.moods.list(),
    'moods:create': (input) => d.moods.create(input),
    'moods:update': (input) => d.moods.update(input),
    'moods:delete': ({ id }) => d.moods.remove(id),
    'moods:reorder': ({ ids }) => d.moods.reorder(ids),
    'moods:forItem': ({ itemId }) => d.moods.forItem(itemId),
    'moods:setForItem': ({ itemId, moodIds }) => d.moods.setForItem(itemId, moodIds),
    'moods:bulk': ({ itemIds, moodId, add }) => ({ changed: d.moods.bulk(itemIds, moodId, add) }),

    'itemExtras:prefs': ({ itemId }) => d.extras.prefs(itemId),
    'itemExtras:setPrefs': ({ itemId, ...patch }) => d.extras.setPrefs(itemId, patch),
    'itemExtras:runs': ({ itemId }) => d.extras.runs(itemId),
    'itemExtras:updateRun': ({ itemId, runNumber, ...patch }) => d.extras.updateRun(itemId, runNumber, patch),
    'itemExtras:streaming': ({ itemId }) => d.extras.streaming(itemId),
    'itemExtras:relations': ({ itemId }) => d.extras.relations(itemId),
    'itemExtras:addRelation': ({ itemId, otherId, relation }) =>
      d.extras.addRelation(itemId, otherId, relation),
    'itemExtras:removeRelation': ({ itemId, relationId }) => d.extras.removeRelation(itemId, relationId),
    'itemExtras:suggestions': ({ itemId }) => d.extras.suggestions(itemId),
    'itemExtras:resolveSuggestion': ({ itemId, suggestionId, accept }) =>
      d.extras.resolveSuggestion(itemId, suggestionId, accept),
    'itemExtras:franchisesForItem': ({ itemId }) => d.extras.franchisesForItem(itemId),

    'franchises:list': () => d.extras.franchises(),
    'franchises:get': ({ id }) => d.extras.franchise(id),
    'franchises:create': ({ name, itemIds }) => d.extras.createFranchise(name, itemIds),
    'franchises:update': ({ id, ...patch }) => d.extras.updateFranchise(id, patch),
    'franchises:setEntries': ({ id, entries }) => d.extras.setEntries(id, entries),
    'franchises:delete': ({ id }) => {
      d.extras.deleteFranchise(id);
      return null;
    },

    'value:list': ({ itemId }) => d.value.list(itemId),
    'value:add': ({ itemId, purchase }) => d.value.add(itemId, purchase),
    'value:update': ({ id, purchase }) => d.value.update(id, purchase),
    'value:delete': ({ id }) => d.value.remove(id),
    'value:summary': () => d.value.summary(),

    'sessions:open': () => d.sessions.open(),
    'sessions:forItem': ({ itemId }) => d.sessions.forItem(itemId),
    'sessions:start': ({ itemId }) => d.sessions.start(itemId),
    'sessions:pause': ({ id }) => d.sessions.pause(id),
    'sessions:resume': ({ id }) => d.sessions.resume(id),
    'sessions:stop': ({ id, adjustedSeconds, note }) => d.sessions.stop(id, adjustedSeconds, note),
    'sessions:log': ({ itemId, startedAt, seconds, note }) =>
      d.sessions.logManual(itemId, startedAt, seconds, note),
    'sessions:edit': ({ id, ...patch }) => d.sessions.edit(id, patch),
    'sessions:delete': ({ id }) => {
      d.sessions.remove(id);
      return null;
    },

    'availability:services': () => d.availability.services(),
    'availability:addService': ({ name, kind }) => d.availability.addService(name, kind),
    'availability:updateService': ({ id, ...patch }) => d.availability.updateService(id, patch),
    'availability:removeService': ({ id }) => d.availability.removeService(id),
    'availability:forItem': ({ itemId }) => d.availability.forItem(itemId),
    'availability:add': ({ itemId, entry }) => d.availability.add(itemId, entry),
    'availability:update': ({ id, entry }) => d.availability.update(id, entry),
    'availability:delete': ({ id }) => d.availability.remove(id),
    'availability:leavingSoon': () => d.availability.leavingSoon(),

    'recs:list': ({ limit, types }) => d.recommendations.list(limit, types),
    'recs:feedback': ({ itemId, kind }) => {
      d.recommendations.feedback(itemId, kind);
      return null;
    },
    'recs:clearFeedback': () => ({ cleared: d.recommendations.clearFeedback() }),

    'merge:pairs': () => d.merge.findPairs(),
    'merge:dismiss': ({ keepId, removeId }) => {
      d.merge.dismiss(keepId, removeId);
      return d.merge.findPairs();
    },
    'merge:preview': ({ keepId, removeId }) => d.merge.preview(keepId, removeId),
    'merge:apply': ({ keepId, removeId, fields }) => d.merge.merge(keepId, removeId, { fields }),
    'merge:lastUndoable': () => d.merge.lastUndoable(),
    'merge:undo': ({ id }) => {
      d.merge.undo(id);
      return null;
    },

    'share:saveCard': async ({ name, pngBase64 }) => {
      const png = new Uint8Array(Buffer.from(pngBase64, 'base64'));
      // The card is drawn locally by the renderer; main re-checks it really is a sane PNG before writing.
      if (png.byteLength > 6 * 1024 * 1024) throw appError('TOO_LARGE', 'That image is too large.');
      const dims = sniffImage(png) === 'png' ? imageDimensions(png, 'png') : null;
      if (!dims || dims.width > 4096 || dims.height > 4096)
        throw appError('VALIDATION', 'The share card could not be created.');
      return saveVia(
        'Save share card',
        `maybe-pile-${name}.png`,
        [{ name: 'PNG image', extensions: ['png'] }],
        () => png,
      );
    },

    'sync:status': () => d.sync.status(),
    'sync:chooseFolder': async () => {
      const dir = await d.platform.folderDialog({
        title: 'Choose a sync folder',
        defaultPath: d.getExportDir(),
      });
      return dir ? d.sync.setFolder(dir) : null;
    },
    'sync:disable': () => d.sync.setFolder(null),
    'sync:setDeviceName': ({ name }) => {
      const st = d.sync.status();
      return d.sync.setFolder(st.enabled ? st.folderLabel : null, name);
    },
    'sync:preview': () => d.sync.preview(),
    'sync:apply': () => {
      const r = d.sync.apply();
      return r;
    },
    'sync:conflicts': () => d.sync.conflicts(),
    'sync:resolve': ({ id, choice }) => d.sync.resolve(id, choice),

    'radar:upcoming': () => d.radar.upcoming(),
    'radar:refreshPreview': () => d.radar.refreshPreview(),
    'radar:refreshApply': ({ token, choices }) => d.radar.refreshApply(token, choices),
    'radar:exportIcs': async () => {
      const ics = d.radar.ics();
      const r = await saveVia(
        'Export upcoming releases (.ics)',
        `maybe-pile-releases-${stamp().slice(0, 10)}.ics`,
        [{ name: 'iCalendar', extensions: ['ics'] }],
        () => ics.text,
      );
      return r ? { ...r, included: ics.included, skipped: ics.skipped } : null;
    },

    'sources:list': () => d.sources.list(),
    'sources:saveSteam': (input) => d.sources.saveSteam(input),
    'sources:clearSteamKey': () => d.sources.clearSteamKey(),
    'sources:delete': ({ sourceId }) => d.sources.remove(sourceId),
    'sources:testSteam': ({ sourceId }) => d.sources.testSteam(sourceId),
    'sources:startFetch': ({ sourceId }) => d.sources.startFetch(sourceId),
    'sources:fetchStatus': ({ jobId }) => d.sources.fetchStatus(jobId),
    'sources:cancelFetch': ({ jobId }) => d.sources.cancelFetch(jobId),
    'sources:entries': (f) => d.sources.entries(f),
    'sources:setIgnored': ({ sourceId, externalIds, ignored }) => ({
      changed: d.sources.setIgnored(sourceId, externalIds, ignored),
    }),
    'sources:import': (input) => d.sources.importSelected(input),
    'sources:diff': ({ sourceId }) => d.sources.diff(sourceId),
    'sources:applyPlaytime': ({ sourceId, externalIds }) => ({
      updated: d.sources.applyPlaytime(sourceId, externalIds),
    }),
    'sources:loadManual': (input) => d.sources.loadManual(input),
    'sources:loadManualFile': async ({ sourceId, label }) => {
      const path = await d.platform.openDialog({
        title: 'Choose a game list',
        filters: [{ name: 'Text or CSV', extensions: ['txt', 'csv', 'tsv'] }],
      });
      if (!path) return null;
      return d.sources.loadManual({ sourceId, label, text: decodeText(readLimited(path, 5 * 1024 * 1024)) });
    },

    'batches:list': () => d.batches.list(),
    'batches:undoPreview': ({ batchId }) => d.batches.undoPreview(batchId),
    'batches:undo': ({ batchId }) => d.batches.undo(batchId),

    'tracker:preview': async ({ kind, profileId }) => {
      const filters =
        kind === 'letterboxd'
          ? [{ name: 'Letterboxd export (.zip or .csv)', extensions: ['zip', 'csv'] }]
          : kind === 'mal'
            ? [{ name: 'MyAnimeList export (.xml or .xml.gz)', extensions: ['xml', 'gz'] }]
            : kind === 'goodreads'
              ? [CSV_FILTER]
              : [{ name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] }];
      const title =
        kind === 'goodreads'
          ? 'Import Goodreads library'
          : kind === 'letterboxd'
            ? 'Import Letterboxd export'
            : kind === 'mal'
              ? 'Import MyAnimeList list'
              : 'Import a CSV file';
      const path = await d.platform.openDialog({ title, filters });
      if (!path) return null;
      const bytes = readLimited(path, TRACKER_MAX_BYTES);
      const profile = profileId ? d.tracker.profiles().find((p) => p.id === profileId) : undefined;
      return d.tracker.preview(kind, [{ name: basename(path), bytes }], profile?.mapping as never);
    },
    'tracker:remap': ({ mapToken, previousToken, mapping }) =>
      d.tracker.remap(mapToken, previousToken, mapping),
    'tracker:apply': (input) => d.importer.apply(input),
    'tracker:profiles': () => d.tracker.profiles(),
    'tracker:saveProfile': ({ name, mapping }) => d.tracker.saveProfile(name, mapping),
    'tracker:deleteProfile': ({ id }) => d.tracker.deleteProfile(id),

    'goals:list': ({ includeArchived }) => d.goals.list(includeArchived),
    'goals:save': (input) => d.goals.save(input),
    'goals:archive': ({ id, archived }) => d.goals.setArchived(id, archived),
    'goals:delete': ({ id }) => d.goals.remove(id),

    'progress:add': (p) => d.progress.add(p),
    'progress:edit': (p) => d.progress.edit(p),
    'progress:remove': ({ eventId }) => d.progress.remove(eventId),
    'progress:history': ({ itemId }) => d.progress.history(itemId),
    'progress:addViewing': (p) => d.progress.addViewing(p),
    'progress:editViewing': (p) => d.progress.editViewing(p),
    'progress:removeViewing': ({ viewingId }) => d.progress.removeViewing(viewingId),
    'progress:viewings': ({ itemId }) => d.progress.viewings(itemId),
    'progress:toggleEpisodes': (p) => d.progress.toggleEpisodes(p),
    'progress:upsertSeason': (p) => d.progress.upsertSeason(p),
    'progress:deleteSeason': ({ itemId, seasonId }) => d.progress.deleteSeason(itemId, seasonId),
    'progress:upsertEpisode': (p) => d.progress.upsertEpisode(p),
    'progress:deleteEpisode': ({ itemId, episodeId }) => d.progress.deleteEpisode(itemId, episodeId),
    'progress:setMilestones': (p) => d.progress.setMilestones(p),
    'progress:setScheme': ({ itemId, scheme }) => d.progress.setScheme(itemId, scheme),

    'customFields:list': () => d.catalog.listCustomFields(),
    'customFields:save': (p) => d.catalog.saveCustomField(p),
    'customFields:delete': ({ id }) => d.catalog.deleteCustomField(id),
    'series:list': () => d.catalog.listSeries(),
    'series:save': (p) => d.catalog.saveSeries(p),
    'series:delete': ({ id }) => d.catalog.deleteSeries(id),
    'series:setMembership': (p) => d.catalog.setMembership(p.seriesId, p.itemId, p.position, p.member),

    'providers:list': () => d.providers.list(),
    'providers:search': (p) => d.providers.search(p),
    'providers:preview': (ref) => d.providers.preview(ref),
    'providers:import': (p) => d.providers.importPreviewed(p),
    'providers:refreshPreview': ({ itemId }) => d.providers.refreshPreview(itemId),
    'providers:refreshApply': (p) => d.providers.refreshApply(p),
    'providers:setKey': ({ providerId, field, value }) => {
      const p = getProvider(providerId) ?? getArtSource(providerId);
      if (!p || !(p.keyFields as readonly string[]).includes(field))
        throw appError('VALIDATION', 'That provider does not use this kind of key.');
      d.secrets.set(providerId, field, value);
      return d.providers.list();
    },
    'providers:setEnabled': ({ providerId, enabled }) => {
      if (!getProvider(providerId) && !getArtSource(providerId))
        throw appError('VALIDATION', 'Unknown provider.');
      const current = d.custom.getSettings().providerEnabled;
      d.custom.patchSettings({ providerEnabled: { ...current, [providerId]: enabled } });
      return d.providers.list();
    },
    'providers:watch': ({ itemId, region }) => d.providers.watchAvailability(itemId, region),

    'artwork:chooseLocal': async ({ itemId }) => {
      d.library.get(itemId);
      const path = await d.platform.openDialog({
        title: 'Choose an image',
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      });
      if (!path) return null;
      d.artwork.setLocalImage(itemId, path);
      return d.library.get(itemId);
    },
    'artwork:remove': ({ itemId }) => {
      d.artwork.setItemArtwork(itemId, null);
      return d.library.get(itemId);
    },
    'artwork:retry': async ({ itemId }) => {
      const item = d.library.get(itemId);
      const provider = item.artwork?.providerId ? getProvider(item.artwork.providerId) : undefined;
      if (!provider) throw appError('VALIDATION', 'This artwork has no online source to retry.');
      if (provider.cachingPolicy !== 'cache-allowed') {
        throw appError(
          'VALIDATION',
          `${provider.displayName} artwork is shown from the web and not stored locally.`,
          { recovery: 'Choose a local image if you want an offline copy.' },
        );
      }
      await d.artwork.retry(itemId, provider.artworkHosts);
      return d.library.get(itemId);
    },

    'themes:list': () => d.custom.listThemes(),
    'themes:get': ({ id }) => d.custom.getTheme(id),
    'themes:active': () => d.custom.activeTheme(),
    'themes:save': (p) => d.custom.saveTheme(p),
    'themes:duplicate': ({ id }) => d.custom.duplicateTheme(id),
    'themes:delete': ({ id }) => {
      d.custom.deleteTheme(id);
      return null;
    },
    'themes:import': async () => {
      const path = await d.platform.openDialog({ title: 'Import theme', filters: [THEME_FILTER] });
      if (!path) return null;
      return d.custom.importTheme(decodeText(readLimited(path, THEME_MAX_BYTES)));
    },
    'themes:export': async ({ id }) => {
      const f = d.custom.exportTheme(id);
      return saveVia('Export theme', f.fileName, [THEME_FILTER], () => f.text);
    },
    'themes:reset': ({ deleteCustom }) => {
      d.custom.resetThemes(deleteCustom);
      return null;
    },

    'layouts:get': () => d.custom.layouts(),
    'layouts:set': ({ surface, entries }) => d.custom.setLayout(surface, entries as LayoutEntry[]),
    'layouts:reset': ({ surface }) => d.custom.resetLayout(surface),
    'layouts:import': async () => {
      const path = await d.platform.openDialog({ title: 'Import layout', filters: [LAYOUT_FILTER] });
      if (!path) return null;
      return d.custom.importLayout(decodeText(readLimited(path, LAYOUT_MAX_BYTES)));
    },
    'layouts:export': async () => {
      const f = d.custom.exportLayout();
      return saveVia('Export layout', f.fileName, [LAYOUT_FILTER], () => f.text);
    },

    'data:exportJson': () =>
      saveVia('Export library (JSON)', `maybe-pile-export-${stamp()}.json`, [JSON_FILTER], () =>
        JSON.stringify(buildJsonExport(d.ctx.db(), d.ctx.appVersion, d.ctx.clock.now()), null, 2),
      ),
    'data:exportCsv': () =>
      saveVia('Export library (CSV)', `maybe-pile-${stamp()}.csv`, [CSV_FILTER], () =>
        buildCsvExport(d.ctx.db(), d.custom.getSettings().csvBom),
      ),
    'data:importPreview': async ({ kind }) => {
      const filters = kind === 'json' ? [JSON_FILTER] : kind === 'csv' ? [CSV_FILTER] : [BACKUP_FILTER];
      const title = kind === 'backup' ? 'Restore from backup' : `Import ${kind.toUpperCase()}`;
      const path = await d.platform.openDialog({ title, filters });
      if (!path) return null;
      if (kind === 'backup') return d.backup.previewRestore(path);
      const text = decodeText(readLimited(path, MAX_IMPORT_BYTES));
      return kind === 'json'
        ? d.importer.previewJson(text, basename(path))
        : d.importer.previewCsv(text, basename(path));
    },
    'data:importApply': ({ kind, ...input }) => {
      if (kind === 'backup') return d.backup.applyRestore(input.token, input.confirmation);
      return d.importer.apply(input);
    },
    'data:importCancel': ({ kind, token }) => {
      if (kind === 'backup') d.backup.cancelRestore(token);
      return null;
    },
    'data:backupCreate': async () => {
      const path = await d.platform.saveDialog({
        title: 'Create full backup',
        defaultPath: join(d.getExportDir(), `maybe-pile-${stamp()}.mpbackup`),
        filters: [BACKUP_FILTER],
      });
      if (!path) return null;
      return d.backup.createBackup(path, { overwrite: existsSync(path) });
    },
    'data:backupList': () => d.backup.listInternal(),
    'data:restoreInternalPreview': ({ label }) => {
      const p = join(d.ctx.paths.backups, label);
      if (!existsSync(p)) throw appError('NOT_FOUND', 'That snapshot no longer exists.');
      return d.backup.previewRestore(p);
    },
  };
}
