import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REQUEST_SCHEMAS } from '../../src/shared/ipc-contract';
import { checkOpenExternal } from '../../src/main/security/policy';
import { buildJsonExport } from '../../src/main/services/export-service';
import { HttpFailure } from '../../src/providers/http';
import { json, raw } from '../helpers/http';
import { addItem } from '../helpers/services';
import {
  addSteamSource,
  makeFeatureEnv,
  STEAM_ID,
  STEAM_KEY,
  steamRoutes,
  syncSteam,
  type FeatureEnv,
  type SteamGame,
} from '../helpers/features';

let env: FeatureEnv;
beforeEach(() => {
  env = makeFeatureEnv();
});
afterEach(() => env.cleanup());

const GAMES: SteamGame[] = [
  { appid: 10, name: 'Counter-Strike', playtime_forever: 1200, rtime_last_played: 1700000000 },
  { appid: 20, name: 'Hollow Knight', playtime_forever: 0 },
  { appid: 30, name: 'Celeste', playtime_forever: 0 },
  { appid: 40, name: 'Celeste Original Soundtrack', playtime_forever: 0 },
  { appid: 50, name: 'Outer Wilds', playtime_forever: 0 },
];

const entries = (
  sourceId: string,
  view: 'unplayed' | 'played' | 'all' | 'inPile' | 'ignored' | 'new' | 'removed' = 'unplayed',
  extra = {},
) =>
  env.f.sources.entries({
    sourceId,
    view,
    search: '',
    showNonGames: false,
    sort: 'name',
    direction: 'asc',
    ...extra,
  });

const importOpts = {
  status: 'planned' as const,
  tags: ['steam'],
  listId: null,
  importPlaytime: false,
  enrich: false,
};

describe('Steam key handling', () => {
  it('stores the key encrypted outside the DB and never returns, logs or exports it', async () => {
    steamRoutes(env.http, GAMES);
    const id = addSteamSource(env);
    const views = env.f.sources.list();
    expect(views[0]?.keySet).toBe(true);
    expect(JSON.stringify(views)).not.toContain(STEAM_KEY);
    expect(readFileSync(env.ctx.paths.secrets, 'utf8')).not.toContain(STEAM_KEY); // encrypted (base64 of cipher text)
    await syncSteam(env, id);
    expect(JSON.stringify(env.log.lines)).not.toContain(STEAM_KEY);
    expect(JSON.stringify(env.log.lines)).not.toContain(STEAM_ID);
    expect(JSON.stringify(buildJsonExport(env.db, 'v', new Date()))).not.toContain(STEAM_KEY);
    expect(JSON.stringify(env.db.all('SELECT * FROM library_sources'))).not.toContain(STEAM_KEY);
    // the key travels only in the request to Steam
    expect(env.http.calls.every((c) => c.url.startsWith('https://api.steampowered.com/'))).toBe(true);
    // keeping the key: saving with an empty key does not clear it
    env.f.sources.saveSteam({ sourceId: id, label: 'Renamed', account: STEAM_ID, apiKey: '' });
    expect(env.f.sources.list()[0]?.keySet).toBe(true);
    env.f.sources.clearSteamKey();
    expect(env.f.sources.list()[0]?.keySet).toBe(false);
  });

  it('validates key and account with field-level errors', () => {
    expect(() =>
      env.f.sources.saveSteam({ sourceId: null, label: 'S', account: '123', apiKey: 'nope' }),
    ).toThrow(
      expect.objectContaining({
        safe: expect.objectContaining({
          fieldErrors: expect.objectContaining({ apiKey: expect.any(String), account: expect.any(String) }),
        }),
      }),
    );
    expect(() =>
      env.f.sources.saveSteam({
        sourceId: null,
        label: 'S',
        account: 'https://evil.example/id/x',
        apiKey: STEAM_KEY,
      }),
    ).toThrow(/Some Steam settings/);
  });

  it('IPC schemas reject malformed Steam requests before they reach main', () => {
    expect(
      REQUEST_SCHEMAS['sources:saveSteam'].safeParse({
        sourceId: null,
        label: 'S',
        account: 'x',
        apiKey: 'k',
        extra: 1,
      }).success,
    ).toBe(false);
    expect(REQUEST_SCHEMAS['sources:startFetch'].safeParse({ sourceId: 'not-a-uuid' }).success).toBe(false);
    expect(
      REQUEST_SCHEMAS['sources:import'].safeParse({
        sourceId: '11111111-1111-4111-8111-111111111111',
        externalIds: [],
        ...importOpts,
      }).success,
    ).toBe(false);
    expect(
      REQUEST_SCHEMAS['sources:entries'].safeParse({
        sourceId: '11111111-1111-4111-8111-111111111111',
        view: 'everything',
        search: '',
        showNonGames: false,
        sort: 'name',
        direction: 'asc',
      }).success,
    ).toBe(false);
    expect(
      REQUEST_SCHEMAS['sources:setIgnored'].safeParse({
        sourceId: '11111111-1111-4111-8111-111111111111',
        externalIds: ['x'.repeat(201)],
        ignored: true,
      }).success,
    ).toBe(false);
  });

  it('opens store links only through the HTTPS allowlisted opener', () => {
    expect(checkOpenExternal('https://store.steampowered.com/app/20/').ok).toBe(true);
    expect(checkOpenExternal('http://store.steampowered.com/app/20/').ok).toBe(false);
    expect(checkOpenExternal('https://store.steampowered.com.evil.example/app/20/').ok).toBe(false);
  });
});

