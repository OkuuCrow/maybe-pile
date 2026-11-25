/** Artwork Picker sources, in default display order. */
import type { ArtSource } from './art-types';
import { fanartSource } from './fanart';
import { steamGridDbSource } from './steamgriddb';
import { tmdbArtSource } from './tmdb';

export const ART_SOURCES: readonly ArtSource[] = [tmdbArtSource, fanartSource, steamGridDbSource];

export function getArtSource(id: string): ArtSource | undefined {
  return ART_SOURCES.find((s) => s.id === id);
}

/** Hosts art sources may serve images from (checked before any download/proxy). */
export const ART_SOURCE_HOSTS: readonly string[] = ART_SOURCES.flatMap((s) => s.hosts);
