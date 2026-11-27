/**
 * §14.6 Paste a list → review table → confirmed import (an undoable batch).
 * §16.6 Offline add queue: adding never loses input when offline; lookups run
 * later (sequential, rate-limited by the provider's limiter, with backoff)
 * and results wait for review — nothing overwrites user-entered fields.
 *
 * Screenshot OCR is not shipped (decision in docs/product-decisions.md):
 * text-list import only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { appError } from '../../shared/result';
import type { MediaType, Status } from '../../shared/enums';
import { MEDIA_TYPES } from '../../shared/enums';
import { PASTE_MAX_CHARS, PASTE_MAX_LINES, type PasteApplySchema } from '../../shared/pack21-schemas';
import { defaultPersonal, emptyMeta } from '../../domain/metadata';
import { titleKey } from '../../domain/normalize';
import type { SearchHitView } from '../../shared/types';
import type { ServiceContext } from './context';
import type { ImportBatchService } from './import-batch-service';
import type { LibraryService } from './library-service';
import type { ProviderService } from './provider-service';

export interface ParsedLine {
  lineId: number;
  raw: string;
  title: string;
  year: number | null;
  type: MediaType | null;
  duplicateOf: { id: string; title: string } | null;
  repeatOfLine: number | null;
}

export interface MatchCandidate {
  title: string;
  year: number | null;
  type: MediaType;
  creators: string[];
  thumbUrl: string | null;
  providerId: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface MatchedLine extends ParsedLine {
  status: 'matched' | 'no-match' | 'no-source' | 'error' | 'pending';
  candidates: MatchCandidate[];
  error: string | null;
}

const TYPE_HINTS: Record<string, MediaType> = {
  movie: 'movie',
  film: 'movie',
  tv: 'tv',
  show: 'tv',
  series: 'tv',
  anime: 'anime',
  game: 'game',
  videogame: 'game',
  book: 'book',
  novel: 'book',
};

/** Parses "Dune 2021 (movie)", "Dune (2021) [book]", "- Hades", "1. Severance — tv". Pure. */
export function parsePastedList(text: string, defaultType: MediaType | null): ParsedLine[] {
  const lines = text.slice(0, PASTE_MAX_CHARS).split(/\r?\n/);
  const out: ParsedLine[] = [];
  const seen = new Map<string, number>();
  for (const raw0 of lines) {
    if (out.length >= PASTE_MAX_LINES) break;
    // eslint-disable-next-line no-control-regex
    let raw = raw0.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '').trim();
    if (!raw) continue;
    raw = raw.slice(0, 500);
    let s = raw.replace(/^(?:[-*•–·]|\d{1,4}[.)])\s+/, '');
    let type: MediaType | null = null;
    // Trailing type hint: (movie) [game] — tv / - book
    const hint = /\s*(?:[([]\s*([a-z]+)\s*[)\]]|[—–-]\s*([a-z]+))\s*$/i.exec(s);
    if (hint) {
      const t = TYPE_HINTS[(hint[1] ?? hint[2] ?? '').toLowerCase()];
      if (t) {
        type = t;
        s = s.slice(0, hint.index).trim();
      }
    }
    let year: number | null = null;
    const y = /\s*[([]?\b(1[89]\d{2}|2[01]\d{2})\b[)\]]?\s*$/.exec(s);
    if (y && y.index > 0) {
      year = Number(y[1]);
      s = s.slice(0, y.index).trim();
    }
    s = s.replace(/[,;:]+$/, '').trim();
    if (!s) continue;
    const key = `${titleKey(s)}|${year ?? ''}|${type ?? defaultType ?? ''}`;
    out.push({
      lineId: out.length,
      raw,
      title: s.slice(0, 500),
      year,
      type: type ?? defaultType,
      duplicateOf: null,
      repeatOfLine: seen.get(key) ?? null,
    });
    if (!seen.has(key)) seen.set(key, out.length - 1);
  }
  return out;
}

