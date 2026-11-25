import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../../src/main/services/db-manager';
import { BackupService } from '../../src/main/services/backup-service';
import { ArtworkService, passthroughProcessor } from '../../src/main/services/artwork-service';
import { ImportService } from '../../src/main/services/import-service';
import { buildCsvExport, buildJsonExport } from '../../src/main/services/export-service';
import { LibraryService } from '../../src/main/services/library-service';
import { ProgressService } from '../../src/main/services/progress-service';
import { CustomizationService } from '../../src/main/services/customization-service';
import { CatalogService } from '../../src/main/services/catalog-service';
import { pathsFor, type ServiceContext } from '../../src/main/services/context';
import { MemoryLogger } from '../../src/main/services/logger';
import { parseCsv } from '../../src/domain/csv';
import { PILE_DARK } from '../../src/domain/themes';
import { tempDir } from '../helpers/db';
import { FakeClock, createInput, season } from '../helpers/services';
import { FakeHttp, PNG_1PX } from '../helpers/http';

interface Env {
  dir: string;
  dbm: DatabaseManager;
  ctx: ServiceContext;
  library: LibraryService;
  progress: ProgressService;
  backup: BackupService;
  artwork: ArtworkService;
  importer: ImportService;
  custom: CustomizationService;
  catalog: CatalogService;
  cleanup: () => void;
}

function makeEnv(): Env {
  const t = tempDir();
  const paths = pathsFor(t.dir);
  const log = new MemoryLogger();
  const clock = new FakeClock();
  const dbm = new DatabaseManager(paths, log, () => clock.now());
  dbm.open();
  const ctx: ServiceContext = { db: () => dbm.db, clock, log, paths, appVersion: '1.0.0-test' };
  const library = new LibraryService(ctx);
  const artwork = new ArtworkService(ctx, passthroughProcessor, new FakeHttp());
  return {
    dir: t.dir,
    dbm,
    ctx,
    library,
    progress: new ProgressService(ctx, library),
    artwork,
    backup: new BackupService(ctx, dbm, artwork),
    importer: new ImportService(ctx, library),
    custom: new CustomizationService(ctx),
    catalog: new CatalogService(ctx),
    cleanup: () => {
      dbm.close();
      t.cleanup();
    },
  };
}

let env: Env;
let other: Env;
beforeEach(() => {
  env = makeEnv();
  other = makeEnv();
});
afterEach(() => {
  env.cleanup();
  other.cleanup();
});

function add(e: Env, ...args: Parameters<typeof createInput>) {
  const r = e.library.create(createInput(...args));
  if (r.kind !== 'created') throw new Error('dup');
  return r.item;
}

/** Populates a varied library: all types, progress, viewings, episodes, milestones, custom fields, series, theme, layout, artwork. */
function seed(e: Env) {
  const [def] = e.catalog.saveCustomField({
    id: null,
    name: 'Format owned',
    type: 'select',
    options: ['Blu-ray', 'Digital'],
  });
  const m = add(e, 'movie', 'Arrival', {
    meta: { releaseDate: '2016', externalIds: [{ kind: 'imdb', value: 'tt2543164' }] },
    personal: { rating: 9, tags: ['sci-fi'], customFields: [{ defId: def?.id ?? '', value: 'Blu-ray' }] },
  });
  e.progress.addViewing({ itemId: m.id, watchedAt: '2024-01-01T20:00:00.000Z', note: 'first' });
  const t = add(e, 'tv', 'Severance', { seasons: [season(1, 3)], personal: { status: 'in_progress' } });
  e.progress.toggleEpisodes({
    itemId: t.id,
    episodeIds: [t.seasons[0]?.episodes[0]?.id ?? ''],
    watched: true,
    scope: 'episode',
  });
  const g = add(e, 'game', 'Hades', {
    personal: { gameScheme: 'milestones' },
    milestones: ['Tartarus', 'Asphodel'],
  });
  e.progress.add({
    itemId: g.id,
    entry: { kind: 'milestone', milestoneId: g.milestones[0]?.id ?? '' },
    occurredAt: null,
    note: 'yay',
  });
  const b = add(e, 'book', 'Piranesi', { meta: { pageCount: 272 }, personal: { notes: 'House of statues' } });
  e.progress.add({ itemId: b.id, entry: { kind: 'pages', value: 100 }, occurredAt: null, note: null });
  const [series] = e.catalog.saveSeries({
    id: null,
    name: 'Standalones',
    description: null,
    totalKnown: null,
  });
  e.catalog.setMembership(series?.id ?? '', b.id, 1, true);
  e.custom.saveTheme({ id: null, name: 'Night', tokens: PILE_DARK });
  e.custom.setLayout('dashboard', [{ id: 'tags', visible: true, span: 2 }]);
  const art = e.artwork.storeBytes(PNG_1PX, 'user', null, null);
  e.artwork.setItemArtwork(b.id, art);
  return { m, t, g, b };
}

