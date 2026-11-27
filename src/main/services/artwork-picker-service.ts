/**
 * Artwork Picker: gathers candidate images for an item from every applicable
 * source in parallel, hands the renderer opaque tokens (never raw URLs), and
 * applies choices through ArtworkService (which enforces image safety and the
 * per-source caching policy).
 *
 * Rules:
 * - A user's choice (`user_selected`) is never replaced by refreshes or
 *   automatic picks; "Revert to automatic" clears it.
 * - Candidates are ephemeral (30 min, in memory). Only chosen images persist.
 * - Automatic picks rank by the per-type source priority in Settings, then
 *   language (English/textless first), then the source's own score.
 */
import type { BulkAutoPickResult } from '../../shared/types';
import { randomBytes } from 'node:crypto';
import { appError } from '../../shared/result';
import { ARTWORK_SLOTS, type ArtworkSlot, type MediaType } from '../../shared/enums';
import type {
  ArtworkCandidateView,
  ArtworkGallery,
  ArtworkSlotView,
  ArtworkSourceStatus,
} from '../../shared/types';
import { readSettings } from '../../db/repositories/config-repo';
import * as items from '../../db/repositories/items-repo';
import { ART_SOURCES } from '../../providers/art-registry';
import type { ArtCandidate, ArtLookup } from '../../providers/art-types';
import { toUserSafeError } from '../../providers/types';
import type { ArtworkService } from './artwork-service';
import type { ServiceContext } from './context';
import type { ProviderService } from './provider-service';

const TTL_MS = 30 * 60 * 1000;
const MAX_TOKENS = 3000;

interface StoredCandidate {
  itemId: string;
  candidate: ArtCandidate;
  sourceName: string;
  policy: 'cache-allowed' | 'remote-only';
  hosts: readonly string[];
  at: number;
}

const token = () => randomBytes(16).toString('hex');

/** Ranking used by automatic picks; exported for tests. */
export function rankCandidates(cands: ArtCandidate[], priority: readonly string[]): ArtCandidate[] {
  const pr = (id: string) => {
    const i = priority.indexOf(id);
    return i === -1 ? priority.length : i;
  };
  const lang = (c: ArtCandidate) => (c.language === null || c.language === 'en' ? 0 : 1);
  return [...cands].sort(
    (a, b) => pr(a.sourceId) - pr(b.sourceId) || lang(a) - lang(b) || (b.score ?? 0) - (a.score ?? 0),
  );
}

