import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isValidIsoDate,
  isValidPartialDate,
  toPartialDate,
  weekStartUtc,
  yearOf,
} from '../../src/domain/dates';
import { escapeCell, neutralizeFormula, parseCsv, restoreFormula, toCsv } from '../../src/domain/csv';
import { checkExternalUrl, externalIdError, linksFromExternalIds, LINK_HOSTS } from '../../src/domain/links';
import {
  htmlToPlainText,
  isbn10Valid,
  sortTitle,
  tagKey,
  titleKey,
  uniqueTags,
} from '../../src/domain/normalize';
import { ratingLabel, starsToRating } from '../../src/domain/rating';
import {
  isAutoApplicable,
  planStatusChange,
  suggestionsAfterProgress,
  type StatusState,
} from '../../src/domain/status-rules';
import { compareForRefresh, canonicalValue, emptyMeta, mergeRefresh } from '../../src/domain/metadata';
import { contrastRatio } from '../../src/domain/contrast';
import {
  BUILTIN_THEMES,
  contrastWarnings,
  parseThemeFile,
  PILE_LIGHT,
  themeToCssVars,
  THEME_MAX_BYTES,
} from '../../src/domain/themes';
import { DEFAULT_LAYOUTS, parseLayoutFile, repairLayout } from '../../src/domain/layouts';
import { redact, redactString } from '../../src/main/services/logger';

describe('dates', () => {
  it('validates partial dates including leap years', () => {
    for (const ok of ['2024', '2024-02', '2024-02-29', '1999-12-31'])
      expect(isValidPartialDate(ok)).toBe(true);
    for (const bad of ['2023-02-29', '2024-13', '24', '2024-1-1', '2024-00', '', '2024-04-31'])
      expect(isValidPartialDate(bad)).toBe(false);
    expect(isValidIsoDate('2024')).toBe(false);
    expect(yearOf('1982-06')).toBe(1982);
  });
  it('normalizes provider dates', () => {
    expect(toPartialDate('2010-07-16')).toBe('2010-07-16');
    expect(toPartialDate('July 16, 2010')).toBe('2010-07-16');
    expect(toPartialDate('Jul 2010')).toBe('2010-07');
    expect(toPartialDate('c. 1850')).toBe('1850');
    expect(toPartialDate(1999)).toBe('1999');
    expect(toPartialDate('soon')).toBeNull();
    expect(toPartialDate('')).toBeNull();
  });
  it('weeks start on Monday (UTC)', () => {
    expect(weekStartUtc(new Date('2025-03-16T23:00:00Z'))).toBe('2025-03-10'); // Sunday
    expect(weekStartUtc(new Date('2025-03-10T00:00:00Z'))).toBe('2025-03-10');
  });
});

describe('normalization', () => {
  it('tags are case/accent-insensitive', () => {
    expect(tagKey('  Café   Noir ')).toBe('cafe noir');
    expect(uniqueTags(['A', 'a', 'Ä', 'b'])).toEqual(['A', 'b']);
  });
  it('title keys drop articles/punctuation; sort keys are natural', () => {
    expect(titleKey('The Witcher 3: Wild Hunt')).toBe('witcher 3 wild hunt');
    expect(titleKey('Pokémon')).toBe(titleKey('POKEMON'));
    expect(sortTitle('Part 2') < sortTitle('Part 10')).toBe(true);
  });
  it('strips HTML safely', () => {
    expect(htmlToPlainText('<p>a<br>b</p><script>x</script>&lt;i&gt;')).toBe('a\nb\nx<i>');
  });
  it('validates ISBN-10 checksums', () => {
    expect(isbn10Valid('0306406152')).toBe(true);
    expect(isbn10Valid('0306406153')).toBe(false);
  });
});

