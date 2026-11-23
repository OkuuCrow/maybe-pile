import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectNoAxeViolations, installBridge, renderApp, seed, type UiEnv } from './harness';

let env: UiEnv;
beforeEach(() => {
  env = installBridge();
});
afterEach(() => {
  cleanup();
  env.cleanup();
});

describe('dashboard', () => {
  it('a11y: empty state has landmarks, headings, and no axe violations', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: /Your pile is empty/ })).toBeTruthy();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('a11y: populated dashboard renders real counts and widgets', async () => {
    seed(env);
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Library counts' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Continue' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Piranesi/ }).length).toBeGreaterThan(0);
    await expectNoAxeViolations();
  });
});

describe('add dialog', () => {
  it('a11y: traps focus, closes on Esc and restores focus to the opener', async () => {
    const user = userEvent.setup();
    renderApp();
    const opener = await screen.findByRole('button', { name: 'Add your first item' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Add an item' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await expectNoAxeViolations();
    for (let i = 0; i < 25; i++) await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('a11y: manual form shows an error summary and associates errors, keeps input, then saves', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Add your first item' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('tab', { name: 'Enter manually' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Book' }));
    await user.type(within(dialog).getByLabelText('Publication date'), '2020-13');
    await user.click(within(dialog).getByRole('button', { name: 'Add to library' }));
    const summary = await within(dialog).findByRole('alert');
    expect(summary.textContent).toMatch(/Title/);
    const title = within(dialog).getByLabelText(/^Title/);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    const describedBy = title.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy.split(' ').pop() ?? '')?.textContent).toMatch(/required/);
    await expectNoAxeViolations();
    // input is kept; fix the errors and save
    expect((within(dialog).getByLabelText('Publication date') as HTMLInputElement).value).toBe('2020-13');
    await user.clear(within(dialog).getByLabelText('Publication date'));
    await user.type(within(dialog).getByLabelText('Publication date'), '2020');
    await user.type(title, 'Piranesi');
    await user.type(within(dialog).getByLabelText('Page count', { exact: false }), '272');
    await user.click(within(dialog).getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Piranesi' })).toBeTruthy();
    expect(
      env.library.query({
        text: '',
        types: [],
        statuses: [],
        tags: [],
        tagMode: 'any',
        ratingMin: null,
        ratingMax: null,
        addedFrom: null,
        addedTo: null,
        sort: 'title',
        direction: 'asc',
        offset: 0,
        limit: 10,
        listId: null,
        upNextOnly: false,
        health: null,
      }).total,
    ).toBe(1);
  });

  it('offers open existing / add anyway / cancel for duplicates', async () => {
    seed(env);
    const user = userEvent.setup();
    renderApp('#/library');
    await user.click(await screen.findByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('tab', { name: 'Enter manually' }));
    await user.type(within(dialog).getByLabelText(/^Title/), 'Arrival');
    await user.type(within(dialog).getByLabelText('Release date'), '2016');
    await user.click(within(dialog).getByRole('button', { name: 'Add to library' }));
    expect(await within(dialog).findByText(/looks like something already in your library/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Open existing' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Add anyway' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Arrival' })).toBeTruthy();
  });
});

describe('library', () => {
  it('a11y: lists items with status text, filters by search and supports keyboard selection', async () => {
    seed(env);
    const user = userEvent.setup();
    renderApp('#/library');
    expect(await screen.findByText('4 items')).toBeTruthy();
    // status is conveyed as text, not color alone
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    await expectNoAxeViolations();
    await user.type(screen.getByLabelText('Search library'), 'statues');
    await waitFor(() => expect(screen.getByText('1 item')).toBeTruthy(), { timeout: 3000 });
    const link = screen.getByRole('link', { name: /Piranesi/ });
    link.focus();
    await user.keyboard('x');
    expect(await screen.findByText('1 selected')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Select Piranesi' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('shows filter chips, removable individually, and a one-click reset', async () => {
    seed(env);
    const user = userEvent.setup();
    renderApp('#/library');
    await screen.findByText('4 items');
    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    await user.click(within(screen.getByRole('group', { name: 'Type' })).getByLabelText('Books'));
    await waitFor(() => expect(screen.getByText('1 item')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Remove filter Type: Book' })).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Clear all filters' })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByText('4 items')).toBeTruthy());
  });

  it('bulk delete requires typing DELETE and offers undo', async () => {
    seed(env);
    const user = userEvent.setup();
    renderApp('#/library');
    await screen.findByText('4 items');
    await user.click(screen.getByRole('button', { name: 'Select all shown' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    const dlg = await screen.findByRole('alertdialog');
    const confirm = within(dlg).getByRole('button', { name: /Delete 4 item/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dlg).getByLabelText(/Type DELETE/), 'DELETE');
    await user.click(confirm);
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByText('4 items')).toBeTruthy());
  });
});

describe('item detail', () => {
  it('a11y: detail page, progress controls, and delete confirmation default to Cancel', async () => {
    const { book } = seed(env);
    const user = userEvent.setup();
    renderApp(`#/item/${book.id}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Piranesi' })).toBeTruthy();
    await expectNoAxeViolations();
    await user.type(screen.getByLabelText(/Current page/), '100');
    await user.click(screen.getByRole('button', { name: 'Save progress' }));
    expect((await screen.findAllByText('100 of 272 pages')).length).toBeGreaterThan(0);
    const progressbar = screen.getAllByRole('progressbar')[0];
    expect(progressbar?.getAttribute('aria-valuetext')).toBe('100 of 272 pages');
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    const dlg = await screen.findByRole('alertdialog', { name: /Delete “Piranesi”/ });
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(dlg.textContent).toMatch(/progress history/);
    await user.keyboard('{Enter}'); // Enter activates the safe default
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('heading', { level: 1, name: 'Piranesi' })).toBeTruthy();
  });

  it('suggests (does not force) completion and asks before re-opening', async () => {
    const { tv } = seed(env);
    const user = userEvent.setup();
    renderApp(`#/item/${tv.id}`);
    await screen.findByRole('heading', { level: 1, name: 'Severance' });
    await user.click(screen.getByRole('button', { name: 'Mark season watched' }));
    const accept = await screen.findByRole('button', { name: 'Mark Completed' });
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('planned');
    await user.click(accept);
    await waitFor(() =>
      expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('completed'),
    );
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'in_progress' } });
    const dlg = await screen.findByRole('dialog', { name: 'Change status to In Progress' });
    expect(within(dlg).getByLabelText(/Start a new re-watch/)).toBeTruthy();
    await expectNoAxeViolations(dlg);
  });

  it('opens external links only through the main-process opener', async () => {
    const { movie } = seed(env);
    const user = userEvent.setup();
    renderApp(`#/item/${movie.id}`);
    await user.click(await screen.findByRole('link', { name: /IMDb/ }));
    await waitFor(() => expect(env.platform.opened).toEqual(['https://www.imdb.com/title/tt2543164/']));
  });
});

