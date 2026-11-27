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
import { applyTitlePreference, groupByCrossIds } from '../../domain/anime';
import { saveRelationSuggestions, saveStreamingLinks } from '../../db/repositories/extras-repo';
import {
  canonicalValue,
  compareForRefresh,
  defaultPersonal,
  displayValue,
  isEmptyValue,
  mergeRefresh,
} from '../../domain/metadata';
import { titleKey } from '../../domain/normalize';
import type { MediaType } from '../../shared/enums';
import { isEpisodic } from '../../shared/enums';
import { planStatusChange } from '../../domain/status-rules';
import { readSettings } from '../../db/repositories/config-repo';
import { addAudit } from '../../db/repositories/catalog-repo';
import * as items from '../../db/repositories/items-repo';
import { mergeProviderSeasons, previewSeasonMerge } from '../../db/repositories/progress-repo';
import type { HttpClient } from '../../providers/http';
import { RateLimiter } from '../../providers/rate-limiter';
import { getProvider, PROVIDERS } from '../../providers/registry';
import { ART_SOURCES } from '../../providers/art-registry';
import {
  toUserSafeError,
  type MetadataProvider,
  type ProviderContext,
  type ProviderItem,
  type ProviderResult,
  type SearchHit,
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
    readonly artwork: ArtworkService,
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

  /**
   * Context for a non-metadata source (artwork). Limiters are shared by id, so
   * TMDB artwork and TMDB metadata draw from the same budget.
   */
  sourceContext(
    id: string,
    rateLimit: { maxRequests: number; perMs: number },
    signal?: AbortSignal,
  ): ProviderContext {
    let l = this.limiters.get(id);
    if (!l) {
      l = new RateLimiter(rateLimit);
      this.limiters.set(id, l);
    }
    const { settings } = readSettings(this.ctx.db());
    return {
      http: this.http,
      limiter: l,
      keys: this.secrets.keysFor(id),
      region: settings.region,
      ...(signal ? { signal } : {}),
    };
  }

  sourceEnabled(id: string): boolean {
    return readSettings(this.ctx.db()).settings.providerEnabled[id] ?? true;
  }

  private enabled(p: MetadataProvider): boolean {
    const { settings } = readSettings(this.ctx.db());
    return settings.providerEnabled[p.id] ?? p.enabledByDefault ?? true;
  }

  private showAdult(): boolean {
    return readSettings(this.ctx.db()).settings.anime.showAdult;
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
    const meta = PROVIDERS.map((p): ProviderInfo => {
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
        termsNote: p.termsNote ?? null,
        kind: 'metadata' as const,
        keyLabels: {},
      };
    });
    const ids = new Set(PROVIDERS.map((p) => p.id));
    const art: ProviderInfo[] = ART_SOURCES.filter((a) => !ids.has(a.id)).map((a) => {
      const keys = this.secrets.keysFor(a.id);
      return {
        id: a.id,
        displayName: a.displayName,
        supports: [...a.supports],
        attribution: a.attribution,
        requiresApiKey: a.requiresApiKey,
        keyFields: [...a.keyFields],
        keysSet: this.secrets.isSet(a.id, a.keyFields),
        configured: a.isConfigured(keys),
        enabled: this.sourceEnabled(a.id),
        cachingPolicy: a.cachingPolicy,
        rateLimitText: `${a.rateLimit.maxRequests} request(s) per ${a.rateLimit.perMs / 1000}s`,
        signupUrl: a.signupUrl,
        termsNote: a.termsNote,
        kind: 'art' as const,
        keyLabels: a.keyLabels ?? {},
      };
    });
    return [...meta, ...art];
  }

  async search(input: ProviderSearchInput): Promise<SearchHitView[]> {
    const p = this.requireProvider(input.providerId);
    if (!p.supports.includes(input.type))
      throw appError('VALIDATION', `${p.displayName} doesn't cover this media type.`);
    const hits = this.unwrap(
      p,
      await p.search(
        { type: input.type, query: input.query, year: input.year, includeAdult: this.showAdult() },
        this.context(p),
      ),
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
    const raw = this.unwrap(p, await p.fetchDetails(ref, this.context(p)));
    const { settings } = readSettings(this.ctx.db());
    if (raw.meta.isAdult && !settings.anime.showAdult)
      throw appError('VALIDATION', 'This title is marked as adult content, which is hidden.', {
        recovery: 'Turn on "Show adult titles" in Settings → Anime to import it.',
      });
    const item =
      ref.type === 'anime'
        ? { ...raw, meta: applyTitlePreference(raw.meta, settings.anime.titleLanguage) }
        : raw;
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
    if (isEpisodic(ref.type) && item.seasons.length === 0)
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
      if (r.kind === 'created') await this.applyExtras(r.item.id, p, item, warnings);
      return { ...r, warnings };
    } catch (e) {
      // Item creation is transactional; remove any artwork we fetched for it.
      this.artwork.gc();
      throw e;
    }
  }

  /**
   * Post-import/refresh extras: marks the provider cover as the automatic cover
   * slot, fills a banner when the provider has one (never over a user choice),
   * and stores relation suggestions + documented streaming links.
   */
  private async applyExtras(
    itemId: string,
    p: MetadataProvider,
    item: ProviderItem,
    warnings: string[],
  ): Promise<void> {
    const db = this.ctx.db();
    const now = this.ctx.clock.now().toISOString();
    const row = db.get<{ artwork_id: string | null }>('SELECT artwork_id FROM items WHERE id = ?', [itemId]);
    if (row?.artwork_id && !this.artwork.selectedRow(itemId, 'cover'))
      this.artwork.select(itemId, 'cover', row.artwork_id, false);
    for (const extra of item.extraArt ?? []) {
      try {
        const a = await this.artwork.adopt(
          itemId,
          extra.slot,
          {
            url: extra.url,
            sourceId: p.id,
            policy: p.cachingPolicy,
            hosts: p.artworkHosts,
            attribution: p.displayName,
            licenseNote: null,
            assetId: null,
            width: null,
            height: null,
            language: null,
            adult: item.meta.isAdult,
          },
          false,
        );
        if (a.warning) warnings.push(a.warning);
      } catch (e) {
        this.ctx.log.warn('artwork.extraFailed', { providerId: p.id, error: e });
      }
    }
    db.transaction(() => {
      if (item.relations?.length) saveRelationSuggestions(db, itemId, p.id, item.relations, now);
      if (item.streaming) saveStreamingLinks(db, itemId, p.id, item.streaming, now);
    });
  }

  /**
   * "All sources" anime search: queries every enabled, configured anime source
   * in the user's provider order, then merges hits that share a cross id
   * (AniList/MAL/Kitsu). The first source in the order wins the merged row.
   */
  async searchAllAnime(
    query: string,
    year: number | null,
  ): Promise<{
    hits: (SearchHitView & { alsoOn: string[] })[];
    failures: { providerId: string; message: string }[];
  }> {
    const { settings } = readSettings(this.ctx.db());
    const order = settings.anime.providerOrder;
    const rank = (id: string) => {
      const i = order.indexOf(id);
      return i === -1 ? order.length : i;
    };
    const sources = PROVIDERS.filter(
      (p) => p.supports.includes('anime') && this.enabled(p) && p.isConfigured(this.secrets.keysFor(p.id)),
    ).sort((a, b) => rank(a.id) - rank(b.id));
    const results = await Promise.all(
      sources.map(async (p) => ({
        p,
        r: await p.search(
          { type: 'anime', query, year, includeAdult: settings.anime.showAdult },
          this.context(p),
        ),
      })),
    );
    const failures: { providerId: string; message: string }[] = [];
    const flat: {
      p: MetadataProvider;
      hit: SearchHit;
      providerId: string;
      ids: SearchHit['crossIds'] & object;
    }[] = [];
    for (const { p, r } of results) {
      if (r.kind !== 'ok') {
        failures.push({ providerId: p.id, message: toUserSafeError(r, p.displayName).message });
        continue;
      }
      for (const hit of r.value) flat.push({ p, hit, providerId: p.id, ids: hit.crossIds ?? {} });
    }
    const groups = groupByCrossIds(flat);
    const hits = groups
      .flatMap((g) => {
        const best = [...g].sort((a, b) => rank(a.providerId) - rank(b.providerId))[0] ?? g[0];
        if (!best) return null;
        const view = this.toHitView(best.p, best.hit);
        return [
          {
            ...view,
            alsoOn: [...new Set(g.map((x) => x.p.displayName))].filter((n) => n !== best.p.displayName),
          },
        ];
      })
      .filter((x) => x !== null);
    this.ctx.log.info('provider.searchAll', { sources: sources.length, results: hits.length });
    return { hits, failures };
  }

  private toHitView(p: MetadataProvider, h: SearchHit): SearchHitView {
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
  }

  /** Re-fetches the item's own source record (used by the Artwork Picker for provider art). */
  async fetchSourceItem(itemId: string): Promise<{ provider: MetadataProvider; item: ProviderItem } | null> {
    let src: { provider: MetadataProvider; ref: ProviderRef };
    try {
      src = this.sourceFor(itemId);
    } catch {
      return null;
    }
    const r = await src.provider.fetchDetails(src.ref, this.context(src.provider));
    return r.kind === 'ok' ? { provider: src.provider, item: r.value } : null;
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
    const eps = isEpisodic(row.type)
      ? previewSeasonMerge(db, itemId, incoming.seasons)
      : { added: 0, updated: 0 };
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
      if (isEpisodic(row.type)) {
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
    db.transaction(() => {
      if (incoming.relations?.length) saveRelationSuggestions(db, row.id, p.id, incoming.relations, now);
      if (incoming.streaming) saveStreamingLinks(db, row.id, p.id, incoming.streaming, now);
    });
    this.ctx.log.info('provider.refreshApplied', { providerId: p.id, itemId: row.id });
    return this.library.get(row.id);
  }

  /* ---------------------------------------------------------------- enrichment (library sources) */

  /** First enabled, configured provider for a media type (keyed providers first). */
  enrichmentProvider(type: MediaType): MetadataProvider | null {
    const candidates = PROVIDERS.filter((p) => p.supports.includes(type) && this.enabled(p));
    const configured = candidates.filter((p) => p.isConfigured(this.secrets.keysFor(p.id)));
    return configured.find((p) => p.requiresApiKey) ?? configured[0] ?? null;
  }

  /**
   * Looks the item up by exact (normalized) title and fills only fields that are
   * currently empty. Never overwrites anything; returns false when no
   * unambiguous match exists. Network failures are reported as false + reason.
   */
  async enrichEmptyFields(
    itemId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; reason: string | null }> {
    const db = this.ctx.db();
    const row = items.getItemRow(db, itemId);
    if (!row) return { ok: false, reason: 'Item no longer exists.' };
    const p = this.enrichmentProvider(row.type);
    if (!p) return { ok: false, reason: 'No metadata provider is configured for this type.' };
    const hits = await p.search({ type: row.type, query: row.title, year: null }, this.context(p, signal));
    if (hits.kind !== 'ok') return { ok: false, reason: toUserSafeError(hits, p.displayName).message };
    const key = titleKey(row.title);
    const exact = hits.value.filter((h) => titleKey(h.title) === key);
    if (exact.length !== 1 || !exact[0])
      return { ok: false, reason: exact.length > 1 ? 'Several matches; skipped.' : 'No exact match.' };
    return this.fillEmptyFromRef(itemId, p, exact[0].ref, signal);
  }

  /**
   * §16.6 offline queue / §14.6 review: the user picked this match. Fills only empty fields and links the
   * source; user-entered values are never overwritten (same rule as enrichment).
   */
  async enrichFromRef(
    itemId: string,
    ref: ProviderRef,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; reason: string | null }> {
    const p = getProvider(ref.providerId);
    if (!p || !this.enabled(p)) return { ok: false, reason: 'That source is not available.' };
    return this.fillEmptyFromRef(itemId, p, ref, signal);
  }

  private async fillEmptyFromRef(
    itemId: string,
    p: MetadataProvider,
    ref: ProviderRef,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; reason: string | null }> {
    const db = this.ctx.db();
    const row = items.getItemRow(db, itemId);
    if (!row) return { ok: false, reason: 'Item no longer exists.' };
    const details = await p.fetchDetails(ref, this.context(p, signal));
    if (details.kind !== 'ok') return { ok: false, reason: toUserSafeError(details, p.displayName).message };
    const incoming = details.value;
    const now = this.ctx.clock.now().toISOString();
    db.transaction(() => {
      const current = items.loadMeta(db, row);
      const cmp = compareForRefresh(row.type, current, incoming.meta, items.loadProvenance(db, row.id));
      const choices: Record<string, 'keep' | 'update'> = {};
      for (const r of cmp.rows) {
        const f = r.field as MetadataField;
        choices[r.field] = isEmptyValue(current[f]) ? 'update' : 'keep';
      }
      // External ids are merged, never replaced.
      const merged = mergeRefresh(current, incoming.meta, cmp.rows, choices);
      const ids = [...current.externalIds];
      for (const e of incoming.meta.externalIds) if (!ids.some((x) => x.kind === e.kind)) ids.push(e);
      merged.meta.externalIds = ids;
      items.writeMeta(db, row.id, row.type, merged.meta);
      for (const f of merged.updated)
        items.setProvenance(db, row.id, f, 'provider', p.id, canonicalValue(f, incoming.meta[f]), now);
      items.setSource(db, row.id, p.id, incoming.ref.id, incoming.sourceUrl, now);
      addAudit(
        db,
        row.id,
        'refresh',
        p.id,
        merged.updated.map((f) => ({
          field: f,
          oldValue: null,
          newValue: displayValue(f, incoming.meta[f]),
        })),
        now,
      );
      items.touch(db, row.id, now);
      items.reindexItem(db, row.id);
    });
    return { ok: true, reason: null };
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
    if (item.type !== 'movie' && item.type !== 'tv' && item.type !== 'anime')
      return { ...base, message: 'Where-to-watch applies to movies, TV shows and anime.' };
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
