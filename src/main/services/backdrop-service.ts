/**
 * §15.6 Backdrops + storage controls.
 *
 * - Ambient palettes are computed once per artwork in main (from the small
 *   cached thumbnail, never full-resolution art) and cached in
 *   `artwork_palettes` (derived data: regenerated if missing, not needed in backups).
 * - Storage: size of the artwork cache, a configurable cap, LRU eviction of
 *   *non-user-selected, re-downloadable* cached images only (they become
 *   remote-only and show again when online). User-selected and user-added
 *   images are never evicted; the library database is never touched beyond
 *   those artwork rows.
 */
import { readFileSync, rmSync, statSync } from 'node:fs';
import { appError } from '../../shared/result';
import { readSettings } from '../../db/repositories/config-repo';
import { extractPalette, type Palette } from '../../domain/backdrop';
import type { BackdropStyle } from '../../shared/schemas';
import type { ArtworkService } from './artwork-service';
import type { ServiceContext } from './context';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA bytes, row-major. */
  data: Uint8Array;
}

export interface ItemBackdropView {
  itemStyle: 'default' | BackdropStyle;
  palette: Palette | null;
  /** maybepile-art:// URL of the background/banner image, if any. */
  backgroundUrl: string | null;
  coverThumbUrl: string | null;
  adult: boolean;
}

export interface StorageView {
  cacheBytes: number;
  cacheFiles: number;
  userBytes: number;
  evictableBytes: number;
  capMb: number;
}

