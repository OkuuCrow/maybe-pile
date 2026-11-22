/**
 * Theme format, validation and token mapping.
 *
 * Security: theme files are untrusted. Values are restricted to strict hex
 * colors, bounded numbers and enums. Nothing from a theme is ever concatenated
 * into CSS text; the renderer applies each validated value with
 * `style.setProperty(name, value)` where `name` comes from the fixed TOKEN_VARS
 * table below, never from the file.
 *
 * Unknown keys are *rejected* (not ignored) so typos are surfaced to the user.
 */
import { z } from 'zod';
import { contrastRatio, HEX_COLOR_RE } from './contrast';

export const THEME_FORMAT = 'maybepile-theme';
export const THEME_SCHEMA_VERSION = 1;
export const THEME_MAX_BYTES = 64 * 1024;

export const COLOR_TOKENS = [
  'bg',
  'surface',
  'surfaceAlt',
  'text',
  'textMuted',
  'accent',
  'onAccent',
  'border',
  'focus',
  'planned',
  'inProgress',
  'completed',
  'onHold',
  'dropped',
  'success',
  'warning',
  'danger',
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export const RADIUS_OPTIONS = ['none', 'small', 'medium', 'large'] as const;
export const DENSITY_OPTIONS = ['compact', 'comfortable'] as const;
export const FONT_FAMILY_OPTIONS = ['system', 'humanist', 'serif', 'mono'] as const;
export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.5;

/** Font stacks are a fixed allowlist of locally installed system fonts — no URLs. */
export const FONT_STACKS: Record<(typeof FONT_FAMILY_OPTIONS)[number], string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif',
  humanist: '"Seravek", "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", "URW Palladio L", P052, Georgia, serif',
  mono: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
};

const RADIUS_PX: Record<(typeof RADIUS_OPTIONS)[number], string> = {
  none: '0px',
  small: '4px',
  medium: '8px',
  large: '14px',
};

const hexColor = z.string().regex(HEX_COLOR_RE, 'Colors must be hex values like #1A2B3C or #1A2B3CFF.');

const colorsShape = Object.fromEntries(COLOR_TOKENS.map((k) => [k, hexColor])) as Record<
  ColorToken,
  typeof hexColor
>;

