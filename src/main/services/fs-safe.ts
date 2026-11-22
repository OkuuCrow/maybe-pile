/**
 * Safe file writes: temp file in the destination directory → fsync → rename.
 * A crash mid-write leaves either the old file or the new one, never a torn file.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statfsSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { appError, AppError } from '../../shared/result';

export function atomicWrite(dest: string, data: Uint8Array | string, opts: { overwrite: boolean }): void {
  if (!opts.overwrite && existsSync(dest)) {
    throw appError('CONFLICT', `A file named "${basename(dest)}" already exists.`, {
      recovery: 'Choose a different name or location.',
    });
  }
  const dir = dirname(dest);
  const tmp = join(dir, `.${basename(dest)}.${randomBytes(6).toString('hex')}.tmp`);
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  ensureFreeSpace(dir, buf.byteLength);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx');
    let off = 0;
    while (off < buf.byteLength) off += writeSync(fd, buf, off, buf.byteLength - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, dest);
  } catch (e) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw mapFsError(e, basename(dest));
  }
}

/** Throws DISK_FULL if the volume clearly lacks room (with a 10 MB margin). */
export function ensureFreeSpace(dir: string, bytes: number): void {
  try {
    const s = statfsSync(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < bytes + 10 * 1024 * 1024) {
      throw appError('DISK_FULL', 'There is not enough free disk space for this operation.', {
        recovery: 'Free up some space or choose another drive, then try again.',
      });
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    // statfs unsupported on this filesystem: proceed and rely on write errors.
  }
}

/** Maps Node fs errors to user-safe errors without leaking full paths. */
export function mapFsError(e: unknown, label: string): AppError {
  if (e instanceof AppError) return e;
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return appError('PERMISSION', `Maybe Pile doesn't have permission to write "${label}".`, {
        recovery: 'Choose a folder you can write to (for example, Documents).',
      });
    case 'ENOSPC':
      return appError('DISK_FULL', 'The disk is full.', { recovery: 'Free up space and try again.' });
    case 'ENOENT':
      return appError('IO', `"${label}" could not be found.`, {
        recovery: 'Check that the file or folder still exists.',
      });
    case 'EBUSY':
      return appError('FILE_LOCKED', `"${label}" is in use by another program.`, {
        recovery: 'Close the other program and try again.',
      });
    case 'EROFS':
      return appError('PERMISSION', 'That location is read-only.', { recovery: 'Choose a writable folder.' });
    default:
      return appError('IO', `Couldn't write "${label}".`, {
        recovery: 'Try again, or choose a different location.',
      });
  }
}
