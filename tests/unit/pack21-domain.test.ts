import { describe, expect, it } from 'vitest';
import { buildSharePage, escapeHtml, safeDataUri, SHARE_CSP } from '../../src/domain/share-page';
import { extractPalette, requiredScrim, resolveBackdrop, scrimOpacity } from '../../src/domain/backdrop';
import { composite, parseHex, relativeLuminance } from '../../src/domain/contrast';
import { FEATURES, isShown, labelFor, searchFeatures } from '../../src/shared/feature-registry';
import { commonsArtSource, commonsLicenseOk } from '../../src/providers/commons-art';
import { tvmazeArtSource } from '../../src/providers/tvmaze-art';
import { ART_SOURCES, KEY_FREE_ART_SOURCES } from '../../src/providers/art-registry';
import { ARTWORK_HOSTS, OUTBOUND_HOSTS } from '../../src/providers/registry';
import { FakeHttp, instantLimiter, json } from '../helpers/http';
import { MemoryLogger } from '../../src/main/services/logger';

describe('§14.8 share page', () => {
  const hostile = '<script>alert(1)</script>"\'><img src=x onerror=alert(1)>';
  const page = buildSharePage({
    title: hostile,
    generatedOn: '2026-11-26',
    rows: [
      {
        title: hostile,
        type: 'Movie',
        status: 'Completed',
        rating: 8,
        year: 2016,
        cover: 'data:image/png;base64,iVBORw0KGgo=',
      },
      {
        title: 'Remote',
        type: 'Book',
        status: 'Planned',
        rating: null,
        year: null,
        cover: 'https://evil.example/x.png',
      },
      {
        title: 'SVG',
        type: 'Book',
        status: 'Planned',
        rating: null,
        year: null,
        cover: 'data:image/svg+xml;base64,PHN2Zz4=',
      },
    ],
    fields: ['type', 'status', 'rating', 'year', 'cover'],
  });
  it('escapes every text, has no script/handlers, and a locked-down CSP', () => {
    expect(page).not.toMatch(/<script/i);
    // No event-handler attribute inside any tag (escaped text like "onerror=" is harmless).
    const attrNames = [...page.matchAll(/<[a-z][a-z0-9]*\b([^>]*)>/gi)].flatMap((m) =>
      [...(m[1] ?? '').replace(/"[^"]*"/g, '""').matchAll(/([a-z-]+)=/gi)].map((a) =>
        (a[1] ?? '').toLowerCase(),
      ),
    );
    expect(attrNames.filter((a) => a.startsWith('on'))).toEqual([]);
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&gt;&lt;img');
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">`);
    expect(SHARE_CSP).toBe(
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
  });
  it('references nothing external: only data: images survive; SVG and remote URLs are dropped', () => {
    expect(page).not.toMatch(/(src|href)="(https?:|\/\/)/i);
    expect(page).not.toContain('evil.example');
    expect(page).not.toContain('svg+xml');
    expect((page.match(/<img /g) ?? []).length).toBe(1);
    expect(safeDataUri(`data:image/png;base64,${'A'.repeat(200_000)}`)).toBeNull();
  });
  it('has table semantics and a caption; snapshot', () => {
    expect(page).toContain('<caption>');
    expect(page).toContain('<th scope="col">Title</th>');
    expect(page).toContain('<th scope="row">');
    expect(
      buildSharePage({
        title: 'My pile',
        generatedOn: '2026-11-26',
        rows: [{ title: 'Dune', type: 'Book', status: 'Planned', rating: 9, year: 1965, cover: null }],
        fields: ['type', 'rating'],
      }),
    ).toMatchSnapshot();
    expect(escapeHtml('a\u0001b')).toBe('ab');
  });
});

describe('§15 backdrop scrim + palette', () => {
  const rgba = (w: number, h: number, f: (x: number, y: number) => [number, number, number]) => {
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [r, g, b] = f(x, y);
        d.set([r, g, b, 255], (y * w + x) * 4);
      }
    return d;
  };
  const ratio = (fg: string, under: string, scrim: string, a: number) => {
    const t = parseHex(fg)!;
    const c = composite({ ...parseHex(scrim)!, a }, { ...parseHex(under)!, a: 1 });
    const l1 = relativeLuminance(t);
    const l2 = relativeLuminance(c);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  it('palette extraction is deterministic and finds extremes', () => {
    const busy = rgba(64, 64, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [10, 20, 200]));
    const a = extractPalette(busy, 64, 64);
    expect(a).toEqual(extractPalette(busy, 64, 64));
    expect(a.brightest).toBe('#ffffff');
    expect(a.colors).toHaveLength(2);
  });
  it.each([
    ['light theme over a pure white image', '#1d1b18', '#f6f5f2', ['#ffffff']],
    ['light theme over a black image', '#1d1b18', '#f6f5f2', ['#000000']],
    ['dark theme over a bright busy image', '#f1eee8', '#161513', ['#ffffff', '#ffd400', '#00aaff']],
    ['dark theme over mid grey', '#f1eee8', '#161513', ['#777777']],
  ])('%s keeps text ≥ 4.5:1 with the computed scrim', (_n, text, scrim, under) => {
    const a = requiredScrim(text, scrim, under);
    for (const u of under) expect(ratio(text, u, scrim, a)).toBeGreaterThanOrEqual(4.5);
    const unknown = scrimOpacity({
      textHex: text,
      scrimHex: scrim,
      palette: null,
      intensity: 100,
      themeMin: 0,
    });
    for (const u of ['#000000', '#ffffff', ...under])
      expect(ratio(text, u, scrim, unknown)).toBeGreaterThanOrEqual(4.5);
  });
  it('intensity only ever adds scrim, never below the readability minimum', () => {
    const p = { colors: ['#ffffff'], darkest: '#ffffff', brightest: '#ffffff', luminance: 1 };
    const need = requiredScrim('#f1eee8', '#161513', ['#ffffff']);
    expect(
      scrimOpacity({ textHex: '#f1eee8', scrimHex: '#161513', palette: p, intensity: 100, themeMin: 0 }),
    ).toBeGreaterThanOrEqual(need);
    expect(
      scrimOpacity({ textHex: '#f1eee8', scrimHex: '#161513', palette: p, intensity: 0, themeMin: 0 }),
    ).toBe(1);
  });
  it('style resolution: reduce effects, contrast, hidden/adult art, missing image fallbacks, per-item override', () => {
    const base = {
      global: 'banner' as const,
      item: 'default' as const,
      reduceEffects: false,
      prefersContrast: false,
      artHidden: false,
      adultBlurred: false,
      hasBackgroundImage: true,
      hasCover: true,
    };
    expect(resolveBackdrop(base).style).toBe('banner');
    expect(resolveBackdrop({ ...base, reduceEffects: true }).style).toBe('off');
    expect(resolveBackdrop({ ...base, prefersContrast: true }).style).toBe('off');
    expect(resolveBackdrop({ ...base, adultBlurred: true }).style).toBe('ambient');
    expect(resolveBackdrop({ ...base, artHidden: true }).style).toBe('off');
    expect(resolveBackdrop({ ...base, hasBackgroundImage: false }).style).toBe('ambient');
    expect(resolveBackdrop({ ...base, hasBackgroundImage: false, hasCover: false }).style).toBe('off');
    expect(resolveBackdrop({ ...base, item: 'off' }).style).toBe('off');
    expect(resolveBackdrop({ ...base, global: 'off', item: 'blurred' }).style).toBe('blurred');
  });
});

describe('§13 feature registry', () => {
  it('Simple shows exactly Home, Library, Settings (+ Recently deleted outside the sidebar)', () => {
    const simpleNav = FEATURES.filter((f) => f.kind === 'nav' && isShown(f.id, 'simple')).map((f) =>
      labelFor(f.id, 'simple'),
    );
    expect(simpleNav).toEqual(['Home', 'Library', 'Settings', 'Recently deleted']);
    const simpleSettings = FEATURES.filter((f) => f.kind === 'settings' && isShown(f.id, 'simple')).map((f) =>
      labelFor(f.id, 'simple'),
    );
    expect(simpleSettings).toEqual([
      'Appearance',
      'Reminders',
      'Backup & restore',
      'Data sources',
      'Interface',
    ]);
    expect(FEATURES.every((f) => isShown(f.id, 'full'))).toBe(true);
    expect(isShown('unknown.thing', 'simple')).toBe(false);
  });
  it('core vs advanced tiers for §14–§16 match the spec', () => {
    const core = FEATURES.filter((f) => f.kind === 'feature' && f.tier === 'core')
      .map((f) => f.id)
      .sort();
    expect(core).toEqual(
      [
        'feature.ambientBackdrops',
        'feature.backupCheck',
        'feature.dyslexiaFont',
        'feature.keyFreeCovers',
        'feature.offlineQueue',
        'feature.pasteList',
        'feature.quickRating',
        'feature.restorePlace',
        'feature.trash',
      ].sort(),
    );
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
  });
  it('search finds hidden features with a "Full mode" flag', () => {
    expect(searchFeatures('triage', 'simple')).toEqual([
      { entry: expect.objectContaining({ id: 'nav.triage' }), hidden: true },
    ]);
    expect(searchFeatures('triage', 'full')[0]?.hidden).toBe(false);
  });
});

describe('§15 key-free art sources (recorded fixtures)', () => {
  const ctx = (http: FakeHttp) =>
    ({ http, limiter: instantLimiter(), keys: {}, log: new MemoryLogger() }) as never;
  it('only key-free sources are listed first; hosts are allowlisted; no unofficial sources', () => {
    expect(KEY_FREE_ART_SOURCES).toEqual(['tvmaze-art', 'commons']);
    expect(ART_SOURCES.map((s) => s.id)).not.toContain('itunes');
    for (const h of ['static.tvmaze.com', 'upload.wikimedia.org']) expect(ARTWORK_HOSTS.has(h)).toBe(true);
    expect(OUTBOUND_HOSTS).toContain('commons.wikimedia.org');
  });
  it('TVmaze: IMDb lookup → images; never guesses by title; 404 → empty; 429 surfaced', async () => {
    const http = new FakeHttp()
      .on('/lookup/shows?imdb=tt11280740', () => json({ id: 44933 }))
      .on('/shows/44933/images', () =>
        json([
          {
            id: 1,
            type: 'poster',
            main: true,
            resolutions: {
              original: { url: 'https://static.tvmaze.com/p.jpg', width: 680, height: 1000 },
              medium: { url: 'https://static.tvmaze.com/pm.jpg' },
            },
          },
          {
            id: 2,
            type: 'background',
            resolutions: { original: { url: 'https://static.tvmaze.com/b.jpg', width: 1920, height: 1080 } },
          },
          { id: 3, type: 'poster', resolutions: { original: { url: 'https://evil.example/x.jpg' } } },
        ]),
      );
    const r = await tvmazeArtSource.candidates(
      { type: 'tv', title: 'Severance', year: 2022, externalIds: [{ kind: 'imdb', value: 'tt11280740' }] },
      ctx(http),
    );
    expect(r.kind === 'ok' && r.value.map((c) => [c.slot, c.url])).toEqual([
      ['cover', 'https://static.tvmaze.com/p.jpg'],
      ['background', 'https://static.tvmaze.com/b.jpg'],
    ]);
    const none = await tvmazeArtSource.candidates(
      { type: 'tv', title: 'Severance', year: 2022, externalIds: [] },
      ctx(new FakeHttp()),
    );
    expect(none).toEqual({ kind: 'ok', value: [] });
    const missing = await tvmazeArtSource.candidates(
      { type: 'tv', title: 'x', year: null, externalIds: [{ kind: 'tvmaze', value: '9' }] },
      ctx(new FakeHttp().on('/shows/9/images', () => json({}, 404))),
    );
    expect(missing).toEqual({ kind: 'ok', value: [] });
    const limited = await tvmazeArtSource.candidates(
      { type: 'tv', title: 'x', year: null, externalIds: [{ kind: 'tvmaze', value: '9' }] },
      ctx(new FakeHttp().on('/shows/9/images', () => json({}, 429, { 'retry-after': '5' }))),
    );
    expect(limited.kind).toBe('rateLimited');
  });
  it('Commons: free licenses only (CC0/PD/CC BY/BY-SA), SVG and non-free rejected, attribution recorded', async () => {
    expect(['CC0', 'Public domain', 'CC BY-SA 4.0', 'CC BY 2.0', 'PD-US'].every(commonsLicenseOk)).toBe(true);
    expect(
      ['Fair use', 'CC BY-NC 4.0', 'CC BY-ND 3.0', null, '', 'All rights reserved'].some((l) =>
        commonsLicenseOk(l),
      ),
    ).toBe(false);
    const http = new FakeHttp()
      .on('wbgetentities', () =>
        json({
          entities: {
            Q42: {
              claims: {
                P3383: [
                  { mainsnak: { datavalue: { value: 'Poster free.jpg' } } },
                  { mainsnak: { datavalue: { value: 'Poster nonfree.jpg' } } },
                ],
                P154: [{ mainsnak: { datavalue: { value: 'Logo.svg' } } }],
              },
            },
          },
        }),
      )
      .on('commons.wikimedia.org/w/api.php', () =>
        json({
          query: {
            pages: {
              '1': {
                title: 'File:Poster free.jpg',
                imageinfo: [
                  {
                    url: 'https://upload.wikimedia.org/a.jpg',
                    thumburl: 'https://upload.wikimedia.org/a320.jpg',
                    width: 800,
                    height: 1200,
                    extmetadata: {
                      LicenseShortName: { value: 'Public domain' },
                      Artist: { value: '<a href="x">Studio</a>' },
                    },
                  },
                ],
              },
              '2': {
                title: 'File:Poster nonfree.jpg',
                imageinfo: [
                  {
                    url: 'https://upload.wikimedia.org/b.jpg',
                    extmetadata: { LicenseShortName: { value: 'Fair use' } },
                  },
                ],
              },
              '3': {
                title: 'File:Logo.svg',
                imageinfo: [
                  {
                    url: 'https://upload.wikimedia.org/c.svg',
                    extmetadata: { LicenseShortName: { value: 'CC0' } },
                  },
                ],
              },
            },
          },
        }),
      );
    const r = await commonsArtSource.candidates(
      { type: 'movie', title: 'x', year: null, externalIds: [{ kind: 'wikidata', value: 'Q42' }] },
      ctx(http),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]).toMatchObject({
      slot: 'cover',
      url: 'https://upload.wikimedia.org/a.jpg',
      licenseNote: 'Public domain',
      attribution: 'Studio · Public domain · Wikimedia Commons',
    });
    const drift = await commonsArtSource.candidates(
      { type: 'movie', title: 'x', year: null, externalIds: [{ kind: 'wikidata', value: 'Q42' }] },
      ctx(new FakeHttp().on('wbgetentities', () => json({ unexpected: true }))),
    );
    expect(drift.kind).toBe('malformedResponse');
  });
});
