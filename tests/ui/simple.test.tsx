/**
 * Simple Mode (§13): navigation, first run, omnibox, one-tap progress with undo,
 * reminders card + confirmation dialog, mode switching, hidden types, a11y,
 * and the scripted click/keystroke budget walkthrough (docs/simple-mode.md).
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { readSettings, writeSettings } from '../../src/db/repositories/config-repo';
import { expectNoAxeViolations, installBridge, renderApp, seed, type UiEnv } from './harness';
import { json } from '../helpers/http';
import type { Db } from '../../src/db/connection';

let env: UiEnv | null = null;
afterEach(() => {
  cleanup();
  env?.cleanup();
  env = null;
});

/** Counts user actions (clicks + Enter presses). Typed characters are counted separately. */
function budget() {
  let actions = 0;
  let keys = 0;
  const user = userEvent.setup();
  return {
    click: async (el: Element) => (actions++, user.click(el)),
    enter: async () => (actions++, user.keyboard('{Enter}')),
    type: async (el: Element, text: string) => ((keys += text.length), user.type(el, text)),
    get actions() {
      return actions;
    },
    get keys() {
      return keys;
    },
  };
}

const navLinks = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .queryAllByRole('link')
    .map((a) => a.textContent?.trim());

describe('Simple Mode basics', () => {
  it('a new install starts in Simple Mode with a 3-step skippable first run', async () => {
    env = installBridge({ level: 'simple', firstRun: true });
    const user = userEvent.setup();
    renderApp();
    const dialog = await screen.findByRole('dialog', {
      name: /Welcome to Maybe Pile — What do you want to track\?/,
    });
    await expectNoAxeViolations();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Games' }));
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await screen.findByRole('dialog', { name: /Choose a look/ });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('dialog', { name: /All set/ });
    expect(within(screen.getByRole('dialog')).getByText(/stays on this computer/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(navLinks()).toEqual(['Home', 'Library', 'Settings']);
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Add item' })).toBeTruthy();
  });

  it('Skip finishes the first run on every step', async () => {
    env = installBridge({ level: 'simple', firstRun: true });
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('dialog', { name: /Welcome/ });
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const e = env;
    await waitFor(() => expect(readSettings(dbOf(e)).settings.interface.firstRunDone).toBe(true));
  });

  it('Full mode adds a More group; advanced items are absent in Simple', async () => {
    env = installBridge({ level: 'full' });
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.getByText('More')).toBeTruthy();
    await user.click(screen.getByText('More'));
    expect(navLinks()).toEqual(
      expect.arrayContaining(['Lists', 'Stats', 'Import', 'Cover wall', 'Triage', 'Recent changes']),
    );
    cleanup();
    writeSettings(dbOf(env), {
      interface: { ...readSettings(dbOf(env)).settings.interface, level: 'simple' },
    });
    renderApp();
    await screen.findByRole('heading', { name: 'Home' });
    expect(screen.queryByText('More')).toBeNull();
    expect(navLinks()).toEqual(['Home', 'Library', 'Settings']);
  });

  it('a11y: Simple Home, Library, item detail, Add and Settings have no axe violations', async () => {
    env = installBridge({ level: 'simple' });
    const s = seed(env);
    const user = userEvent.setup();
    renderApp('#/dashboard');
    await screen.findByRole('heading', { name: 'Continue' });
    await expectNoAxeViolations();
    cleanup();
    renderApp('#/library');
    await screen.findByRole('tab', { name: 'All' });
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull();
    await expectNoAxeViolations();
    cleanup();
    renderApp(`#/item/${s.book.id}`);
    await screen.findByRole('heading', { name: 'Piranesi', level: 1 });
    expect(screen.getAllByText('More details').length).toBeGreaterThan(0);
    await expectNoAxeViolations();
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Add item' }));
    await screen.findByRole('dialog', { name: 'Add an item' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Add', 'Paste a list']);
    await expectNoAxeViolations();
    cleanup();
    renderApp('#/settings/appearance');
    await screen.findByRole('heading', { name: 'Appearance', level: 2 });
    const sections = within(screen.getByRole('navigation', { name: 'Settings sections' }))
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(sections).toEqual(['Appearance', 'Interface', 'Reminders', 'Data sources', 'Backup & restore']);
    await expectNoAxeViolations();
  });
});

describe('omnibox, one-tap progress, undo', () => {
  it('finds existing items first and offers “Add X”; Enter does the obvious thing', async () => {
    env = installBridge({ level: 'simple' });
    seed(env);
    const user = userEvent.setup();
    renderApp();
    const box = await screen.findByRole('combobox', { name: /Search your library or add/ });
    await user.type(box, 'Arr');
    await waitFor(() => expect(screen.getAllByRole('option')[0]?.textContent).toMatch(/^Arrival/));
    const opts = screen.getAllByRole('option');
    expect(opts.at(-1)?.textContent).toMatch(/Add “Arr” to Maybe Pile/);
    await user.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Arrival', level: 1 });
  });

  it('+1 episode from Continue, then Undo (keyboard reachable, announced)', async () => {
    env = installBridge({ level: 'simple' });
    const s = seed(env);
    env.library.setStatus({
      id: s.tv.id,
      status: 'in_progress',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    const user = userEvent.setup();
    renderApp();
    const btn = await screen.findByRole('button', { name: '+1 episode: Severance' });
    await user.click(btn);
    const status = await screen.findByText('Watched S1E1.');
    expect(status.closest('[role="status"]')).toBeTruthy();
    expect(env.library.get(s.tv.id).progress.label).toBe('1 of 2 episodes');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(env?.library.get(s.tv.id).progress.label).not.toBe('1 of 2 episodes'));
  });

  it('hidden types with items stay visible as tabs', async () => {
    env = installBridge({ level: 'simple' });
    seed(env);
    writeSettings(dbOf(env), {
      interface: { ...readSettings(dbOf(env)).settings.interface, hiddenTypes: ['book', 'anime'] },
    });
    renderApp('#/library');
    await screen.findByRole('tab', { name: 'All' });
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toContain('Books')); // Piranesi exists, so Books stays
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).not.toContain('Anime');
  });

  it('switching Simple ↔ Full keeps data, theme and reminder settings', async () => {
    env = installBridge({ level: 'simple' });
    seed(env);
    const db = dbOf(env);
    writeSettings(db, { activeThemeId: 'pile-dark' });
    const before = readSettings(db).settings;
    const user = userEvent.setup();
    renderApp('#/settings/interface');
    await user.click(await screen.findByRole('radio', { name: /^Full/ }));
    await waitFor(() => expect(readSettings(db).settings.interface.level).toBe('full'));
    const after = readSettings(db).settings;
    expect(after.activeThemeId).toBe(before.activeThemeId);
    expect(after.notifications).toEqual(before.notifications);
    expect(env.library.query({ ...before.libraryQuery, offset: 0, limit: 50 }).total).toBe(4);
  });
});

describe('reminders card (Simple) and confirmation dialog', () => {
  it('turn on, choose “works when closed”, and the dialog lists exactly what is created', async () => {
    env = installBridge({ level: 'simple' });
    const user = userEvent.setup();
    renderApp('#/settings/notifications');
    expect(await screen.findByRole('heading', { name: 'Reminders', level: 3 })).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: /Reminders/ }));
    await waitFor(() => expect(readSettings(dbOf(env!)).settings.notifications.mode).toBe('whileOpen'));
    expect(readSettings(dbOf(env)).settings.notifications.preset).toBe('sometimes');
    await user.click(await screen.findByRole('radio', { name: /let my computer check/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Set up background reminders?' });
    const listed = within(dialog)
      .getAllByRole('code')
      .map((c) => c.textContent);
    const planned = env.notifications
      .plan({ ...readSettings(dbOf(env)).settings.notifications, mode: 'scheduled' })
      .map((c) => c.location);
    for (const loc of planned) expect(listed).toContain(loc);
    await expectNoAxeViolations();
    await user.click(within(dialog).getByRole('button', { name: /Create these 3/ }));
    await waitFor(() => expect(readSettings(dbOf(env!)).settings.notifications.mode).toBe('scheduled'));
    for (const loc of planned) expect(env.installerFs.has(loc)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Remove background components' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect([...env!.installerFs.keys()]).toEqual(['/opt/app/helper.cjs']));
  });

  it('a fresh install creates nothing in the background', async () => {
    env = installBridge({ level: 'simple' });
    renderApp('#/settings/notifications');
    await screen.findByRole('switch', { name: /Reminders/ });
    expect(readSettings(dbOf(env)).settings.notifications.mode).toBe('off');
    expect([...env.installerFs.keys()]).toEqual(['/opt/app/helper.cjs']);
    expect(env.shown).toEqual([]);
  });
});

describe('click / keystroke budgets (docs/simple-mode.md)', () => {
  it('add with online search ≤ 4 actions; update progress ≤ 2; find ≤ 3 keys; change status ≤ 2; backup ≤ 3', async () => {
    env = installBridge({ level: 'simple' });
    const s = seed(env);
    env.library.setStatus({
      id: s.book.id,
      status: 'in_progress',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    env.http.on('api.tvmaze.com/search/shows', () =>
      json([{ show: { id: 5, name: 'Andor', premiered: '2022-09-21' } }]),
    );
    env.http.on('api.tvmaze.com/shows/5', () =>
      json({ id: 5, name: 'Andor', premiered: '2022-09-21', _embedded: { episodes: [], seasons: [] } }),
    );
    renderApp();

    // 1) Add with online search.
    let b = budget();
    await b.click(within(await screen.findByRole('banner')).getByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an item' });
    await b.type(within(dialog).getByLabelText('What do you want to add?'), 'Andor');
    await b.click(within(dialog).getByRole('radio', { name: /^TV/ }));
    await b.click(within(dialog).getByRole('button', { name: 'Search' }));
    await b.click(await within(dialog).findByRole('button', { name: /Andor/ }));
    await screen.findByRole('heading', { name: 'Andor', level: 1 });
    expect(b.actions).toBeLessThanOrEqual(4);

    // 2) Update progress from Home.
    window.location.hash = '#/dashboard';
    b = budget();
    await b.click(await screen.findByRole('button', { name: '+10 pages: Piranesi' }));
    await screen.findByText(/Now on page 10/);
    expect(b.actions).toBeLessThanOrEqual(2);

    // 3) Find an existing item: ≤ 3 keystrokes after focusing search.
    b = budget();
    const box = screen.getByRole('combobox', { name: /Search your library or add/ });
    await b.type(box, 'Pir');
    await waitFor(() => expect(screen.getAllByRole('option')[0]?.textContent).toMatch(/^Piranesi/));
    expect(b.keys).toBeLessThanOrEqual(3);
    await b.enter();

    // 4) Change status ≤ 2 actions (from Home's Continue card menu).
    await screen.findByRole('heading', { name: 'Piranesi', level: 1 });
    window.location.hash = '#/dashboard';
    await screen.findByRole('heading', { name: 'Home', level: 1 });
    b = budget();
    await b.click(await screen.findByRole('button', { name: 'More actions for Piranesi' }));
    await b.click(screen.getByRole('menuitem', { name: 'Put on hold' }));
    await waitFor(() => expect(env?.library.get(s.book.id).personal.status).toBe('on_hold'));
    expect(b.actions).toBeLessThanOrEqual(2);

    // 5) Create a backup ≤ 3 actions from Home.
    b = budget();
    await b.click(screen.getByRole('link', { name: 'Settings' }));
    await b.click(await screen.findByRole('link', { name: 'Backup & restore' }));
    await b.click(await screen.findByRole('button', { name: /Create (a )?(full )?backup/i }));
    expect(b.actions).toBeLessThanOrEqual(3);
  });
});

function dbOf(e: UiEnv) {
  // The harness keeps the live DB behind the services; LibraryService exposes the context.
  return (e.library as unknown as { ctx: { db(): Db } }).ctx.db();
}
