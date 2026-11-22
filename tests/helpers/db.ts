import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/db/connection';
import { migrate } from '../../src/db/migrate';

/** An isolated temp directory (never the developer's real userData). */
export function tempDir(prefix = 'mp-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fresh, fully migrated database in an isolated temp directory. */
export function freshDb(): { db: Db; dir: string; cleanup: () => void } {
  const t = tempDir();
  const db = new Db(join(t.dir, 'library.sqlite'));
  migrate(db);
  return {
    db,
    dir: t.dir,
    cleanup: () => {
      db.close();
      t.cleanup();
    },
  };
}
