/**
 * Manual live smoke check against the keyless providers (TVmaze, Open Library).
 * NOT part of the automated test suite (tests never touch the network).
 * Usage: npm run smoke:providers
 */
import { createFetchClient } from '../src/providers/http';
import { RateLimiter } from '../src/providers/rate-limiter';
import { openLibraryProvider } from '../src/providers/openlibrary';
import { tvmazeProvider } from '../src/providers/tvmaze';
import type { MetadataProvider } from '../src/providers/types';

const http = createFetchClient((url, init) => fetch(url, init));

async function check(p: MetadataProvider, type: 'tv' | 'book', query: string) {
  const ctx = { http, limiter: new RateLimiter(p.rateLimit), keys: {}, region: 'US' };
  const t0 = Date.now();
  const s = await p.search({ type, query, year: null }, ctx);
  if (s.kind !== 'ok') return console.log(`${p.id} search → ${s.kind}`);
  const first = s.value[0];
  console.log(
    `${p.id} search "${query}" → ${s.value.length} hits; first: ${first?.title} (${first?.year}) ref=${first?.ref.id}`,
  );
  if (!first) return;
  const d = await p.fetchDetails(first.ref, ctx);
  if (d.kind !== 'ok') return console.log(`${p.id} details → ${d.kind}`);
  const m = d.value.meta;
  console.log(
    `${p.id} details → title="${m.title}" date=${m.releaseDate} creators=${m.creators.map((c) => c.name).join(', ') || '—'} ` +
      `ids=${m.externalIds.map((e) => `${e.kind}:${e.value}`).join(',')} pages=${m.pageCount ?? '—'} ` +
      `seasons=${d.value.seasons.length} episodes=${d.value.seasons.reduce((n, x) => n + x.episodes.length, 0)} artwork=${d.value.artworkUrl ? 'yes' : 'no'} (${Date.now() - t0} ms)`,
  );
}

await check(tvmazeProvider, 'tv', 'Severance');
await check(openLibraryProvider, 'book', 'Piranesi Susanna Clarke');
