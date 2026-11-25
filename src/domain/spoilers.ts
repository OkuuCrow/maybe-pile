/**
 * Spoiler Shield. Decides what to hide for an item:
 *  - episode titles/descriptions beyond the next unwatched episode,
 *  - the item description (only when the user shields it explicitly),
 *  - notes marked as containing spoilers.
 * Hidden text is replaced by a labelled "Reveal" control in the UI (never by
 * color/blur alone), and revealing is per-view (not persisted).
 */
import type { SpoilerMode } from '../shared/enums';

export interface SpoilerContext {
  mode: SpoilerMode;
  shieldByDefault: boolean;
  status: string;
}

/** Whether the shield is active for this item. Completed items are never shielded unless forced. */
export function shieldActive(c: SpoilerContext): boolean {
  if (c.mode === 'show') return false;
  if (c.mode === 'shield') return true;
  return c.shieldByDefault && c.status !== 'completed';
}

/**
 * Whether an episode's details should be hidden. `nextUnwatched` is the
 * 1-based absolute index of the first unwatched episode; it and everything
 * before it stay visible.
 */
export function hideEpisode(
  active: boolean,
  absoluteIndex: number,
  watched: boolean,
  nextUnwatched: number | null,
): boolean {
  if (!active || watched) return false;
  if (nextUnwatched === null) return false;
  return absoluteIndex > nextUnwatched;
}
