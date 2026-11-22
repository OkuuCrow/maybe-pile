/**
 * External link policy. Links are data, never code: they are validated when
 * stored and re-validated in the main process at click time before
 * `shell.openExternal` is called.
 *
 * - Only `https:` is allowed (no `http:` exception is needed by any provider).
 * - No embedded credentials, no custom ports, max 2048 characters.
 * - Each link kind has a host allowlist; anything else is rejected.
 * - Store links are built only from exact provider-supplied IDs/URLs, never
 *   from fuzzy title matches.
 */
import type { ExternalId } from '../shared/schemas';
import type { ExternalLinkView } from '../shared/types';

export const MAX_URL_LENGTH = 2048;

export const LINK_HOSTS: Record<ExternalLinkView['kind'], readonly string[]> = {
  imdb: ['www.imdb.com', 'imdb.com', 'm.imdb.com'],
  watch: ['www.themoviedb.org', 'themoviedb.org', 'www.justwatch.com'],
  steam: ['store.steampowered.com'],
  xbox: ['www.xbox.com', 'xbox.com', 'www.microsoft.com', 'apps.microsoft.com'],
  playstation: ['store.playstation.com'],
  tmdb: ['www.themoviedb.org'],
  tvmaze: ['www.tvmaze.com'],
  openlibrary: ['openlibrary.org'],
  igdb: ['www.igdb.com'],
};

/** Every host any link kind may point to (used by the generic external-link opener). */
export const ALL_LINK_HOSTS: ReadonlySet<string> = new Set(Object.values(LINK_HOSTS).flat());

/** Additional hosts allowed for attribution/about/help links. */
export const INFO_HOSTS: readonly string[] = [
  'www.themoviedb.org',
  'www.tvmaze.com',
  'openlibrary.org',
  'www.igdb.com',
  'www.justwatch.com',
  'api-docs.igdb.com',
  'dev.twitch.tv',
  'developer.themoviedb.org',
  'creativecommons.org',
];

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Validates and normalizes an external URL. `allowedHosts` null means "any
 * host" (still https-only); the opener always passes a concrete allowlist.
 */
export function checkExternalUrl(
  raw: string,
  allowedHosts: ReadonlySet<string> | readonly string[] | null,
): UrlCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'Empty link.' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'Link is too long.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s]/.test(raw)) return { ok: false, reason: 'Link contains invalid characters.' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'Link is not a valid URL.' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Only secure https links can be opened.' };
  if (u.username !== '' || u.password !== '')
    return { ok: false, reason: 'Links with embedded credentials are not allowed.' };
  if (u.port !== '') return { ok: false, reason: 'Links with custom ports are not allowed.' };
  const host = u.hostname.toLowerCase();
  if (host === '' || !host.includes('.')) return { ok: false, reason: 'Link has no valid host.' };
  if (allowedHosts) {
    const set = allowedHosts instanceof Set ? allowedHosts : new Set(allowedHosts);
    if (!set.has(host))
      return { ok: false, reason: 'This website is not on the list of allowed link destinations.' };
  }
  // URL() has already normalized host case and percent-encoding.
  return { ok: true, url: u.toString() };
}

export const IMDB_ID_RE = /^tt\d{7,10}$/;
export const STEAM_APP_ID_RE = /^\d{1,10}$/;

export function imdbUrl(id: string): string | null {
  return IMDB_ID_RE.test(id) ? `https://www.imdb.com/title/${id}/` : null;
}

export function steamUrl(appId: string): string | null {
  return STEAM_APP_ID_RE.test(appId) ? `https://store.steampowered.com/app/${appId}/` : null;
}

/** Accepts a stored external-id value that is either a full store URL or (Steam only) an app id. */
function storeLink(kind: 'steam' | 'xbox' | 'playstation', value: string): string | null {
  if (kind === 'steam' && STEAM_APP_ID_RE.test(value)) return steamUrl(value);
  const check = checkExternalUrl(value, LINK_HOSTS[kind]);
  return check.ok ? check.url : null;
}

/** Validates an external id value for its kind; returns an error message or null. */
export function externalIdError(id: ExternalId): string | null {
  switch (id.kind) {
    case 'imdb':
      return IMDB_ID_RE.test(id.value) ? null : 'IMDb IDs look like tt1234567.';
    case 'tmdb':
    case 'tvmaze':
    case 'igdb':
      return /^\d{1,12}$/.test(id.value) ? null : 'This ID must be a number.';
    case 'openlibrary':
      return /^OL\d+[WMA]$/.test(id.value) ? null : 'Open Library IDs look like OL45804W.';
    case 'isbn10':
      return /^\d{9}[\dX]$/.test(id.value) ? null : 'ISBN-10 must be 10 characters.';
    case 'isbn13':
      return /^\d{13}$/.test(id.value) ? null : 'ISBN-13 must be 13 digits.';
    case 'steam':
    case 'xbox':
    case 'playstation':
      return storeLink(id.kind, id.value) ? null : 'Use the official store page URL (or a Steam app ID).';
  }
}

/** Builds displayable links from stored external IDs. Invalid/uncertain values are omitted. */
export function linksFromExternalIds(type: string, ids: readonly ExternalId[]): ExternalLinkView[] {
  const out: ExternalLinkView[] = [];
  const get = (k: ExternalId['kind']) => ids.find((i) => i.kind === k)?.value ?? null;
  const imdb = get('imdb');
  if ((type === 'movie' || type === 'tv') && imdb) {
    const url = imdbUrl(imdb);
    if (url) out.push({ kind: 'imdb', label: 'IMDb', url });
  }
  if (type === 'game') {
    for (const k of ['steam', 'xbox', 'playstation'] as const) {
      const v = get(k);
      const url = v ? storeLink(k, v) : null;
      if (url)
        out.push({
          kind: k,
          label: k === 'steam' ? 'Steam' : k === 'xbox' ? 'Xbox' : 'PlayStation Store',
          url,
        });
    }
  }
  const tmdb = get('tmdb');
  if (tmdb && /^\d+$/.test(tmdb) && (type === 'movie' || type === 'tv')) {
    out.push({
      kind: 'tmdb',
      label: 'TMDB',
      url: `https://www.themoviedb.org/${type === 'tv' ? 'tv' : 'movie'}/${tmdb}`,
    });
  }
  const tvmaze = get('tvmaze');
  if (tvmaze && /^\d+$/.test(tvmaze) && type === 'tv') {
    out.push({ kind: 'tvmaze', label: 'TVmaze', url: `https://www.tvmaze.com/shows/${tvmaze}` });
  }
  const ol = get('openlibrary');
  if (ol && /^OL\d+W$/.test(ol) && type === 'book') {
    out.push({ kind: 'openlibrary', label: 'Open Library', url: `https://openlibrary.org/works/${ol}` });
  }
  return out;
}
