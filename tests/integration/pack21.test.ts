/**
 * 2.1 features (§13–§16) on a real temp library with fake HTTP and an injected clock.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSettings, writeSettings } from '../../src/db/repositories/config-repo';
import { ArtworkService, passthroughProcessor } from '../../src/main/services/artwork-service';
import { buildJsonExport } from '../../src/main/services/export-service';
import { checkBackupDir } from '../../src/main/services/maintenance-service';
import { parsePastedList } from '../../src/main/services/import21-service';
import { createPack21Services, type Pack21Services } from '../../src/main/services/pack21-services';
import { exportPack21, importPack21, Pack21SectionSchema } from '../../src/main/services/pack21-portable';
import { splitAcrossDays } from '../../src/main/services/organize-service';
import { readRegistry } from '../../src/main/services/library-registry';
import { HttpFailure } from '../../src/providers/http';
import { ExportEnvelopeSchema } from '../../src/main/services/portable-format';
import { TemplateFileSchema, ViewFileSchema } from '../../src/shared/pack21-schemas';
import { DEFAULT_LIBRARY_QUERY } from '../../src/shared/schemas';
import { makeFeatureEnv, type FeatureEnv } from '../helpers/features';
import { json } from '../helpers/http';
import { addItem, season } from '../helpers/services';

interface Env extends FeatureEnv {
  p: Pack21Services;
  artwork: ArtworkService;
  relaunched: number;
}

function makePackEnv(): Env {
  const env = makeFeatureEnv() as Env;
  env.artwork = new ArtworkService(env.ctx, passthroughProcessor, env.http);
  env.relaunched = 0;
  env.p = createPack21Services(env.ctx, {
    library: env.library,
    progress: env.progress,
    providers: env.providers,
    artwork: env.artwork,
    features: env.f,
    decodeImage: () => ({ width: 2, height: 1, data: Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255]) }),
    root: env.dir,
    activeLibraryId: 'default',
    relaunch: () => void env.relaunched++,
  });
  return env;
}

let env: Env;
beforeEach(() => {
  env = makePackEnv();
});
afterEach(() => env.cleanup());

describe('§16.1 Recently deleted', () => {
  it('soft delete keeps every related row; restore is complete; retention purges after N days', () => {
    const tv = addItem(env, 'tv', 'Severance', { seasons: [season(1, 3)] });
    env.p.extras21.checklistOp({ op: 'add', itemId: tv.id, text: 'Finish season 1' });
    env.p.extras21.saveLoan({
      id: null,
      itemId: tv.id,
      person: 'Sam',
      direction: 'lent',
      loanedOn: '2025-03-01',
      dueOn: null,
      returnedOn: null,
      note: null,
    });
    env.library.setUpNext(tv.id, true);
    const list = env.f.lists
      .save({ id: null, name: 'Favs', description: null, color: null, icon: null })
      .find((l) => l.name === 'Favs')!;
    env.f.lists.setMembership(list.id, [tv.id], true);
    env.library.softDelete([tv.id]);
    expect(env.library.query(DEFAULT_LIBRARY_QUERY).items).toHaveLength(0);
    expect(env.p.history.trash()).toHaveLength(1);
    expect(env.p.history.trash()[0]?.purgeOn).toBe('2025-04-09'); // 30 days after 2025-03-10
    env.p.history.restore([tv.id]);
    const d = env.library.get(tv.id);
    expect(d.lists.map((l) => l.name)).toEqual(['Favs']);
    expect(d.upNextPosition).toBe(0);
    expect(env.p.extras21.checklist(tv.id).total).toBe(1);
    expect(env.p.extras21.loans({ itemId: tv.id })).toHaveLength(1);
    // Retention: not purged before N days, purged after.
    env.library.softDelete([tv.id]);
    env.clock.advance(29 * 86_400_000);
    expect(env.p.history.purgeExpired()).toBe(0);
    env.clock.advance(2 * 86_400_000);
    expect(env.p.history.purgeExpired()).toBe(1);
    expect(env.db.get('SELECT 1 AS x FROM items WHERE id = ?', [tv.id])).toBeUndefined();
  });
});

describe('§16.1 Recent changes', () => {
  it('logs fields (never notes text), undoes a change, refuses when changed again', () => {
    const m = addItem(env, 'movie', 'Arrival');
    env.p.history.logged([m.id], 'user', () => {
      env.library.setRating(m.id, 8);
      const d = env.library.get(m.id);
      env.library.update({ id: m.id, personal: { ...d.personal, notes: 'SECRET NOTE TEXT' } });
    });
    const changes = env.p.history.changes();
    expect(changes.map((c) => c.field).sort()).toEqual(['notes', 'rating']);
    expect(JSON.stringify(env.db.all('SELECT * FROM change_log'))).not.toContain('SECRET');
    const rating = changes.find((c) => c.field === 'rating')!;
    expect(rating).toMatchObject({ oldValue: null, newValue: '8', undoable: true });
    expect(changes.find((c) => c.field === 'notes')?.undoable).toBe(false);
    env.p.history.undoChange(rating.id);
    expect(env.library.get(m.id).personal.rating).toBeNull();
    env.p.history.logged([m.id], 'user', () => env.library.setRating(m.id, 6));
    env.library.setRating(m.id, 4);
    const latest = env.p.history.changes().find((c) => c.field === 'rating' && !c.undone)!;
    expect(latest.undoable).toBe(false);
    expect(() => env.p.history.undoChange(latest.id)).toThrow(/Changed again/);
  });
});

describe('§13.4 one-tap actions with undo', () => {
  it('+1 episode, pages, percent, start/done/hold — each undone exactly', () => {
    const tv = addItem(env, 'tv', 'Frieren', { seasons: [season(1, 3)] });
    const r1 = env.p.quick.act(tv.id, 'nextEpisode', null);
    expect(r1.message).toBe('Watched S1E1.');
    expect(env.library.get(tv.id).progress.label).toBe('1 of 3 episodes');
    env.p.quick.undoAction(r1.undoToken);
    expect(env.library.get(tv.id).progress.label).toMatch(/^No episodes watched|0 of 3/);
    expect(() => env.p.quick.undoAction(r1.undoToken)).toThrow(/no longer be undone/);

    const book = addItem(env, 'book', 'Dune', { meta: { pageCount: 400 } });
    env.p.quick.act(book.id, 'pages10', null);
    const r2 = env.p.quick.act(book.id, 'pages10', null);
    expect(r2.message).toBe('Now on page 20 of 400.');
    env.p.quick.undoAction(r2.undoToken);
    expect(env.library.get(book.id).progress.label).toMatch(/10/);

    const game = addItem(env, 'game', 'Hades', { personal: { gameScheme: 'percent' } });
    const r3 = env.p.quick.act(game.id, 'setPercent', 40);
    expect(env.library.get(game.id).progress.percent).toBe(40);
    env.p.quick.undoAction(r3.undoToken);
    expect(env.library.get(game.id).progress.percent ?? 0).toBe(0);

    const movie = addItem(env, 'movie', 'Arrival');
    const before = env.library.get(movie.id).personal;
    const r4 = env.p.quick.act(movie.id, 'watched', null);
    expect(r4.item.status).toBe('completed');
    env.p.quick.undoAction(r4.undoToken);
    const after = env.library.get(movie.id).personal;
    expect([after.status, after.dateStarted, after.dateCompleted]).toEqual([
      before.status,
      before.dateStarted,
      before.dateCompleted,
    ]);

    const r5 = env.p.quick.act(game.id, 'start', null);
    expect(r5.item.status).toBe('in_progress');
    const r6 = env.p.quick.act(game.id, 'hold', null);
    expect(r6.item.status).toBe('on_hold');
    env.p.quick.undoAction(r6.undoToken);
    expect(env.library.get(game.id).personal.status).toBe('in_progress');
  });
  it('omnibox finds library items first', () => {
    addItem(env, 'movie', 'Arrival');
    addItem(env, 'book', 'Dune');
    expect(env.p.quick.search('arr').map((i) => i.title)).toEqual(['Arrival']);
    expect(env.p.quick.search('   ')).toEqual([]);
  });
});

describe('§16.8 skipped episodes', () => {
  it('count toward completion, are reported separately, never as watched time, and skip the next episode', () => {
    const tv = addItem(env, 'tv', 'Naruto', { seasons: [season(1, 4)] });
    const eps = env.library.get(tv.id).seasons[0]!.episodes;
    env.progress.toggleEpisodes({
      itemId: tv.id,
      episodeIds: [eps[0]!.id, eps[1]!.id],
      watched: true,
      scope: 'upTo',
    });
    env.p.extras21.skipEpisodes(tv.id, [eps[2]!.id], true);
    const d = env.library.get(tv.id);
    expect(d.progress.label).toBe('2 watched · 1 skipped · 4 total');
    expect(d.progress.nextAction).toMatch(/^Next: S1E4/);
    env.p.extras21.skipEpisodes(tv.id, [eps[3]!.id], true);
    expect(env.library.get(tv.id).progress.isComplete).toBe(true);
    expect(
      env.db.get<{ n: number }>('SELECT count(*) AS n FROM episodes WHERE item_id = ? AND watched = 1', [
        tv.id,
      ])?.n,
    ).toBe(2);
    env.p.extras21.skipEpisodes(tv.id, [eps[3]!.id], false);
    expect(env.library.get(tv.id).progress.isComplete).toBe(false);
  });
});

describe('§14.9 checklists, §14.10 loans, §16.9 recommended by, §16.10 journal, §16.5 next step', () => {
  it('checklist CRUD, ordering, derived counts, completion suggestion only', () => {
    const g = addItem(env, 'game', 'Elden Ring');
    for (const t of ['DLC', 'Platinum', 'NG+'])
      env.p.extras21.checklistOp({ op: 'add', itemId: g.id, text: t });
    let cl = env.p.extras21.checklist(g.id);
    env.p.extras21.checklistOp({ op: 'move', itemId: g.id, entryId: cl.entries[2]!.id, direction: 'up' });
    cl = env.p.extras21.checklist(g.id);
    expect(cl.entries.map((e) => e.text)).toEqual(['DLC', 'NG+', 'Platinum']);
    for (const e of cl.entries)
      env.p.extras21.checklistOp({ op: 'check', itemId: g.id, entryId: e.id, checked: true });
    expect(env.p.extras21.checklist(g.id)).toMatchObject({ done: 3, total: 3, complete: true });
    expect(env.library.get(g.id).personal.status).toBe('planned'); // never changes status by itself
    expect(env.library.query(DEFAULT_LIBRARY_QUERY).items[0]?.checklist).toEqual({ done: 3, total: 3 });
    env.p.extras21.checklistOp({ op: 'delete', itemId: g.id, entryId: cl.entries[0]!.id });
    expect(env.p.extras21.checklist(g.id).total).toBe(2);
  });
  it('loans with overdue flag, recommended-by counts, merge and forget anonymize everywhere', () => {
    const b = addItem(env, 'book', 'Piranesi');
    const m = addItem(env, 'movie', 'Arrival', { personal: { status: 'completed' } });
    env.p.extras21.saveLoan({
      id: null,
      itemId: b.id,
      person: 'Sam',
      direction: 'lent',
      loanedOn: '2025-03-01',
      dueOn: '2025-03-05',
      returnedOn: null,
      note: null,
    });
    expect(env.p.extras21.loans({ open: true })[0]).toMatchObject({ person: 'Sam', overdue: true });
    env.p.extras21.setRecommender({ itemId: b.id, person: 'sam', note: null, recommendedOn: null });
    env.p.extras21.setRecommender({ itemId: m.id, person: 'Alex', note: null, recommendedOn: null });
    const sam = env.p.extras21.people().find((p) => p.name === 'Sam')!;
    expect(sam).toMatchObject({ loans: 1, recommended: 1, recommendedInPile: 1 });
    const alex = env.p.extras21.people().find((p) => p.name === 'Alex')!;
    env.p.extras21.mergePeople(alex.id, sam.id);
    expect(env.p.extras21.people().find((p) => p.id === sam.id)).toMatchObject({
      recommended: 2,
      recommendedCompleted: 1,
    });
    env.p.extras21.forgetPerson(sam.id);
    expect(JSON.stringify(env.db.all('SELECT * FROM people'))).not.toContain('Sam');
    expect(env.p.extras21.loans({ open: true })[0]?.person).toBe('Someone');
  });
  it('journal FTS search and next step with spoiler flag', () => {
    const b = addItem(env, 'book', 'Dune');
    env.p.extras21.saveJournal({
      id: null,
      itemId: b.id,
      entryDate: '2025-03-01',
      body: 'The spice must flow',
      progressLabel: 'p. 120',
      spoiler: true,
    });
    expect(env.p.extras21.searchJournal('spice')).toHaveLength(1);
    expect(env.p.extras21.searchJournal('"); DROP TABLE items; --')).toEqual([]);
    env.p.extras21.setNextStep({ itemId: b.id, text: 'finish chapter 3', spoiler: false });
    const s = env.library.query(DEFAULT_LIBRARY_QUERY).items[0]!;
    expect([s.nextStep, s.nextStepSpoiler]).toEqual(['finish chapter 3', false]);
    expect(env.p.history.changes().some((c) => c.field === 'nextStep')).toBe(true);
  });
});

describe('§14.4 views, §14.5 templates, §14.1 time goals', () => {
  it('views flag deleted lists; template files reject unknown fields; deleting a template keeps items', () => {
    const list = env.f.lists
      .save({ id: null, name: 'Cozy', description: null, color: null, icon: null })
      .find((l) => l.name === 'Cozy')!;
    env.p.organize.saveView({
      id: null,
      name: 'Cozy view',
      query: { ...DEFAULT_LIBRARY_QUERY, listId: list.id },
      viewMode: 'grid',
      pinned: true,
    });
    env.f.lists.remove(list.id);
    expect(env.p.organize.views()[0]?.notices).toEqual(['The list this view filtered by was deleted.']);
    expect(() =>
      env.p.organize.saveView({
        id: null,
        name: 'cozy VIEW',
        query: DEFAULT_LIBRARY_QUERY,
        viewMode: 'grid',
        pinned: false,
      }),
    ).toThrow(/already exists/);
    expect(
      ViewFileSchema.safeParse({
        format: 'maybepile-view',
        version: 1,
        name: 'x',
        query: { ...DEFAULT_LIBRARY_QUERY, sort: 'eval(1)' },
        viewMode: 'grid',
      }).success,
    ).toBe(false);
    const body = {
      version: 1,
      type: 'game',
      status: 'planned',
      tags: [],
      moodIds: [],
      customFields: [],
      checklist: ['a'],
      listId: null,
      platform: 'Tabletop',
    } as const;
    expect(
      TemplateFileSchema.safeParse({
        format: 'maybepile-template',
        version: 1,
        name: 'T',
        body: { ...body, script: 'x' },
      }).success,
    ).toBe(false);
    env.p.organize.saveTemplate(null, 'Board game night', {
      ...body,
      tags: [],
      moodIds: [],
      checklist: [...body.checklist],
      customFields: [],
    });
    const g = addItem(env, 'game', 'Catan');
    env.p.organize.deleteTemplate(env.p.organize.templates()[0]!.id);
    expect(env.library.get(g.id).meta.title).toBe('Catan');
  });
  it('time goals count sessions per local day, splitting sessions across midnight', () => {
    const days: Record<string, number> = {};
    splitAcrossDays(
      Date.parse('2025-03-09T23:00:00Z'),
      Date.parse('2025-03-10T01:00:00Z'),
      7200,
      'UTC',
      (d, s) => (days[d] = (days[d] ?? 0) + s),
    );
    expect(days).toEqual({ '2025-03-09': 3600, '2025-03-10': 3600 });
    const b = addItem(env, 'book', 'Dune');
    env.p.organize.saveTimeGoal({
      id: null,
      title: 'Read',
      targetMinutes: 30,
      period: 'day',
      mediaType: 'book',
      listId: null,
      moodId: null,
    });
    env.f.sessions.logManual(b.id, '2025-03-10T08:00:00.000Z', 20 * 60, null);
    const g = env.p.organize.timeGoals()[0]!;
    expect(g.minutes).toBe(20);
    expect(g.pace).toBe('a-bit-behind');
  });
});

describe('§14.6 paste a list + §16.6 offline queue', () => {
  it('parses hints, numbering, duplicates, unicode and caps', () => {
    const lines = parsePastedList(
      '1. Dune 2021 (movie)\n- Hades [game]\n\nSeverance — tv\nDune 2021 (movie)\nPokémon Adventures\n\u202Eevil',
      null,
    );
    expect(lines.map((l) => [l.title, l.year, l.type, l.repeatOfLine])).toEqual([
      ['Dune', 2021, 'movie', null],
      ['Hades', null, 'game', null],
      ['Severance', null, 'tv', null],
      ['Dune', 2021, 'movie', 0],
      ['Pokémon Adventures', null, null, null],
      ['evil', null, null, null],
    ]);
    expect(parsePastedList('x\n'.repeat(2000), 'book')).toHaveLength(500);
  });
  it('matches sequentially, imports only confirmed lines as one undoable batch', async () => {
    env.http.on('api.tvmaze.com/search/shows', () =>
      json([{ show: { id: 1, name: 'Severance', premiered: '2022-02-18' } }]),
    );
    addItem(env, 'tv', 'Lost');
    const r = env.p.import21.parse('Severance\nLost\nSkip me', 'tv');
    expect(r.lines[1]?.duplicateOf?.title).toBe('Lost');
    const m = await env.p.import21.match(r.token, [0]);
    expect(m[0]).toMatchObject({
      status: 'matched',
      candidates: [{ title: 'Severance', confidence: 'high' }],
    });
    const res = await env.p.import21.apply({
      token: r.token,
      status: 'planned',
      decisions: [
        { lineId: 0, action: 'manual', candidate: null, type: 'tv', title: 'Severance' },
        { lineId: 2, action: 'skip', candidate: null, type: 'tv', title: 'Skip me' },
      ],
    });
    expect(res).toMatchObject({ added: 1, skipped: 1, failed: 0 });
    expect(env.f.batches.list()[0]?.itemCount).toBe(1);
  });
  it('offline add never loses input, backs off, and later offers matches for review', async () => {
    let online = false;
    env.http.on('api.tvmaze.com/search/shows', () =>
      online
        ? json([{ show: { id: 7, name: 'Severance', premiered: '2022-02-18' } }])
        : new HttpFailure('network', 'offline'),
    );
    const { itemId } = env.p.import21.addOffline({ title: 'Severance', type: 'tv', year: 2022 });
    expect(env.library.get(itemId).meta.title).toBe('Severance');
    expect(await env.p.import21.processQueue()).toEqual({ finished: 0, waiting: 1 });
    expect(env.p.import21.queue()[0]).toMatchObject({ state: 'waiting', attempts: 1 });
    expect((await env.p.import21.processQueue()).finished).toBe(0); // backoff: not due yet
    online = true;
    env.clock.advance(3 * 60_000);
    expect((await env.p.import21.processQueue()).finished).toBe(1);
    expect(env.p.import21.queue()[0]).toMatchObject({ state: 'found', candidates: [{ title: 'Severance' }] });
    expect(env.db.get('SELECT key FROM app_events WHERE key = ?', ['offline_queue_finished'])).toBeDefined();
    env.p.import21.cancel(env.p.import21.queue()[0]!.id);
    expect(env.library.get(itemId).meta.title).toBe('Severance'); // cancelling keeps the item
  });
});

describe('§16.2 check-up, §16.4 bulk edit, §16.7 rules, §16.3 triage', () => {
  it('detects seeded problems; fixes take a snapshot first; read-only run changes nothing', async () => {
    const a = addItem(env, 'movie', 'Arrival');
    env.db.run('DELETE FROM items_fts');
    env.db.run("UPDATE items SET progress_label = 'bogus' WHERE id = ?", [a.id]);
    mkdirSync(env.ctx.paths.artwork, { recursive: true });
    writeFileSync(join(env.ctx.paths.artwork, `${'a'.repeat(64)}.png`), 'x');
    const before = env.db.get<{ n: number }>('SELECT total_changes() AS n');
    const r = await env.p.maintenance.checkup();
    expect(r.findings.map((f) => f.code).sort()).toEqual(['artworkUnused', 'derived', 'fts']);
    expect(env.db.get<{ label: string }>('SELECT progress_label AS label FROM items')?.label).toBe('bogus');
    void before;
    const fix = await env.p.maintenance.fix(['reindexFts', 'recomputeDerived', 'removeUnusedCache']);
    expect(existsSync(join(env.ctx.paths.backups, fix.snapshot))).toBe(true);
    expect((await env.p.maintenance.checkup()).findings).toEqual([]);
    expect(env.p.maintenance.reportText()).not.toContain('Arrival');
  });
  it('bulk edit previews exceptions, applies in one batch, undoes as one', () => {
    const a = addItem(env, 'movie', 'A');
    const b = addItem(env, 'book', 'B');
    const change = {
      status: 'on_hold' as const,
      rating: 6,
      tags: { mode: 'add' as const, values: ['cozy'] },
      moods: null,
      list: null,
      platform: 'Switch',
    };
    const pv = env.p.maintenance.bulkPreview([a.id, b.id], change);
    expect(pv.exceptions.map((e) => e.reason)).toEqual([
      'Platforms apply to games only.',
      'Platforms apply to games only.',
    ]);
    const noPlatform = { ...change, platform: null };
    const r = env.p.maintenance.bulkApply([a.id, b.id], noPlatform);
    expect(env.library.get(a.id).personal).toMatchObject({ status: 'on_hold', rating: 6, tags: ['cozy'] });
    env.p.history.undoBatch(r.batchId!);
    expect(env.library.get(a.id).personal).toMatchObject({ status: 'planned', rating: null, tags: [] });
    expect(env.library.get(b.id).personal.status).toBe('planned');
  });
  it('rules preview what changes, run as one undoable batch, flag (never delete), suggest only', () => {
    const old = addItem(env, 'game', 'Old game', {
      personal: { status: 'in_progress', dateStarted: '2024-01-01', dateAdded: '2024-01-01' },
    });
    const stale = addItem(env, 'book', 'Stale', { personal: { dateAdded: '2023-01-01' } });
    writeSettings(env.db, {
      autoRules: {
        suggestCompleted: true,
        onHoldAfterDays: { enabled: true, days: 90 },
        stalePlanned: { enabled: true, months: 12 },
        removeFromUpNextOnStart: false,
      },
    });
    const pv = env.p.maintenance.rulePreview();
    expect(pv.find((p) => p.rule === 'onHoldAfterDays')?.items.map((i) => i.title)).toEqual(['Old game']);
    const r = env.p.maintenance.runRules();
    expect(env.library.get(old.id).personal.status).toBe('on_hold');
    expect(env.db.get('SELECT 1 AS x FROM item_flags WHERE item_id = ?', [stale.id])).toBeDefined();
    expect(env.db.get<{ n: number }>('SELECT count(*) AS n FROM items')?.n).toBe(2);
    env.p.history.undoBatch(r.batchId!);
    expect(env.library.get(old.id).personal.status).toBe('in_progress');
    expect(env.p.maintenance.runRules().changed).toBe(1); // idempotent: only the undone change comes back
  });
  it('triage actions return exact undos', () => {
    const a = addItem(env, 'movie', 'A');
    expect(env.p.maintenance.triageQueue('planned', null, []).map((i) => i.title)).toEqual(['A']);
    const u1 = env.p.maintenance.triageAct(a.id, 'upNext', null).undo;
    expect(env.library.get(a.id).upNextPosition).toBe(0);
    env.p.maintenance.triageUndo(u1);
    expect(env.library.get(a.id).upNextPosition).toBeNull();
    const u2 = env.p.maintenance.triageAct(a.id, 'drop', null).undo;
    expect(env.library.get(a.id).personal.status).toBe('dropped');
    env.p.maintenance.triageUndo(u2);
    expect(env.library.get(a.id).personal.status).toBe('planned');
    const u3 = env.p.maintenance.triageAct(a.id, 'snooze', 30).undo;
    expect(env.library.get(a.id).snoozedUntil).toBe('2025-04-09');
    env.p.maintenance.triageUndo(u3);
    expect(env.library.get(a.id).snoozedUntil).toBeNull();
  });
});

describe('§14.7 backup destination check', () => {
  const stat = (map: Record<string, number>) => (p: string) => (p in map ? { dev: map[p]! } : null);
  it('same volume per OS, cloud and removable hints, missing folder, never blocks', () => {
    expect(
      checkBackupDir(
        'C:\\Users\\a\\Backups',
        'C:\\Users\\a\\AppData\\MaybePile',
        'win32',
        stat({ 'C:\\Users\\a\\Backups': 1, 'C:\\Users\\a\\AppData\\MaybePile': 1 }),
      ).sameVolume,
    ).toBe(true);
    expect(
      checkBackupDir('D:\\Backups', 'C:\\data', 'win32', stat({ 'D:\\Backups': 2, 'C:\\data': 1 }))
        .sameVolume,
    ).toBe(false);
    expect(
      checkBackupDir(
        '/home/a/b',
        '/home/a/.config/m',
        'linux',
        stat({ '/home/a/b': 5, '/home/a/.config/m': 5 }),
      ).sameVolume,
    ).toBe(true);
    const cloud = checkBackupDir(
      '/home/a/Dropbox/mp',
      '/x',
      'linux',
      stat({ '/home/a/Dropbox/mp': 9, '/x': 1 }),
    );
    expect(cloud.cloudHint).toBe('Dropbox');
    expect(
      checkBackupDir('/media/usb/mp', '/x', 'linux', stat({ '/media/usb/mp': 3, '/x': 1 })).removableHint,
    ).toBe(true);
    expect(checkBackupDir('/gone', '/x', 'linux', stat({ '/x': 1 }))).toMatchObject({ exists: false });
  });
});

describe('§15 backdrops + storage', () => {
  it('palettes are cached; eviction never removes user-selected or user-added images', () => {
    env.db.run(
      `INSERT INTO artwork (id, source, file_name, thumb_name, remote_url, created_at, user_selected, fetched_at) VALUES
       ('a1', 'cache', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', NULL, 'https://image.tmdb.org/a.png', '2025-01-01', 0, '2025-01-01'),
       ('a2', 'cache', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png', NULL, 'https://image.tmdb.org/b.png', '2025-01-02', 1, '2025-01-02'),
       ('a3', 'user', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png', NULL, NULL, '2025-01-03', 0, '2025-01-03')`,
    );
    mkdirSync(env.ctx.paths.artwork, { recursive: true });
    for (const f of [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png',
    ])
      writeFileSync(join(env.ctx.paths.artwork, f), 'x'.repeat(100));
    const res = env.p.backdrops.clearCache();
    expect(res.evicted).toBe(1);
    expect(readdirSync(env.ctx.paths.artwork).sort()).toEqual([
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png',
    ]);
    expect(env.db.get<{ source: string }>("SELECT source FROM artwork WHERE id = 'a1'")?.source).toBe(
      'remote',
    );
    expect(env.p.backdrops.storage().userBytes).toBe(200);
  });
});

describe('§16.11 multiple libraries', () => {
  it('create / duplicate / switch (relaunch) / delete with snapshot; default and active cannot be deleted', () => {
    addItem(env, 'movie', 'Mine');
    env.p.libraries.create('Family');
    const fam = readRegistry(env.dir).libraries.find((l) => l.name === 'Family')!;
    expect(existsSync(join(env.dir, 'libraries', fam.id))).toBe(true);
    env.p.libraries.duplicate('default');
    expect(env.p.libraries.list()).toHaveLength(3);
    expect(() => env.p.libraries.remove('default')).toThrow(/cannot be deleted/);
    env.p.libraries.switchTo(fam.id);
    expect(env.relaunched).toBe(1);
    expect(readRegistry(env.dir).active).toBe(fam.id);
    const copy = env.p.libraries.list().find((l) => l.name.endsWith('(copy)'))!;
    const r = env.p.libraries.remove(copy.id);
    expect(r.snapshot).toMatch(/^deleted-library-/);
    expect(existsSync(join(env.dir, 'libraries', copy.id))).toBe(false);
  });
});

describe('export / import (formatVersion 4)', () => {
  it('round-trips reminders, extras, trash and settings; background modes are not restored', () => {
    const b = addItem(env, 'book', 'Dune');
    const gone = addItem(env, 'movie', 'Gone');
    env.p.extras21.setNextStep({ itemId: b.id, text: 'chapter 3', spoiler: false });
    env.p.extras21.checklistOp({ op: 'add', itemId: b.id, text: 'Appendix' });
    env.p.extras21.saveLoan({
      id: null,
      itemId: b.id,
      person: 'Sam',
      direction: 'lent',
      loanedOn: '2025-03-01',
      dueOn: null,
      returnedOn: null,
      note: null,
    });
    env.p.extras21.saveJournal({
      id: null,
      itemId: b.id,
      entryDate: '2025-03-01',
      body: 'Great',
      progressLabel: null,
      spoiler: false,
    });
    env.db.run(
      "INSERT INTO reminders (id, item_id, message, kind, anchor_at, anchor_date, local_time, enabled, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', ?, 'Read it', 'once', '2025-03-11T09:00:00.000Z', '2025-03-11', '10:00', 1, 'x', 'x')",
      [b.id],
    );
    writeSettings(env.db, {
      notifications: { ...readSettings(env.db).settings.notifications, mode: 'scheduled' },
    });
    env.library.softDelete([gone.id]);
    const envl = buildJsonExport(env.db, '2.1.0', new Date('2025-03-10T00:00:00Z'));
    expect(ExportEnvelopeSchema.safeParse(envl).success).toBe(true);
    expect(envl.data.items.map((i) => (i as { meta: { title: string } }).meta.title).sort()).toEqual([
      'Dune',
      'Gone',
    ]);
    const sec = Pack21SectionSchema.parse(exportPack21(env.db));

    const target = makePackEnv();
    try {
      const nb = addItem(target, 'book', 'Dune');
      const ng = addItem(target, 'movie', 'Gone');
      const n = importPack21(
        target.db,
        sec,
        new Map([
          [b.id, nb.id],
          [gone.id, ng.id],
        ]),
        '2025-03-10T00:00:00.000Z',
      );
      expect(n).toBeGreaterThan(5);
      expect(target.p.extras21.forItem(nb.id)).toMatchObject({
        nextStep: { text: 'chapter 3' },
        checklist: { total: 1 },
        journalCount: 1,
      });
      expect(target.p.extras21.loans({ itemId: nb.id })[0]?.person).toBe('Sam');
      expect(target.db.get<{ n: number }>('SELECT count(*) AS n FROM reminders')?.n).toBe(1);
      expect(target.p.history.trash().map((t) => t.title)).toEqual(['Gone']);
      expect(readSettings(target.db).settings.notifications.mode).toBe('whileOpen');
    } finally {
      target.cleanup();
    }
  });
});
