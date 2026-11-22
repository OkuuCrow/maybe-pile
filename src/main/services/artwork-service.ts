/**
 * Artwork storage.
 *
 * - Cached/user images live in `<userData>/artwork/` as content-addressed files
 *   (`<sha256>.<ext>` plus `<sha256>.thumb.jpg`), so duplicates are stored once
 *   and file names can never be influenced by provider or user input.
 * - Images are sniffed by magic bytes (PNG/JPEG/WebP/GIF), size-capped, then
 *   re-encoded by the injected `ImageProcessor` (Electron nativeImage), which
 *   drops EXIF/metadata and produces a small grid thumbnail.
 * - Providers whose terms don't clearly allow caching get a `remote` row: only
 *   the https URL is stored and main proxies it on demand (see protocol.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { appError } from '../../shared/result';
import { checkExternalUrl } from '../../domain/links';
import type { HttpClient } from '../../providers/http';
import { HttpFailure } from '../../providers/http';
import type { ServiceContext } from './context';
import { atomicWrite } from './fs-safe';
import { newId } from '../../db/repositories/items-repo';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const ARTWORK_FILE_RE = /^[a-f0-9]{64}(?:\.thumb)?\.(?:jpg|png)$/;

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif';

export function sniffImage(buf: Uint8Array): ImageKind | null {
  const b = (i: number) => buf[i] ?? -1;
  if (buf.length < 12) return null;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpeg';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'gif';
  if (
    b(0) === 0x52 &&
    b(1) === 0x49 &&
    b(2) === 0x46 &&
    b(3) === 0x46 &&
    b(8) === 0x57 &&
    b(9) === 0x45 &&
    b(10) === 0x42 &&
    b(11) === 0x50
  )
    return 'webp';
  return null;
}

export interface ProcessedImage {
  data: Uint8Array;
  ext: 'jpg' | 'png';
  thumb: Uint8Array;
}

/** Decodes/re-encodes an image. Returns null if it cannot be decoded. */
export interface ImageProcessor {
  process(buf: Uint8Array, kind: ImageKind): ProcessedImage | null;
}

/** Test/fallback processor: no re-encoding; keeps PNG/JPEG as-is, rejects others. */
export const passthroughProcessor: ImageProcessor = {
  process(buf, kind) {
    if (kind !== 'png' && kind !== 'jpeg') return null;
    return { data: buf, ext: kind === 'png' ? 'png' : 'jpg', thumb: buf };
  },
};

