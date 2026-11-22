/**
 * Rating scale: stored as an integer 1–10, displayed as 0.5–5 stars in half-star
 * steps (stored 7 → 3.5 stars). Null means "not rated". There is no zero rating:
 * "unrated" and "worst" must never be confused.
 */

export const RATING_MIN = 1;
export const RATING_MAX = 10;

export function ratingToStars(rating: number | null): number | null {
  return rating === null ? null : rating / 2;
}

export function starsToRating(stars: number | null): number | null {
  if (stars === null) return null;
  const r = Math.round(stars * 2);
  if (r < RATING_MIN || r > RATING_MAX) return null;
  return r;
}

/** Accessible text such as "3.5 out of 5 stars" or "Not rated". */
export function ratingLabel(rating: number | null): string {
  const stars = ratingToStars(rating);
  if (stars === null) return 'Not rated';
  return `${stars % 1 === 0 ? stars.toFixed(0) : stars.toFixed(1)} out of 5 stars`;
}
