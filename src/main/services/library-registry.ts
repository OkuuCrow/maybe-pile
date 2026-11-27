/**
 * Multiple libraries (§16.11). `libraries.json` in the user-data root lists
 * the libraries and which one is active. A library's folder is *derived* from
 * its id (never read from the file), so a tampered registry cannot point the
 * app or the helper at arbitrary paths.
 *
 * - `default` lives in the user-data root itself (existing installs migrate
 *   "in place": nothing is moved).
 * - Others live in `libraries/<id>/` with their own library.sqlite, artwork
 *   and backups. Logs, API keys and notify-state.sqlite stay global.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const DEFAULT_LIBRARY = 'default';
export const LIBRARY_ID_RE = /^[a-z0-9-]{1,40}$/;
const REGISTRY_FILE = 'libraries.json';

const RegistrySchema = z.strictObject({
  version: z.literal(1),
  active: z.string().regex(LIBRARY_ID_RE),
  libraries: z
    .array(
      z.strictObject({
        id: z.string().regex(LIBRARY_ID_RE),
        name: z.string().min(1).max(60),
        createdAt: z.string().max(40),
      }),
    )
    .min(1)
    .max(50),
});
export type Registry = z.infer<typeof RegistrySchema>;

export interface LibraryEntry {
  id: string;
  name: string;
  dir: string;
  createdAt: string;
}

export function libraryDir(userData: string, id: string): string {
  if (!LIBRARY_ID_RE.test(id)) throw new Error('invalid library id');
  return id === DEFAULT_LIBRARY ? userData : join(userData, 'libraries', id);
}

function defaultRegistry(): Registry {
  return {
    version: 1,
    active: DEFAULT_LIBRARY,
    libraries: [{ id: DEFAULT_LIBRARY, name: 'My library', createdAt: new Date(0).toISOString() }],
  };
}

export function readRegistry(userData: string): Registry {
  const file = join(userData, REGISTRY_FILE);
  if (!existsSync(file)) return defaultRegistry();
  try {
    const parsed = RegistrySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) return defaultRegistry();
    const r = parsed.data;
    if (!r.libraries.some((l) => l.id === DEFAULT_LIBRARY))
      r.libraries.unshift({ id: DEFAULT_LIBRARY, name: 'My library', createdAt: new Date(0).toISOString() });
    if (!r.libraries.some((l) => l.id === r.active)) r.active = DEFAULT_LIBRARY;
    return r;
  } catch {
    return defaultRegistry();
  }
}

export function writeRegistry(userData: string, r: Registry): void {
  const valid = RegistrySchema.parse(r);
  const file = join(userData, REGISTRY_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function listLibraries(userData: string): LibraryEntry[] {
  return readRegistry(userData).libraries.map((l) => ({ ...l, dir: libraryDir(userData, l.id) }));
}

export function activeLibrary(userData: string): LibraryEntry {
  const r = readRegistry(userData);
  const l = r.libraries.find((x) => x.id === r.active) ?? r.libraries[0] ?? defaultRegistry().libraries[0];
  if (!l) throw new Error('no library');
  return { ...l, dir: libraryDir(userData, l.id) };
}

export function createLibraryEntry(userData: string, name: string, now: Date): LibraryEntry {
  const r = readRegistry(userData);
  if (r.libraries.length >= 50) throw new Error('too many libraries');
  const id = randomUUID().slice(0, 8);
  const entry = { id, name: name.trim().slice(0, 60) || 'Library', createdAt: now.toISOString() };
  mkdirSync(libraryDir(userData, id), { recursive: true });
  writeRegistry(userData, { ...r, libraries: [...r.libraries, entry] });
  return { ...entry, dir: libraryDir(userData, id) };
}
