/**
 * Dependencies shared by all services. Services never import `electron`
 * directly so they can be tested in plain Node with temp directories; the
 * Electron-specific adapters (dialogs, nativeImage, safeStorage, net) are
 * injected by src/main/main.ts.
 */
import { join } from 'node:path';
import type { Db } from '../../db/connection';
import type { Logger } from './logger';

export interface AppPaths {
  userData: string;
  artwork: string;
  backups: string;
  logs: string;
  database: string;
  secrets: string;
}

export function pathsFor(userData: string): AppPaths {
  return {
    userData,
    artwork: join(userData, 'artwork'),
    backups: join(userData, 'backups'),
    logs: join(userData, 'logs'),
    database: join(userData, 'library.sqlite'),
    secrets: join(userData, 'secrets.json'),
  };
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ServiceContext {
  /** Getter, because a restore swaps the database handle. */
  db(): Db;
  clock: Clock;
  log: Logger;
  paths: AppPaths;
  appVersion: string;
}
