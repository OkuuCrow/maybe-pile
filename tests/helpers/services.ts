import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../../src/db/connection';
import { migrate } from '../../src/db/migrate';
import { pathsFor, type Clock, type ServiceContext } from '../../src/main/services/context';
import { MemoryLogger } from '../../src/main/services/logger';
import { LibraryService } from '../../src/main/services/library-service';
import { ProgressService } from '../../src/main/services/progress-service';
import { defaultPersonal, emptyMeta } from '../../src/domain/metadata';
import type { MediaType } from '../../src/shared/enums';
import type { ItemCreateInput, MetadataFields, PersonalFields, SeasonInput } from '../../src/shared/schemas';
import { tempDir } from './db';

export class FakeClock implements Clock {
  constructor(public current = new Date('2025-03-10T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface TestEnv {
  ctx: ServiceContext;
  db: Db;
  dir: string;
  clock: FakeClock;
  log: MemoryLogger;
  library: LibraryService;
  progress: ProgressService;
  reopen(): void;
  cleanup(): void;
}

export function makeEnv(): TestEnv {
  const t = tempDir();
  const paths = pathsFor(t.dir);
  for (const d of [paths.artwork, paths.backups, paths.logs]) mkdirSync(d, { recursive: true });
  let db = new Db(paths.database);
  migrate(db);
  const clock = new FakeClock();
  const log = new MemoryLogger();
  const ctx: ServiceContext = { db: () => db, clock, log, paths, appVersion: '1.0.0-test' };
  const library = new LibraryService(ctx);
  const progress = new ProgressService(ctx, library);
  const env: TestEnv = {
    ctx,
    get db() {
      return db;
    },
    dir: t.dir,
    clock,
    log,
    library,
    progress,
    reopen() {
      db.close();
      db = new Db(join(t.dir, 'library.sqlite'));
      migrate(db);
    },
    cleanup() {
      db.close();
      t.cleanup();
    },
  };
  return env;
}

export function createInput(
  type: MediaType,
  title: string,
  opts: {
    meta?: Partial<MetadataFields>;
    personal?: Partial<PersonalFields>;
    seasons?: SeasonInput[];
    milestones?: string[];
  } = {},
): ItemCreateInput {
  return {
    type,
    meta: { ...emptyMeta(title), ...opts.meta },
    personal: { ...defaultPersonal(type, '2025-03-10'), ...opts.personal },
    seasons: opts.seasons ?? [],
    milestones: opts.milestones ?? [],
    allowDuplicate: false,
  };
}

export function addItem(env: TestEnv, ...args: Parameters<typeof createInput>) {
  const r = env.library.create(createInput(...args));
  if (r.kind !== 'created') throw new Error('expected created');
  return r.item;
}

export function season(number: number, episodes: number, known: number | null = episodes): SeasonInput {
  return {
    number,
    title: null,
    episodeCountKnown: known,
    episodes: Array.from({ length: episodes }, (_, i) => ({
      number: i + 1,
      title: `Episode ${i + 1}`,
      airDate: null,
      runtime: null,
    })),
  };
}