describe('rating', () => {
  it('uses half-stars stored as 1–10', () => {
    expect(starsToRating(3.5)).toBe(7);
    expect(starsToRating(0)).toBeNull();
    expect(starsToRating(5.5)).toBeNull();
    expect(ratingLabel(7)).toBe('3.5 out of 5 stars');
    expect(ratingLabel(10)).toBe('5 out of 5 stars');
    expect(ratingLabel(null)).toBe('Not rated');
  });
});

describe('status rules', () => {
  const st = (patch: Partial<StatusState> = {}): StatusState => ({
    type: 'book',
    status: 'planned',
    dateStarted: null,
    dateCompleted: null,
    pass: 1,
    ...patch,
  });
  const none = { isComplete: false, hasAnyProgress: false };
  const some = { isComplete: false, hasAnyProgress: true };
  const done = { isComplete: true, hasAnyProgress: true };

  it('first progress on Planned suggests In Progress with a start date (not overwriting)', () => {
    expect(suggestionsAfterProgress(st(), none, some, '2025-01-01')).toEqual([
      expect.objectContaining({ kind: 'start', status: 'in_progress', setDateStarted: '2025-01-01' }),
    ]);
    expect(
      suggestionsAfterProgress(st({ dateStarted: '2020-01-01' }), none, some, '2025-01-01')[0]
        ?.setDateStarted,
    ).toBe('2020-01-01');
    expect(suggestionsAfterProgress(st({ status: 'in_progress' }), none, some, '2025-01-01')).toEqual([]);
  });
  it('reaching the end suggests (never forces) completion', () => {
    const s = suggestionsAfterProgress(st({ status: 'in_progress' }), some, done, '2025-01-01');
    expect(s.map((x) => x.kind)).toEqual(['complete']);
    expect(isAutoApplicable(s[0] ?? (undefined as never))).toBe(false);
    expect(suggestionsAfterProgress(st({ status: 'completed' }), some, done, 'x')).toEqual([]);
    expect(suggestionsAfterProgress(st({ status: 'in_progress' }), done, done, 'x')).toEqual([]); // already complete before
  });
  it('regressing a Completed item suggests reopening', () => {
    expect(suggestionsAfterProgress(st({ status: 'completed' }), done, some, 'x').map((s) => s.kind)).toEqual(
      ['reopen'],
    );
  });
  it('completing fills date_completed only when empty and offers fill-remaining', () => {
    const p = planStatusChange(
      st({ status: 'in_progress' }),
      { status: 'completed', startNewPass: false, clearDateCompleted: false },
      '2025-01-01',
    );
    expect(p).toMatchObject({
      status: 'completed',
      dateCompleted: '2025-01-01',
      offerFillRemaining: true,
      changed: true,
    });
    expect(
      planStatusChange(
        st({ dateCompleted: '2019-05-05' }),
        { status: 'completed', startNewPass: false, clearDateCompleted: false },
        'x',
      ).dateCompleted,
    ).toBe('2019-05-05');
  });
  it('re-opening Completed asks before new pass / clearing date', () => {
    const s = st({ status: 'completed', dateStarted: '2024-01-01', dateCompleted: '2024-02-01' });
    const plain = planStatusChange(
      s,
      { status: 'in_progress', startNewPass: false, clearDateCompleted: false },
      '2025-01-01',
    );
    expect(plain).toMatchObject({
      pass: 1,
      dateCompleted: '2024-02-01',
      confirmations: ['newPass', 'clearDateCompleted'],
    });
    const confirmed = planStatusChange(
      s,
      { status: 'in_progress', startNewPass: true, clearDateCompleted: true },
      '2025-01-01',
    );
    expect(confirmed).toMatchObject({ pass: 2, dateCompleted: null, dateStarted: '2024-01-01' });
  });
  it('on hold / dropped / planned leave dates and progress alone', () => {
    for (const status of ['on_hold', 'dropped', 'planned'] as const) {
      const p = planStatusChange(
        st({ status: 'in_progress', dateStarted: '2024-01-01' }),
        { status, startNewPass: false, clearDateCompleted: false },
        'x',
      );
      expect(p).toMatchObject({ status, dateStarted: '2024-01-01', dateCompleted: null, pass: 1 });
    }
  });
  it('same status is a no-op', () => {
    expect(
      planStatusChange(st(), { status: 'planned', startNewPass: false, clearDateCompleted: false }, 'x')
        .changed,
    ).toBe(false);
  });
});

