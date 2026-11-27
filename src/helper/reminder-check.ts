/**
 * Node-mode reminder helper entry (Linux scheduled mode):
 *
 *   ELECTRON_RUN_AS_NODE=1 <maybe-pile binary> <userData>/helper/reminder-check.cjs \
 *     --reminder-check --data-dir <userData>
 *
 * Runs without a display server: no Electron APIs, no window, no renderer, no
 * network. Delivers through the session bus (gdbus) or notify-send. Exits
 * with a documented code (see src/notifications/helper.ts) and never hangs
 * the scheduler: a hard timer forces exit.
 *
 * `--dry-run` plans and logs what would be shown without showing or claiming
 * anything (usable on any OS for troubleshooting).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileLogger } from '../main/services/logger';
import { createLinuxNotifier, dbusEnv } from '../notifications/adapters/linux';
import type { Notifier } from '../notifications/adapters/types';
import { nodeExec } from '../notifications/exec';
import { EXIT, HELPER_TIMEOUT_MS, parseHelperArgs, runHelper } from '../notifications/helper';

const hardExit = setTimeout(() => process.exit(EXIT.timeout), HELPER_TIMEOUT_MS + 2_000);
hardExit.unref();

async function main(): Promise<number> {
  const args = parseHelperArgs(process.argv.slice(2));
  if (!args || !args.dataDir) {
    process.stderr.write(
      'usage: reminder-check.cjs --reminder-check --data-dir <absolute path> [--dry-run]\n',
    );
    return EXIT.badArgs;
  }
  const log = new FileLogger(join(args.dataDir, 'logs'));
  const env = dbusEnv(process.env, existsSync);
  const notifier: Notifier =
    process.platform === 'linux'
      ? createLinuxNotifier({ exec: nodeExec, env })
      : {
          id: 'none',
          probe: async () => ({
            available: false,
            reason: 'Node-mode delivery is Linux-only',
            capabilities: { actions: false, bodyMarkup: false, persistent: false, icon: false },
          }),
          show: async () => ({ status: 'unsupported', reason: 'Node-mode delivery is Linux-only' }),
        };
  const r = await runHelper({ dataDir: args.dataDir, notifier, log, dryRun: args.dryRun });
  if (args.dryRun)
    process.stdout.write(
      `${JSON.stringify({ code: r.code, libraries: r.checkedLibraries, reason: r.reason })}\n`,
    );
  return r.code;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(EXIT.unexpected),
);