const strip = (env: ReturnType<typeof buildJsonExport>) => ({ ...env, exportedAt: 'x' });

describe('JSON export/import', () => {
  it('round-trips a full library with equality', () => {
    seed(env);
    const exported = buildJsonExport(env.ctx.db(), '1.0.0-test', new Date());
    const text = JSON.stringify(exported);
    // the export never contains absolute paths
    expect(text).not.toContain(env.dir.replace(/\\/g, '\\\\'));
    const preview = other.importer.previewJson(text, 'export.json');
    expect(preview.messages.filter((m) => m.severity === 'error')).toEqual([]);
    expect(preview.canApply).toBe(true);
    expect(preview.incoming.items).toEqual({ movie: 1, tv: 1, game: 1, book: 1, anime: 0 });
    expect(preview.conflicts).toEqual([]);
    const r = other.importer.apply({
      token: preview.token,
      defaultResolution: 'skip',
      resolutions: {},
      confirmation: '',
    });
    expect(r).toMatchObject({ added: 4, skipped: 0 });
    const again = buildJsonExport(other.ctx.db(), '1.0.0-test', new Date());
    // Artwork binaries are not part of JSON; the reference is dropped when the file isn't present.
    const norm = (e: typeof exported) => ({
      ...strip(e),
      data: {
        ...e.data,
        items: (e.data.items as { artwork: unknown }[]).map((i) => ({ ...i, artwork: null })),
      },
      counts: { ...e.counts },
    });
    expect(norm(again).data.items).toEqual(norm(exported).data.items);
    expect(again.data.customFieldDefs).toEqual(exported.data.customFieldDefs);
    expect(again.data.series.map((s) => s.members.length)).toEqual([1]);
    expect(again.data.themes.map((t) => t.name)).toEqual(['Night']);
  });

  it('detects conflicts and applies skip / duplicate / update (never overwriting newer local edits)', () => {
    const { m } = seed(env);
    const text = JSON.stringify(buildJsonExport(env.ctx.db(), 'v', new Date()));
    env.ctx.clock.now = () => new Date('2030-01-01T00:00:00Z'); // local edits are newer
    env.library.update({
      id: m.id,
      personal: { ...env.library.get(m.id).personal, notes: 'newer local note' },
    });
    const p = env.importer.previewJson(text, 'x.json');
    expect(p.conflicts).toHaveLength(4);
    expect(p.conflicts.every((c) => c.reason === 'local-id')).toBe(true);
    const movieConflict = p.conflicts.find((c) => c.existingId === m.id);
    expect(movieConflict?.importIsNewer).toBe(false);
    const r = env.importer.apply({
      token: p.token,
      defaultResolution: 'update',
      resolutions: { [movieConflict?.id ?? '']: 'duplicate' },
      confirmation: '',
    });
    expect(r.duplicated).toBe(1);
    expect(env.library.get(m.id).personal.notes).toBe('newer local note');
    const dupes = env.library.query({ ...await_default(), text: 'arrival' });
    expect(dupes.total).toBe(2);
  });

  it('rejects invalid input with paths and changes nothing', () => {
    const before = env.library.dashboard().total;
    const bad = [
      ['{', /not valid JSON/],
      [JSON.stringify({ format: 'other' }), /not a Maybe Pile export/],
      [JSON.stringify({ format: 'maybepile-export', formatVersion: 99 }), /version 99/],
    ] as const;
    for (const [text, re] of bad) {
      const p = env.importer.previewJson(text, 'bad.json');
      expect(p.canApply).toBe(false);
      expect(p.messages[0]?.message).toMatch(re);
    }
    const env2 = buildJsonExport(env.ctx.db(), 'v', new Date());
    const broken = { ...env2, data: { ...env2.data, items: [{ id: 'not-a-uuid', type: 'movie' }] } };
    const p = env.importer.previewJson(JSON.stringify(broken), 'bad.json');
    expect(p.canApply).toBe(false);
    expect(p.messages[0]?.path).toMatch(/^\$\.data\.items\[0\]/);
    expect(env.library.dashboard().total).toBe(before);
  });

  it('a failure mid-import rolls back everything', () => {
    seed(env);
    const text = JSON.stringify(buildJsonExport(env.ctx.db(), 'v', new Date()));
    const p = other.importer.previewJson(text, 'x.json');
    expect(() =>
      other.importer.apply(
        { token: p.token, defaultResolution: 'skip', resolutions: {}, confirmation: '' },
        { failAfterItems: 2 },
      ),
    ).toThrow(/Injected/);
    expect(other.library.dashboard().total).toBe(0);
    expect(other.ctx.db().foreignKeyViolations()).toBe(0);
  });
});

