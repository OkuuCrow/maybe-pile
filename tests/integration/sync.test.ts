/** Sync folder: two simulated devices sharing one folder (isolated temp DBs, fake clocks). */
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFeatureEnv, type FeatureEnv } from '../helpers/features';
import { tempDir } from '../helpers/db';
import { defaultPersonal, emptyMeta } from '../../src/domain/metadata';
import { decide, localDiff, naturalKey } from '../../src/domain/sync';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function device(folder: string, name: string): FeatureEnv {
  const e = makeFeatureEnv();
  cleanups.push(() => e.cleanup());
  e.f.sync.setFolder(folder, name);
  return e;
}

function add(e: FeatureEnv, title: string, ext?: { kind: string; value: string }) {
  const r = e.library.create({
    type: 'movie',
    meta: { ...emptyMeta(title), releaseDate: '1995', externalIds: ext ? [ext] : [] },
    personal: defaultPersonal('movie', e.library.today()),
    seasons: [],
    milestones: [],
    allowDuplicate: true,
  } as never);
  if (r.kind !== 'created') throw new Error('x');
  return r.item;
}
const byTitle = (e: FeatureEnv, t: string) =>
  e.db.get<{ id: string; status: string; rating: number | null; notes: string; deleted_at: string | null }>(
    'SELECT id, status, rating, notes, deleted_at FROM items WHERE title = ?',
    [t],
  );

describe('sync planning (pure)', () => {
  it('natural keys prefer external ids, then type+title+year', () => {
    expect(
      naturalKey({
        type: 'movie',
        titleKey: 'heat',
        year: 1995,
        externalIds: [
          { kind: 'imdb', value: 'tt1' },
          { kind: 'tmdb', value: '9' },
        ],
      }),
    ).toBe('movie|tmdb:9');
    expect(naturalKey({ type: 'movie', titleKey: 'heat', year: 1995, externalIds: [] })).toBe(
      'movie|t:heat|1995',
    );
  });

  it('three-way decisions: untouched local applies, both changed conflicts, equal is noop, latest remote wins', () => {
    const L = {
      status: 'planned',
      rating: 8,
      notes: 'mine',
      dateStarted: null,
      dateCompleted: null,
      tags: [],
      deleted: false,
    } as const;
    const B = { ...L, notes: 'old' };
    const d = decide(
      [
        { key: 'k', field: 'rating', value: 6, deviceId: 'a', at: '2025-01-01T00:00:00Z', create: null },
        { key: 'k', field: 'rating', value: 4, deviceId: 'b', at: '2025-01-02T00:00:00Z', create: null },
        {
          key: 'k',
          field: 'notes',
          value: 'theirs',
          deviceId: 'a',
          at: '2025-01-01T00:00:00Z',
          create: null,
        },
        {
          key: 'k',
          field: 'status',
          value: 'planned',
          deviceId: 'a',
          at: '2025-01-01T00:00:00Z',
          create: null,
        },
      ],
      () => ({ ...L, tags: [] }),
      () => ({ ...B, tags: [] }),
    );
    expect(d.map((x) => [x.change.field, x.kind, x.change.value])).toEqual([
      ['rating', 'apply', 4],
      ['notes', 'conflict', 'theirs'],
      ['status', 'noop', 'planned'],
    ]);
    expect(localDiff({ ...L, tags: [] }, { ...B, tags: [] })).toEqual({ notes: 'mine' });
  });
});

