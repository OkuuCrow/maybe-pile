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
import { ARTWORK_SLOTS, type ArtworkSlot } from '../../shared/enums';
import type { ArtworkSlotView } from '../../shared/types';
import { checkExternalUrl } from '../../domain/links';
import type { HttpClient } from '../../providers/http';
import { HttpFailure } from '../../providers/http';
import type { ServiceContext } from './context';
import { atomicWrite } from './fs-safe';
import { newId } from '../../db/repositories/items-repo';
import { ARTWORK_REDIRECT_HOSTS } from '../../providers/registry';

export interface AdoptInput {
  url: string;
  sourceId: string;
  policy: 'cache-allowed' | 'remote-only';
  hosts: readonly string[];
  attribution: string | null;
  licenseNote: string | null;
  assetId: string | null;
  width: number | null;
  height: number | null;
  language: string | null;
  adult: boolean;
}

export interface SlotRow {
  id: string;
  source: 'cache' | 'user' | 'remote';
  file_name: string | null;
  thumb_name: string | null;
  remote_url: string | null;
  origin: string | null;
  attribution_text: string | null;
  license_note: string | null;
  width: number | null;
  height: number | null;
  language: string | null;
  cache_state: 'cached' | 'remote-only' | 'unavailable';
  user_selected: number;
  adult: number;
}

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

/** Pixel caps, checked from the header BEFORE any decode (decompression-bomb guard). */
export const MAX_IMAGE_DIMENSION = 12_000;
export const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * Reads width/height from an image header without decoding pixel data.
 * Returns null when the header is malformed or truncated.
 */
export function imageDimensions(buf: Uint8Array, kind: ImageKind): { width: number; height: number } | null {
  const u16be = (i: number) => ((buf[i] ?? 0) << 8) | (buf[i + 1] ?? 0);
  const u16le = (i: number) => (buf[i] ?? 0) | ((buf[i + 1] ?? 0) << 8);
  const u24le = (i: number) => (buf[i] ?? 0) | ((buf[i + 1] ?? 0) << 8) | ((buf[i + 2] ?? 0) << 16);
  const u32be = (i: number) =>
    (((buf[i] ?? 0) << 24) >>> 0) +
    (((buf[i + 1] ?? 0) << 16) | ((buf[i + 2] ?? 0) << 8) | (buf[i + 3] ?? 0));
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  switch (kind) {
    case 'png':
      // IHDR must be the first chunk.
      if (buf.length < 24 || String.fromCharCode(...buf.slice(12, 16)) !== 'IHDR') return null;
      return ok(u32be(16), u32be(20));
    case 'gif':
      return buf.length < 10 ? null : ok(u16le(6), u16le(8));
    case 'webp': {
      if (buf.length < 30) return null;
      const chunk = String.fromCharCode(...buf.slice(12, 16));
      if (chunk === 'VP8X') return ok(u24le(24) + 1, u24le(27) + 1);
      if (chunk === 'VP8L') {
        const b0 = buf[21] ?? 0,
          b1 = buf[22] ?? 0,
          b2 = buf[23] ?? 0,
          b3 = buf[24] ?? 0;
        return ok(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
      }
      if (chunk === 'VP8 ') return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
      return null;
    }
    case 'jpeg': {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1] ?? 0;
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          i += 2;
          continue;
        }
        const len = u16be(i + 2);
        if (len < 2) return null;
        // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return ok(u16be(i + 7), u16be(i + 5));
        i += 2 + len;
      }
      return null;
    }
  }
}

/** Throws a user-safe error when an image is too large to decode safely. */
export function assertSafeDimensions(buf: Uint8Array, kind: ImageKind): { width: number; height: number } {
  const d = imageDimensions(buf, kind);
  if (!d)
    throw appError(
      'VALIDATION',
      "That image couldn't be read. It may be damaged or in an unsupported format.",
    );
  if (
    d.width > MAX_IMAGE_DIMENSION ||
    d.height > MAX_IMAGE_DIMENSION ||
    d.width * d.height > MAX_IMAGE_PIXELS
  )
    throw appError('TOO_LARGE', 'That image has too many pixels.', {
      recovery: `Use an image up to ${MAX_IMAGE_DIMENSION}px on each side.`,
    });
  return d;
}

export interface ProcessedImage {
  data: Uint8Array;
  ext: 'jpg' | 'png';
  thumb: Uint8Array;
  width?: number;
  height?: number;
}