export const ThemeTokensSchema = z.strictObject({
  colorScheme: z.enum(['light', 'dark']),
  colors: z.strictObject(colorsShape),
  radius: z.enum(RADIUS_OPTIONS),
  density: z.enum(DENSITY_OPTIONS),
  fontScale: z.number().min(FONT_SCALE_MIN).max(FONT_SCALE_MAX),
  fontFamily: z.enum(FONT_FAMILY_OPTIONS),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;

export const ThemeFileSchema = z.strictObject({
  format: z.literal(THEME_FORMAT),
  schemaVersion: z.literal(THEME_SCHEMA_VERSION),
  name: z
    .string()
    .trim()
    .min(1, 'Theme name is required.')
    .max(60, 'Theme name must be at most 60 characters.'),
  tokens: ThemeTokensSchema,
});
export type ThemeFile = z.infer<typeof ThemeFileSchema>;

export const PILE_LIGHT: ThemeTokens = {
  colorScheme: 'light',
  colors: {
    bg: '#F6F5F2',
    surface: '#FFFFFF',
    surfaceAlt: '#EEECE7',
    text: '#1C1B19',
    textMuted: '#57534B',
    accent: '#2F4FBF',
    onAccent: '#FFFFFF',
    border: '#8A857B',
    focus: '#1D4ED8',
    planned: '#4F5666',
    inProgress: '#1F5FA6',
    completed: '#276B2B',
    onHold: '#8A5300',
    dropped: '#B42318',
    success: '#1E6B30',
    warning: '#8A5300',
    danger: '#B42318',
  },
  radius: 'medium',
  density: 'comfortable',
  fontScale: 1,
  fontFamily: 'system',
};

export const PILE_DARK: ThemeTokens = {
  colorScheme: 'dark',
  colors: {
    bg: '#141517',
    surface: '#1D1F22',
    surfaceAlt: '#272A2E',
    text: '#ECEAE6',
    textMuted: '#ABA79F',
    accent: '#8FA3FA',
    onAccent: '#0E1220',
    border: '#7A7F87',
    focus: '#A5B4FC',
    planned: '#B0B8C7',
    inProgress: '#7DB9F0',
    completed: '#7BD389',
    onHold: '#F2C063',
    dropped: '#FF8A80',
    success: '#7BD389',
    warning: '#F2C063',
    danger: '#FF8A80',
  },
  radius: 'medium',
  density: 'comfortable',
  fontScale: 1,
  fontFamily: 'system',
};

export const BUILTIN_THEMES = [
  { id: 'pile-light', name: 'Pile Light', tokens: PILE_LIGHT },
  { id: 'pile-dark', name: 'Pile Dark', tokens: PILE_DARK },
] as const;
export const SYSTEM_THEME_ID = 'system';
export const FALLBACK_THEME_ID = 'pile-light';
export const BUILTIN_THEME_IDS: ReadonlySet<string> = new Set(['system', 'pile-light', 'pile-dark']);

/** Fixed mapping from token → CSS custom property. The only source of property names. */
export const TOKEN_VARS: Record<ColorToken, string> = {
  bg: '--mp-bg',
  surface: '--mp-surface',
  surfaceAlt: '--mp-surface-alt',
  text: '--mp-text',
  textMuted: '--mp-text-muted',
  accent: '--mp-accent',
  onAccent: '--mp-on-accent',
  border: '--mp-border',
  focus: '--mp-focus',
  planned: '--mp-status-planned',
  inProgress: '--mp-status-in-progress',
  completed: '--mp-status-completed',
  onHold: '--mp-status-on-hold',
  dropped: '--mp-status-dropped',
  success: '--mp-success',
  warning: '--mp-warning',
  danger: '--mp-danger',
};

/** Converts validated tokens to [property, value] pairs. Inputs must already be validated. */
export function themeToCssVars(t: ThemeTokens): [string, string][] {
  const vars: [string, string][] = COLOR_TOKENS.map((k) => [TOKEN_VARS[k], t.colors[k]]);
  vars.push(['--mp-radius', RADIUS_PX[t.radius]]);
  vars.push(['--mp-space', t.density === 'compact' ? '6px' : '8px']);
  vars.push(['--mp-font-scale', String(t.fontScale)]);
  vars.push(['--mp-font-family', FONT_STACKS[t.fontFamily]]);
  vars.push(['color-scheme', t.colorScheme]);
  return vars;
}

export interface ContrastWarning {
  pair: string;
  ratio: number;
  required: number;
}

/** Pairs checked against WCAG 2.2 AA (4.5:1 text, 3:1 UI components/focus indicators). */
export const CONTRAST_PAIRS: { fg: ColorToken; bg: ColorToken; min: number; label: string }[] = [
  { fg: 'text', bg: 'bg', min: 4.5, label: 'Text on background' },
  { fg: 'text', bg: 'surface', min: 4.5, label: 'Text on surface' },
  { fg: 'text', bg: 'surfaceAlt', min: 4.5, label: 'Text on alternate surface' },
  { fg: 'textMuted', bg: 'bg', min: 4.5, label: 'Muted text on background' },
  { fg: 'textMuted', bg: 'surface', min: 4.5, label: 'Muted text on surface' },
  { fg: 'onAccent', bg: 'accent', min: 4.5, label: 'Button text on accent' },
  { fg: 'accent', bg: 'surface', min: 4.5, label: 'Accent (links) on surface' },
  { fg: 'focus', bg: 'bg', min: 3, label: 'Focus ring on background' },
  { fg: 'focus', bg: 'surface', min: 3, label: 'Focus ring on surface' },
  { fg: 'border', bg: 'surface', min: 3, label: 'Control borders on surface' },
  { fg: 'planned', bg: 'surface', min: 4.5, label: 'Planned status on surface' },
  { fg: 'inProgress', bg: 'surface', min: 4.5, label: 'In Progress status on surface' },
  { fg: 'completed', bg: 'surface', min: 4.5, label: 'Completed status on surface' },
  { fg: 'onHold', bg: 'surface', min: 4.5, label: 'On Hold status on surface' },
  { fg: 'dropped', bg: 'surface', min: 4.5, label: 'Dropped status on surface' },
  { fg: 'success', bg: 'surface', min: 4.5, label: 'Success text on surface' },
  { fg: 'warning', bg: 'surface', min: 4.5, label: 'Warning text on surface' },
  { fg: 'danger', bg: 'surface', min: 4.5, label: 'Error text on surface' },
];

export function contrastWarnings(t: ThemeTokens): ContrastWarning[] {
  const out: ContrastWarning[] = [];
  for (const p of CONTRAST_PAIRS) {
    const ratio = contrastRatio(t.colors[p.fg], t.colors[p.bg], t.colors.bg);
    if (ratio !== null && ratio < p.min) out.push({ pair: p.label, ratio, required: p.min });
  }
  return out;
}

export interface FormatIssue {
  path: string;
  message: string;
}

/** Converts Zod issues into "$.tokens.colors.bg: message" style messages. */
export function formatZodIssues(error: z.ZodError): FormatIssue[] {
  return error.issues.slice(0, 50).map((i) => {
    const path = ['$', ...i.path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p)))]
      .join('.')
      .replace(/\.\[/g, '[');
    let message = i.message;
    if (i.code === 'unrecognized_keys') message = `Unknown key(s): ${i.keys.join(', ')}. Remove them.`;
    if (i.code === 'invalid_value' && 'values' in i) {
      message = `Invalid value. Allowed: ${i.values.map((v) => JSON.stringify(v)).join(', ')}.`;
    }
    return { path, message };
  });
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; issues: FormatIssue[] };

/** Parses untrusted JSON text into a validated theme file. Never evaluates anything. */
export function parseThemeFile(textContent: string): ParseOutcome<ThemeFile> {
  if (new TextEncoder().encode(textContent).byteLength > THEME_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ path: '$', message: `File is larger than ${THEME_MAX_BYTES / 1024} KB.` }],
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(textContent);
  } catch {
    return { ok: false, issues: [{ path: '$', message: 'File is not valid JSON.' }] };
  }
  if (typeof json === 'object' && json !== null && 'schemaVersion' in json) {
    const v = (json as { schemaVersion: unknown }).schemaVersion;
    if (typeof v === 'number' && v > THEME_SCHEMA_VERSION) {
      return {
        ok: false,
        issues: [
          {
            path: '$.schemaVersion',
            message: `This theme uses format version ${v}, but this app supports up to ${THEME_SCHEMA_VERSION}. Update Maybe Pile to import it.`,
          },
        ],
      };
    }
  }
  const r = ThemeFileSchema.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: formatZodIssues(r.error) };
}