interface PasteSession {
  at: number;
  lines: MatchedLine[];
  refs: Map<string, { providerId: string; id: string; type: MediaType }>;
}

export class Import21Service {
  private readonly sessions = new Map<string, PasteSession>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly library: LibraryService,
    private readonly providers: ProviderService,
    private readonly batches: ImportBatchService,
  ) {}

  private get db() {
    return this.ctx.db();
  }

  /* ---------------------------------------------------------------- paste */

  parse(
    text: string,
    defaultType: MediaType | null,
  ): { token: string; lines: MatchedLine[]; sourceAvailable: Record<MediaType, boolean> } {
    const parsed = parsePastedList(text, defaultType);
    const lines: MatchedLine[] = parsed.map((l) => {
      const dup = l.type
        ? this.db.get<{ id: string; title: string }>(
            'SELECT id, title FROM items WHERE deleted_at IS NULL AND type = ? AND title_key = ? LIMIT 1',
            [l.type, titleKey(l.title)],
          )
        : undefined;
      return { ...l, duplicateOf: dup ?? null, status: 'pending', candidates: [], error: null };
    });
    const token = randomBytes(16).toString('hex');
    this.prune();
    this.sessions.set(token, { at: Date.now(), lines, refs: new Map() });
    const sourceAvailable = Object.fromEntries(
      MEDIA_TYPES.map((t) => [t, !!this.providers.enrichmentProvider(t)]),
    ) as Record<MediaType, boolean>;
    return { token, lines, sourceAvailable };
  }

  private session(token: string): PasteSession {
    const s = this.sessions.get(token);
    if (!s) throw appError('NOT_FOUND', 'This pasted list expired. Paste it again.');
    return s;
  }

  /** Looks up the given lines one at a time (the provider limiter paces requests). */
  async match(token: string, lineIds: readonly number[]): Promise<MatchedLine[]> {
    const s = this.session(token);
    for (const id of lineIds) {
      const line = s.lines[id];
      if (!line || line.repeatOfLine !== null) continue;
      if (!line.type) {
        line.status = 'no-source';
        line.error = 'Choose a type for this line.';
        continue;
      }
      const p = this.providers.enrichmentProvider(line.type);
      if (!p) {
        line.status = 'no-source';
        line.error = 'No online source is set up for this type.';
        continue;
      }
      try {
        const hits = await this.providers.search({
          providerId: p.id,
          type: line.type,
          query: line.title,
          year: line.year,
        });
        line.candidates = hits.slice(0, 5).map((h, i) => {
          s.refs.set(`${id}:${i}`, h.ref);
          return toCandidate(h, line.title, line.year, i);
        });
        line.status = hits.length > 0 ? 'matched' : 'no-match';
        line.error = null;
      } catch (e) {
        line.status = 'error';
        line.error = e instanceof Error ? e.message.slice(0, 160) : 'Lookup failed.';
      }
    }
    return s.lines;
  }

  /** Imports the confirmed decisions in one batch (undo via Import history). */
  async apply(
    input: z.output<typeof PasteApplySchema>,
  ): Promise<{ added: number; skipped: number; failed: number; batchId: string | null }> {
    const s = this.session(input.token);
    let added = 0;
    let skipped = 0;
    let failed = 0;
    const createdIds: string[] = [];
    for (const d of input.decisions) {
      if (d.action === 'skip') {
        skipped++;
        continue;
      }
      try {
        if (d.action === 'match' && d.candidate !== null) {
          const ref = s.refs.get(`${d.lineId}:${d.candidate}`);
          if (!ref) throw new Error('missing match');
          const preview = await this.providers.preview(ref);
          const r = await this.providers.importPreviewed({
            previewToken: preview.token,
            status: input.status,
            tags: [],
            allowDuplicate: false,
          });
          if (r.kind === 'created') {
            createdIds.push(r.item.id);
            added++;
          } else skipped++;
        } else {
          const r = this.library.create({
            type: d.type,
            meta: emptyMeta(d.title),
            personal: { ...defaultPersonal(d.type, this.library.today()), status: input.status },
            seasons: [],
            milestones: [],
            allowDuplicate: false,
          });
          if (r.kind === 'created') {
            createdIds.push(r.item.id);
            added++;
          } else skipped++;
        }
      } catch {
        failed++;
      }
    }
    let batchId: string | null = null;
    if (createdIds.length > 0) {
      this.db.transaction(() => {
        batchId = this.batches.begin('manual-list', `Pasted list (${createdIds.length})`, null);
        for (const id of createdIds) this.batches.record(batchId, id);
      });
    }
    this.sessions.delete(input.token);
    this.ctx.log.info('paste.applied', { added, skipped, failed });
    return { added, skipped, failed, batchId };
  }

  private prune() {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [k, v] of this.sessions) if (v.at < cutoff) this.sessions.delete(k);
  }

  /* ---------------------------------------------------------------- offline add queue */

  /** Creates the item from what the user typed and queues the online lookup. Never loses the input. */
  addOffline(input: { title: string; type: MediaType; year: number | null }): { itemId: string } {
    const meta = { ...emptyMeta(input.title), releaseDate: input.year ? String(input.year) : null };
    const r = this.library.create({
      type: input.type,
      meta,
      personal: defaultPersonal(input.type, this.library.today()),
      seasons: [],
      milestones: [],
      allowDuplicate: true,
    });
    if (r.kind !== 'created') throw appError('INTERNAL', 'The item could not be created.');
    const now = this.ctx.clock.now().toISOString();
    const n =
      this.db.get<{ n: number }>("SELECT count(*) AS n FROM lookup_queue WHERE state IN ('waiting','failed')")
        ?.n ?? 0;
    if (n < 500)
      this.db.run(
        `INSERT INTO lookup_queue (id, item_id, query, media_type, year, state, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'waiting', 0, ?, ?, ?)`,
        [randomUUID(), r.item.id, input.title.slice(0, 200), input.type, input.year, now, now, now],
      );
    return { itemId: r.item.id };
  }

  queue(): {
    id: string;
    itemId: string;
    title: string;
    type: MediaType;
    state: string;
    attempts: number;
    lastError: string | null;
    candidates: MatchCandidate[];
  }[] {
    return this.db
      .all<{
        id: string;
        item_id: string;
        query: string;
        media_type: MediaType;
        state: string;
        attempts: number;
        last_error: string | null;
        candidates: string | null;
      }>(
        "SELECT * FROM lookup_queue WHERE state IN ('waiting','found','no_match','failed') ORDER BY created_at",
      )
      .map((r) => ({
        id: r.id,
        itemId: r.item_id,
        title: r.query,
        type: r.media_type,
        state: r.state,
        attempts: r.attempts,
        lastError: r.last_error,
        candidates: r.candidates
          ? (JSON.parse(r.candidates) as (MatchCandidate & { ref?: unknown })[]).map(
              ({ ref: _ref, ...c }) => c,
            )
          : [],
      }));
  }

  /** Sequential lookups with exponential backoff; returns how many finished (found/no match). */
  async processQueue(opts: { force?: boolean } = {}): Promise<{ finished: number; waiting: number }> {
    const now = this.ctx.clock.now();
    const due = this.db.all<{
      id: string;
      item_id: string;
      query: string;
      media_type: MediaType;
      year: number | null;
      attempts: number;
    }>(
      `SELECT id, item_id, query, media_type, year, attempts FROM lookup_queue
        WHERE state = 'waiting' ${opts.force ? '' : 'AND (next_attempt_at IS NULL OR next_attempt_at <= ?)'} ORDER BY created_at LIMIT 25`,
      opts.force ? [] : [now.toISOString()],
    );
    let finished = 0;
    for (const q of due) {
      const p = this.providers.enrichmentProvider(q.media_type);
      const stamp = this.ctx.clock.now().toISOString();
      if (!p) {
        this.db.run("UPDATE lookup_queue SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [
          'No online source is set up for this type.',
          stamp,
          q.id,
        ]);
        continue;
      }
      try {
        const hits = await this.providers.search({
          providerId: p.id,
          type: q.media_type,
          query: q.query,
          year: q.year,
        });
        const candidates = hits
          .slice(0, 5)
          .map((h, i) => ({ ...toCandidate(h, q.query, q.year, i), ref: h.ref }));
        this.db.run(
          'UPDATE lookup_queue SET state = ?, candidates = ?, last_error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?',
          [hits.length ? 'found' : 'no_match', JSON.stringify(candidates), stamp, q.id],
        );
        finished++;
      } catch (e) {
        const attempts = q.attempts + 1;
        const backoff = Math.min(6 * 3_600_000, 60_000 * 2 ** attempts);
        this.db.run(
          'UPDATE lookup_queue SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
          [
            attempts >= 6 ? 'failed' : 'waiting',
            attempts,
            new Date(now.getTime() + backoff).toISOString(),
            (e instanceof Error ? e.message : 'Lookup failed.').slice(0, 200),
            stamp,
            q.id,
          ],
        );
      }
    }
    if (finished > 0) {
      this.db.run(
        "INSERT INTO app_events (key, at, value) VALUES ('offline_queue_finished', ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, value = excluded.value",
        [this.ctx.clock.now().toISOString(), String(finished)],
      );
    }
    const waiting =
      this.db.get<{ n: number }>("SELECT count(*) AS n FROM lookup_queue WHERE state = 'waiting'")?.n ?? 0;
    return { finished, waiting };
  }

  retry(id: string): void {
    this.db.run(
      "UPDATE lookup_queue SET state = 'waiting', next_attempt_at = NULL, updated_at = ? WHERE id = ?",
      [this.ctx.clock.now().toISOString(), id],
    );
  }

  /** Cancelling only stops the lookup; the item stays. */
  cancel(id: string): void {
    this.db.run("UPDATE lookup_queue SET state = 'cancelled', updated_at = ? WHERE id = ?", [
      this.ctx.clock.now().toISOString(),
      id,
    ]);
  }

  async applyCandidate(id: string, candidate: number): Promise<{ ok: boolean; reason: string | null }> {
    const row = this.db.get<{ item_id: string; candidates: string | null }>(
      'SELECT item_id, candidates FROM lookup_queue WHERE id = ?',
      [id],
    );
    if (!row?.candidates) throw appError('NOT_FOUND', 'That lookup is no longer available.');
    const c = (JSON.parse(row.candidates) as { ref: { providerId: string; id: string; type: MediaType } }[])[
      candidate
    ];
    if (!c) throw appError('VALIDATION', 'Choose one of the suggested matches.');
    const r = await this.providers.enrichFromRef(row.item_id, c.ref);
    if (r.ok) this.db.run('DELETE FROM lookup_queue WHERE id = ?', [id]);
    return r;
  }

  waitingCount(): number {
    return (
      this.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM lookup_queue WHERE state IN ('waiting','found','failed')",
      )?.n ?? 0
    );
  }
}

function toCandidate(h: SearchHitView, title: string, year: number | null, rank: number): MatchCandidate {
  const sameTitle = titleKey(h.title) === titleKey(title);
  const sameYear = year === null || h.year === year;
  const confidence: MatchCandidate['confidence'] =
    sameTitle && sameYear && rank === 0 ? 'high' : sameTitle || (rank === 0 && sameYear) ? 'medium' : 'low';
  return {
    title: h.title,
    year: h.year,
    type: h.type,
    creators: h.creators.slice(0, 3),
    thumbUrl: h.thumbUrl,
    providerId: h.providerId,
    confidence,
  };
}

export type { Status };