function await_default() {
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
    limit: 100,
    listId: null,
    upNextOnly: false,
    health: null,
  };
}

describe('CSV export/import', () => {
  it('exports one row per item with formula-injection protection', () => {
    add(env, 'book', '=HYPERLINK("http://evil")', {
      personal: { notes: '+danger', tags: ['a', 'b'] },
      meta: { creators: [{ name: 'Ann Leckie', role: 'author' }] },
    });
    const csv = buildCsvExport(env.ctx.db(), true);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(csv);
    const header = rows[0] ?? [];
    const row = rows[1] ?? [];
    expect(row[header.indexOf('title')]).toBe('\'=HYPERLINK("http://evil")');
    expect(row[header.indexOf('notes')]).toBe("'+danger");
    expect(row[header.indexOf('tags')]).toBe('a; b');
    expect(row[header.indexOf('creators')]).toBe('Ann Leckie (Author)');
  });

  it('imports CSV (round-trip of core fields) with row-level validation', () => {
    seed(env);
    const csv = buildCsvExport(env.ctx.db(), false);
    const p = other.importer.previewCsv(csv, 'lib.csv');
    expect(p.messages.filter((m) => m.severity === 'error')).toEqual([]);
    expect(p.incoming.items).toEqual({ movie: 1, tv: 1, game: 1, book: 1, anime: 0 });
    other.importer.apply({ token: p.token, defaultResolution: 'skip', resolutions: {}, confirmation: '' });
    const page = other.library.query(await_default());
    expect(page.items.map((i) => i.title)).toEqual(['Arrival', 'Hades', 'Piranesi', 'Severance']);
    const arrival = other.library.get(page.items[0]?.id ?? '');
    expect(arrival.personal.rating).toBe(9);
    expect(arrival.meta.externalIds).toEqual([{ kind: 'imdb', value: 'tt2543164' }]);
    expect(arrival.provenance.title?.origin).toBe('manual-entry');

    const bad = other.importer.previewCsv(
      'type,title,status,rating_stars\nmovie,,planned,\nspaceship,X,planned,\nbook,Y,reading,\nbook,Z,planned,7\n',
      'bad.csv',
    );
    expect(bad.canApply).toBe(false);
    expect(bad.messages.map((m) => m.path)).toEqual([
      'row 2, title',
      'row 3, type',
      'row 4, status',
      'row 5, rating_stars',
    ]);
    expect(other.importer.previewCsv('name\nx\n', 'x.csv').messages[0]?.message).toMatch(/type.*title/);
    expect(other.importer.previewCsv('type,title\n"unterminated', 'x.csv').messages[0]?.message).toMatch(
      /truncated/,
    );
  });
});

