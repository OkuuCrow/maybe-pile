/**
 * Orchestrates metadata providers: search → explicit selection → preview →
 * import, metadata refresh with per-field choices, and watch availability.
 *
 * Previews are kept in a short-lived in-memory cache keyed by an opaque token
 * so the import commits exactly what the user reviewed.
 */
import { randomBytes } from 'node:crypto';
import { AppError, appError } from '../../shared/result';
import type {
  ImportFromProviderInput,
  MetadataField,
  ProviderRef,
  ProviderSearchInput,
  RefreshApplyInput,
} from '../../shared/schemas';
import type {
  ImportPreview,
  ItemDetail,
  ProviderInfo,
  RefreshFieldRow,
  RefreshPreview,
  SearchHitView,
  WatchAvailability,
} from '../../shared/types';
import { linksFromExternalIds } from '../../domain/links';
import {
  canonicalValue,
  compareForRefresh,
  defaultPersonal,
  displayValue,
  mergeRefresh,
} from '../../domain/metadata';
import { planStatusChange } from '../../domain/status-rules';
import { readSettings } from '../../db/repositories/config-repo';
import { addAudit } from '../../db/repositories/catalog-repo';
import * as items from '../../db/repositories/items-repo';
import { mergeProviderSeasons, previewSeasonMerge } from '../../db/repositories/progress-repo';
import type { HttpClient } from '../../providers/http';
import { RateLimiter } from '../../providers/rate-limiter';
import { getProvider, PROVIDERS } from '../../providers/registry';
import {
  toUserSafeError,
  type MetadataProvider,
  type ProviderContext,
  type ProviderItem,
  type ProviderResult,
} from '../../providers/types';
import type { ArtworkService } from './artwork-service';
import type { ServiceContext } from './context';
import type { CreateResult, LibraryService } from './library-service';
import type { SecretsService } from './secrets-service';

const TTL_MS = 30 * 60 * 1000;

interface CachedPreview {
  provider: MetadataProvider;
  item: ProviderItem;
  at: number;
}
interface CachedRefresh {
  provider: MetadataProvider;
  itemId: string;
  item: ProviderItem;
  rows: RefreshFieldRow[];
  at: number;
}

const token = () => randomBytes(16).toString('hex');

function bounded<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}

