/**
 * Data-location rules (documented in docs/backup-and-transfer.md):
 *
 * 1. `MAYBEPILE_USER_DATA` (tests/e2e/advanced users) wins.
 * 2. Portable build (electron-builder sets PORTABLE_EXECUTABLE_DIR) or a
 *    `portable.flag` file next to the executable → `<exe dir>/MaybePileData/`.
 *    If that folder is not writable → `<appData>/MaybePile-Portable/` with a
 *    visible notice. A portable copy never shares the installed copy's data.
 * 3. Installed → `<appData>/MaybePile/` (e.g. %APPDATA%\MaybePile,
 *    ~/Library/Application Support/MaybePile, ~/.config/MaybePile).
 */
import { join } from 'node:path';

export interface DataLocation {
  dir: string;
  portable: boolean;
  notice: string | null;
}

export function resolveDataLocation(opts: {
  env: NodeJS.ProcessEnv;
  appDataDir: string;
  exeDir: string;
  exists: (p: string) => boolean;
  isWritableDir: (p: string) => boolean;
}): DataLocation {
  const override = opts.env['MAYBEPILE_USER_DATA'];
  if (override) return { dir: override, portable: false, notice: null };
  const portableBase =
    opts.env['PORTABLE_EXECUTABLE_DIR'] ||
    (opts.exists(join(opts.exeDir, 'portable.flag')) ? opts.exeDir : null);
  if (portableBase) {
    const target = join(portableBase, 'MaybePileData');
    if (opts.isWritableDir(target)) return { dir: target, portable: true, notice: null };
    return {
      dir: join(opts.appDataDir, 'MaybePile-Portable'),
      portable: true,
      notice:
        'The folder next to the portable app is read-only, so your portable library is stored in your user profile (MaybePile-Portable) instead.',
    };
  }
  return { dir: join(opts.appDataDir, 'MaybePile'), portable: false, notice: null };
}