describe('full backup and restore', () => {
  it('round-trips via .mpbackup with artwork, settings, themes and layouts', () => {
    const { b } = seed(env);
    const file = join(env.dir, 'my.mpbackup');
    const res = env.backup.createBackup(file, { overwrite: false });
    expect(res.fileLabel).toBe('my.mpbackup');
    expect(() => env.backup.createBackup(file, { overwrite: false })).toThrow(/already exists/);
    // archive layout uses relative POSIX paths only
    const names = Object.keys(unzipSync(readFileSync(file)));
    expect(names.every((n) => !n.includes('\\') && !n.startsWith('/') && !/^[A-Za-z]:/.test(n))).toBe(true);
    expect(names).toContain('manifest.json');

    add(other, 'movie', 'Will be replaced');
    const p = other.backup.previewRestore(file);
    expect(p.messages.filter((m) => m.severity === 'error')).toEqual([]);
    expect(p).toMatchObject({ mode: 'replace', canApply: true, confirmationWord: 'RESTORE' });
    expect(p.current.items.movie).toBe(1);
    expect(p.incoming.items).toEqual({ movie: 1, tv: 1, game: 1, book: 1, anime: 0 });
    expect(() => other.backup.applyRestore(p.token, 'yes')).toThrow(/Type RESTORE/);
    const r = other.backup.applyRestore(p.token, 'RESTORE');
    expect(r.snapshotLabel).toMatch(/^pre-restore-.*\.mpbackup$/);
    expect(existsSync(join(other.dir, 'backups', r.snapshotLabel ?? ''))).toBe(true);
    const restored = other.library.get(b.id);
    expect(restored.personal.notes).toBe('House of statues');
    expect(restored.progress.label).toBe('100 of 272 pages');
    expect(restored.artwork?.source).toBe('user');
    expect(other.artwork.resolveFile(restored.artwork?.fullUrl.split('/').pop() ?? '')).not.toBeNull();
    expect(other.custom.listThemes().some((t) => t.name === 'Night')).toBe(true);
    expect(other.custom.layouts().dashboard[0]?.id).toBe('tags');
    expect(other.library.query({ ...await_default(), text: 'replaced' }).total).toBe(0);
    expect(other.library.query({ ...await_default(), text: 'statues' }).total).toBe(1); // FTS present
  });

  it('a restored backup gets a fresh sync identity with sync turned off', () => {
    seed(env);
    env.dbm.db.run(
      "INSERT INTO sync_state (key, value) VALUES ('device_id', '11111111-1111-4111-8111-111111111111')",
    );
    env.dbm.db.run(
      `INSERT INTO settings (key, value) VALUES ('sync', '{"enabled":true,"folder":"C:/elsewhere","deviceName":"Old"}')`,
    );
    const file = join(env.dir, 'sync.mpbackup');
    env.backup.createBackup(file, { overwrite: false });
    const p = other.backup.previewRestore(file);
    other.backup.applyRestore(p.token, 'RESTORE');
    expect(other.dbm.db.all('SELECT * FROM sync_state')).toEqual([]);
    expect(other.dbm.db.get("SELECT value FROM settings WHERE key = 'sync'")).toBeUndefined();
  });

  it('pre-restore snapshot can itself be restored (undo)', () => {
    seed(env);
    const file = join(env.dir, 'a.mpbackup');
    env.backup.createBackup(file, { overwrite: false });
    add(other, 'movie', 'Original');
    const p = other.backup.previewRestore(file);
    const r = other.backup.applyRestore(p.token, 'RESTORE');
    const snap = join(other.dir, 'backups', r.snapshotLabel ?? '');
    const undo = other.backup.previewRestore(snap);
    other.backup.applyRestore(undo.token, 'RESTORE');
    expect(other.library.query(await_default()).items.map((i) => i.title)).toEqual(['Original']);
  });

  it('injected failure mid-restore leaves the original library intact', () => {
    seed(env);
    const file = join(env.dir, 'a.mpbackup');
    env.backup.createBackup(file, { overwrite: false });
    const keep = add(other, 'movie', 'Keep me', { personal: { notes: 'precious' } });
    const art = other.artwork.storeBytes(PNG_1PX, 'user', null, null);
    other.artwork.setItemArtwork(keep.id, art);
    for (const step of [1, 2, 3, 4]) {
      const p = other.backup.previewRestore(file);
      expect(() => other.backup.applyRestore(p.token, 'RESTORE', { failAtStep: step })).toThrow(
        /left exactly as it was/,
      );
      const still = other.library.get(keep.id);
      expect(still.personal.notes).toBe('precious');
      expect(other.artwork.resolveFile(still.artwork?.fullUrl.split('/').pop() ?? '')).not.toBeNull();
      expect(other.library.query(await_default()).total).toBe(1);
    }
    expect(readdirSync(other.dir).filter((f) => f.includes('restore-old'))).toEqual([]);
  });

  describe('rejects bad archives without touching the library', () => {
    const write = (name: string, files: Record<string, Uint8Array>) => {
      const p = join(env.dir, name);
      writeFileSync(p, zipSync(files));
      return p;
    };
    const makeBackup = (name: string) => {
      const p = join(env.dir, name);
      env.backup.createBackup(p, { overwrite: true });
      return p;
    };

    it('checksum mismatch', () => {
      seed(env);
      const files = unzipSync(readFileSync(makeBackup('good.mpbackup')));
      const db = files['library.sqlite'];
      if (db) db[200] = (db[200] ?? 0) ^ 0xff;
      const p = env.backup.previewRestore(write('tampered.mpbackup', files));
      expect(p.canApply).toBe(false);
      expect(p.messages.at(-1)?.message).toMatch(/Checksum mismatch/);
    });
    it('truncated / not a zip', () => {
      seed(env);
      const full = readFileSync(makeBackup('full.mpbackup'));
      const p1 = join(env.dir, 'trunc.mpbackup');
      writeFileSync(p1, full.subarray(0, Math.floor(full.length / 2)));
      expect(env.backup.previewRestore(p1).messages.at(-1)?.message).toMatch(/damaged or truncated/);
      const p2 = join(env.dir, 'text.mpbackup');
      writeFileSync(p2, 'hello');
      expect(env.backup.previewRestore(p2).canApply).toBe(false);
    });
    it('path traversal and unexpected entries', () => {
      for (const name of [
        '../evil.txt',
        '/abs.txt',
        'artwork/../../x.jpg',
        'C:/win.txt',
        'artwork\\x.jpg',
        'extra.exe',
      ]) {
        const p = env.backup.previewRestore(
          write(`trav${Math.random()}.mpbackup`, { 'manifest.json': strToU8('{}'), [name]: strToU8('x') }),
        );
        expect(p.canApply).toBe(false);
        expect(p.messages.at(-1)?.message).toMatch(/Unsafe path|Unexpected file/);
      }
    });
    it('unsupported (newer) format and schema versions', () => {
      const m = (v: Record<string, unknown>) =>
        strToU8(
          JSON.stringify({
            format: 'maybepile-backup',
            formatVersion: 1,
            appVersion: 'x',
            schemaVersion: 1,
            createdAt: 'x',
            counts: {},
            artworkCount: 0,
            secretsIncluded: false,
            files: [],
            ...v,
          }),
        );
      expect(
        env.backup
          .previewRestore(write('v.mpbackup', { 'manifest.json': m({ formatVersion: 7 }) }))
          .messages.at(-1)?.message,
      ).toMatch(/format version 7/);
      expect(
        env.backup
          .previewRestore(write('s.mpbackup', { 'manifest.json': m({ schemaVersion: 99 }) }))
          .messages.at(-1)?.message,
      ).toMatch(/newer Maybe Pile/);
      expect(
        env.backup.previewRestore(write('n.mpbackup', { 'manifest.json': strToU8('nope') })).messages.at(-1)
          ?.message,
      ).toMatch(/manifest/);
    });
    it('does not change the current library', () => {
      const a = add(env, 'movie', 'Untouched');
      env.backup.previewRestore(write('x.mpbackup', { 'manifest.json': strToU8('{}') }));
      expect(env.library.get(a.id).meta.title).toBe('Untouched');
    });
  });
});