describe('external links', () => {
  it('accepts valid https and normalizes', () => {
    expect(checkExternalUrl('https://WWW.IMDB.com/title/tt0133093/', LINK_HOSTS.imdb)).toEqual({
      ok: true,
      url: 'https://www.imdb.com/title/tt0133093/',
    });
  });
  it.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['data:text/html,<script>alert(1)</script>'],
    ['ftp://www.imdb.com/x'],
    ['http://www.imdb.com/title/tt0133093/'],
    ['https://user:pass@www.imdb.com/'],
    ['https://www.imdb.com:8443/'],
    ['https://evil.com/www.imdb.com'],
    ['https://www.imdb.com.evil.com/'],
    ['not a url'],
    ['https://www.imdb.com/\n'],
    [`https://www.imdb.com/${'a'.repeat(2100)}`],
    ['maybepile-art://file/x'],
  ])('rejects %s', (url) => {
    expect(checkExternalUrl(url, LINK_HOSTS.imdb).ok).toBe(false);
  });
  it('builds links per type and omits invalid/uncertain ones', () => {
    expect(
      linksFromExternalIds('movie', [
        { kind: 'imdb', value: 'tt0133093' },
        { kind: 'tmdb', value: '603' },
      ]).map((l) => l.url),
    ).toEqual(['https://www.imdb.com/title/tt0133093/', 'https://www.themoviedb.org/movie/603']);
    expect(linksFromExternalIds('movie', [{ kind: 'imdb', value: 'tt12' }])).toEqual([]);
    expect(
      linksFromExternalIds('game', [
        { kind: 'steam', value: '292030' },
        { kind: 'xbox', value: 'https://evil.com/x' },
        { kind: 'playstation', value: 'https://store.playstation.com/en-us/product/X' },
      ]).map((l) => l.kind),
    ).toEqual(['steam', 'playstation']);
    expect(linksFromExternalIds('game', [{ kind: 'imdb', value: 'tt0133093' }])).toEqual([]); // IMDb not shown for games
    expect(linksFromExternalIds('book', [{ kind: 'openlibrary', value: 'OL45804W' }])[0]?.url).toBe(
      'https://openlibrary.org/works/OL45804W',
    );
  });
  it('validates external ids by kind', () => {
    expect(externalIdError({ kind: 'imdb', value: 'tt0133093' })).toBeNull();
    expect(externalIdError({ kind: 'imdb', value: '0133093' })).toMatch(/tt/);
    expect(externalIdError({ kind: 'steam', value: 'https://store.steampowered.com/app/1/' })).toBeNull();
    expect(externalIdError({ kind: 'steam', value: 'https://steamcommunity.com/app/1' })).not.toBeNull();
  });
});

describe('CSV', () => {
  it('neutralizes formula injection and round-trips', () => {
    for (const v of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      expect(neutralizeFormula(v).startsWith("'")).toBe(true);
      expect(restoreFormula(neutralizeFormula(v))).toBe(v);
    }
    expect(neutralizeFormula('Normal')).toBe('Normal');
    expect(escapeCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    const csv = toCsv(
      ['a', 'b'],
      [
        ['=cmd|calc', 'x,y'],
        [null, 3],
      ],
      true,
    );
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ["'=cmd|calc", 'x,y'],
      ['', '3'],
    ]);
  });
  it('parses quoted newlines, CRLF/LF and rejects malformed quoting', () => {
    expect(parseCsv('a,b\r\n"1\n2",3\n')).toEqual([
      ['a', 'b'],
      ['1\n2', '3'],
    ]);
    expect(() => parseCsv('a\n"unterminated')).toThrow(/truncated/);
    expect(() => parseCsv('a\nx"y"')).toThrow(/Quote/);
  });
});

