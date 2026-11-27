/**
 * §16.11 Multiple libraries. Each library has its own SQLite DB, artwork
 * cache and settings (settings live in the library DB). Switching restarts
 * the app on the chosen library, so no service ever mixes two libraries.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appError } from '../../shared/result';
import { Db } from '../../db/connection';
import { timestampForFile } from './db-manager';
import {
  DEFAULT_LIBRARY,
  createLibraryEntry,
  libraryDir,
  readRegistry,
  writeRegistry,
} from './library-registry';
import type { ServiceContext } from './context';

export interface LibraryView {
  id: string;
  name: string;
  active: boolean;
  isDefault: boolean;
  createdAt: string;
}

export class LibrariesService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly root: string,
    private readonly activeId: string,
    /** Restarts the app (main: app.relaunch + app.exit). */
    private readonly relaunch: () => void,
  ) {}

  list(): LibraryView[] {
    const r = readRegistry(this.root);
    return r.libraries.map((l) => ({
      id: l.id,
      name: l.name,
      active: l.id === this.activeId,
      isDefault: l.id === DEFAULT_LIBRARY,
      createdAt: l.createdAt,
    }));
  }

  create(name: string): LibraryView[] {
    createLibraryEntry(this.root, name, this.ctx.clock.now());
    return this.list();
  }

  rename(id: string, name: string): LibraryView[] {
    const r = readRegistry(this.root);
    const l = r.libraries.find((x) => x.id === id);
    if (!l) throw appError('NOT_FOUND', 'That library no longer exists.');
    l.name = name.trim().slice(0, 60);
    writeRegistry(this.root, r);
    return this.list();
  }

  /** Copies a consistent snapshot of a library (database + artwork) into a new library. */
  duplicate(id: string): LibraryView[] {
    const r = readRegistry(this.root);
    const src = r.libraries.find((x) => x.id === id);
    if (!src) throw appError('NOT_FOUND', 'That library no longer exists.');
    const entry = createLibraryEntry(this.root, `${src.name} (copy)`, this.ctx.clock.now());
    const from = libraryDir(this.root, id);
    if (id === this.activeId) this.ctx.db().snapshotTo(join(entry.dir, 'library.sqlite'));
    else if (existsSync(join(from, 'library.sqlite'))) {
      const db = new Db(join(from, 'library.sqlite'), { readOnly: true });
      try {
        db.snapshotTo(join(entry.dir, 'library.sqlite'));
      } finally {
        db.close();
      }
    }
    if (existsSync(join(from, 'artwork')))
      cpSync(join(from, 'artwork'), join(entry.dir, 'artwork'), { recursive: true });
    return this.list();
  }

  /** Deletes a non-active, non-default library after keeping a snapshot of its database in the root backups folder. */
  remove(id: string): { snapshot: string | null; libraries: LibraryView[] } {
    if (id === DEFAULT_LIBRARY) throw appError('VALIDATION', 'Your first library cannot be deleted.');
    if (id === this.activeId)
      throw appError('VALIDATION', 'Switch to another library before deleting this one.');
    const r = readRegistry(this.root);
    if (!r.libraries.some((x) => x.id === id)) throw appError('NOT_FOUND', 'That library no longer exists.');
    const dir = libraryDir(this.root, id);
    let snapshot: string | null = null;
    if (existsSync(join(dir, 'library.sqlite'))) {
      mkdirSync(join(this.root, 'backups'), { recursive: true });
      snapshot = `deleted-library-${id}-${timestampForFile(this.ctx.clock.now())}.sqlite`;
      copyFileSync(join(dir, 'library.sqlite'), join(this.root, 'backups', snapshot));
    }
    writeRegistry(this.root, { ...r, libraries: r.libraries.filter((x) => x.id !== id) });
    rmSync(dir, { recursive: true, force: true });
    this.ctx.log.info('libraries.deleted');
    return { snapshot, libraries: this.list() };
  }

  switchTo(id: string): void {
    const r = readRegistry(this.root);
    if (!r.libraries.some((x) => x.id === id)) throw appError('NOT_FOUND', 'That library no longer exists.');
    if (id === this.activeId) return;
    writeRegistry(this.root, { ...r, active: id });
    this.ctx.log.info('libraries.switch');
    this.relaunch();
  }
}
