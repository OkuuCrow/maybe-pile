/**
 * Wires the 2.1 services (Simple Mode, §14–§16). Used by main.ts and by the
 * UI/integration harnesses so production and tests share the same graph.
 */
import type { ServiceContext } from './context';
import type { FeatureServices } from './feature-services';
import type { LibraryService } from './library-service';
import type { ProgressService } from './progress-service';
import type { ProviderService } from './provider-service';
import type { ArtworkService } from './artwork-service';
import { BackdropService, type RgbaImage } from './backdrop-service';
import { Extras21Service } from './extras21-service';
import { HistoryService } from './history-service';
import { Import21Service } from './import21-service';
import { LibrariesService } from './libraries-service';
import { MaintenanceService } from './maintenance-service';
import { OrganizeService } from './organize-service';
import { QuickService } from './quick-service';

export interface Pack21Deps {
  library: LibraryService;
  progress: ProgressService;
  providers: ProviderService;
  artwork: ArtworkService;
  features: FeatureServices;
  decodeImage: (bytes: Uint8Array) => RgbaImage | null;
  /** User-data root and active library id (multiple libraries). */
  root: string;
  activeLibraryId: string;
  relaunch: () => void;
  backgroundHealth?: () => Promise<{ ok: boolean; message: string }>;
  repairBackground?: () => Promise<void>;
}

export function createPack21Services(ctx: ServiceContext, d: Pack21Deps) {
  const history = new HistoryService(ctx, d.library);
  return {
    history,
    quick: new QuickService(ctx, d.library, d.progress),
    extras21: new Extras21Service(ctx, d.library, history, d.features.moods),
    organize: new OrganizeService(ctx),
    import21: new Import21Service(ctx, d.library, d.providers, d.features.batches),
    maintenance: new MaintenanceService(ctx, {
      library: d.library,
      history,
      artwork: d.artwork,
      health: d.features.health,
      moods: d.features.moods,
      lists: d.features.lists,
      ...(d.backgroundHealth ? { backgroundHealth: d.backgroundHealth } : {}),
      ...(d.repairBackground ? { repairBackground: d.repairBackground } : {}),
    }),
    backdrops: new BackdropService(ctx, d.artwork, d.decodeImage),
    libraries: new LibrariesService(ctx, d.root, d.activeLibraryId, d.relaunch),
  };
}

export type Pack21Services = ReturnType<typeof createPack21Services>;
