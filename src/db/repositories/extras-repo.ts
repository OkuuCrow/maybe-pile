/**
 * Provider "extras" captured at import/refresh: relation suggestions (franchise
 * feature) and provider-documented streaming links (where-to-watch for anime).
 * Neither is ever applied automatically: suggestions wait for the user, and
 * links are shown only if their host is on the streaming allowlist.
 */
import type { Db } from '../connection';
import { checkExternalUrl, LINK_HOSTS } from '../../domain/links';
import type { ExternalIdKind, MediaType } from '../../shared/enums';
import { newId } from './items-repo';

export interface RelationInputRow {
  relation: string;
  ref: { providerId: string; id: string; type: MediaType };
  title: string;
  year: number | null;
}

/** Which external-id kind a provider's refs correspond to (to match targets already in the library). */
export const PROVIDER_ID_KIND: Record<string, ExternalIdKind> = {
  kitsu: 'kitsu',
  anilist: 'anilist',
  mal: 'mal',
  jikan: 'mal',
  tmdb: 'tmdb',
  tvmaze: 'tvmaze',
  igdb: 'igdb',
  openlibrary: 'openlibrary',
  wikidata: 'wikidata',
};

/** Finds a live library item with the given external id. */
export function findItemByExternalId(db: Db, kind: ExternalIdKind, value: string): string | null {
  const row = db.get<{ item_id: string }>(
    `SELECT e.item_id FROM external_ids e JOIN items i ON i.id = e.item_id
      WHERE e.kind = ? AND e.value = ? AND i.deleted_at IS NULL LIMIT 1`,
    [kind, value],
  );
  return row?.item_id ?? null;
}

/**
 * Upserts pending relation suggestions. Dismissed/accepted suggestions are left
 * alone, so a refresh never resurrects something the user rejected.
 */
export function saveRelationSuggestions(
  db: Db,
  itemId: string,
  providerId: string,
  relations: RelationInputRow[],
  now: string,
): number {
  let n = 0;
  const kind = PROVIDER_ID_KIND[providerId];
  for (const r of relations.slice(0, 40)) {
    const title = r.title.trim().slice(0, 500);
    if (!title || r.ref.id.length > 100) continue;
    // Tmdb anime refs are prefixed ("tv:1"), matching how they're stored.
    const target = kind ? findItemByExternalId(db, kind, r.ref.id) : null;
    if (target === itemId) continue;
    const res = db.run(
      `INSERT INTO relation_suggestions
         (id, item_id, provider_id, target_ref, target_type, target_title, target_year, relation, target_item_id, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (item_id, provider_id, target_ref, relation) DO UPDATE SET
         target_title = excluded.target_title,
         target_year = COALESCE(excluded.target_year, relation_suggestions.target_year),
         target_item_id = COALESCE(relation_suggestions.target_item_id, excluded.target_item_id)`,
      [newId(), itemId, providerId, r.ref.id, r.ref.type, title, r.year, r.relation, target, now],
    );
    n += res.changes;
  }
  return n;
}

export interface StreamingLinkRow {
  service: string;
  url: string;
  subs: string[];
  dubs: string[];
}

/** Replaces a provider's streaming links for an item. Links off the allowlist are dropped. */
export function saveStreamingLinks(
  db: Db,
  itemId: string,
  providerId: string,
  links: StreamingLinkRow[],
  now: string,
): number {
  db.run('DELETE FROM streaming_links WHERE item_id = ? AND provider_id = ?', [itemId, providerId]);
  let n = 0;
  for (const l of links.slice(0, 20)) {
    const check = checkExternalUrl(l.url, LINK_HOSTS.streaming);
    if (!check.ok) continue;
    const lang = (a: string[]) =>
      JSON.stringify(a.filter((x) => /^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/.test(x)).slice(0, 30));
    db.run(
      `INSERT OR IGNORE INTO streaming_links (id, item_id, provider_id, service, url, subs, dubs, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        itemId,
        providerId,
        l.service.trim().slice(0, 60) || 'Streaming',
        check.url,
        lang(l.subs),
        lang(l.dubs),
        now,
      ],
    );
    n++;
  }
  return n;
}

export function loadStreamingLinks(
  db: Db,
  itemId: string,
): { providerId: string; service: string; url: string; subs: string[]; dubs: string[]; fetchedAt: string }[] {
  return db
    .all<{
      provider_id: string;
      service: string;
      url: string;
      subs: string;
      dubs: string;
      fetched_at: string;
    }>(
      'SELECT provider_id, service, url, subs, dubs, fetched_at FROM streaming_links WHERE item_id = ? ORDER BY service',
      [itemId],
    )
    .filter((r) => checkExternalUrl(r.url, LINK_HOSTS.streaming).ok)
    .map((r) => ({
      providerId: r.provider_id,
      service: r.service,
      url: r.url,
      subs: safeJsonArray(r.subs),
      dubs: safeJsonArray(r.dubs),
      fetchedAt: r.fetched_at,
    }));
}

function safeJsonArray(s: string): string[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
