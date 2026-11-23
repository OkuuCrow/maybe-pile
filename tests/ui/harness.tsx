/**
 * UI test harness: window.maybePile is backed by the REAL main-process
 * handlers and services (temp database), invoked through the same dispatcher
 * and Zod validation as production. Only native dialogs/shell are faked.
 */
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { expect } from 'vitest';
import { buildApi } from '../../src/shared/ipc-channels';
import type { MaybePileApi } from '../../src/shared/ipc-contract';
import { buildHandlers, decodeText, type Platform } from '../../src/main/ipc/handlers';
import { createFeatureServices, type FeatureServices } from '../../src/main/services/feature-services';
import { createDispatcher } from '../../src/main/ipc/register';
import { ArtworkService, passthroughProcessor } from '../../src/main/services/artwork-service';
import { BackupService } from '../../src/main/services/backup-service';
import { CatalogService } from '../../src/main/services/catalog-service';
import { pathsFor, type ServiceContext } from '../../src/main/services/context';
import { CustomizationService } from '../../src/main/services/customization-service';
import { DatabaseManager } from '../../src/main/services/db-manager';
import { LibraryService } from '../../src/main/services/library-service';
import { MemoryLogger } from '../../src/main/services/logger';
import { ProgressService } from '../../src/main/services/progress-service';
import { ProviderService } from '../../src/main/services/provider-service';
import { SecretsService } from '../../src/main/services/secrets-service';
import { App } from '../../src/renderer/app/App';
import { tempDir } from '../helpers/db';
import { FakeHttp, instantLimiter } from '../helpers/http';
import { FakeClock, createInput } from '../helpers/services';

export interface UiEnv {
  library: LibraryService;
  progress: ProgressService;
  features: FeatureServices;
  http: FakeHttp;
  secrets: SecretsService;
  platform: Platform & { opened: string[] };
  cleanup: () => void;
}

export function installBridge(): UiEnv {
  const t = tempDir('mp-ui-');
  const paths = pathsFor(t.dir);
  const log = new MemoryLogger();
  const clock = new FakeClock(new Date());
  const dbm = new DatabaseManager(paths, log);
  dbm.open();
  const ctx: ServiceContext = { db: () => dbm.db, clock, log, paths, appVersion: '1.0.0-test' };
  const http = new FakeHttp();
  const secrets = new SecretsService(
    paths.secrets,
    { isEncryptionAvailable: () => false, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
    log,
    {},
  );
  const library = new LibraryService(ctx);
  const progress = new ProgressService(ctx, library);
  const artwork = new ArtworkService(ctx, passthroughProcessor, http);
  const providers = new ProviderService(ctx, http, secrets, library, artwork, () => instantLimiter());
  const features = createFeatureServices(ctx, {
    library,
    providers,
    secrets,
    http,
    decodeText,
    steamLimiter: instantLimiter(),
    sleep: async () => undefined,
  });
  const opened: string[] = [];
  const platform: UiEnv['platform'] = {
    opened,
    saveDialog: async () => null,
    openDialog: async () => null,
    folderDialog: async () => null,
    openPath: async () => undefined,
    openExternal: async (u) => void opened.push(u),
  };
  const handlers = buildHandlers({
    ctx,
    library,
    progress,
    catalog: new CatalogService(ctx),
    custom: new CustomizationService(ctx),
    providers,
    artwork,
    ...features,
    backup: new BackupService(ctx, dbm, artwork),
    secrets,
    platform,
    appInfo: () => ({
      name: 'Maybe Pile',
      version: '1.0.0-test',
      tagline: 'Someday, maybe. Now organized.',
      electron: 'x',
      chrome: 'x',
      node: 'x',
      sqlite: dbm.db.sqliteVersion(),
      schemaVersion: 2,
      platform: 'test',
      portable: false,
      dataLocationLabel: t.dir,
      dataLocationNotice: null,
      secretStorage: 'plaintext-fallback',
      upgradeNotice: null,
      recoveryNotice: null,
      backupLocationLabel: t.dir,
      readOnly: false,
    }),
    acknowledgeNotices: () => undefined,
    exportLogText: () => '',
    getExportDir: () => t.dir,
    setExportDir: () => undefined,
  });
  const dispatch = createDispatcher(handlers, () => true, log);
  const api = {
    ...buildApi((c, p) =>
      dispatch(c, { frameUrl: 'app://maybepile/', isMainFrame: true, webContentsId: 1 }, p),
    ),
    events: { onMenuCommand: () => () => undefined },
  };
  window.maybePile = api as unknown as MaybePileApi;
  return {
    library,
    progress,
    features,
    http,
    secrets,
    platform,
    cleanup: () => {
      dbm.close();
      t.cleanup();
    },
  };
}

export function seed(env: UiEnv) {
  const mk = (...a: Parameters<typeof createInput>) => {
    const r = env.library.create(createInput(...a));
    if (r.kind !== 'created') throw new Error('dup');
    return r.item;
  };
  return {
    movie: mk('movie', 'Arrival', {
      meta: { releaseDate: '2016', externalIds: [{ kind: 'imdb', value: 'tt2543164' }] },
      personal: { rating: 9, tags: ['sci-fi'] },
    }),
    book: mk('book', 'Piranesi', {
      meta: { pageCount: 272 },
      personal: { status: 'in_progress', notes: 'House of statues' },
    }),
    tv: mk('tv', 'Severance', {
      seasons: [
        {
          number: 1,
          title: null,
          episodeCountKnown: 2,
          episodes: [1, 2].map((n) => ({ number: n, title: `Ep ${n}`, airDate: null, runtime: null })),
        },
      ],
    }),
    game: mk('game', 'Hades', {
      personal: { gameScheme: 'milestones' },
      milestones: ['Tartarus', 'Asphodel'],
    }),
  };
}

export function renderApp(hash = '#/dashboard') {
  window.location.hash = hash;
  return render(<App />);
}

/** Runs axe-core (WCAG 2.x A/AA rules). Color contrast is verified separately (jsdom can't compute it). */
export async function expectNoAxeViolations(node: Element = document.body) {
  const r = await axe.run(node, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  const summary = r.violations.map(
    (v) =>
      `${v.id}: ${v.help} → ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')}`,
  );
  expect(summary).toEqual([]);
}