/** Decodes/re-encodes an image (dropping EXIF/metadata). Returns null if it cannot be decoded. */
export interface ImageProcessor {
  process(buf: Uint8Array, kind: ImageKind, opts?: { maxWidth?: number }): ProcessedImage | null;
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
    wide = false,
  ): string {
    if (buf.byteLength > MAX_IMAGE_BYTES)
      throw appError('TOO_LARGE', 'That image is larger than 15 MB.', {
        recovery: 'Choose a smaller image.',
      });
    const kind = sniffImage(buf);
    if (!kind) throw appError('VALIDATION', 'That file is not a supported image (PNG, JPEG, WebP or GIF).');
    const dims = assertSafeDimensions(buf, kind);
    const processed = this.images.process(buf, kind, wide ? { maxWidth: 2560 } : undefined);
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
      `INSERT INTO artwork (id, source, file_name, thumb_name, remote_url, provider_id, mime, byte_size, created_at,
                            width, height, sha256, cache_state, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cached', ?)`,
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
        processed.width ?? dims.width,
        processed.height ?? dims.height,
        hash,
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
      `INSERT INTO artwork (id, source, remote_url, provider_id, created_at, cache_state) VALUES (?, 'remote', ?, ?, ?, 'remote-only')`,
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
        redirectHosts: ARTWORK_REDIRECT_HOSTS,
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

  /**
   * Sets the cover (entry point used by import, local images and the cover menu).
   * `user` = an explicit user choice; provider imports pass false so refreshes may update it.
   */
  setItemArtwork(itemId: string, artworkId: string | null, user = true): void {
    if (artworkId === null) {
      const r = this.db.run(
        'UPDATE items SET artwork_id = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        [this.ctx.clock.now().toISOString(), itemId],
      );
      if (r.changes === 0) throw appError('NOT_FOUND', 'That item no longer exists.');
      this.db.run("UPDATE artwork SET selected = 0 WHERE item_id = ? AND slot = 'cover'", [itemId]);
      this.gc();
      return;
    }
    this.select(itemId, 'cover', artworkId, user);
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
    const wasUser = this.isUserSelected(itemId, 'cover');
    const bytes = await this.download(row.remote_url, hosts);
    const id = this.storeBytes(bytes, 'cache', row.provider_id, row.remote_url);
    this.db.run('UPDATE artwork SET origin = (SELECT origin FROM artwork WHERE id = ?) WHERE id = ?', [
      row.id,
      id,
    ]);
    this.setItemArtwork(itemId, id, wasUser);
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

  /* ---------------------------------------------------------------- slots (Artwork Picker) */

  /**
   * Stores (or references) an image for a slot and selects it. Policy:
   * - `remote-only` sources are never downloaded; the row keeps the https URL.
   * - `cache-allowed` sources are downloaded, validated and re-encoded; on
   *   failure we fall back to a remote reference with a warning.
   * `user` marks the choice as the user's: automatic refreshes never replace it.
   */
  async adopt(
    itemId: string,
    slot: ArtworkSlot,
    art: AdoptInput,
    user: boolean,
  ): Promise<{ artworkId: string; warning: string | null; skipped: boolean }> {
    const current = this.selectedRow(itemId, slot);
    if (!user && current?.user_selected === 1) return { artworkId: current.id, warning: null, skipped: true };
    let artworkId: string | null = null;
    let warning: string | null = null;
    const wide = slot === 'banner' || slot === 'background';
    if (art.policy === 'cache-allowed') {
      try {
        const bytes = await this.download(art.url, art.hosts);
        artworkId = this.storeBytes(bytes, 'cache', art.sourceId, art.url, wide);
      } catch (e) {
        this.ctx.log.warn('artwork.downloadFailed', { providerId: art.sourceId, error: e });
        warning = 'The image could not be downloaded; it will be shown when online.';
      }
    }
    if (!artworkId) artworkId = this.addRemote(art.url, art.sourceId, art.hosts);
    if (!artworkId) throw appError('VALIDATION', 'Artwork URL is not from an allowed host.');
    this.db.run(
      `UPDATE artwork SET origin = ?, source_asset_id = ?, width = COALESCE(width, ?), height = COALESCE(height, ?),
         language = ?, license_note = ?, attribution_text = ?, adult = ?, fetched_at = ? WHERE id = ?`,
      [
        art.sourceId,
        art.assetId?.slice(0, 200) ?? null,
        art.width && art.width > 0 ? Math.round(art.width) : null,
        art.height && art.height > 0 ? Math.round(art.height) : null,
        art.language?.slice(0, 20) ?? null,
        art.licenseNote?.slice(0, 500) ?? null,
        art.attribution?.slice(0, 500) ?? null,
        art.adult ? 1 : 0,
        this.ctx.clock.now().toISOString(),
        artworkId,
      ],
    );
    this.select(itemId, slot, artworkId, user);
    return { artworkId, warning, skipped: false };
  }

  /** Makes `artworkId` the selected image for the slot (transactional). Cover also updates items.artwork_id. */
  select(itemId: string, slot: ArtworkSlot, artworkId: string, user: boolean): void {
    const db = this.db;
    const now = this.ctx.clock.now().toISOString();
    db.transaction(() => {
      const item = db.get<{ id: string }>('SELECT id FROM items WHERE id = ? AND deleted_at IS NULL', [
        itemId,
      ]);
      if (!item) throw appError('NOT_FOUND', 'That item no longer exists.');
      const art = db.get<{ id: string; item_id: string | null }>(
        'SELECT id, item_id FROM artwork WHERE id = ?',
        [artworkId],
      );
      if (!art || (art.item_id !== null && art.item_id !== itemId))
        throw appError('NOT_FOUND', 'That image is no longer available.');
      db.run('UPDATE artwork SET selected = 0 WHERE item_id = ? AND slot = ? AND selected = 1', [
        itemId,
        slot,
      ]);
      db.run(
        'UPDATE artwork SET item_id = ?, slot = ?, selected = 1, user_selected = ?, is_auto = ? WHERE id = ?',
        [itemId, slot, user ? 1 : 0, user ? 0 : 1, artworkId],
      );
      if (slot === 'cover')
        db.run('UPDATE items SET artwork_id = ?, updated_at = ? WHERE id = ?', [artworkId, now, itemId]);
      else db.run('UPDATE items SET updated_at = ? WHERE id = ?', [now, itemId]);
    });
    this.gc();
  }

  /** Clears the slot and the user's choice so the next automatic pick may fill it. */
  revertToAutomatic(itemId: string, slot: ArtworkSlot): void {
    const db = this.db;
    db.transaction(() => {
      db.run(
        'UPDATE artwork SET selected = 0, user_selected = 0 WHERE item_id = ? AND slot = ? AND selected = 1',
        [itemId, slot],
      );
      if (slot === 'cover')
        db.run('UPDATE items SET artwork_id = NULL, updated_at = ? WHERE id = ?', [
          this.ctx.clock.now().toISOString(),
          itemId,
        ]);
    });
    this.gc();
  }

  isUserSelected(itemId: string, slot: ArtworkSlot): boolean {
    return this.selectedRow(itemId, slot)?.user_selected === 1;
  }

  selectedRow(itemId: string, slot: ArtworkSlot): SlotRow | undefined {
    return this.db.get<SlotRow>(
      `SELECT id, source, file_name, thumb_name, remote_url, origin, attribution_text, license_note, width, height,
              language, cache_state, user_selected, adult
         FROM artwork WHERE item_id = ? AND slot = ? AND selected = 1`,
      [itemId, slot],
    );
  }

  /** Selected art for every slot of an item, as renderer-safe views. */
  slotsFor(itemId: string): ArtworkSlotView[] {
    const rows = this.db.all<SlotRow & { slot: ArtworkSlot }>(
      `SELECT id, slot, source, file_name, thumb_name, remote_url, origin, attribution_text, license_note, width, height,
              language, cache_state, user_selected, adult
         FROM artwork WHERE item_id = ? AND selected = 1`,
      [itemId],
    );
    return ARTWORK_SLOTS.map((slot): ArtworkSlotView => {
      const r = rows.find((x) => x.slot === slot);
      if (!r)
        return {
          slot,
          artworkId: null,
          url: null,
          thumbUrl: null,
          origin: null,
          attribution: null,
          licenseNote: null,
          width: null,
          height: null,
          language: null,
          cacheState: null,
          userSelected: false,
          adult: false,
        };
      const url =
        r.source === 'remote'
          ? `maybepile-art://remote/${r.id}`
          : r.file_name
            ? `maybepile-art://file/${r.file_name}`
            : null;
      const thumbUrl =
        r.source === 'remote' ? url : r.thumb_name ? `maybepile-art://file/${r.thumb_name}` : url;
      return {
        slot,
        artworkId: r.id,
        url,
        thumbUrl,
        origin: r.origin,
        attribution: r.attribution_text,
        licenseNote: r.license_note,
        width: r.width,
        height: r.height,
        language: r.language,
        cacheState: r.cache_state,
        userSelected: r.user_selected === 1,
        adult: r.adult === 1,
      };
    });
  }

  /** Removes unreferenced artwork rows and files. Selected slot art counts as referenced. */
  gc(): { rows: number; files: number } {
    const rows = this.db.run(
      `DELETE FROM artwork
        WHERE id NOT IN (SELECT artwork_id FROM items WHERE artwork_id IS NOT NULL)
          AND NOT (selected = 1 AND item_id IS NOT NULL)`,
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
