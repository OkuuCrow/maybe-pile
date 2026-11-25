/** Expansion Pack 2 pure domain logic and safety helpers. */
import { describe, expect, it } from 'vitest';
import {
  applyTitlePreference,
  buildAnimeSeasons,
  groupByCrossIds,
  matchesAudio,
  normalizeAiringStatus,
  normalizeAnimeFormat,
  normalizeAnimeSeason,
  normalizeSource,
  preferredTitle,
  seasonOfDate,
} from '../../src/domain/anime';
import { estimatePileTime, sumPileTime, type PileTimeInput } from '../../src/domain/pile-time';
import { currencyExponent, formatMoney, parseAmount, summarizeValue } from '../../src/domain/value';
import { elapsedSeconds, formatDuration, needsReview } from '../../src/domain/sessions';
import { hideEpisode, shieldActive } from '../../src/domain/spoilers';
import { nextInSeries } from '../../src/domain/franchise';
import { recommend, type RecItem } from '../../src/domain/recommendations';
import { decodeXmlText, malSeasons, MalXmlError, parseMalXml } from '../../src/domain/mal-xml';
import { emptyMeta } from '../../src/domain/metadata';
import { hostMatches, nextRedirect, createFetchClient, HttpFailure } from '../../src/providers/http';
import { assertSafeDimensions, imageDimensions, sniffImage } from '../../src/main/services/artwork-service';
import { rankCandidates } from '../../src/main/services/artwork-picker-service';
import { PNG_1PX } from '../helpers/http';

describe('anime normalization', () => {
  it('normalizes formats, statuses, seasons and sources', () => {
    expect(normalizeAnimeFormat('TV_SHORT')).toBe('tv_short');
    expect(normalizeAnimeFormat('Movie')).toBe('movie');
    expect(normalizeAnimeFormat('weird')).toBeNull();
    expect(normalizeAiringStatus('Currently Airing')).toBe('releasing');
    expect(normalizeAiringStatus('tba')).toBe('not_yet_released');
    expect(normalizeAnimeSeason('Autumn')).toBe('fall');
    expect(seasonOfDate('2023-09-29')).toEqual({ season: 'fall', year: 2023 });
    expect(seasonOfDate('2023-09-10')).toEqual({ season: 'summer', year: 2023 });
    expect(seasonOfDate('2023-12-28')).toEqual({ season: 'winter', year: 2024 });
    expect(seasonOfDate('2023-07')).toEqual({ season: 'summer', year: 2023 });
    expect(seasonOfDate('2023')).toBeNull();
    expect(normalizeSource('LIGHT_NOVEL')).toBe('Light novel');
    expect(normalizeSource('other')).toBeNull();
  });

  it('builds episode lists for the edge cases', () => {
    // unknown total, no rows → empty, unknown
    expect(buildAnimeSeasons({ total: null, runtime: 24 })[0]).toMatchObject({
      episodeCountKnown: null,
      episodes: [],
    });
    // ongoing: only aired listed, total unknown
    expect(buildAnimeSeasons({ total: null, aired: 5, runtime: 24 })[0]?.episodes).toHaveLength(5);
    // movie
    expect(buildAnimeSeasons({ total: 1, runtime: 120 })[0]?.episodes).toEqual([
      { number: 1, title: null, airDate: null, runtime: 120 },
    ]);
    // absurd total
    expect(buildAnimeSeasons({ total: 99999, runtime: 24 })[0]).toMatchObject({
      episodeCountKnown: null,
      episodes: [],
    });
    // rows: duplicates/out-of-range dropped, gaps filled
    const s = buildAnimeSeasons({
      total: 3,
      runtime: 24,
      episodes: [
        { number: 1, title: 'A', airDate: null, runtime: null },
        { number: 1, title: 'dup', airDate: null, runtime: null },
        { number: 9, title: 'out', airDate: null, runtime: null },
        { number: 3, title: 'C', airDate: null, runtime: 30 },
      ],
    })[0]!;
    expect(s.episodes.map((e) => e.title)).toEqual(['A', null, 'C']);
    expect(s.episodes[2]?.runtime).toBe(30);
  });

  it('applies the title-language preference without losing titles', () => {
    const meta = {
      ...emptyMeta('Frieren: Beyond Journey’s End'),
      titleRomaji: 'Sousou no Frieren',
      titleEnglish: 'Frieren: Beyond Journey’s End',
      titleNative: '葬送のフリーレン',
    };
    expect(preferredTitle(meta, 'native', 'x')).toBe('葬送のフリーレン');
    const r = applyTitlePreference(meta, 'romaji');
    expect(r.title).toBe('Sousou no Frieren');
    expect(r.altTitles).toContain('Frieren: Beyond Journey’s End');
    expect(applyTitlePreference(r, 'romaji')).toBe(r);
    expect(
      preferredTitle({ titleRomaji: null, titleEnglish: null, titleNative: null }, 'english', 'fallback'),
    ).toBe('fallback');
  });

  it('groups hits by any shared cross id (transitively)', () => {
    const g = groupByCrossIds([
      { providerId: 'kitsu', ids: { kitsu: '1', mal: '10' } },
      { providerId: 'anilist', ids: { anilist: '5', mal: '10' } },
      { providerId: 'jikan', ids: { mal: '99' } },
      { providerId: 'x', ids: { anilist: '5' } },
    ]);
    expect(g.map((x) => x.map((h) => h.providerId))).toEqual([['kitsu', 'anilist', 'x'], ['jikan']]);
  });

  it('matches audio preferences', () => {
    expect(matchesAudio({ subs: ['en'], dubs: [] }, 'dub')).toBe(false);
    expect(matchesAudio({ subs: [], dubs: ['en'] }, 'dub')).toBe(true);
    expect(matchesAudio({ subs: [], dubs: [] }, 'both')).toBe(true);
  });
});

