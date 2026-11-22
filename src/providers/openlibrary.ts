/**
 * Open Library — books, no API key. https://openlibrary.org/developers/api
 * Unidentified clients are limited to ~1 request/second; we stay under that.
 * Covers: https://covers.openlibrary.org (cache-allowed; we only fetch on explicit import).
 * Attribution: link back to Open Library.
 */
import { z } from 'zod';
import { requestJson } from './http';
import { cleanText, finalizeMeta, looseArray, looseNumber, looseString, yearFromDate } from './common';
import type { MetadataProvider, SearchHit } from './types';
import { normalizeIsbn } from '../domain/normalize';

const API = 'https://openlibrary.org';
const COVERS = 'https://covers.openlibrary.org';

const SearchSchema = z.object({
  docs: looseArray(
    z.object({
      key: z.string().regex(/^\/works\/OL\d+W$/),
      title: looseString,
      subtitle: looseString,
      author_name: looseArray(z.string()),
      first_publish_year: looseNumber,
      cover_i: looseNumber,
    }),
  ),
});

const WorkSchema = z.object({
  key: z.string(),
  title: looseString,
  subtitle: looseString,
  description: z.union([z.string(), z.object({ value: looseString }), z.null()]).optional(),
  subjects: looseArray(z.string()),
  covers: looseArray(z.number()),
  first_publish_date: looseString,
  authors: looseArray(z.object({ author: z.object({ key: z.string().regex(/^\/authors\/OL\d+A$/) }) })),
});

const AuthorSchema = z.object({ name: looseString });

const EditionsSchema = z.object({
  entries: looseArray(
    z.object({
      number_of_pages: looseNumber,
      isbn_13: looseArray(z.string()),
      isbn_10: looseArray(z.string()),
      publishers: looseArray(z.string()),
      publish_date: looseString,
    }),
  ),
});

export const openLibraryProvider: MetadataProvider = {
  id: 'openlibrary',
  displayName: 'Open Library',
  supports: ['book'],
  attribution: {
    text: 'Book data and covers from Open Library (openlibrary.org).',
    url: 'https://openlibrary.org/',
    required: true,
  },
  requiresApiKey: false,
  keyFields: [],
  signupUrl: null,
  rateLimit: { maxRequests: 1, perMs: 1_100, maxWaitMs: 10_000 },
  cachingPolicy: 'cache-allowed',
  artworkHosts: ['covers.openlibrary.org'],
  isConfigured: () => true,

  async search(q, ctx) {
    const params = new URLSearchParams({
      q: q.query,
      fields: 'key,title,subtitle,author_name,first_publish_year,cover_i',
      limit: '20',
    });
    if (q.year) params.set('first_publish_year', String(q.year));
    const r = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: `${API}/search.json?${params.toString()}`, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      SearchSchema,
    );
    if (r.kind !== 'ok') return r;
    return {
      kind: 'ok',
      value: r.value.docs.map<SearchHit>((d) => ({
        ref: { providerId: 'openlibrary', id: d.key.replace('/works/', ''), type: 'book' },
        title: [d.title, d.subtitle].filter(Boolean).join(': ') || '(untitled)',
        year:
          d.first_publish_year !== null && Number.isInteger(d.first_publish_year)
            ? d.first_publish_year
            : null,
        type: 'book',
        creators: d.author_name.slice(0, 3),
        synopsis: null,
        thumbUrl: d.cover_i && d.cover_i > 0 ? `${COVERS}/b/id/${Math.round(d.cover_i)}-M.jpg` : null,
      })),
    };
  },

  async fetchDetails(ref, ctx) {
    if (!/^OL\d+W$/.test(ref.id)) return { kind: 'notFound' };
    const signal = ctx.signal ? { signal: ctx.signal } : {};
    const w = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: `${API}/works/${ref.id}.json`, ...signal },
      WorkSchema,
    );
    if (w.kind !== 'ok') return w;
    const work = w.value;
    const authors: string[] = [];
    for (const a of work.authors.slice(0, 3)) {
      const ar = await requestJson(
        ctx.http,
        ctx.limiter,
        { url: `${API}${a.author.key}.json`, ...signal },
        AuthorSchema,
      );
      if (ar.kind === 'ok' && ar.value.name) authors.push(ar.value.name);
      else if (ar.kind === 'rateLimited') return ar;
    }
    // Edition data (pages/ISBN/publisher) is best-effort; a failure leaves those fields empty.
    const ed = await requestJson(
      ctx.http,
      ctx.limiter,
      { url: `${API}/works/${ref.id}/editions.json?limit=50`, ...signal },
      EditionsSchema,
    );
    const editions = ed.kind === 'ok' ? ed.value.entries : [];
    const best =
      editions.find((e) => e.isbn_13.length > 0 && e.number_of_pages) ??
      editions.find((e) => e.isbn_13.length > 0) ??
      editions[0];
    const isbn13 = best?.isbn_13.map((i) => normalizeIsbn(i).isbn13).find(Boolean) ?? null;
    const isbn10 = best?.isbn_10.map((i) => normalizeIsbn(i).isbn10).find(Boolean) ?? null;
    const desc = typeof work.description === 'string' ? work.description : (work.description?.value ?? null);
    const meta = finalizeMeta('book', {
      title: [work.title, work.subtitle].filter(Boolean).join(': '),
      description: cleanText(desc, 20_000),
      // Works often lack first_publish_date; fall back to the earliest edition year (year-only).
      releaseDate: work.first_publish_date ?? earliestYear(editions.map((e) => e.publish_date)),
      genres: work.subjects.slice(0, 8),
      creators: authors.map((name) => ({ name, role: 'author' as const })),
      externalIds: [
        { kind: 'openlibrary', value: ref.id },
        ...(isbn13 ? [{ kind: 'isbn13' as const, value: isbn13 }] : []),
        ...(isbn10 ? [{ kind: 'isbn10' as const, value: isbn10 }] : []),
      ],
      publisher: best?.publishers[0]?.slice(0, 200) ?? null,
      pageCount:
        best?.number_of_pages !== null && best?.number_of_pages !== undefined
          ? Math.round(best.number_of_pages)
          : null,
      isbn13,
      isbn10,
    });
    if (!meta) return { kind: 'malformedResponse', detail: 'Missing title.' };
    const cover = work.covers.find((c) => c > 0);
    return {
      kind: 'ok',
      value: {
        ref,
        meta,
        seasons: [],
        artworkUrl: cover ? `${COVERS}/b/id/${Math.round(cover)}-L.jpg` : null,
        sourceUrl: `https://openlibrary.org/works/${ref.id}`,
      },
    };
  },
};

function earliestYear(dates: (string | null)[]): string | null {
  const years = dates.map((d) => yearFromDate(d)).filter((y): y is number => y !== null && y > 1000);
  return years.length > 0 ? String(Math.min(...years)) : null;
}
