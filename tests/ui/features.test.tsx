import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json } from '../helpers/http';
import { buildCommands } from '../../src/renderer/features/palette/CommandPalette';
import { guessType } from '../../src/renderer/features/palette/QuickCapture';
import { expectNoAxeViolations, installBridge, renderApp, seed, type UiEnv } from './harness';

let env: UiEnv;
beforeEach(() => {
  env = installBridge();
});
afterEach(() => {
  cleanup();
  env.cleanup();
});

const KEY = '0123456789ABCDEF0123456789ABCDEF';

function steamSource(games: { appid: number; name: string; playtime_forever?: number }[]) {
  env.http.on('GetOwnedGames', () => json({ response: { game_count: games.length, games } }));
  const list = env.features.sources.saveSteam({
    sourceId: null,
    label: 'My Steam',
    account: '76561197960287930',
    apiKey: KEY,
  });
  return list[0]?.id ?? '';
}

describe('Steam review screen', () => {
  it('a11y: unplayed by default, keyboard multi-select, ignore, import with confirmation', async () => {
    const user = userEvent.setup();
    const id = steamSource([
      { appid: 1, name: 'Alpha', playtime_forever: 0 },
      { appid: 2, name: 'Beta', playtime_forever: 0 },
      { appid: 3, name: 'Gamma', playtime_forever: 0 },
      { appid: 4, name: 'Delta', playtime_forever: 600 },
      { appid: 5, name: 'Delta Soundtrack', playtime_forever: 0 },
    ]);
    await env.features.sources.waitFor(env.features.sources.startFetch(id).jobId);
    renderApp('#/import/sources');
    const list = await screen.findByRole('listbox', { name: /My Steam games/ });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label')?.split('.')[0])).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    await expectNoAxeViolations();

    list.focus();
    await user.keyboard('{ArrowDown}'); // focus moves to row 0 on focus, then row 1
    await user.keyboard(' ');
    expect(within(list).getByRole('option', { name: /^Beta/ }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(
      within(list)
        .getByRole('option', { name: /^Gamma/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText(/selected/, { selector: '.bulk-bar span' }).textContent).toMatch(/^2 selected/);
    await user.keyboard('{Control>}a{/Control}');
    expect(
      within(list)
        .getAllByRole('option')
        .every((o) => o.getAttribute('aria-selected') === 'true'),
    ).toBe(true);

    // Ignore the focused row with "I"
    await user.keyboard('i');
    await waitFor(() =>
      expect(within(screen.getByRole('listbox')).queryByRole('option', { name: /^Gamma/ })).toBeNull(),
    );

    // Import the remaining selection (Alpha, Beta)
    await user.click(screen.getByRole('button', { name: 'Import selected…' }));
    const dlg = await screen.findByRole('dialog', { name: /Import 2 game/ });
    await expectNoAxeViolations(dlg);
    await user.click(within(dlg).getByRole('button', { name: 'Review…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Import these games?' });
    expect(confirm.textContent).toMatch(/Add 2 game\(s\) as Planned, tag “steam”/);
    await user.click(within(confirm).getByRole('button', { name: 'Import' }));
    const result = await screen.findByRole('dialog', { name: 'Import finished' });
    expect(result.textContent).toMatch(/2\s*added/);
    expect(within(result).getByRole('button', { name: 'Undo this import' })).toBeTruthy();
    await expectNoAxeViolations(result);
  });

  it('a11y: setup form shows field errors and never echoes the key', async () => {
    const user = userEvent.setup();
    renderApp('#/import/sources');
    await user.click(await screen.findByRole('button', { name: 'Add Steam account' }));
    const dlg = await screen.findByRole('dialog', { name: 'Add Steam account' });
    await user.type(within(dlg).getByLabelText(/SteamID64, profile URL/), 'https://evil.example/id/x');
    await user.type(within(dlg).getByLabelText('Steam Web API key'), 'short');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        within(dlg)
          .getByLabelText(/SteamID64, profile URL/)
          .getAttribute('aria-invalid'),
      ).toBe('true'),
    );
    expect(within(dlg).getByLabelText('Steam Web API key').getAttribute('aria-invalid')).toBe('true');
    expect(within(dlg).getByText(/How to set up Steam import/)).toBeTruthy();
    await expectNoAxeViolations(dlg);
    expect(document.body.innerHTML).not.toContain(KEY);
  });
});

describe('Pick for Me, Up Next, Pile Health, Lists, Stats, Goals', () => {
  it('a11y: Pick for Me announces the pick with reasons and can start it', async () => {
    const user = userEvent.setup();
    seed(env);
    renderApp('#/pick');
    await user.click(await screen.findByRole('button', { name: 'Pick for me' }));
    const card = await screen.findByText(/Why:/);
    expect(card.closest('[aria-live="polite"]')).toBeTruthy();
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Start it' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Start this now?' });
    await user.click(within(confirm).getByRole('button', { name: 'Start it' }));
    expect(await screen.findByRole('heading', { name: 'Recent picks' })).toBeTruthy();
    expect(screen.getAllByText(/^Started/).length).toBeGreaterThan(0);
  });

  it('a11y: empty pool names the constraint and offers to loosen it', async () => {
    const user = userEvent.setup();
    seed(env);
    renderApp('#/pick');
    await user.selectOptions(await screen.findByLabelText('Time tonight'), '30');
    await user.click(screen.getByRole('button', { name: 'Pick for me' }));
    expect(await screen.findByText(/filter removed the last candidates/)).toBeTruthy();
    expect(screen.getByText('Available time')).toBeTruthy();
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: /Loosen that filter/ }));
    expect(await screen.findByText(/Why:/)).toBeTruthy();
  });

  it('a11y: dashboard shows Up Next, Pick, Pile Health, Goals, Upcoming and Lists widgets', async () => {
    const s = seed(env);
    env.library.setUpNext(s.movie.id, true);
    renderApp('#/dashboard');
    for (const name of ['Up Next', 'Pick for Me', 'Pile Health', 'Goals', 'Upcoming', 'Lists'])
      expect(await screen.findByRole('heading', { name, level: 2 })).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('a11y: Pile Health triage with snooze dialog and confirmation for Drop', async () => {
    const user = userEvent.setup();
    env.library.create({
      type: 'book',
      meta: { ...(await import('../../src/domain/metadata')).emptyMeta('Ancient') },
      personal: { ...(await import('../../src/domain/metadata')).defaultPersonal('book', '2019-01-01') },
      seasons: [],
      milestones: [],
      allowDuplicate: false,
    });
    renderApp('#/health');
    expect(await screen.findByText(/Planned for \d+ years/)).toBeTruthy();
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Snooze…' }));
    const dlg = await screen.findByRole('dialog', { name: /Snooze “Ancient”/ });
    await expectNoAxeViolations(dlg);
    await user.click(within(dlg).getByRole('button', { name: 'Snooze' }));
    expect(await screen.findByText(/Snoozed until/)).toBeTruthy();
    expect(await screen.findByText(/Nothing looks stale/)).toBeTruthy();
  });

  it('a11y: lists — create, open, delete (items kept)', async () => {
    const user = userEvent.setup();
    const s = seed(env);
    renderApp('#/lists');
    await user.click(await screen.findByRole('button', { name: 'Create a list' }));
    const dlg = await screen.findByRole('dialog', { name: 'New list' });
    await user.type(within(dlg).getByLabelText(/^Name/), 'Spooky season');
    await expectNoAxeViolations(dlg);
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    const link = await screen.findByRole('link', { name: /Spooky season/ });
    const lid = env.features.lists.list()[0]?.id ?? '';
    env.features.lists.setMembership(lid, [s.movie.id, s.book.id], true);
    await expectNoAxeViolations();
    await user.click(link);
    expect((await screen.findAllByText('0 of 2 completed')).length).toBeGreaterThan(0);
    await expectNoAxeViolations();
    await user.click(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Lists' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Delete Spooky season' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/stay in your library/);
    await user.click(within(confirm).getByRole('button', { name: 'Delete list' }));
    await waitFor(() => expect(env.features.lists.list()).toEqual([]));
    expect(env.library.get(s.movie.id).meta.title).toBe('Arrival');
  });

  it('a11y: stats charts have text alternatives and data tables; year in review', async () => {
    const user = userEvent.setup();
    const s = seed(env);
    env.library.setStatus({
      id: s.book.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    renderApp('#/stats');
    const img = await screen.findAllByRole('img');
    expect(img.length).toBeGreaterThan(0);
    await expectNoAxeViolations();
    const toggle = screen.getAllByRole('button', { name: 'Show data table' })[0];
    if (!toggle) throw new Error('no toggle');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('table').length).toBeGreaterThan(1);
    await user.click(screen.getByRole('button', { name: 'Year in Review' }));
    expect(await screen.findByText(/at a glance/)).toBeTruthy();
    expect(screen.getByText(/finished items had no rating/)).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('a11y: goals — create with validation and see plain-text pace', async () => {
    const user = userEvent.setup();
    renderApp('#/goals');
    await user.click(await screen.findByRole('button', { name: 'Create a goal' }));
    const dlg = await screen.findByRole('dialog', { name: 'New goal' });
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        within(dlg)
          .getByLabelText(/Goal name/)
          .getAttribute('aria-invalid'),
      ).toBe('true'),
    );
    await user.type(within(dlg).getByLabelText(/Goal name/), 'Read 24 books');
    await expectNoAxeViolations(dlg);
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect((await screen.findAllByText('Read 24 books')).length).toBeGreaterThan(0);
    expect(screen.getByText(/pace|Not started|Goal reached/i, { selector: '.pace' })).toBeTruthy();
    await expectNoAxeViolations();
  });
});

describe('command palette and quick capture', () => {
  it('a11y: Ctrl+K opens a combobox; arrows + Enter navigate; Esc returns focus', async () => {
    const user = userEvent.setup();
    seed(env);
    renderApp('#/dashboard');
    const opener = await screen.findByRole('button', { name: /Search & commands/ });
    opener.focus();
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(palette).getByRole('combobox');
    expect(document.activeElement).toBe(input);
    await expectNoAxeViolations();
    await user.type(input, 'piran');
    await waitFor(() => expect(within(palette).getAllByRole('option')[0]?.textContent).toMatch(/Piranesi/));
    expect(screen.getByText(/\d+ results?/).textContent).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Piranesi' })).toBeTruthy();
    const main = screen.getByRole('main');
    main.focus();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
    expect(document.activeElement).toBe(main); // focus returns to where it was
  });

  it('command registry is deterministic and contains the required actions', () => {
    const noop = () => undefined;
    const cmds = buildCommands({
      navigate: noop,
      openAdd: noop,
      openCapture: noop,
      showShortcuts: noop,
      exportJson: async () => undefined,
      startSteamSync: noop,
      switchTheme: async () => undefined,
      toggleComponent: async () => undefined,
      themes: [{ id: 'pile-dark', name: 'Pile Dark' }],
      dashboardComponents: [{ id: 'goals', label: 'Goals', visible: true }],
    });
    const labels = cmds.map((c) => c.label);
    for (const l of [
      'Add item…',
      'Pick for Me',
      'Start Steam sync',
      'Export library (JSON)…',
      'Switch theme: Pile Dark',
      'Hide dashboard component: Goals',
      'Show keyboard shortcuts',
    ])
      expect(labels).toContain(l);
    expect(new Set(cmds.map((c) => c.id)).size).toBe(cmds.length);
  });

  it('a11y: Quick Capture adds a Planned item without network and warns about duplicates', async () => {
    const user = userEvent.setup();
    seed(env);
    renderApp('#/library');
    await screen.findByRole('heading', { level: 1 });
    fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true });
    const dlg = await screen.findByRole('dialog', { name: 'Quick Capture' });
    await expectNoAxeViolations(dlg);
    await user.click(within(dlg).getByRole('button', { name: 'Add to pile' }));
    expect(
      within(dlg)
        .getByLabelText(/^Title/)
        .getAttribute('aria-invalid'),
    ).toBe('true');
    await user.type(within(dlg).getByLabelText(/^Title/), 'Arrival');
    await user.click(within(dlg).getByRole('button', { name: 'Add to pile' }));
    expect(await within(dlg).findByText('You may already have this:')).toBeTruthy();
    await user.click(within(dlg).getByRole('radio', { name: 'Book' }));
    await user.clear(within(dlg).getByLabelText(/^Title/));
    await user.type(within(dlg).getByLabelText(/^Title/), 'The Left Hand of Darkness');
    await user.click(within(dlg).getByRole('button', { name: 'Add to pile' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick Capture' })).toBeNull());
    const added = env.library.checkDuplicates({
      type: 'book',
      title: 'The Left Hand of Darkness',
      releaseDate: null,
      externalIds: [],
      excludeId: null,
    });
    expect(added).toHaveLength(1);
    expect(env.library.get(added[0]?.id ?? '').personal.status).toBe('planned');
    expect(env.http.calls).toHaveLength(0);
    expect(guessType('Severance season 2')).toBe('tv');
    expect(guessType('Arrival')).toBeNull();
  });
});