describe('sync folder with two devices', () => {
  it('propagates creates and edits, previews without writing, reports and resolves conflicts, syncs deletes', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const A = device(t.dir, 'Laptop');
    const B = device(t.dir, 'Desktop');

    // A adds an item and rates it; B gets it.
    const heat = add(A, 'Heat', { kind: 'imdb', value: 'tt0113277' });
    A.library.setRating(heat.id, 9);
    const p0 = A.f.sync.preview();
    expect(p0.outgoing).toBe(1);
    expect(readdirSync(join(t.dir, 'maybe-pile-sync'))).toEqual([]); // dry run wrote nothing
    expect(A.f.sync.apply()).toMatchObject({ sent: 1, applied: 0 });
    const pB = B.f.sync.preview();
    expect(pB.incoming.creates).toBe(1);
    B.f.sync.apply();
    expect(byTitle(B, 'Heat')).toMatchObject({ rating: 9, status: 'planned' });
    expect(B.f.sync.status().otherDevices[0]).toMatchObject({ deviceName: 'Laptop', lastSeq: 1, readSeq: 1 });

    // Re-sync is a no-op both ways (no echo).
    expect(A.f.sync.preview()).toMatchObject({ outgoing: 0, incoming: { apply: 0, creates: 0 } });
    B.f.sync.apply();
    expect(A.f.sync.preview()).toMatchObject({
      outgoing: 0,
      incoming: { apply: 0, creates: 0 },
      conflicts: [],
    });

    // Non-conflicting edits on each side merge field by field.
    const bHeat = byTitle(B, 'Heat')!;
    B.db.run("UPDATE items SET notes = 'rewatch with commentary' WHERE id = ?", [bHeat.id]);
    A.library.setStatus({
      id: heat.id,
      status: 'in_progress',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    A.f.sync.apply();
    B.f.sync.apply();
    A.f.sync.apply();
    expect(byTitle(A, 'Heat')).toMatchObject({ status: 'in_progress', notes: 'rewatch with commentary' });
    expect(byTitle(B, 'Heat')).toMatchObject({ status: 'in_progress', notes: 'rewatch with commentary' });

    // Both change the rating → conflict, nothing silently overwritten.
    A.library.setRating(heat.id, 10);
    B.library.setRating(bHeat.id, 4);
    A.f.sync.apply();
    const conflictPreview = B.f.sync.preview();
    expect(conflictPreview.conflicts).toEqual([
      expect.objectContaining({ title: 'Heat', field: 'rating', local: '4', remote: '10', device: 'Laptop' }),
    ]);
    B.f.sync.apply();
    expect(byTitle(B, 'Heat')?.rating).toBe(4);
    const [c] = B.f.sync.conflicts();
    expect(B.f.sync.status().openConflicts).toBe(1);
    // "Keep mine" on B → B's value is sent and A (unchanged since) adopts it.
    B.f.sync.resolve(c!.id, 'mine');
    B.f.sync.apply();
    A.f.sync.apply();
    expect(byTitle(A, 'Heat')?.rating).toBe(4);
    expect(A.f.sync.conflicts()).toEqual([]);

    // Deletes propagate as soft deletes (undoable locally).
    A.library.softDelete([heat.id]);
    A.f.sync.apply();
    B.f.sync.apply();
    expect(byTitle(B, 'Heat')?.deleted_at).not.toBeNull();

    // Each device only writes its own append-only file; lines are valid JSON.
    const files = readdirSync(join(t.dir, 'maybe-pile-sync'));
    expect(files).toHaveLength(2);
    for (const f of files)
      for (const line of readFileSync(join(t.dir, 'maybe-pile-sync', f), 'utf8')
        .trim()
        .split('\n'))
        expect(() => JSON.parse(line)).not.toThrow();
    expect(readdirSync(A.ctx.paths.backups).some((f) => f.startsWith('pre-sync-'))).toBe(true);
  });

  it('"take theirs" applies the remote value; corrupt lines are skipped with a warning; failures roll back', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const A = device(t.dir, 'A');
    const B = device(t.dir, 'B');
    const x = add(A, 'Ronin');
    A.f.sync.apply();
    B.f.sync.apply();
    const bx = byTitle(B, 'Ronin')!;
    A.db.run("UPDATE items SET notes = 'from A' WHERE id = ?", [x.id]);
    B.db.run("UPDATE items SET notes = 'from B' WHERE id = ?", [bx.id]);
    A.f.sync.apply();
    B.f.sync.apply();
    const [c] = B.f.sync.conflicts();
    B.f.sync.resolve(c!.id, 'theirs');
    expect(byTitle(B, 'Ronin')?.notes).toBe('from A');
    expect(B.f.sync.preview().outgoing).toBe(0);

    // A torn/garbage line in another device's log doesn't break sync.
    const aFile = readdirSync(join(t.dir, 'maybe-pile-sync')).find((f) => f.startsWith(A.f.sync.deviceId()))!;
    appendFileSync(join(t.dir, 'maybe-pile-sync', aFile), '{"v":1,"deviceId":"not-a-uuid"\n');
    expect(B.f.sync.preview().warnings.length).toBeGreaterThan(0);

    // Failure mid-apply rolls the whole transaction back.
    A.db.run("UPDATE items SET notes = 'A again' WHERE id = ?", [x.id]);
    A.f.sync.apply();
    const before = byTitle(B, 'Ronin')?.notes;
    B.db.run(`CREATE TRIGGER boom BEFORE UPDATE OF notes ON items BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => B.f.sync.apply()).toThrow();
    expect(byTitle(B, 'Ronin')?.notes).toBe(before);
    B.db.run('DROP TRIGGER boom');
    B.f.sync.apply();
    expect(byTitle(B, 'Ronin')?.notes).toBe('A again');
  });

  it('refuses to run without a reachable folder', () => {
    const e = makeFeatureEnv();
    cleanups.push(() => e.cleanup());
    expect(() => e.f.sync.preview()).toThrow(/Choose a sync folder/);
  });
});