const base: PileTimeInput = {
  type: 'movie',
  status: 'planned',
  runtimeMinutes: null,
  episodeRuntime: null,
  episodesTotal: 0,
  episodesWatched: 0,
  pageCount: null,
  pagesRead: null,
  audioMinutes: null,
  bookFormat: null,
  hoursPlayed: null,
  progressPct: null,
  manualMinutes: null,
  providerMinutes: null,
};

describe('Pile Time', () => {
  it('prefers manual > provider > derived, with confidence and explanation', () => {
    expect(estimatePileTime({ ...base, runtimeMinutes: 148 })).toMatchObject({
      remainingMinutes: 148,
      source: 'runtime',
      confidence: 'high',
    });
    expect(estimatePileTime({ ...base, runtimeMinutes: 148, manualMinutes: 200 })).toMatchObject({
      source: 'manual',
      totalMinutes: 200,
    });
    const game = estimatePileTime({ ...base, type: 'game', providerMinutes: 600, hoursPlayed: 4 });
    expect(game).toMatchObject({ source: 'provider', remainingMinutes: 360, confidence: 'medium' });
    expect(estimatePileTime({ ...base, type: 'game' })).toMatchObject({
      source: 'none',
      remainingMinutes: null,
    });
  });

  it('handles episodes (assumed runtime), pages and completed items', () => {
    const a = estimatePileTime({ ...base, type: 'anime', episodesTotal: 12, episodesWatched: 2 });
    expect(a).toMatchObject({ remainingMinutes: 240, confidence: 'low' });
    expect(a.explanation).toContain('assumed');
    const b = estimatePileTime({ ...base, type: 'book', pageCount: 300, pagesRead: 100 });
    expect(b).toMatchObject({ remainingMinutes: 300, source: 'pages', confidence: 'low' });
    expect(estimatePileTime({ ...base, status: 'completed', runtimeMinutes: 90 }).remainingMinutes).toBe(0);
  });

  it('sums totals and counts items without estimates', () => {
    const t = sumPileTime([
      { type: 'movie', est: estimatePileTime({ ...base, runtimeMinutes: 100 }) },
      { type: 'game', est: estimatePileTime({ ...base, type: 'game' }) },
    ]);
    expect(t).toMatchObject({ remainingMinutes: 100, itemsWithEstimate: 1, itemsWithout: 1 });
    expect(t.byType.game.missing).toBe(1);
  });
});