describe('Up Next, pick and year stats', () => {
  it('a11y: queue an item from its page, see it on the dashboard, reorder and pick', async () => {
    const { book, movie } = seed(env);
    const user = userEvent.setup();
    renderApp(`#/item/${book.id}`);
    await user.click(await screen.findByRole('button', { name: 'Add to Up Next' }));
    expect(await screen.findByRole('button', { name: /Up Next #1 — remove/ })).toBeTruthy();
    env.library.setUpNext(movie.id, true);
    cleanup();
    renderApp('#/dashboard');
    const queue = await screen.findByRole('heading', { name: 'Up Next' });
    const list = queue.parentElement?.querySelector('ol') as HTMLElement;
    expect(
      within(list)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Piranesi', 'Arrival']);
    await user.click(within(list).getByRole('button', { name: 'Move Arrival up' }));
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('link')
          .map((l) => l.textContent),
      ).toEqual(['Arrival', 'Piranesi']),
    );
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Arrival down')); // focus kept on the moved item
    await user.click(screen.getByRole('button', { name: 'Pick for me' }));
    expect(await screen.findAllByRole('button', { name: 'Re-roll' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /This year/ })).toBeTruthy();
    await expectNoAxeViolations();
  });
});

describe('settings', () => {
  it.each(['appearance', 'layout', 'providers', 'library', 'features', 'backup', 'data', 'about'])(
    'a11y: %s tab has no violations',
    async (tab) => {
      seed(env);
      renderApp(`#/settings/${tab}`);
      await screen.findByRole('heading', { level: 2 });
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      await expectNoAxeViolations();
    },
  );

  it('layout editor reorders and hides components with buttons and checkboxes', async () => {
    const user = userEvent.setup();
    renderApp('#/settings/layout');
    const down = await screen.findByRole('button', { name: 'Move Library counts down' });
    await user.click(down);
    await waitFor(() => expect(screen.getAllByText(/^2\. Library counts/).length).toBe(1));
    const visible = screen.getAllByRole('checkbox', { name: 'Visible' })[0] as HTMLInputElement;
    await user.click(visible);
    await waitFor(() =>
      expect((screen.getAllByRole('checkbox', { name: 'Visible' })[0] as HTMLInputElement).checked).toBe(
        false,
      ),
    );
  });

  it('theme editor warns when contrast falls below AA', async () => {
    const user = userEvent.setup();
    renderApp('#/settings/appearance');
    await user.click(await screen.findByRole('button', { name: 'Duplicate selected' }));
    const text = await screen.findByLabelText('Text', { selector: 'input.mono' });
    await user.clear(text);
    await user.type(text, '#EEEEEE');
    expect(await screen.findByText(/fall below WCAG AA/)).toBeTruthy();
    expect(screen.getByText(/Text on background/)).toBeTruthy();
  });

  it('keyboard shortcuts overlay opens with ? and is not triggered while typing', async () => {
    const user = userEvent.setup();
    seed(env);
    renderApp('#/library');
    await screen.findByText('4 items');
    await user.type(screen.getByLabelText('Search library'), '?');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('?');
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});