describe('metadata refresh rules', () => {
  const base = { ...emptyMeta('Old'), description: 'old desc', genres: ['Drama'] };
  const incoming = { ...emptyMeta('New'), description: 'new desc', genres: ['drama'], runtimeMinutes: 100 };
  it('defaults user-edited fields to keep and untouched provider fields to update', () => {
    const prov = {
      title: {
        origin: 'user' as const,
        providerId: 'tmdb',
        providerValue: canonicalValue('title', 'Old'),
        updatedAt: 't',
      },
      description: {
        origin: 'provider' as const,
        providerId: 'tmdb',
        providerValue: canonicalValue('description', 'old desc'),
        updatedAt: 't',
      },
    };
    const c = compareForRefresh('movie', base, incoming, prov);
    expect(c.rows.map((r) => [r.field, r.defaultChoice])).toEqual([
      ['title', 'keep'],
      ['description', 'update'],
      ['runtimeMinutes', 'update'],
    ]);
    expect(c.unchanged).toContain('genres'); // case-insensitive set equality
    const m = mergeRefresh(base, incoming, c.rows, {});
    expect(m.meta.title).toBe('Old');
    expect(m.meta.description).toBe('new desc');
    expect(mergeRefresh(base, incoming, c.rows, { title: 'update' }).meta.title).toBe('New');
  });
  it('detects provider fields edited outside provenance as user-edited, protects unknown-origin values, never blanks', () => {
    const prov = {
      description: {
        origin: 'provider' as const,
        providerId: 'tmdb',
        providerValue: canonicalValue('description', 'something else'),
        updatedAt: 't',
      },
    };
    const c = compareForRefresh('movie', base, { ...incoming, title: 'Old' }, prov);
    expect(c.rows.find((r) => r.field === 'description')?.defaultChoice).toBe('keep');
    const blank = compareForRefresh('movie', base, { ...emptyMeta('Old') }, {});
    expect(blank.rows).toEqual([]);
  });
});

describe('themes', () => {
  it('built-in themes meet WCAG AA for all checked pairs', () => {
    for (const t of BUILTIN_THEMES) expect(contrastWarnings(t.tokens), t.name).toEqual([]);
  });
  it('contrast math', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    expect(contrastRatio('#00000080', '#FFFFFF')).toBeLessThan(5);
  });
  const file = (tokens: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ format: 'maybepile-theme', schemaVersion: 1, name: 'T', tokens, ...extra });
  it('accepts valid themes and the example file', () => {
    expect(parseThemeFile(file(PILE_LIGHT)).ok).toBe(true);
    expect(parseThemeFile(readFileSync('examples/ocean.mptheme.json', 'utf8')).ok).toBe(true);
  });
  it.each([
    [
      'unsafe CSS value',
      { ...PILE_LIGHT, colors: { ...PILE_LIGHT.colors, bg: 'red;background:url(https://x)' } },
      'tokens.colors.bg',
    ],
    [
      'url() color',
      { ...PILE_LIGHT, colors: { ...PILE_LIGHT.colors, text: 'url(javascript:alert(1))' } },
      'tokens.colors.text',
    ],
    ['named color', { ...PILE_LIGHT, colors: { ...PILE_LIGHT.colors, text: 'red' } }, 'tokens.colors.text'],
    ['wrong type', { ...PILE_LIGHT, fontScale: '1.2' }, 'tokens.fontScale'],
    ['out of range', { ...PILE_LIGHT, fontScale: 9 }, 'tokens.fontScale'],
    ['bad enum', { ...PILE_LIGHT, fontFamily: 'url(evil.woff)' }, 'tokens.fontFamily'],
    ['unknown key', { ...PILE_LIGHT, script: 'alert(1)' }, '$.tokens'],
    ['missing color', { ...PILE_LIGHT, colors: { ...PILE_LIGHT.colors, bg: undefined } }, 'tokens.colors.bg'],
  ])('rejects %s with a JSON path', (_label, tokens, path) => {
    const r = parseThemeFile(file(tokens));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path.includes(path))).toBe(true);
  });
  it('rejects newer versions, bad JSON and oversized files', () => {
    const v2 = parseThemeFile(file(PILE_LIGHT, { schemaVersion: 2 }));
    expect(!v2.ok && v2.issues[0]?.message).toMatch(/version 2/);
    expect(parseThemeFile('{').ok).toBe(false);
    expect(parseThemeFile(' '.repeat(THEME_MAX_BYTES + 1)).ok).toBe(false);
    const enumErr = parseThemeFile(file({ ...PILE_LIGHT, density: 'huge' }));
    expect(!enumErr.ok && enumErr.issues[0]?.message).toMatch(/Allowed: "compact", "comfortable"/);
  });
  it('maps tokens to a fixed set of CSS variables', () => {
    const vars = themeToCssVars(PILE_LIGHT);
    expect(vars.every(([k]) => /^(--mp-[a-z-]+|color-scheme)$/.test(k))).toBe(true);
  });
  it('warns when a custom theme falls below AA', () => {
    const w = contrastWarnings({ ...PILE_LIGHT, colors: { ...PILE_LIGHT.colors, text: '#CCCCCC' } });
    expect(w.map((x) => x.pair)).toContain('Text on background');
  });
});