describe('Pile Value', () => {
  it('parses and formats minor units without conversion', () => {
    expect(parseAmount('19.99', 'USD')).toBe(1999);
    expect(parseAmount('1,299.5', 'USD')).toBe(129950);
    expect(parseAmount('1200', 'JPY')).toBe(1200);
    expect(parseAmount('12.5', 'JPY')).toBeNull();
    expect(parseAmount('-3', 'USD')).toBeNull();
    expect(parseAmount('1.2345', 'KWD')).toBeNull();
    expect(currencyExponent('KWD')).toBe(3);
    expect(formatMoney(1999, 'USD', 'en-US')).toBe('$19.99');
  });

  it('summarizes per currency', () => {
    const s = summarizeValue([
      { itemId: 'a', status: 'planned', amountMinor: 1000, currency: 'USD', hours: null },
      { itemId: 'b', status: 'completed', amountMinor: 2000, currency: 'USD', hours: 10 },
      { itemId: 'c', status: 'in_progress', amountMinor: 500, currency: 'EUR', hours: null },
    ]);
    expect(s[0]).toMatchObject({
      currency: 'USD',
      spentMinor: 3000,
      unfinishedMinor: 1000,
      untouchedMinor: 1000,
      items: 2,
      costPerHourMinor: 200,
    });
    expect(s[1]).toMatchObject({ currency: 'EUR', unfinishedMinor: 500 });
  });
});