describe('fetching', () => {
  it('resolves vanity names, test connection reports success, and loads the library', async () => {
    steamRoutes(env.http, GAMES);
    const id = addSteamSource(env, 'https://steamcommunity.com/id/gaben/');
    const t = await env.f.sources.testSteam(id);
    expect(t.message).toMatch(/5 game/);
    expect(env.f.sources.list()[0]?.accountHint).toBe('…930');
    const job = await syncSteam(env, id);
    expect(job.state).toBe('done');
    expect(entries(id).rows.map((r) => r.name)).toEqual(['Celeste', 'Hollow Knight', 'Outer Wilds']); // unplayed, non-games hidden
    expect(entries(id, 'unplayed', { showNonGames: true }).rows.map((r) => r.externalId)).toContain('40');
    expect(entries(id, 'played').rows.map((r) => r.name)).toEqual(['Counter-Strike']);
    expect(entries(id, 'played').rows[0]?.lastPlayedAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('unknown vanity name gives a specific error', async () => {
    steamRoutes(env.http, GAMES);
    const id = addSteamSource(env, 'nobodyhere');
    await expect(env.f.sources.testSteam(id)).rejects.toMatchObject({ safe: { code: 'PROVIDER_NOT_FOUND' } });
  });

  it('detects private profiles and explains the exact privacy setting', async () => {
    steamRoutes(env.http, 'private');
    const id = addSteamSource(env);
    const job = await syncSteam(env, id);
    expect(job.state).toBe('failed');
    expect(job.error?.message).toMatch(/private/i);
    expect(job.error?.recovery).toMatch(/Privacy Settings/);
    expect(job.error?.recovery).toMatch(/Game details/);
    expect(env.f.sources.list()[0]?.lastSyncStatus).toBe('private');
    await expect(env.f.sources.testSteam(id)).rejects.toMatchObject({
      safe: { message: expect.stringMatching(/private/) },
    });
  });

  it('invalid or revoked key (401/403)', async () => {
    env.http.on('GetOwnedGames', () => json({}, 403));
    const id = addSteamSource(env);
    const job = await syncSteam(env, id);
    expect(job.error).toMatchObject({ code: 'PROVIDER_UNAUTHORIZED' });
    expect(job.error?.fieldErrors?.['apiKey']).toBeDefined();
  });

  it('honours Retry-After on 429 and retries, never hammering', async () => {
    let n = 0;
    env.http.on('GetOwnedGames', () =>
      ++n === 1
        ? json({}, 429, { 'retry-after': '7' })
        : json({ response: { game_count: 1, games: [{ appid: 1, name: 'A' }] } }),
    );
    const id = addSteamSource(env);
    const job = await syncSteam(env, id);
    expect(job.state).toBe('done');
    expect(n).toBe(2);
    expect(env.sleeps).toContain(7000);
  });

  it('gives up with a clear message when Steam asks to wait too long', async () => {
    env.http.on('GetOwnedGames', () => json({}, 429, { 'retry-after': '3600' }));
    const id = addSteamSource(env);
    const job = await syncSteam(env, id);
    expect(job.error?.code).toBe('PROVIDER_RATE_LIMITED');
    expect(env.http.calls.filter((c) => c.url.includes('GetOwnedGames'))).toHaveLength(1);
  });

  it('backs off on transient 5xx and timeouts, then fails with a network error', async () => {
    let n = 0;
    env.http.on('GetOwnedGames', () =>
      ++n < 3 ? json({}, 503) : json({ response: { game_count: 0, games: [] } }),
    );
    const id = addSteamSource(env);
    expect((await syncSteam(env, id)).state).toBe('done');
    expect(env.sleeps.slice(0, 2)).toEqual([2000, 4000]);
    env.http.on('GetOwnedGames', () => new HttpFailure('timeout', 't'));
    expect((await syncSteam(env, id)).error?.code).toBe('PROVIDER_TIMEOUT');
    env.http.on('GetOwnedGames', () => new HttpFailure('network', 'dns'));
    expect((await syncSteam(env, id)).error?.code).toBe('PROVIDER_NETWORK');
  });

  it('handles truncated JSON, wrong types, missing names, unicode and duplicate appids', async () => {
    env.http.on('GetOwnedGames', () => raw('{"response": {"games": [{"appid": 1'));
    const id = addSteamSource(env);
    expect((await syncSteam(env, id)).error?.code).toBe('PROVIDER_MALFORMED');
    env.http.on('GetOwnedGames', () => json({ response: 'nope' }));
    expect((await syncSteam(env, id)).error?.code).toBe('PROVIDER_MALFORMED');
    env.http.on('GetOwnedGames', () =>
      json({
        response: {
          game_count: 5,
          games: [
            { appid: 1, name: 'ポケモン\u0000 Ünïcödé 🎮', playtime_forever: 0 },
            { appid: 2 },
            { appid: 'three', name: 'bad' },
            { appid: 4, name: 'Dup', playtime_forever: 5 },
            { appid: 4, name: 'Dup', playtime_forever: 50 },
          ],
        },
      }),
    );
    const job = await syncSteam(env, id);
    expect(job.state).toBe('done');
    expect(job.phase).toMatch(/1 entry was unreadable/);
    expect(job.phase).toMatch(/1 duplicate/);
    const all = entries(id, 'all').rows;
    expect(all.map((r) => r.name).sort()).toEqual(['Dup', 'Steam app 2', 'ポケモン Ünïcödé 🎮']);
    expect(all.find((r) => r.externalId === '4')?.playtimeMinutes).toBe(50);
  });

  it('cancel leaves the previous snapshot untouched', async () => {
    steamRoutes(env.http, GAMES);
    const id = addSteamSource(env);
    await syncSteam(env, id);
    let release: () => void = () => undefined;
    env.http.on(
      'GetOwnedGames',
      (req) =>
        new Promise((resolve) => {
          release = () => resolve(new HttpFailure('aborted', 'aborted'));
          req.signal?.addEventListener('abort', () => release());
        }),
    );
    const job = env.f.sources.startFetch(id);
    await new Promise((r) => setTimeout(r, 5));
    expect(env.f.sources.cancelFetch(job.jobId).state).toBe('cancelled');
    release();
    await env.f.sources.waitFor(job.jobId);
    expect(entries(id, 'all').total).toBe(4);
  });

  it('stays responsive for 10,000+ games (fetch, reconcile, filter)', async () => {
    const many: SteamGame[] = Array.from({ length: 10_500 }, (_, i) => ({
      appid: i + 1,
      name: `Game ${i + 1}`,
      playtime_forever: i % 3 === 0 ? 60 : 0,
    }));
    steamRoutes(env.http, many);
    const id = addSteamSource(env);
    const t0 = performance.now();
    await syncSteam(env, id);
    const t1 = performance.now();
    const page = entries(id);
    const t2 = performance.now();
    const searched = entries(id, 'all', { search: 'game 99' });
    const t3 = performance.now();
    expect(page.total).toBe(7000);
    expect(searched.total).toBe(111); // 99, 990-999, 9900-9999
    // Generous bounds so CI variance doesn't flake; real numbers are reported in docs/verification-log.md.
    expect(t1 - t0).toBeLessThan(15_000);
    expect(t2 - t1).toBeLessThan(3_000);
    expect(t3 - t2).toBeLessThan(3_000);
  });
});

describe('review, ignore and import', () => {
  it('ignore list persists across syncs and in-pile games are detected and never duplicated', async () => {
    steamRoutes(env.http, GAMES);
    const existing = addItem(env, 'game', 'Celeste', {
      meta: { externalIds: [{ kind: 'steam', value: '30' }] },
    });
    const id = addSteamSource(env);
    await syncSteam(env, id);
    expect(entries(id, 'inPile').rows.map((r) => [r.name, r.itemId])).toEqual([['Celeste', existing.id]]);
    env.f.sources.setIgnored(id, ['50'], true);
    await syncSteam(env, id);
    expect(entries(id).rows.map((r) => r.name)).toEqual(['Hollow Knight']);
    expect(entries(id, 'ignored').rows.map((r) => r.name)).toEqual(['Outer Wilds']);
    const r = await env.f.sources.importSelected({ sourceId: id, externalIds: ['30', '20'], ...importOpts });
    expect(r.added).toBe(1);
    expect(r.skippedDuplicates).toEqual([{ externalId: '30', title: 'Celeste', existingId: existing.id }]);
  });

  it('title-only matches are a warning, not a block', async () => {
    steamRoutes(env.http, GAMES);
    const manual = addItem(env, 'game', 'Hollow Knight');
    const id = addSteamSource(env);
    await syncSteam(env, id);
    expect(entries(id).rows.find((r) => r.externalId === '20')?.possibleDuplicateOf).toEqual({
      id: manual.id,
      title: 'Hollow Knight',
    });
  });

  it('imports a selection as Planned with tags, list, provenance, link and optional playtime', async () => {
    steamRoutes(env.http, GAMES);
    const id = addSteamSource(env);
    await syncSteam(env, id);
    const list = env.f.lists.save({
      id: null,
      name: 'Couch co-op',
      description: null,
      color: 'teal',
      icon: 'users',
    })[0];
    const r = await env.f.sources.importSelected({
      sourceId: id,
      externalIds: ['10', '20'],
      ...importOpts,
      listId: list?.id ?? null,
      importPlaytime: true,
    });
    expect(r).toMatchObject({ added: 2, failed: [], skippedDuplicates: [] });
    const cs = env.library.query({ ...q(), text: 'Counter' }).items[0];
    const detail = env.library.get(cs?.id ?? '');
    expect(detail.personal).toMatchObject({ status: 'planned', tags: ['steam'], gameScheme: 'hours' });
    expect(detail.meta.externalIds).toEqual([{ kind: 'steam', value: '10' }]);
    expect(detail.provenance.title?.origin).toBe('provider');
    expect(detail.provenance.title?.providerId).toBe('steam');
    expect(detail.links.find((l) => l.kind === 'steam')?.url).toBe('https://store.steampowered.com/app/10/');
    expect(detail.lists.map((l) => l.name)).toEqual(['Couch co-op']);
    expect(detail.progress.label).toMatch(/20 h/);
    const hk = env.library.get(env.library.query({ ...q(), text: 'Hollow' }).items[0]?.id ?? '');
    expect(hk.personal.gameScheme).toBe('percent'); // unplayed: nothing to import
    expect(entries(id, 'inPile').total).toBe(2);
    expect(env.f.batches.list()[0]).toMatchObject({ kind: 'steam', itemCount: 2, canUndo: true });
  });

  it('a failure mid-batch rolls back that chunk completely and reports exactly what was not added', async () => {
    const many: SteamGame[] = Array.from({ length: 450 }, (_, i) => ({
      appid: i + 1,
      name: `G${i + 1}`,
      playtime_forever: 0,
    }));
    steamRoutes(env.http, many);
    const id = addSteamSource(env);
    await syncSteam(env, id);
    const before = env.db.get<{ n: number }>('SELECT count(*) AS n FROM items')?.n;
    const r = await env.f.sources.importSelected(
      { sourceId: id, externalIds: many.map((g) => String(g.appid)), ...importOpts },
      { failInChunk: 1 },
    );
    expect(r.added).toBe(250); // chunks 0 and 2 (200 + 50)
    expect(r.failed).toHaveLength(200);
    expect(env.db.get<{ n: number }>('SELECT count(*) AS n FROM items')?.n).toBe((before ?? 0) + 250);
    // no orphan rows from the failed chunk
    expect(env.db.get<{ n: number }>("SELECT count(*) AS n FROM external_ids WHERE kind = 'steam'")?.n).toBe(
      250,
    );
    expect(
      env.db.get<{ n: number }>(
        'SELECT count(*) AS n FROM field_provenance WHERE item_id NOT IN (SELECT id FROM items)',
      )?.n,
    ).toBe(0);
    expect(env.db.get<{ n: number }>('SELECT count(*) AS n FROM import_batch_items')?.n).toBe(250);
    expect(
      env.db.get<{ n: number }>('SELECT count(*) AS n FROM library_source_entries WHERE item_id IS NOT NULL')
        ?.n,
    ).toBe(250);
    expect(env.db.foreignKeyViolations()).toBe(0);
  });

  it('undo removes only untouched items; edited ones are kept with reasons', async () => {
    steamRoutes(env.http, GAMES);
    const id = addSteamSource(env);
    await syncSteam(env, id);
    const r = await env.f.sources.importSelected({
      sourceId: id,
      externalIds: ['10', '20', '30', '50'],
      ...importOpts,
    });
    const ids = Object.fromEntries(
      env.db
        .all<{ external_id: string; item_id: string }>(
          'SELECT external_id, item_id FROM library_source_entries WHERE item_id IS NOT NULL',
        )
        .map((x) => [x.external_id, x.item_id]),
    );
    env.clock.advance(60_000);
    env.library.setRating(ids['20'] ?? '', 8); // edit
    env.progress.add({
      itemId: ids['30'] ?? '',
      entry: { kind: 'percent', value: 10 },
      occurredAt: null,
      note: null,
    }); // progress
    env.f.lists.setMembership(env.f.lists.ensure('Later'), [ids['50'] ?? ''], true); // list membership is not an edit
    const preview = env.f.batches.undoPreview(r.batchId ?? '');
    expect(preview.removable.map((x) => x.title).sort()).toEqual(['Counter-Strike', 'Outer Wilds']);
    expect(preview.kept.map((x) => x.title).sort()).toEqual(['Celeste', 'Hollow Knight']);
    const done = env.f.batches.undo(r.batchId ?? '');
    expect(done.removable).toHaveLength(2);
    expect(
      env.library
        .query(q())
        .items.map((i) => i.title)
        .sort(),
    ).toEqual(['Celeste', 'Hollow Knight']);
    expect(entries(id, 'inPile').total).toBe(2);
    expect(() => env.f.batches.undo(r.batchId ?? '')).toThrow(/already undone/);
    // retention purge removes the record (not the items)
    env.clock.advance(31 * 86_400_000);
    expect(env.f.batches.purgeExpired()).toBe(1);
    expect(env.library.query(q()).total).toBe(2);
  });
});

describe('re-sync', () => {
  it('shows new / playtime changed / removed, flags removed pile items, never deletes them', async () => {
    steamRoutes(env.http, GAMES);
    const id = addSteamSource(env);
    await syncSteam(env, id);
    await env.f.sources.importSelected({
      sourceId: id,
      externalIds: ['10', '30'],
      ...importOpts,
      importPlaytime: true,
    });
    env.clock.advance(86_400_000);
    steamRoutes(env.http, [
      { appid: 10, name: 'Counter-Strike', playtime_forever: 1500 },
      { appid: 20, name: 'Hollow Knight', playtime_forever: 0 },
      { appid: 40, name: 'Celeste Original Soundtrack', playtime_forever: 0 },
      { appid: 50, name: 'Outer Wilds', playtime_forever: 0 },
      { appid: 60, name: 'Tunic', playtime_forever: 0 },
    ]);
    const job = await syncSteam(env, id);
    expect(job.diff).toEqual({ added: 1, playtimeChanged: 1, removed: 1 });
    const d = env.f.sources.diff(id);
    expect(d.added.map((x) => x.name)).toEqual(['Tunic']);
    expect(d.playtimeChanged).toMatchObject([
      { name: 'Counter-Strike', before: 1200, after: 1500, pileHours: 20 },
    ]);
    expect(d.removed.map((x) => x.name)).toEqual(['Celeste']);
    expect(entries(id, 'new').rows.map((r) => r.name)).toEqual(['Tunic']);
    const celesteId = d.removed[0]?.itemId ?? '';
    expect(env.library.get(celesteId).goneFromSources).toEqual(['Steam']);
    // opt-in playtime update adds a history entry; nothing changed before that
    const csId = d.playtimeChanged[0]?.itemId ?? '';
    expect(env.progress.history(csId)).toHaveLength(1);
    expect(env.f.sources.applyPlaytime(id, ['10'])).toBe(1);
    expect(env.progress.history(csId)).toHaveLength(2);
    expect(env.library.get(csId).progress.label).toMatch(/25 h/);
  });

  it('manual game-list source uses the same review/import flow', async () => {
    const list = env.f.sources.loadManual({
      sourceId: null,
      label: 'GOG',
      text: 'title,platform\nDisco Elysium,PC (GOG)\n"Baldur\'s Gate 3",PC (GOG)\n=cmd|calc,PC\n,\n',
    });
    const src = list.find((s) => s.kind === 'manual');
    const id = src?.id ?? '';
    const rows = entries(id).rows;
    expect(rows.map((r) => r.name).sort()).toEqual(["Baldur's Gate 3", 'Disco Elysium', '=cmd|calc'].sort());
    expect(rows[0]?.storeUrl).toBeNull(); // cells are only text; a formula-looking title is never evaluated
    const r = await env.f.sources.importSelected({
      sourceId: id,
      externalIds: rows.map((x) => x.externalId),
      ...importOpts,
    });
    expect(r.added).toBe(3);
    const de = env.library.get(env.library.query({ ...q(), text: 'Disco' }).items[0]?.id ?? '');
    expect(de.personal.platforms).toEqual([{ name: 'PC (GOG)', owned: true, played: false }]);
    expect(env.f.batches.list()[0]?.kind).toBe('manual-list');
    // plain lines also work
    env.f.sources.loadManual({ sourceId: id, label: 'GOG', text: 'Disco Elysium\n# comment\nPentiment' });
    expect(entries(id, 'all').rows.map((r) => r.name)).toContain('Pentiment');
  });
});

function q() {
  return {
    text: '',
    types: [],
    statuses: [],
    tags: [],
    tagMode: 'any' as const,
    ratingMin: null,
    ratingMax: null,
    addedFrom: null,
    addedTo: null,
    sort: 'title' as const,
    direction: 'asc' as const,
    offset: 0,
    limit: 500,
    listId: null,
    upNextOnly: false,
    health: null,
  };
}