describe('layouts', () => {
  it('accepts the example and defaults', () => {
    expect(parseLayoutFile(readFileSync('examples/focused.mplayout.json', 'utf8')).ok).toBe(true);
  });
  it.each([
    ['unknown component', { dashboard: [{ id: 'evil', visible: true }], library: [] }],
    [
      'duplicate',
      {
        dashboard: [
          { id: 'counts', visible: true },
          { id: 'counts', visible: false },
        ],
        library: [],
      },
    ],
    ['bad setting', { dashboard: [{ id: 'counts', visible: true, span: 3 }], library: [] }],
    ['unknown setting', { dashboard: [{ id: 'counts', visible: true, html: '<b>' }], library: [] }],
    [
      'oversized array',
      { dashboard: Array.from({ length: 50 }, () => ({ id: 'counts', visible: true })), library: [] },
    ],
    ['wrong type', { dashboard: 'all', library: [] }],
  ])('rejects %s', (_l, body) => {
    expect(
      parseLayoutFile(JSON.stringify({ format: 'maybepile-layout', schemaVersion: 1, ...body })).ok,
    ).toBe(false);
  });
  it('repairs layouts missing components with a notice', () => {
    const r = repairLayout('dashboard', [{ id: 'tags', visible: false, span: 1 }]);
    expect(r.entries[0]).toEqual({ id: 'tags', visible: false, span: 1 });
    expect(r.entries).toHaveLength(DEFAULT_LAYOUTS.dashboard.length);
    expect(r.notices[0]).toMatch(/missing 6 component/);
  });
});

describe('log redaction', () => {
  it('redacts secrets, personal text and paths', () => {
    const out = JSON.stringify(
      redact({
        apiKey: 'abc',
        title: 'My Secret Diary',
        notes: 'private',
        url: 'https://api.themoviedb.org/3/search?api_key=0123456789abcdef0123456789abcdef&query=x',
        header: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
        path: 'C:\\Users\\someone\\AppData\\Roaming\\MaybePile\\library.sqlite',
        count: 3,
      }),
    );
    expect(out).not.toContain('abc"');
    expect(out).not.toContain('Diary');
    expect(out).not.toContain('private');
    expect(out).not.toContain('0123456789abcdef0123456789abcdef');
    expect(out).not.toContain('eyJzdWIi');
    expect(out).not.toContain('someone');
    expect(out).toContain('library.sqlite');
    expect(out).toContain('"count":3');
    expect(redactString('client_secret=supersecretvalue123')).toBe('client_secret=[redacted]');
  });
});
