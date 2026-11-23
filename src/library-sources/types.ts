/**
 * Library sources: places a user's *owned* games come from (Steam, a pasted
 * list…). Each source fetches a snapshot of entries; the shared review /
 * selection / import UI works on those snapshots regardless of the source.
 *
 * To add a source (e.g. a GOG export file): implement `LibrarySource`, add its
 * kind to the `library_sources.kind` CHECK in a new migration, and register it
 * in `SOURCES` (see docs/providers.md → "Adding a library source").
 * Sources must use documented APIs or files the user provides — never scraping.
 */
import type { UserSafeError } from '../shared/result';
import type { FetchedEntry } from '../domain/steam';

export interface FetchContext {
  signal: AbortSignal;
  /** Reports a human phase ("Resolving profile…") and optional 0–1 progress. */
  onProgress(phase: string, progress: number | null): void;
  /** Injectable sleep (tests run instantly). */
  sleep(ms: number): Promise<void>;
}

export type SourceFetchResult =
  | { kind: 'ok'; entries: FetchedEntry[]; warnings: string[]; resolvedAccount: string | null }
  | { kind: 'private'; resolvedAccount: string | null }
  | { kind: 'error'; error: UserSafeError };

export interface LibrarySource<Config> {
  id: 'steam' | 'manual';
  displayName: string;
  /** Attribution / terms notice shown in the UI. */
  attribution: string;
  rateLimit: { text: string };
  /** Validates raw settings into a config, or returns field errors. */
  configure(
    raw: Record<string, string>,
  ): { ok: true; config: Config } | { ok: false; fieldErrors: Record<string, string> };
  /** One lightweight call that proves the configuration works. */
  testConnection(
    config: Config,
    ctx: FetchContext,
  ): Promise<
    { ok: true; message: string; resolvedAccount: string | null } | { ok: false; error: UserSafeError }
  >;
  fetchEntries(config: Config, ctx: FetchContext): Promise<SourceFetchResult>;
}
