/**
 * Steam library import: input validation, non-game heuristics, the
 * "unplayed" rule and re-sync diffs. Pure (no network).
 */

/** Steam Web API keys are 32 hexadecimal characters. */
export const STEAM_KEY_RE = /^[0-9A-F]{32}$/i;
/** 64-bit SteamIDs for individual accounts: 17 digits starting 7656119. */
export const STEAMID64_RE = /^7656119\d{10}$/;
/** Custom profile ("vanity") names: letters, digits, underscore, hyphen. */
export const VANITY_RE = /^[A-Za-z0-9_-]{2,32}$/;

export type SteamAccountInput =
  | { ok: true; kind: 'steamid'; steamId: string }
  | { ok: true; kind: 'vanity'; vanity: string }
  | { ok: false; message: string };

/**
 * Accepts a SteamID64, a vanity name, or a https://steamcommunity.com profile
 * URL (`/profiles/<id>` or `/id/<name>`). Any other host is rejected.
 */
export function parseSteamAccount(raw: string): SteamAccountInput {
  const input = raw.trim();
  if (input === '')
    return { ok: false, message: 'Enter your SteamID64, profile URL or custom profile name.' };
  if (/^\d+$/.test(input)) {
    return STEAMID64_RE.test(input)
      ? { ok: true, kind: 'steamid', steamId: input }
      : { ok: false, message: 'A SteamID64 has 17 digits and starts with 7656119.' };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.includes('/')) {
    let u: URL;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
    } catch {
      return { ok: false, message: 'That profile URL could not be read.' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      return { ok: false, message: 'Profile URLs must start with https://steamcommunity.com/.' };
    if (u.hostname.toLowerCase() !== 'steamcommunity.com')
      return { ok: false, message: 'Only steamcommunity.com profile URLs are accepted.' };
    if (u.username || u.password || u.port) return { ok: false, message: 'That profile URL is not valid.' };
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'profiles' && parts[1] && parts.length <= 2) return parseSteamAccount(parts[1]);
    if (parts[0] === 'id' && parts[1] && parts.length <= 2) {
      return VANITY_RE.test(parts[1])
        ? { ok: true, kind: 'vanity', vanity: parts[1] }
        : { ok: false, message: 'That custom profile name contains characters Steam does not allow.' };
    }
    return {
      ok: false,
      message: 'Use a profile URL like https://steamcommunity.com/id/yourname or /profiles/7656119….',
    };
  }
  return VANITY_RE.test(input)
    ? { ok: true, kind: 'vanity', vanity: input }
    : { ok: false, message: 'Custom profile names use 2–32 letters, digits, underscores or hyphens.' };
}

export function steamKeyError(key: string): string | null {
  if (key === '') return null;
  return STEAM_KEY_RE.test(key) ? null : 'A Steam Web API key is 32 letters and digits (0–9, A–F).';
}

/**
 * GetOwnedGames does not return an app type, so obvious non-games are
 * recognized by name. This is a heuristic: it is shown with its reason and
 * the user can always toggle "Show non-game items".
 */
const NON_GAME_PATTERNS: [RegExp, string][] = [
  [/\bdedicated server\b/i, 'Dedicated server'],
  [/\b(?:test|public test|pts) server\b/i, 'Test server'],
  [/\bsoundtrack\b|\bost\b|original score/i, 'Soundtrack'],
  [/\b(?:sdk|software development kit)\b/i, 'SDK / tool'],
  [/\b(?:mod tools?|level editor|editor|authoring tools?|workshop tool)\b/i, 'Tool'],
  [/\bbenchmark\b/i, 'Benchmark'],
  [/\bdemo\b/i, 'Demo'],
  [/\bplaytest\b/i, 'Playtest'],
  [/\b(?:beta|alpha) (?:branch|client)\b/i, 'Beta client'],
  [/\bartbook\b|\bart book\b|\bdigital art\b/i, 'Artbook'],
  [/\bwallpaper engine\b/i, 'Application'],
  [/\bsource filmmaker\b|\bsteamvr\b|\bspacewar\b/i, 'Tool'],
];

export function nonGameReason(name: string): string | null {
  for (const [re, label] of NON_GAME_PATTERNS) if (re.test(name)) return label;
  return null;
}

/** "Unplayed" = Steam recorded zero minutes. It is *not* proof the game was never played. */
export function isUnplayed(playtimeMinutes: number | null): boolean {
  return (playtimeMinutes ?? 0) === 0;
}

export interface FetchedEntry {
  externalId: string;
  name: string;
  playtimeMinutes: number | null;
  lastPlayedAt: string | null;
  platform: string | null;
}

export interface SnapshotEntry {
  externalId: string;
  name: string;
  playtimeMinutes: number | null;
  removed: boolean;
}

export interface SourceDiff {
  added: FetchedEntry[];
  playtimeChanged: { entry: FetchedEntry; before: number | null }[];
  removed: SnapshotEntry[];
}

/** Compares the previous snapshot with a new fetch. Nothing in the pile changes from this. */
export function diffSnapshot(prev: readonly SnapshotEntry[], next: readonly FetchedEntry[]): SourceDiff {
  const before = new Map(prev.map((p) => [p.externalId, p]));
  const seen = new Set<string>();
  const added: FetchedEntry[] = [];
  const playtimeChanged: SourceDiff['playtimeChanged'] = [];
  for (const n of next) {
    seen.add(n.externalId);
    const p = before.get(n.externalId);
    if (!p || p.removed) added.push(n);
    else if ((p.playtimeMinutes ?? 0) !== (n.playtimeMinutes ?? 0))
      playtimeChanged.push({ entry: n, before: p.playtimeMinutes });
  }
  const removed = prev.filter((p) => !p.removed && !seen.has(p.externalId));
  return { added, playtimeChanged, removed };
}

export function formatPlaytime(minutes: number | null): string {
  if (!minutes) return 'Never played (per Steam)';
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} h`;
}

/** Redacts a SteamID64 for logs: keeps the last 3 digits only. */
export function redactSteamId(id: string): string {
  return id.length > 3 ? `…${id.slice(-3)}` : '…';
}