export class ArtworkPickerService {
  private readonly candidates = new Map<string, StoredCandidate>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly artwork: ArtworkService,
    private readonly providers: ProviderService,
  ) {}

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, v] of this.candidates) if (v.at < cutoff) this.candidates.delete(k);
    while (this.candidates.size > MAX_TOKENS) {
      const first = this.candidates.keys().next();
      if (first.done) break;
      this.candidates.delete(first.value);
    }
  }

  private lookup(itemId: string): { lookup: ArtLookup; adult: boolean } {
    const db = this.ctx.db();
    const row = items.getItemRow(db, itemId);
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    const meta = items.loadMeta(db, row);
    const year = meta.releaseDate ? Number(meta.releaseDate.slice(0, 4)) : null;
    return {
      lookup: { type: row.type, title: meta.title, year, externalIds: meta.externalIds },
      adult: meta.isAdult,
    };
  }

  slots(itemId: string): ArtworkSlotView[] {
    if (!items.getItemRow(this.ctx.db(), itemId)) throw appError('NOT_FOUND', 'That item no longer exists.');
    return this.artwork.slotsFor(itemId);
  }

  /** Fetches candidates from all sources in parallel. Failures are per-source, never fatal. */
  async gallery(itemId: string, signal?: AbortSignal): Promise<ArtworkGallery> {
    this.prune();
    const { lookup, adult } = this.lookup(itemId);
    const raw = await this.collect(itemId, lookup, signal);
    const views: ArtworkCandidateView[] = [];
    for (const r of raw.candidates) {
      const t = token();
      this.candidates.set(t, { ...r, itemId, at: Date.now() });
      const thumbToken = token();
      const previewToken = token();
      this.providers.previewThumbs.set(thumbToken, r.candidate.thumbUrl);
      this.providers.previewThumbs.set(previewToken, r.candidate.url);
      views.push({
        token: t,
        sourceId: r.candidate.sourceId,
        sourceName: r.sourceName,
        slot: r.candidate.slot,
        thumbUrl: `maybepile-art://preview/${thumbToken}`,
        previewUrl: `maybepile-art://preview/${previewToken}`,
        width: r.candidate.width,
        height: r.candidate.height,
        language: r.candidate.language,
        attribution: r.candidate.attribution,
        licenseNote: r.candidate.licenseNote,
        cachePolicy: r.policy,
        adult: adult || r.candidate.adult,
      });
    }
    // Keep the shared preview map bounded (it is also used by search thumbnails).
    while (this.providers.previewThumbs.size > MAX_TOKENS * 2) {
      const first = this.providers.previewThumbs.keys().next();
      if (first.done) break;
      this.providers.previewThumbs.delete(first.value);
    }
    this.prune();
    return { itemId, candidates: views, sources: raw.sources };
  }

  private async collect(
    itemId: string,
    lookup: ArtLookup,
    signal?: AbortSignal,
  ): Promise<{
    candidates: Omit<StoredCandidate, 'itemId' | 'at'>[];
    sources: ArtworkSourceStatus[];
  }> {
    const sources: ArtworkSourceStatus[] = [];
    const out: Omit<StoredCandidate, 'itemId' | 'at'>[] = [];
    const tasks: Promise<void>[] = [];

    // 1) The item's own metadata source (cover + banner/background it documents).
    tasks.push(
      (async () => {
        const src = await this.providers.fetchSourceItem(itemId).catch(() => null);
        if (!src) return;
        const { provider: p, item } = src;
        const list: ArtCandidate[] = [];
        const base = {
          sourceId: p.id,
          width: null,
          height: null,
          language: null,
          attribution: p.displayName,
          licenseNote: p.cachingPolicy === 'remote-only' ? 'Shown live from the source; not stored.' : null,
          assetId: null,
          adult: item.meta.isAdult,
          score: null,
        };
        if (item.artworkUrl)
          list.push({ ...base, slot: 'cover', url: item.artworkUrl, thumbUrl: item.artworkUrl });
        for (const e of item.extraArt ?? [])
          list.push({ ...base, slot: e.slot, url: e.url, thumbUrl: e.url });
        for (const c of list)
          out.push({
            candidate: c,
            sourceName: p.displayName,
            policy: p.cachingPolicy,
            hosts: p.artworkHosts,
          });
        sources.push({
          sourceId: p.id,
          sourceName: p.displayName,
          state: 'ok',
          message: null,
          count: list.length,
        });
      })(),
    );

    // 2) Dedicated art sources.
    for (const s of ART_SOURCES) {
      if (!s.supports.includes(lookup.type)) continue;
      if (!this.providers.sourceEnabled(s.id)) continue;
      const keyFree = readSettings(this.ctx.db()).settings.artworkSources;
      if ((s.id === 'tvmaze-art' && !keyFree.tvmaze) || (s.id === 'commons' && !keyFree.commons)) continue;
      const ctx = this.providers.sourceContext(s.id, s.rateLimit, signal);
      if (!s.isConfigured(ctx.keys)) {
        sources.push({
          sourceId: s.id,
          sourceName: s.displayName,
          state: 'not-configured',
          message: `Add a free ${s.displayName} key in Settings → Providers to unlock more images.`,
          count: 0,
        });
        continue;
      }
      tasks.push(
        (async () => {
          const r = await s
            .candidates(lookup, ctx)
            .catch(() => ({ kind: 'networkError' as const, detail: 'failed' }));
          if (r.kind !== 'ok') {
            sources.push({
              sourceId: s.id,
              sourceName: s.displayName,
              state: 'error',
              message: toUserSafeError(r, s.displayName).message,
              count: 0,
            });
            return;
          }
          for (const c of r.value)
            out.push({ candidate: c, sourceName: s.displayName, policy: s.cachingPolicy, hosts: s.hosts });
          sources.push({
            sourceId: s.id,
            sourceName: s.displayName,
            state: 'ok',
            message: null,
            count: r.value.length,
          });
        })(),
      );
    }
    await Promise.all(tasks);
    // De-duplicate identical URLs per slot (e.g. a provider cover that is also a TMDB poster).
    const seen = new Set<string>();
    const unique = out.filter((c) => {
      const k = `${c.candidate.slot}|${c.candidate.url}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { candidates: unique, sources };
  }

  /** Applies a gallery choice as the user's own selection. */
  async choose(
    itemId: string,
    candidateToken: string,
  ): Promise<{ slots: ArtworkSlotView[]; warning: string | null }> {
    const c = this.candidates.get(candidateToken);
    if (!c || c.itemId !== itemId)
      throw appError('NOT_FOUND', 'That image choice has expired.', {
        recovery: 'Reopen the artwork picker.',
      });
    const { adult } = this.lookup(itemId);
    const r = await this.artwork.adopt(
      itemId,
      c.candidate.slot,
      {
        url: c.candidate.url,
        sourceId: c.candidate.sourceId,
        policy: c.policy,
        hosts: c.hosts,
        attribution: c.candidate.attribution,
        licenseNote: c.candidate.licenseNote,
        assetId: c.candidate.assetId,
        width: c.candidate.width,
        height: c.candidate.height,
        language: c.candidate.language,
        adult: adult || c.candidate.adult,
      },
      true,
    );
    this.ctx.log.info('artwork.chosen', { providerId: c.candidate.sourceId, slot: c.candidate.slot });
    return { slots: this.artwork.slotsFor(itemId), warning: r.warning };
  }

  /** Clears the user's choice for a slot and immediately tries an automatic pick. */
  async revert(itemId: string, slot: ArtworkSlot, signal?: AbortSignal): Promise<ArtworkSlotView[]> {
    this.artwork.revertToAutomatic(itemId, slot);
    await this.autoPick(itemId, [slot], signal).catch((e: unknown) => {
      this.ctx.log.warn('artwork.autoPickFailed', { error: e });
    });
    return this.artwork.slotsFor(itemId);
  }

  /** Removes the image from a slot, as a user choice (automatic picks won't refill it until reverted). */
  clear(itemId: string, slot: ArtworkSlot): ArtworkSlotView[] {
    const db = this.ctx.db();
    db.transaction(() => {
      db.run('UPDATE artwork SET selected = 0 WHERE item_id = ? AND slot = ? AND selected = 1', [
        itemId,
        slot,
      ]);
      if (slot === 'cover')
        db.run('UPDATE items SET artwork_id = NULL, updated_at = ? WHERE id = ?', [
          this.ctx.clock.now().toISOString(),
          itemId,
        ]);
    });
    this.artwork.gc();
    return this.artwork.slotsFor(itemId);
  }

  /**
   * Fills the given slots (default: Settings → Artwork auto slots) with the best
   * candidate, skipping slots the user chose. Returns per-slot outcomes.
   */
  async autoPick(
    itemId: string,
    slots?: readonly ArtworkSlot[],
    signal?: AbortSignal,
  ): Promise<{ updated: ArtworkSlot[]; kept: ArtworkSlot[]; empty: ArtworkSlot[] }> {
    const { settings } = readSettings(this.ctx.db());
    const { lookup, adult } = this.lookup(itemId);
    const want = slots ?? (settings.artwork.autoSlots.length ? settings.artwork.autoSlots : ['cover']);
    const result = { updated: [] as ArtworkSlot[], kept: [] as ArtworkSlot[], empty: [] as ArtworkSlot[] };
    const pending = want.filter((s) => {
      if (this.artwork.isUserSelected(itemId, s)) {
        result.kept.push(s);
        return false;
      }
      return true;
    });
    if (pending.length === 0) return result;
    const raw = await this.collect(itemId, lookup, signal);
    const priority = settings.artwork.priority[lookup.type as MediaType] ?? [];
    for (const slot of pending) {
      const ranked = rankCandidates(
        raw.candidates.filter((c) => c.candidate.slot === slot).map((c) => c.candidate),
        priority,
      );
      const best = ranked[0];
      if (!best) {
        result.empty.push(slot);
        continue;
      }
      const meta = raw.candidates.find((c) => c.candidate === best);
      if (!meta) continue;
      const r = await this.artwork.adopt(
        itemId,
        slot,
        {
          url: best.url,
          sourceId: best.sourceId,
          policy: meta.policy,
          hosts: meta.hosts,
          attribution: best.attribution,
          licenseNote: best.licenseNote,
          assetId: best.assetId,
          width: best.width,
          height: best.height,
          language: best.language,
          adult: adult || best.adult,
        },
        false,
      );
      if (r.skipped) result.kept.push(slot);
      else result.updated.push(slot);
    }
    return result;
  }

  /** Bulk auto-pick across items (sequential; respects rate limits; cancellable). */
  async bulkAutoPick(
    itemIds: readonly string[],
    slots: readonly ArtworkSlot[] | undefined,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<BulkAutoPickResult> {
    const res: BulkAutoPickResult = {
      processed: 0,
      updated: 0,
      keptUserChoice: 0,
      noCandidates: 0,
      failed: 0,
      cancelled: false,
    };
    for (const id of itemIds) {
      if (signal?.aborted) {
        res.cancelled = true;
        break;
      }
      try {
        const r = await this.autoPick(id, slots, signal);
        if (r.updated.length) res.updated++;
        if (r.kept.length && !r.updated.length) res.keptUserChoice++;
        if (!r.updated.length && !r.kept.length) res.noCandidates++;
      } catch (e) {
        res.failed++;
        this.ctx.log.warn('artwork.bulkFailed', { error: e });
      }
      res.processed++;
      onProgress?.(res.processed, itemIds.length);
    }
    return res;
  }
}

export { ARTWORK_SLOTS };
