/** Artwork Picker sources, in default display order. */
import type { ArtSource } from './art-types';
import { fanartSource } from './fanart';
import { steamGridDbSource } from './steamgriddb';
import { tmdbArtSource } from './tmdb';
import { tvmazeArtSource } from './tvmaze-art';
import { commonsArtSource } from './commons-art';

/**
 * Key-free sources first (2.1 §15). Evaluated and excluded (docs/providers.md): Apple iTunes Search API
 * (artwork only as store promotion next to a store badge), Internet Archive (terms page unreadable,
 * thumbnail API undocumented), unofficial IMDb-keyed community image services (unclear rights).
 */
export const ART_SOURCES: readonly ArtSource[] = [
  tvmazeArtSource,
  commonsArtSource,
  tmdbArtSource,
  fanartSource,
  steamGridDbSource,
];

/** Sources that need no key (shown first; "Add a free key to unlock more images" lists the rest). */
export const KEY_FREE_ART_SOURCES = ART_SOURCES.filter((s) => !s.requiresApiKey).map((s) => s.id);

export function getArtSource(id: string): ArtSource | undefined {
  return ART_SOURCES.find((s) => s.id === id);
}

/** Hosts art sources may serve images from (checked before any download/proxy). */
export const ART_SOURCE_HOSTS: readonly string[] = ART_SOURCES.flatMap((s) => s.hosts);