export class ProviderService {
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly previews = new Map<string, CachedPreview>();
  private readonly refreshes = new Map<string, CachedRefresh>();
  /** token → remote thumbnail URL for search results (served via maybepile-art://preview/). */
  readonly previewThumbs = new Map<string, string>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly http: HttpClient,
    private readonly secrets: SecretsService,
    private readonly library: LibraryService,
    private readonly artwork: ArtworkService,
    private readonly limiterFactory: (p: MetadataProvider) => RateLimiter = (p) =>
      new RateLimiter(p.rateLimit),
  ) {}

  private limiter(p: MetadataProvider): RateLimiter {
    let l = this.limiters.get(p.id);
    if (!l) {
      l = this.limiterFactory(p);
      this.limiters.set(p.id, l);
    }
    return l;
  }

  private context(p: MetadataProvider, signal?: AbortSignal): ProviderContext {
    const { settings } = readSettings(this.ctx.db());
    return {
      http: this.http,
      limiter: this.limiter(p),
      keys: this.secrets.keysFor(p.id),
      region: settings.region,
      ...(signal ? { signal } : {}),
    };
  }

  private enabled(p: MetadataProvider): boolean {
    const { settings } = readSettings(this.ctx.db());
    return settings.providerEnabled[p.id] ?? true;
  }

  private requireProvider(id: string): MetadataProvider {
    const p = getProvider(id);
    if (!p) throw appError('VALIDATION', 'Unknown metadata provider.');
    if (!this.enabled(p))
      throw appError('PROVIDER_UNAVAILABLE', `${p.displayName} is turned off.`, {
        recovery: 'Turn it on in Settings → Providers.',
      });
    return p;
  }

  private unwrap<T>(p: MetadataProvider, r: ProviderResult<T>): T {
    if (r.kind === 'ok') return r.value;
    this.ctx.log.warn('provider.failure', { providerId: p.id, kind: r.kind });
    throw new AppError(toUserSafeError(r, p.displayName));
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, v] of this.previews) if (v.at < cutoff) this.previews.delete(k);
    for (const [k, v] of this.refreshes) if (v.at < cutoff) this.refreshes.delete(k);
  }

  list(): ProviderInfo[] {
    return PROVIDERS.map((p) => {
      const keys = this.secrets.keysFor(p.id);
      return {
        id: p.id,
        displayName: p.displayName,
        supports: [...p.supports],
        attribution: p.attribution,
        requiresApiKey: p.requiresApiKey,
        keyFields: [...p.keyFields],
        keysSet: this.secrets.isSet(p.id, p.keyFields),
        configured: p.isConfigured(keys),
        enabled: this.enabled(p),
        cachingPolicy: p.cachingPolicy,
        rateLimitText: `${p.rateLimit.maxRequests} request(s) per ${p.rateLimit.perMs / 1000}s`,
        signupUrl: p.signupUrl,
      };
    });
  }

  async search(input: ProviderSearchInput): Promise<SearchHitView[]> {
    const p = this.requireProvider(input.providerId);
    if (!p.supports.includes(input.type))
      throw appError('VALIDATION', `${p.displayName} doesn't cover this media type.`);
    const hits = this.unwrap(
      p,
      await p.search({ type: input.type, query: input.query, year: input.year }, this.context(p)),
    );
    this.ctx.log.info('provider.search', { providerId: p.id, results: hits.length });
    return hits.map((h) => {
      let thumbUrl: string | null = null;
      if (h.thumbUrl) {
        const t = token();
        this.previewThumbs.set(t, h.thumbUrl);
        bounded(this.previewThumbs, 500);
        thumbUrl = `maybepile-art://preview/${t}`;
      }
      return {
        providerId: p.id,
        ref: h.ref,
        title: h.title,
        year: h.year,
        type: h.type,
        creators: h.creators,
        synopsis: h.synopsis,
        thumbUrl,
      };
    });
  }

  async preview(ref: ProviderRef): Promise<ImportPreview> {
    this.prune();
    const p = this.requireProvider(ref.providerId);
    const item = this.unwrap(p, await p.fetchDetails(ref, this.context(p)));
    const t = token();
    this.previews.set(t, { provider: p, item, at: Date.now() });
    bounded(this.previews, 20);
    let artworkPreviewUrl: string | null = null;
    if (item.artworkUrl) {
      const pt = token();
      this.previewThumbs.set(pt, item.artworkUrl);
      artworkPreviewUrl = `maybepile-art://preview/${pt}`;
    }
    const warnings: string[] = [];
    if (!item.meta.description) warnings.push('No description was provided.');
    if (ref.type === 'tv' && item.seasons.length === 0)
      warnings.push('No season/episode list was provided; you can add episodes manually.');
    if (ref.type === 'book' && item.meta.pageCount === null)
      warnings.push('Page count is unknown; you can track progress by percentage.');
    return {
      token: t,
      providerId: p.id,
      providerName: p.displayName,
      attribution: p.attribution.text,
      meta: item.meta,
      seasons: item.seasons.map((s) => ({
        number: s.number,
        title: s.title,
        episodeCount: s.episodes.length,
      })),
      hasArtwork: Boolean(item.artworkUrl),
      artworkPreviewUrl,
      artworkPolicy: p.cachingPolicy,
      links: linksFromExternalIds(ref.type, item.meta.externalIds),
      duplicates: this.library.checkDuplicates({
        type: ref.type,
        title: item.meta.title,
        releaseDate: item.meta.releaseDate,
        externalIds: item.meta.externalIds,
        excludeId: null,
      }),
      warnings,
    };
  }

  async importPreviewed(input: ImportFromProviderInput): Promise<CreateResult & { warnings: string[] }> {
    const cached = this.previews.get(input.previewToken);
    if (!cached)
      throw appError('NOT_FOUND', 'This preview has expired.', {
        recovery: 'Select the search result again.',
      });
    const { provider: p, item } = cached;
    const type = item.ref.type;
    const today = this.library.today();
    const plan = planStatusChange(
      { type, status: 'planned', dateStarted: null, dateCompleted: null, pass: 1 },
      { status: input.status, startNewPass: false, clearDateCompleted: false },
      today,
    );
    const personal = {
      ...defaultPersonal(type, today),
      status: input.status,
      tags: input.tags,
      dateStarted: plan.dateStarted,
      dateCompleted: plan.dateCompleted,
    };

    if (!input.allowDuplicate) {
      const matches = this.library.checkDuplicates({
        type,
        title: item.meta.title,
        releaseDate: item.meta.releaseDate,
        externalIds: item.meta.externalIds,
        excludeId: null,
      });
      if (matches.length > 0) return { kind: 'duplicates', matches, warnings: [] };
    }
    const warnings: string[] = [];
    let artworkId: string | null = null;
    if (item.artworkUrl) {
      const a = await this.artwork.acquireProviderArtwork(
        item.artworkUrl,
        p.id,
        p.cachingPolicy,
        p.artworkHosts,
      );
      artworkId = a.artworkId;
      if (a.warning) warnings.push(a.warning);
    }
    try {
      const r = this.library.create(
        { type, meta: item.meta, personal, seasons: item.seasons, milestones: [], allowDuplicate: true },
        {
          kind: 'provider',
          providerId: p.id,
          providerRef: item.ref.id,
          providerUrl: item.sourceUrl,
          artworkId,
        },
      );
      this.previews.delete(input.previewToken);
      return { ...r, warnings };
    } catch (e) {
      // Item creation is transactional; remove any artwork we fetched for it.
      this.artwork.gc();
      throw e;
    }
  }

  /* ---------------------------------------------------------------- refresh */

  private sourceFor(itemId: string): { provider: MetadataProvider; ref: ProviderRef } {
    const row = items.getItemRow(this.ctx.db(), itemId);
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    const sources = this.ctx
      .db()
      .all<{ provider_id: string; provider_ref: string }>(
        'SELECT provider_id, provider_ref FROM item_sources WHERE item_id = ? ORDER BY fetched_at DESC',
        [itemId],
      );
    for (const s of sources) {
      const p = getProvider(s.provider_id);
      if (p && this.enabled(p))
        return { provider: p, ref: { providerId: p.id, id: s.provider_ref, type: row.type } };
    }
    throw appError(
      'VALIDATION',
      'This item was not imported from an online source, so there is nothing to refresh.',
      {
        recovery: 'Edit the details manually.',
      },
    );
  }

  async refreshPreview(itemId: string): Promise<RefreshPreview> {
    this.prune();
    const { provider: p, ref } = this.sourceFor(itemId);
    const incoming = this.unwrap(p, await p.fetchDetails(ref, this.context(p)));
    const db = this.ctx.db();
    const row = items.getItemRow(db, itemId);
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    const current = items.loadMeta(db, row);
    const cmp = compareForRefresh(row.type, current, incoming.meta, items.loadProvenance(db, itemId));
    const eps =
      row.type === 'tv' ? previewSeasonMerge(db, itemId, incoming.seasons) : { added: 0, updated: 0 };
    const t = token();
    this.refreshes.set(t, { provider: p, itemId, item: incoming, rows: cmp.rows, at: Date.now() });
    bounded(this.refreshes, 20);
    return {
      token: t,
      providerId: p.id,
      providerName: p.displayName,
      rows: cmp.rows,
      unchangedCount: cmp.unchanged.length,
      newEpisodes: eps.added,
      updatedEpisodes: eps.updated,
    };
  }

  refreshApply(input: RefreshApplyInput): ItemDetail {
    const cached = this.refreshes.get(input.token);
    if (!cached)
      throw appError('NOT_FOUND', 'This refresh preview has expired.', {
        recovery: 'Start the refresh again.',
      });
    const db = this.ctx.db();
    const row = items.getItemRow(db, cached.itemId);
    if (!row) throw appError('NOT_FOUND', 'That item no longer exists.');
    const now = this.ctx.clock.now().toISOString();
    const { provider: p, item: incoming, rows } = cached;
    db.transaction(() => {
      const current = items.loadMeta(db, row);
      // Re-compare against the *current* state in case the item changed since the preview.
      const fresh = compareForRefresh(row.type, current, incoming.meta, items.loadProvenance(db, row.id));
      const allowed = new Set(rows.map((r) => r.field));
      const choices = Object.fromEntries(Object.entries(input.choices).filter(([f]) => allowed.has(f)));
      const merged = mergeRefresh(current, incoming.meta, fresh.rows, choices);
      items.writeMeta(db, row.id, row.type, merged.meta);
      const prov = items.loadProvenance(db, row.id);
      const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];
      for (const r of fresh.rows) {
        const f = r.field as MetadataField;
        const updated = merged.updated.includes(f);
        if (updated) {
          items.setProvenance(db, row.id, f, 'provider', p.id, canonicalValue(f, incoming.meta[f]), now);
          changes.push({
            field: f,
            oldValue: displayValue(f, current[f]),
            newValue: displayValue(f, incoming.meta[f]),
          });
        } else {
          // Kept: origin unchanged, but remember the provider's latest value for future comparisons.
          const existing = prov[f];
          items.setProvenance(
            db,
            row.id,
            f,
            existing?.origin ?? 'user',
            p.id,
            canonicalValue(f, incoming.meta[f]),
            now,
          );
        }
      }
      for (const f of fresh.unchanged) {
        const existing = prov[f];
        if (
          existing?.origin === 'provider' ||
          (!existing && canonicalValue(f, current[f]) === canonicalValue(f, incoming.meta[f]))
        ) {
          items.setProvenance(db, row.id, f, 'provider', p.id, canonicalValue(f, incoming.meta[f]), now);
        }
      }
      if (row.type === 'tv') {
        const eps = mergeProviderSeasons(db, row.id, incoming.seasons);
        if (eps.added > 0)
          changes.push({ field: 'episodes', oldValue: null, newValue: `${eps.added} new episode(s)` });
        if (eps.updated > 0)
          changes.push({
            field: 'episodeDetails',
            oldValue: null,
            newValue: `${eps.updated} episode(s) updated`,
          });
      }
      items.setSource(db, row.id, p.id, incoming.ref.id, incoming.sourceUrl, now);
      addAudit(db, row.id, 'refresh', p.id, changes, now);
      items.touch(db, row.id, now);
      items.reindexItem(db, row.id);
      items.recomputeProgress(db, row.id);
    });
    this.refreshes.delete(input.token);
    this.ctx.log.info('provider.refreshApplied', { providerId: p.id, itemId: row.id });
    return this.library.get(row.id);
  }

  /* ---------------------------------------------------------------- watch links */

  async watchAvailability(itemId: string, region: string): Promise<WatchAvailability> {
    const item = this.library.get(itemId);
    const base: WatchAvailability = {
      status: 'not-applicable',
      region,
      link: null,
      providers: [],
      attribution: null,
      message: '',
    };
    if (item.type !== 'movie' && item.type !== 'tv')
      return { ...base, message: 'Where-to-watch applies to movies and TV shows.' };
    const tmdbId = item.meta.externalIds.find((e) => e.kind === 'tmdb')?.value;
    const p = getProvider('tmdb');
    if (!p?.discoverLinks) return { ...base, status: 'unavailable', message: 'Availability unavailable.' };
    if (!tmdbId)
      return {
        ...base,
        status: 'unavailable',
        message: 'Availability unavailable — this item has no TMDB ID to look up.',
      };
    if (!this.enabled(p) || !p.isConfigured(this.secrets.keysFor('tmdb'))) {
      return {
        ...base,
        status: 'not-configured',
        message: 'Availability needs a TMDB API key (Settings → Providers).',
      };
    }
    const attribution =
      'Availability data provided by JustWatch via TMDB. It may be incomplete or out of date.';
    const r = await p.discoverLinks(
      { providerId: 'tmdb', id: tmdbId, type: item.type },
      region,
      this.context(p),
    );
    if (r.kind !== 'ok') {
      return { ...base, status: 'error', attribution, message: toUserSafeError(r, p.displayName).message };
    }
    if (!r.value.link && r.value.providers.length === 0) {
      return {
        ...base,
        status: 'unavailable',
        attribution,
        message: `Availability unavailable for region ${region}.`,
      };
    }
    return {
      status: 'available',
      region,
      link: r.value.link ? { kind: 'watch', label: 'Where to watch', url: r.value.link } : null,
      providers: r.value.providers,
      attribution,
      message: `Availability for region ${region}. Offers change often; check before you watch.`,
    };
  }
}
