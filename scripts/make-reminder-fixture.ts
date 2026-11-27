/**
 * Dev tool: creates a throwaway library in <dir> with scheduled reminders on
 * and a stale in-progress item, for manually exercising the reminder helper:
 *
 *   node scripts/run-ts.mjs scripts/make-reminder-fixture.ts <empty dir>
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron dist/helper/reminder-check.cjs \
 *     --reminder-check --data-dir <dir> --dry-run
 *
 * Never point it at your real data folder.
 */
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Db } from '../src/db/connection';
import { migrate } from '../src/db/migrate';
import { writeSettings } from '../src/db/repositories/config-repo';
import { DEFAULT_NOTIFICATION_SETTINGS } from '../src/shared/notification-settings';

const dir = process.argv.at(-1); // run-ts imports in-process: argv = [node, run-ts, script, dir]
if (!dir || !isAbsolute(dir) || !existsSync(dir) || readdirSync(dir).length > 0) {
  console.error('usage: make-reminder-fixture.ts <absolute path to an EMPTY directory>');
  process.exit(2);
}
const db = new Db(join(dir, 'library.sqlite'));
migrate(db);
const now = new Date();
const old = new Date(now.getTime() - 10 * 86_400_000).toISOString();
db.run(
  `INSERT INTO items (id, type, title, sort_title, title_key, status, date_added, date_started, created_at, updated_at)
   VALUES ('11111111-1111-4111-8111-111111111111', 'book', 'Fixture Book', 'fixture book', 'fixture book', 'in_progress', ?, ?, ?, ?)`,
  [old.slice(0, 10), old.slice(0, 10), old, old],
);
const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
writeSettings(db, {
  notifications: {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    mode: 'scheduled',
    quietHours: { ...DEFAULT_NOTIFICATION_SETTINGS.quietHours, enabled: false },
    categories: {
      ...DEFAULT_NOTIFICATION_SETTINGS.categories,
      keepGoing: { ...DEFAULT_NOTIFICATION_SETTINGS.categories.keepGoing, enabled: true, time: hhmm },
    },
  },
});
db.close();
console.log(`fixture library created in ${dir} (keep-going due at ${hhmm} local)`);
