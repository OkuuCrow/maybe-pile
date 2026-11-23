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
import { checkOpenExternal } from '../security/policy';
import type { Handlers } from './register';
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
    'settings:update': (p) => d.custom.patchSettings(p),

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
      const p = getProvider(providerId);
      if (!p || !p.keyFields.includes(field))
        throw appError('VALIDATION', 'That provider does not use this kind of key.');
      d.secrets.set(providerId, field, value);
      return d.providers.list();
    },
    'providers:setEnabled': ({ providerId, enabled }) => {
      if (!getProvider(providerId)) throw appError('VALIDATION', 'Unknown provider.');
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
