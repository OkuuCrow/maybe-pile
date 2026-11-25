/** Expansion Pack 2 UI: keyboard operation, labels and axe checks on the new screens. */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json } from '../helpers/http';
import { expectNoAxeViolations, installBridge, renderApp, seed, type UiEnv } from './harness';

let env: UiEnv;
beforeEach(() => {
  env = installBridge();
});
afterEach(() => {
  cleanup();
  env.cleanup();
});

describe('Expansion Pack 2 screens', () => {
  it('a11y: Pile page shows time, what fits, recommendations, leaving soon, value and duplicates', async () => {
    const s = seed(env);
    env.features.value.add(s.movie.id, {
      amountMinor: 1299,
      currency: 'USD',
      purchasedOn: null,
      store: null,
      edition: null,
      notes: null,
    });
    renderApp('#/pile');
    for (const name of [
      'Pile Time',
      'What fits?',
      'From your pile',
      'Leaving soon',
      'Pile Value',
      'Possible duplicates',
    ])
      expect(await screen.findByRole('heading', { name, level: 2 })).toBeTruthy();
    expect(await screen.findByRole('table', { name: 'Spending by currency' })).toBeTruthy();
    expect(screen.getByLabelText('Time I have (hours)')).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('a11y: item page panels (time, sessions, moods, ownership, artwork, preferences) are labelled', async () => {
    const user = userEvent.setup();
    const s = seed(env);
    renderApp(`#/item/${s.movie.id}`);
    for (const name of [
      'Time',
      'Runs',
      'Series & related',
      'Moods',
      'Ownership & access',
      'Artwork',
      'Preferences',
    ])
      expect(await screen.findByRole('heading', { name, level: 2 })).toBeTruthy();
    // Moods are toggle buttons with aria-pressed (not color only).
    const moodGroup = await screen.findByRole('group', { name: /Moods for/ });
    const first = within(moodGroup).getAllByRole('button')[0]!;
    expect(first.getAttribute('aria-pressed')).toBe('false');
    await user.click(first);
    await waitFor(() =>
      expect(within(moodGroup).getAllByRole('button')[0]!.getAttribute('aria-pressed')).toBe('true'),
    );
    // Session timer is keyboard-operable.
    await user.click(screen.getByRole('button', { name: 'Start timer' }));
    expect(await screen.findByRole('group', { name: 'Session timer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop and save' })).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('a11y: artwork picker dialog has slot tabs, source status and labelled candidates', async () => {
    const user = userEvent.setup();
    const s = seed(env);
    renderApp(`#/item/${s.movie.id}`);
    await user.click(await screen.findByRole('button', { name: 'Artwork…' }));
    const dlg = await screen.findByRole('dialog', { name: /Artwork for/ });
    const tabs = within(dlg).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.replace(/\s*\(\d+\)$/, ''))).toEqual([
      'Cover',
      'Banner',
      'Logo',
      'Icon',
      'Background',
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    await within(dlg).findByRole('list', { name: 'Sources' });
    await expectNoAxeViolations(dlg);
  });

  it('a11y: spoiler shield hides unwatched episode titles with a labelled reveal', async () => {
    const user = userEvent.setup();
    const r = env.library.create({
      type: 'anime',
      meta: { ...(await import('../../src/domain/metadata')).emptyMeta('Mushishi') },
      personal: (await import('../../src/domain/metadata')).defaultPersonal('anime', env.library.today()),
      seasons: [
        {
          number: 1,
          title: null,
          episodeCountKnown: 3,
          episodes: [
            { number: 1, title: 'The Green Seat', airDate: null, runtime: 24 },
            { number: 2, title: 'The Light of the Eyelid', airDate: null, runtime: 24 },
            { number: 3, title: 'Tender Horns', airDate: null, runtime: 24 },
          ],
        },
      ],
      milestones: [],
      allowDuplicate: true,
    } as never);
    if (r.kind !== 'created') throw new Error('x');
    env.features.extras.setPrefs(r.item.id, { spoilerMode: 'shield' });
    renderApp(`#/item/${r.item.id}`);
    expect(await screen.findByText('The Green Seat')).toBeTruthy();
    expect(screen.queryByText('Tender Horns')).toBeNull();
    expect(screen.getAllByText('Title hidden (Spoiler Shield)').length).toBe(2);
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Reveal everything on this page' }));
    expect(await screen.findByText('Tender Horns')).toBeTruthy();
  });

  it('a11y: settings show anime, artwork, spoiler and value options; providers show terms notes', async () => {
    renderApp('#/settings/features');
    for (const name of ['Anime', 'Artwork', 'Spoiler Shield', 'Pile Value', 'Moods', 'Services and stores'])
      expect(await screen.findByRole('heading', { name, level: 3 })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Anime source order' })).toBeTruthy();
    await expectNoAxeViolations();
    cleanup();
    renderApp('#/settings/providers');
    expect(await screen.findByText(/anime and manga list or tracker services/)).toBeTruthy();
    expect(screen.getByText(/describes itself as scraping MyAnimeList/)).toBeTruthy();
    expect(screen.getAllByText('Artwork only').length).toBeGreaterThanOrEqual(2);
  });

  it('a11y: stats heatmap has a table alternative', async () => {
    const user = userEvent.setup();
    const s = seed(env);
    env.library.setStatus({
      id: s.movie.id,
      status: 'completed',
      startNewPass: false,
      clearDateCompleted: false,
      fillRemaining: false,
    });
    env.http.on('never', () => json({}));
    renderApp('#/stats');
    const btn = await screen.findByRole('button', { name: 'Show as table' });
    expect(screen.getByRole('grid', { name: /Completions per day/ })).toBeTruthy();
    await user.click(btn);
    expect(await screen.findByRole('table', { name: /Days with completions/ })).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('a11y: sync folder settings preview changes before syncing', async () => {
    const user = userEvent.setup();
    seed(env);
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    env.features.sync.setFolder(mkdtempSync(join(tmpdir(), 'mp-sync-ui-')), 'Test PC');
    renderApp('#/settings/data');
    expect(await screen.findByRole('heading', { name: 'Sync folder', level: 3 })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check for changes (preview)' }));
    expect(await screen.findByText(/To send: 4 item\(s\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    await expectNoAxeViolations();
  });
});