export class BackdropService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly artwork: ArtworkService,
    /** Decodes an image file's bytes to a small RGBA bitmap (main: nativeImage). */
    private readonly decode: (bytes: Uint8Array) => RgbaImage | null,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  forItem(itemId: string): ItemBackdropView {
    const item = this.db.get<{
      artwork_id: string | null;
      backdrop_style: string | null;
      is_adult: number | null;
    }>(
      `SELECT i.artwork_id, ip.backdrop_style, ad.is_adult FROM items i LEFT JOIN item_prefs ip ON ip.item_id = i.id
         LEFT JOIN anime_details ad ON ad.item_id = i.id WHERE i.id = ? AND i.deleted_at IS NULL`,
      [itemId],
    );
    if (!item) throw appError('NOT_FOUND', 'That item no longer exists.');
    const slots = this.artwork.slotsFor(itemId);
    const pick = (slot: string) => slots.find((s) => s.slot === slot && s.url !== null) ?? null;
    const bg = pick('background') ?? pick('banner');
    const cover = pick('cover');
    return {
      itemStyle: (item.backdrop_style as ItemBackdropView['itemStyle'] | null) ?? 'default',
      palette: item.artwork_id ? this.palette(item.artwork_id) : null,
      backgroundUrl: bg?.url ?? null,
      coverThumbUrl: cover?.thumbUrl ?? cover?.url ?? null,
      adult: item.is_adult === 1 || !!cover?.adult,
    };
  }

  /** Cached palette for an artwork row, computing it from the thumbnail on first use. */
  palette(artworkId: string): Palette | null {
    const cached = this.db.get<{ colors: string; luminance: number }>(
      'SELECT colors, luminance FROM artwork_palettes WHERE artwork_id = ?',
      [artworkId],
    );
    if (cached) {
      try {
        const v = JSON.parse(cached.colors) as Partial<Palette> & { colors?: string[] };
        if (Array.isArray(v.colors) && v.darkest && v.brightest)
          return {
            colors: v.colors,
            darkest: v.darkest,
            brightest: v.brightest,
            luminance: cached.luminance,
          };
      } catch {
        /* recompute */
      }
    }
    const row = this.db.get<{ thumb_name: string | null; file_name: string | null }>(
      'SELECT thumb_name, file_name FROM artwork WHERE id = ?',
      [artworkId],
    );
    const file = row
      ? (this.artwork.resolveFile(row.thumb_name ?? '') ?? this.artwork.resolveFile(row.file_name ?? ''))
      : null;
    if (!file) return null;
    let img: RgbaImage | null = null;
    try {
      img = this.decode(new Uint8Array(readFileSync(file)));
    } catch {
      img = null;
    }
    if (!img) return null;
    const p = extractPalette(img.data, img.width, img.height);
    this.db.run(
      `INSERT INTO artwork_palettes (artwork_id, colors, luminance, computed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(artwork_id) DO UPDATE SET colors = excluded.colors, luminance = excluded.luminance, computed_at = excluded.computed_at`,
      [
        artworkId,
        JSON.stringify({ colors: p.colors, darkest: p.darkest, brightest: p.brightest }),
        Math.max(0, Math.min(1, p.luminance)),
        this.ctx.clock.now().toISOString(),
      ],
    );
    return p;
  }

  setItemStyle(itemId: string, style: 'default' | BackdropStyle): ItemBackdropView {
    if (!this.db.get('SELECT 1 AS x FROM items WHERE id = ? AND deleted_at IS NULL', [itemId]))
      throw appError('NOT_FOUND', 'That item no longer exists.');
    this.db.run(
      `INSERT INTO item_prefs (item_id, backdrop_style) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET backdrop_style = excluded.backdrop_style`,
      [itemId, style],
    );
    return this.forItem(itemId);
  }

  /* ---------------------------------------------------------------- storage */

  private fileSize(name: string | null): number {
    if (!name) return 0;
    const p = this.artwork.resolveFile(name);
    if (!p) return 0;
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  }

  private rows() {
    return this.db.all<{
      id: string;
      source: string;
      file_name: string | null;
      thumb_name: string | null;
      remote_url: string | null;
      user_selected: number;
      created_at: string;
      fetched_at: string | null;
    }>(
      "SELECT id, source, file_name, thumb_name, remote_url, user_selected, created_at, fetched_at FROM artwork WHERE source IN ('cache', 'user')",
    );
  }

  private evictable(r: ReturnType<BackdropService['rows']>[number]): boolean {
    return r.source === 'cache' && r.user_selected === 0 && !!r.remote_url;
  }

  storage(): StorageView {
    let cacheBytes = 0;
    let userBytes = 0;
    let evictableBytes = 0;
    let files = 0;
    for (const r of this.rows()) {
      const size = this.fileSize(r.file_name) + this.fileSize(r.thumb_name);
      files += (r.file_name ? 1 : 0) + (r.thumb_name ? 1 : 0);
      if (r.source === 'user' || r.user_selected === 1) userBytes += size;
      else cacheBytes += size;
      if (this.evictable(r)) evictableBytes += size;
    }
    return {
      cacheBytes,
      cacheFiles: files,
      userBytes,
      evictableBytes,
      capMb: readSettings(this.db).settings.backdrops.cacheCapMb,
    };
  }

  /** Evicts least-recently-fetched evictable images until the cache fits `capBytes` (all of them for 0). */
  evict(capBytes: number): { evicted: number; freedBytes: number } {
    const rows = this.rows();
    let total = rows.reduce(
      (n, r) =>
        n +
        (r.source === 'cache' && r.user_selected === 0
          ? this.fileSize(r.file_name) + this.fileSize(r.thumb_name)
          : 0),
      0,
    );
    const candidates = rows
      .filter((r) => this.evictable(r))
      .sort((a, b) => (a.fetched_at ?? a.created_at).localeCompare(b.fetched_at ?? b.created_at));
    let evicted = 0;
    let freed = 0;
    for (const r of candidates) {
      // A 0 cap ("Clear cached images") evicts every evictable image, even when sizes are unknown.
      if (capBytes > 0 && total <= capBytes) break;
      const size = this.fileSize(r.file_name) + this.fileSize(r.thumb_name);
      const paths = [r.file_name, r.thumb_name]
        .map((n) => (n ? this.artwork.resolveFile(n) : null))
        .filter((p): p is string => !!p);
      // DB first (row becomes remote-only), then files: a crash in between only leaves an unused file.
      this.db.run(
        "UPDATE artwork SET source = 'remote', file_name = NULL, thumb_name = NULL, cache_state = 'remote-only' WHERE id = ? AND user_selected = 0",
        [r.id],
      );
      this.db.run('DELETE FROM artwork_palettes WHERE artwork_id = ?', [r.id]);
      for (const p of paths) {
        const stillUsed = this.db.get('SELECT 1 AS x FROM artwork WHERE file_name = ? OR thumb_name = ?', [
          p.split(/[\\/]/).pop() ?? '',
          p.split(/[\\/]/).pop() ?? '',
        ]);
        if (!stillUsed) rmSync(p, { force: true });
      }
      total -= size;
      freed += size;
      evicted++;
    }
    if (evicted > 0) this.ctx.log.info('artwork.evicted', { evicted, freed });
    return { evicted, freedBytes: freed };
  }

  enforceCap(): { evicted: number; freedBytes: number } {
    return this.evict(readSettings(this.db).settings.backdrops.cacheCapMb * 1024 * 1024);
  }

  clearCache(): { evicted: number; freedBytes: number } {
    return this.evict(0);
  }
}
