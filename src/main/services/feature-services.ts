/**
 * Wires the 1.2 feature-pack services. Used by main.ts and by the UI/integration
 * test harnesses so production and tests share exactly the same graph.
 */
import type { HttpClient } from '../../providers/http';
import { RateLimiter } from '../../providers/rate-limiter';
import { manualSource } from '../../library-sources/manual';
import { createSteamSource } from '../../library-sources/steam';
import type { ServiceContext } from './context';
import { GoalsService } from './goals-service';
import { ImportBatchService } from './import-batch-service';
import { ImportService } from './import-service';
import { LibrarySourceService } from './library-source-service';
import type { LibraryService } from './library-service';
import { ListsService } from './lists-service';
import { PickService } from './pick-service';
import { PileHealthService } from './pile-health-service';
import type { ProviderService } from './provider-service';
import { ReleaseRadarService } from './release-radar-service';
import type { SecretsService } from './secrets-service';
import { StatsService } from './stats-service';
import { TrackerImportService } from './tracker-import-service';

/** Conservative client-side limit for Steam (Valve allows 100,000 calls/day per key). */
export const STEAM_RATE_LIMIT = { maxRequests: 10, perMs: 10_000, maxWaitMs: 15_000 };

export interface FeatureDeps {
  library: LibraryService;
  providers: ProviderService;
  secrets: SecretsService;
  http: HttpClient;
  decodeText: (b: Uint8Array) => string;
  steamLimiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
  timeZone?: string;
}

export function createFeatureServices(ctx: ServiceContext, d: FeatureDeps) {
  const lists = new ListsService(ctx);
  const batches = new ImportBatchService(ctx, d.library);
  const importer = new ImportService(ctx, d.library, batches);
  const steam = createSteamSource(d.http, d.steamLimiter ?? new RateLimiter(STEAM_RATE_LIMIT));
  const sources = new LibrarySourceService(ctx, {
    steam,
    manual: manualSource,
    secrets: d.secrets,
    library: d.library,
    lists,
    batches,
    enrich: (id) => d.providers.enrichEmptyFields(id),
    ...(d.sleep ? { sleep: d.sleep } : {}),
  });
  return {
    lists,
    batches,
    importer,
    sources,
    health: new PileHealthService(ctx),
    pick: new PickService(ctx, d.library),
    stats: new StatsService(ctx, d.timeZone),
    goals: new GoalsService(ctx, d.timeZone),
    radar: new ReleaseRadarService(ctx, d.providers),
    tracker: new TrackerImportService(ctx, importer, d.decodeText),
  };
}

export type FeatureServices = ReturnType<typeof createFeatureServices>;