describe('themes and layouts persistence', () => {
  it('persist across restart, fall back on a corrupt active theme, and reset', () => {
    const t = env.custom.saveTheme({ id: null, name: 'Mine', tokens: PILE_DARK });
    env.custom.patchSettings({ activeThemeId: t.id });
    env.custom.setLayout('library', [{ id: 'sort', visible: false, span: 1 }]);
    env.dbm.close();
    env.dbm.open();
    expect(env.custom.activeTheme()).toMatchObject({ selectedId: t.id, followSystem: false, notice: null });
    expect(env.custom.layouts().library[0]).toEqual({ id: 'sort', visible: false, span: 1 });
    // corrupt the stored theme
    env.ctx.db().run('UPDATE themes SET tokens = \'{"colors":{}}\' WHERE id = ?', [t.id]);
    const fb = env.custom.activeTheme();
    expect(fb.selectedId).toBe('pile-light');
    expect(fb.notice).toMatch(/damaged/);
    // built-ins are read-only; duplicate works
    expect(() => env.custom.saveTheme({ id: 'pile-dark', name: 'x', tokens: PILE_DARK })).toThrow(
      /read-only/,
    );
    expect(env.custom.duplicateTheme('pile-dark').name).toBe('Pile Dark copy');
    env.custom.resetThemes(true);
    expect(env.custom.listThemes().map((x) => x.id)).toEqual(['system', 'pile-light', 'pile-dark']);
    expect(env.custom.resetLayout('both').library[0]?.id).toBe('search');
  });

  it('imports/exports theme and layout files, reporting validation errors', () => {
    const exported = env.custom.exportTheme('pile-dark');
    expect(exported.fileName).toBe('Pile-Dark.mptheme.json');
    expect(env.custom.importTheme(exported.text).name).toBe('Pile Dark (2)');
    expect(() =>
      env.custom.importTheme('{"format":"maybepile-theme","schemaVersion":1,"name":"x","tokens":{}}'),
    ).toThrow(/not valid/);
    const lay = env.custom.importLayout(readFileSync('examples/focused.mplayout.json', 'utf8'));
    expect(lay.dashboard[0]?.id).toBe('upNext');
    const partial = env.custom.importLayout(
      JSON.stringify({
        format: 'maybepile-layout',
        schemaVersion: 1,
        dashboard: [{ id: 'tags', visible: true }],
        library: [],
      }),
    );
    expect(partial.notices.length).toBeGreaterThan(0);
    expect(JSON.parse(env.custom.exportLayout().text).format).toBe('maybepile-layout');
  });
});

describe('settings are never exported with secrets', () => {
  it('JSON export settings contain no key-like fields', () => {
    const e = buildJsonExport(env.ctx.db(), 'v', new Date());
    expect(Object.keys(e.data.settings).join(',')).not.toMatch(/key|secret|token/i);
  });
});