describe('sessions, spoilers, franchises', () => {
  it('computes elapsed time from DB state (restart-safe) and clamps skew', () => {
    const now = Date.parse('2025-03-10T12:00:00Z');
    expect(
      elapsedSeconds(
        { state: 'running', accumulatedSeconds: 60, segmentStartedAt: '2025-03-10T11:59:00Z' },
        now,
      ),
    ).toBe(120);
    expect(
      elapsedSeconds(
        { state: 'running', accumulatedSeconds: 0, segmentStartedAt: '2025-03-10T13:00:00Z' },
        now,
      ),
    ).toBe(0);
    expect(elapsedSeconds({ state: 'paused', accumulatedSeconds: 90, segmentStartedAt: null }, now)).toBe(90);
    expect(needsReview(13 * 3600, 12)).toBe(true);
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('shield rules', () => {
    expect(shieldActive({ mode: 'default', shieldByDefault: true, status: 'in_progress' })).toBe(true);
    expect(shieldActive({ mode: 'default', shieldByDefault: true, status: 'completed' })).toBe(false);
    expect(shieldActive({ mode: 'show', shieldByDefault: true, status: 'planned' })).toBe(false);
    expect(hideEpisode(true, 5, false, 3)).toBe(true);
    expect(hideEpisode(true, 3, false, 3)).toBe(false);
    expect(hideEpisode(true, 5, true, 3)).toBe(false);
  });

  it('next in series respects order, in-progress entries and side stories', () => {
    const e = (itemId: string, position: number, status: string, mainline = true) => ({
      itemId,
      position,
      status,
      mainline,
    });
    expect(nextInSeries([e('a', 10, 'completed'), e('b', 20, 'planned'), e('c', 30, 'planned')], true)).toBe(
      'b',
    );
    expect(nextInSeries([e('a', 10, 'planned'), e('b', 20, 'completed'), e('c', 30, 'planned')], true)).toBe(
      'c',
    );
    expect(nextInSeries([e('a', 10, 'planned'), e('b', 20, 'completed'), e('c', 30, 'planned')], false)).toBe(
      'a',
    );
    expect(
      nextInSeries([e('a', 10, 'completed'), e('x', 15, 'planned', false), e('b', 20, 'in_progress')], true),
    ).toBe('b');
    expect(nextInSeries([e('a', 10, 'completed')], true)).toBeNull();
  });
});

describe('recommendations', () => {
  const r = (o: Partial<RecItem> & { id: string }): RecItem => ({
    title: o.id,
    type: 'anime',
    status: 'planned',
    rating: null,
    genres: [],
    creators: [],
    moods: [],
    franchiseIds: [],
    isNextInSeries: false,
    remainingMinutes: null,
    dateAdded: '2025-01-01',
    ...o,
  });
  it('explains every suggestion and needs a taste signal', () => {
    const out = recommend(
      [
        r({ id: 'liked', status: 'completed', rating: 9, creators: ['Madhouse'], genres: ['Fantasy'] }),
        r({ id: 'same-studio', creators: ['Madhouse'] }),
        r({ id: 'short-only', remainingMinutes: 30 }),
        r({ id: 'genre', genres: ['fantasy'] }),
        r({ id: 'hidden', creators: ['Madhouse'] }),
      ],
      { excluded: new Set(['hidden']), limit: 10, today: '2025-03-10' },
    );
    expect(out.map((x) => x.itemId)).toEqual(['same-studio', 'genre']);
    expect(out[0]?.reasons[0]?.text).toContain('Madhouse');
  });
});

describe('MAL XML', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8" ?>
<myanimelist>
  <myinfo><user_name>x</user_name></myinfo>
  <anime>
    <series_animedb_id>1</series_animedb_id>
    <series_title><![CDATA[Cowboy Bebop & Co]]></series_title>
    <series_type>TV</series_type>
    <series_episodes>26</series_episodes>
    <my_watched_episodes>30</my_watched_episodes>
    <my_start_date>1998-04-03</my_start_date>
    <my_finish_date>0000-00-00</my_finish_date>
    <my_score>9</my_score>
    <my_status>Watching</my_status>
    <my_times_watched>1</my_times_watched>
    <my_tags><![CDATA[classic, space]]></my_tags>
    <my_comments>Great &amp; &#x1F680;</my_comments>
  </anime>
  <anime><series_animedb_id>2</series_animedb_id><series_title>Planned &lt;One&gt;</series_title><series_episodes>0</series_episodes><my_watched_episodes>3</my_watched_episodes><my_status>6</my_status><my_score>0</my_score></anime>
  <anime><series_title>no id</series_title></anime>
  <manga><manga_mangadb_id>3</manga_mangadb_id></manga>
</myanimelist>`;

  it('parses rows, entities, CDATA, clamps watched, reports bad rows and manga', () => {
    const r = parseMalXml(XML);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      title: 'Cowboy Bebop & Co',
      status: 'in_progress',
      rating: 9,
      watchedEpisodes: 26,
      dateStarted: '1998-04-03',
      dateCompleted: null,
      timesWatched: 1,
      tags: ['classic', 'space'],
      notes: 'Great & 🚀',
    });
    expect(r.rows[1]).toMatchObject({
      title: 'Planned <One>',
      status: 'planned',
      rating: null,
      totalEpisodes: null,
    });
    expect(r.messages.some((m) => m.row === 3)).toBe(true);
    expect(r.mangaSkipped).toBe(1);
    expect(malSeasons(r.rows[1]!)[0]?.episodes).toHaveLength(3);
  });

  it('rejects DOCTYPE/ENTITY (XXE) and non-MAL files', () => {
    expect(() =>
      parseMalXml('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><myanimelist></myanimelist>'),
    ).toThrow(MalXmlError);
    expect(() => parseMalXml('<html></html>')).toThrow(MalXmlError);
    expect(decodeXmlText('&#0;&#xD800;ok')).toBe('ok');
  });
});

describe('image safety', () => {
  it('reads dimensions from headers before decoding', () => {
    expect(imageDimensions(PNG_1PX, 'png')).toEqual({ width: 1, height: 1 });
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00, 0, 0]);
    expect(imageDimensions(gif, 'gif')).toEqual({ width: 16, height: 32 });
    // JPEG: SOI, APP0 (len 16), SOF0 with 300x200
    const jpeg = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      ...new Array(14).fill(0),
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x00,
      0xc8,
      0x01,
      0x2c,
      0x03,
      0,
      0,
      0,
      0,
    ]);
    expect(imageDimensions(jpeg, 'jpeg')).toEqual({ width: 300, height: 200 });
  });

  it('rejects pixel bombs and SVG', () => {
    const bomb = Uint8Array.from(PNG_1PX);
    new DataView(bomb.buffer).setUint32(16, 50_000);
    new DataView(bomb.buffer).setUint32(20, 50_000);
    expect(() => assertSafeDimensions(bomb, 'png')).toThrow(/too many pixels/);
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });
});

describe('redirect policy', () => {
  it('only allows https hops to the same host or declared hosts', () => {
    expect(hostMatches('ia902809.us.archive.org', ['*.us.archive.org'])).toBe(true);
    expect(hostMatches('us.archive.org', ['*.us.archive.org'])).toBe(false);
    expect(hostMatches('evilarchive.org', ['archive.org'])).toBe(false);
    const from = 'https://covers.openlibrary.org/b/id/1-L.jpg';
    expect(nextRedirect(from, 'https://archive.org/download/x.jpg', ['archive.org'])).toBe(
      'https://archive.org/download/x.jpg',
    );
    expect(nextRedirect(from, '/b/id/2-L.jpg', [])).toBe('https://covers.openlibrary.org/b/id/2-L.jpg');
    expect(nextRedirect(from, 'https://evil.example.com/x', ['archive.org'])).toBeNull();
    expect(nextRedirect(from, 'http://archive.org/x', ['archive.org'])).toBeNull();
    expect(nextRedirect(from, 'https://user:pw@archive.org/x', ['archive.org'])).toBeNull();
    expect(nextRedirect(from, null, ['archive.org'])).toBeNull();
  });

  it('the fetch client follows allowed hops manually and blocks the rest', async () => {
    const hops: string[] = [];
    const fake = async (url: string, init: { redirect: string }) => {
      hops.push(`${init.redirect} ${url}`);
      if (url.includes('start'))
        return new Response(null, { status: 302, headers: { location: 'https://archive.org/next' } });
      if (url.includes('next'))
        return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } });
      return new Response('x');
    };
    const client = createFetchClient(fake as never);
    await expect(
      client.request({
        url: 'https://covers.openlibrary.org/start',
        timeoutMs: 1000,
        maxBytes: 100,
        redirectHosts: ['archive.org'],
      }),
    ).rejects.toBeInstanceOf(HttpFailure);
    expect(hops).toEqual(['manual https://covers.openlibrary.org/start', 'manual https://archive.org/next']);
  });
});

describe('artwork ranking', () => {
  it('orders by source priority, then English/textless, then score', () => {
    const c = (sourceId: string, language: string | null, score: number) => ({
      sourceId,
      slot: 'cover' as const,
      url: `https://x/${sourceId}${language}${score}`,
      thumbUrl: '',
      width: null,
      height: null,
      language,
      attribution: null,
      licenseNote: null,
      assetId: null,
      adult: false,
      score,
    });
    const ranked = rankCandidates(
      [c('fanart', 'de', 99), c('tmdb', 'ja', 9), c('tmdb', 'en', 1), c('fanart', null, 5)],
      ['tmdb', 'fanart'],
    );
    expect(ranked.map((x) => `${x.sourceId}:${x.language}`)).toEqual([
      'tmdb:en',
      'tmdb:ja',
      'fanart:null',
      'fanart:de',
    ]);
  });
});