export class ArtworkService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly images: ImageProcessor,
    private readonly http: HttpClient,
  ) {
    mkdirSync(ctx.paths.artwork, { recursive: true });
  }

  private get db() {
    return this.ctx.db();
  }

  /** Validates, re-encodes and stores image bytes; returns the new artwork id. */
  storeBytes(
    buf: Uint8Array,
    source: 'cache' | 'user',
    providerId: string | null,
    remoteUrl: string | null,
  ): string {
    if (buf.byteLength > MAX_IMAGE_BYTES)
      throw appError('TOO_LARGE', 'That image is larger than 15 MB.', {
        recovery: 'Choose a smaller image.',
      });
    const kind = sniffImage(buf);
    if (!kind) throw appError('VALIDATION', 'That file is not a supported image (PNG, JPEG, WebP or GIF).');
    const processed = this.images.process(buf, kind);
    if (!processed)
      throw appError(
        'VALIDATION',
        "That image couldn't be read. It may be damaged or in an unsupported format.",
      );
    const hash = createHash('sha256').update(processed.data).digest('hex');
    const file = `${hash}.${processed.ext}`;
    const thumb = `${hash}.thumb.jpg`;
    const fullPath = join(this.ctx.paths.artwork, file);
    if (!existsSync(fullPath)) atomicWrite(fullPath, processed.data, { overwrite: true });
    const thumbPath = join(this.ctx.paths.artwork, thumb);
    if (!existsSync(thumbPath)) atomicWrite(thumbPath, processed.thumb, { overwrite: true });
    const id = newId();
    this.db.run(
      `INSERT INTO artwork (id, source, file_name, thumb_name, remote_url, provider_id, mime, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        source,
        file,
        thumb,
        remoteUrl,
        providerId,
        processed.ext === 'png' ? 'image/png' : 'image/jpeg',
        processed.data.byteLength,
        this.ctx.clock.now().toISOString(),
      ],
    );
    return id;
  }

  addRemote(url: string, providerId: string, hosts: readonly string[]): string | null {
    const check = checkExternalUrl(url, hosts);
    if (!check.ok) return null;
    const id = newId();
    this.db.run(
      `INSERT INTO artwork (id, source, remote_url, provider_id, created_at) VALUES (?, 'remote', ?, ?, ?)`,
      [id, check.url, providerId, this.ctx.clock.now().toISOString()],
    );
    return id;
  }

  async download(url: string, hosts: readonly string[], signal?: AbortSignal): Promise<Uint8Array> {
    const check = checkExternalUrl(url, hosts);
    if (!check.ok) throw appError('VALIDATION', 'Artwork URL is not from an allowed host.');
    try {
      const res = await this.http.request({
        url: check.url,
        timeoutMs: 15_000,
        maxBytes: MAX_IMAGE_BYTES,
        headers: { Accept: 'image/*' },
        ...(signal ? { signal } : {}),
      });
      if (res.status !== 200)
        throw appError('PROVIDER_UNAVAILABLE', 'The artwork could not be downloaded.', {
          recovery: 'Retry later or choose a local image.',
        });
      if (!/^image\//i.test(res.headers['content-type'] ?? ''))
        throw appError('PROVIDER_MALFORMED', 'The artwork download was not an image.');
      return res.body;
    } catch (e) {
      if (e instanceof HttpFailure) {
        throw appError(
          e.kind === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK',
          "Couldn't download the artwork.",
          {
            recovery: 'Retry when online, or choose a local image.',
          },
        );
      }
      throw e;
    }
  }

  /**
   * Downloads and caches provider artwork when policy allows; otherwise (or on
   * failure for remote-only providers) records a remote reference. Returns the
   * artwork id or null, plus a warning to show the user.
   */
  async acquireProviderArtwork(
    url: string,
    providerId: string,
    policy: 'cache-allowed' | 'remote-only',
    hosts: readonly string[],
  ): Promise<{ artworkId: string | null; warning: string | null }> {
    if (policy === 'remote-only') return { artworkId: this.addRemote(url, providerId, hosts), warning: null };
    try {
      const bytes = await this.download(url, hosts);
      return { artworkId: this.storeBytes(bytes, 'cache', providerId, url), warning: null };
    } catch (e) {
      this.ctx.log.warn('artwork.downloadFailed', { providerId, error: e });
      // Keep the reference so the user can retry later; the item import still succeeds.
      return {
        artworkId: this.addRemote(url, providerId, hosts),
        warning:
          'Artwork could not be downloaded; it will be shown when online. You can retry from the item page.',
      };
    }
  }

  setItemArtwork(itemId: string, artworkId: string | null): void {
    const r = this.db.run(
      'UPDATE items SET artwork_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      [artworkId, this.ctx.clock.now().toISOString(), itemId],
    );
    if (r.changes === 0) throw appError('NOT_FOUND', 'That item no longer exists.');
    this.gc();
  }

  setLocalImage(itemId: string, filePath: string): void {
    let st;
    try {
      st = statSync(filePath);
    } catch {
      throw appError('IO', "That image couldn't be opened.");
    }
    if (!st.isFile()) throw appError('VALIDATION', 'Please choose an image file.');
    if (st.size > MAX_IMAGE_BYTES)
      throw appError('TOO_LARGE', 'That image is larger than 15 MB.', {
        recovery: 'Choose a smaller image.',
      });
    const id = this.storeBytes(readFileSync(filePath), 'user', null, null);
    this.setItemArtwork(itemId, id);
  }

  /** Retries caching for a remote reference whose provider allows caching. */
  async retry(itemId: string, hosts: readonly string[]): Promise<void> {
    const row = this.db.get<{ id: string; remote_url: string | null; provider_id: string | null }>(
      `SELECT a.id, a.remote_url, a.provider_id FROM items i JOIN artwork a ON a.id = i.artwork_id WHERE i.id = ? AND a.source = 'remote'`,
      [itemId],
    );
    if (!row?.remote_url) throw appError('NOT_FOUND', 'There is no artwork to retry for this item.');
    const bytes = await this.download(row.remote_url, hosts);
    const id = this.storeBytes(bytes, 'cache', row.provider_id, row.remote_url);
    this.setItemArtwork(itemId, id);
  }

  /** Remote URL for a `remote` artwork row (re-validated against provider hosts). */
  remoteUrl(artworkId: string, hosts: ReadonlySet<string>): string | null {
    const row = this.db.get<{ remote_url: string | null }>(
      "SELECT remote_url FROM artwork WHERE id = ? AND source = 'remote'",
      [artworkId],
    );
    if (!row?.remote_url) return null;
    const check = checkExternalUrl(row.remote_url, hosts);
    return check.ok ? check.url : null;
  }

  /** Absolute path for an artwork file name, or null if invalid/outside the artwork dir. */
  resolveFile(name: string): string | null {
    if (!ARTWORK_FILE_RE.test(name)) return null;
    const base = resolve(this.ctx.paths.artwork);
    const full = resolve(base, name);
    if (!full.startsWith(base + sep)) return null;
    return existsSync(full) ? full : null;
  }

  /** Removes unreferenced artwork rows and files. */
  gc(): { rows: number; files: number } {
    const rows = this.db.run(
      'DELETE FROM artwork WHERE id NOT IN (SELECT artwork_id FROM items WHERE artwork_id IS NOT NULL)',
    ).changes;
    const keep = new Set<string>();
    for (const r of this.db.all<{ file_name: string | null; thumb_name: string | null }>(
      'SELECT file_name, thumb_name FROM artwork',
    )) {
      if (r.file_name) keep.add(r.file_name);
      if (r.thumb_name) keep.add(r.thumb_name);
    }
    let files = 0;
    for (const f of readdirSync(this.ctx.paths.artwork)) {
      if (ARTWORK_FILE_RE.test(f) && !keep.has(f)) {
        rmSync(join(this.ctx.paths.artwork, f), { force: true });
        files++;
      }
    }
    return { rows, files };
  }

  /** All referenced artwork file names (for backups). */
  referencedFiles(): string[] {
    const out = new Set<string>();
    for (const r of this.db.all<{ file_name: string | null; thumb_name: string | null }>(
      "SELECT file_name, thumb_name FROM artwork WHERE source <> 'remote'",
    )) {
      if (r.file_name) out.add(r.file_name);
      if (r.thumb_name) out.add(r.thumb_name);
    }
    return [...out].filter((f) => this.resolveFile(f) !== null);
  }
}
