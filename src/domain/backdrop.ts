/**
 * §15.6 Backdrops: palette extraction (Ambient) and the scrim that keeps
 * text readable (WCAG 2.2 AA, 4.5:1) over any image. Pure and deterministic.
 *
 * Scrim guarantee: the scrim (theme background color at opacity α) is solved
 * against the *extreme* colors of the image actually shown — the darkest and
 * brightest sampled pixels of the resized, pre-blurred variant (blurring only
 * averages, so it never creates new extremes) — plus, when the image is not
 * analysed yet, pure black and pure white. Blending is computed exactly as the
 * browser does (sRGB alpha compositing).
 */
import { composite, parseHex, relativeLuminance, type Rgba } from './contrast';
import type { BackdropStyle } from '../shared/schemas';

export const AA_TEXT = 4.5;

export interface Palette {
  /** Up to 3 dominant colors, most common first (#rrggbb). */
  colors: string[];
  /** Darkest / brightest sampled colors (#rrggbb). */
  darkest: string;
  brightest: string;
  /** Mean relative luminance 0–1. */
  luminance: number;
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');
export const toHex = (c: { r: number; g: number; b: number }) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/** Extracts a small palette from RGBA pixels (row-major). Samples at most ~4096 pixels on a fixed grid. */
export function extractPalette(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Palette {
  const total = width * height;
  if (total <= 0 || data.length < total * 4)
    return { colors: ['#808080'], darkest: '#808080', brightest: '#808080', luminance: 0.2 };
  const step = Math.max(1, Math.floor(Math.sqrt(total / 4096)));
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let lumSum = 0;
  let count = 0;
  let dark = { l: 2, c: { r: 0, g: 0, b: 0 } };
  let bright = { l: -1, c: { r: 0, g: 0, b: 0 } };
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const a = (data[i + 3] ?? 0) / 255;
      if (a < 0.5) continue;
      const c = { r: data[i] ?? 0, g: data[i + 1] ?? 0, b: data[i + 2] ?? 0 };
      const l = relativeLuminance({ ...c, a: 1 });
      lumSum += l;
      count++;
      if (l < dark.l) dark = { l, c };
      if (l > bright.l) bright = { l, c };
      const key = ((c.r >> 5) << 6) | ((c.g >> 5) << 3) | (c.b >> 5);
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += c.r;
      bin.g += c.g;
      bin.b += c.b;
      bins.set(key, bin);
    }
  }
  if (count === 0) return { colors: ['#808080'], darkest: '#808080', brightest: '#808080', luminance: 0.2 };
  const top = [...bins.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0] - b[0])
    .slice(0, 3)
    .map(([, b]) => toHex({ r: b.r / b.n, g: b.g / b.n, b: b.b / b.n }));
  return {
    colors: top,
    darkest: toHex(dark.c),
    brightest: toHex(bright.c),
    luminance: Math.round((lumSum / count) * 1000) / 1000,
  };
}

function ratio(a: Rgba, b: Rgba): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Minimal scrim opacity (0–1) so `text` keeps ≥ target contrast over the scrim
 * composited onto each of `under` (image extremes). Returns 1 if even an opaque
 * scrim is insufficient (the theme itself then fails, which theme validation prevents).
 */
export function requiredScrim(
  textHex: string,
  scrimHex: string,
  under: readonly string[],
  target = AA_TEXT,
): number {
  const text = parseHex(textHex);
  const scrim = parseHex(scrimHex);
  if (!text || !scrim) return 1;
  const colors = under.map(parseHex).filter((c): c is Rgba => c !== null);
  const ok = (alpha: number) =>
    colors.every((c) => ratio(text, composite({ ...scrim, a: alpha }, { ...c, a: 1 })) >= target + 0.01);
  if (ok(0)) return 0;
  if (!ok(1)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi * 100) / 100;
}

/**
 * Final scrim for a backdrop: at least what readability requires, raised by
 * the user's intensity preference (lower intensity = more scrim), within the
 * theme's [min, max] bounds — but never below the readability minimum.
 */
export function scrimOpacity(opts: {
  textHex: string;
  scrimHex: string;
  palette: Palette | null;
  intensity: number;
  themeMin: number;
}): number {
  const extremes = opts.palette
    ? [opts.palette.darkest, opts.palette.brightest, ...opts.palette.colors]
    : ['#000000', '#ffffff'];
  const need = requiredScrim(opts.textHex, opts.scrimHex, extremes);
  const preferred = Math.max(opts.themeMin, 1 - Math.max(0, Math.min(100, opts.intensity)) / 100);
  return Math.min(1, Math.max(need, preferred));
}

export interface BackdropDecision {
  style: BackdropStyle;
  /** Why a fallback was used (shown in the UI as text). */
  reason: string | null;
}

/**
 * Resolves the effective backdrop style. Order: reduce-effects/high-contrast →
 * off; per-item override; Spoiler Shield or adult art → Ambient (or off when
 * the cover itself is hidden); missing image → Ambient → off.
 */
export function resolveBackdrop(input: {
  global: BackdropStyle;
  item: 'default' | BackdropStyle;
  reduceEffects: boolean;
  prefersContrast: boolean;
  artHidden: boolean;
  adultBlurred: boolean;
  hasBackgroundImage: boolean;
  hasCover: boolean;
}): BackdropDecision {
  if (input.reduceEffects || input.prefersContrast)
    return { style: 'off', reason: 'Reduced effects / high contrast is on.' };
  let style: BackdropStyle = input.item === 'default' ? input.global : input.item;
  if (style === 'off') return { style, reason: null };
  if (input.artHidden || input.adultBlurred) {
    if (!input.hasCover || input.artHidden)
      return { style: 'off', reason: 'Artwork is hidden for this item.' };
    return { style: 'ambient', reason: 'Artwork is hidden, so a soft color backdrop is used.' };
  }
  if ((style === 'banner' || style === 'blurred') && !input.hasBackgroundImage) style = 'ambient';
  if (style === 'ambient' && !input.hasCover && !input.hasBackgroundImage)
    return { style: 'off', reason: 'No artwork yet.' };
  return { style, reason: null };
}

/** Original built-in gradient backdrops (shipped with the app; no rights concerns). */
export const BUILT_IN_GRADIENTS: Record<string, [string, string]> = {
  dusk: ['#2b2d42', '#8d99ae'],
  forest: ['#1b4332', '#74c69d'],
  ember: ['#6a040f', '#f48c06'],
  tide: ['#03045e', '#48cae4'],
  paper: ['#f8f1e5', '#d6ccc2'],
};
