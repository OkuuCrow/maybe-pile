/** WCAG 2.2 contrast utilities. Colors are validated `#RRGGBB` or `#RRGGBBAA` strings. */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function parseHex(hex: string): Rgba | null {
  if (!HEX_COLOR_RE.test(hex)) return null;
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return { r: n(1), g: n(3), b: n(5), a: hex.length === 9 ? n(7) / 255 : 1 };
}

/** Alpha-composites `fg` over an opaque `bg`. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** Contrast ratio (1–21) of foreground over background; alpha is composited over `bg` first. */
export function contrastRatio(fgHex: string, bgHex: string, baseHex?: string): number | null {
  const bgRaw = parseHex(bgHex);
  const fgRaw = parseHex(fgHex);
  if (!bgRaw || !fgRaw) return null;
  const base = baseHex ? parseHex(baseHex) : { r: 255, g: 255, b: 255, a: 1 };
  if (!base) return null;
  const bg = bgRaw.a < 1 ? composite(bgRaw, { ...base, a: 1 }) : bgRaw;
  const fg = fgRaw.a < 1 ? composite(fgRaw, bg) : fgRaw;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
