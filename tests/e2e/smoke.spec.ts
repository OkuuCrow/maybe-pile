/**
 * End-to-end smoke test of the acceptance flow against the built app:
 * empty state → add all four types → edit → track progress → search/filter →
 * quit/relaunch (persistence) → theme/layout → export → backup → restore with
 * preview + typed confirmation → pre-restore snapshot exists → bad backup rejected.
 *
 * Native file dialogs are stubbed in the main process; no network is used.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { skipWelcomeAndUseFullMode } from './first-run';

const root = process.cwd();
const userData = mkdtempSync(join(tmpdir(), 'mp-e2e-data-'));
const outDir = mkdtempSync(join(tmpdir(), 'mp-e2e-out-'));

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  env['MAYBEPILE_USER_DATA'] = userData;
  const app = await electron.launch({ args: [root], cwd: root, env });
  const page = await app.firstWindow();
  await page.waitForSelector('h1');
  return { app, page };
}

async function stubSave(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, filePath);
}
async function stubOpen(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [p],
    })) as typeof dialog.showOpenDialog;
  }, filePath);
}

async function addManual(
  page: Page,
  type: 'Movie' | 'TV show' | 'Game' | 'Book',
  title: string,
  fill?: (p: Page) => Promise<void>,
) {
  await page.getByRole('button', { name: 'Add item' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add an item' });
  await dialog.getByRole('tab', { name: 'Enter manually' }).click();
  await dialog.getByRole('radio', { name: type, exact: true }).check();
  await dialog.getByLabel('Title', { exact: false }).first().fill(title);
  if (fill) await fill(page);
  await dialog.getByRole('button', { name: 'Add to library' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

test('Maybe Pile end-to-end smoke', async () => {
  let { app, page } = await launch();
  await skipWelcomeAndUseFullMode(page);
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  // 1. Empty state, no fake data.
  await expect(page.getByRole('heading', { name: /Your pile is empty/ })).toBeVisible();

  // 2. Add one of each type manually.
  await addManual(page, 'Movie', 'Arrival', async (p) => {
    await p.getByLabel('Release date').fill('2016');
  });
  await addManual(page, 'TV show', 'Severance', async (p) => {
    await p.getByRole('button', { name: 'Add season' }).click();
    await p.getByLabel('Episodes').fill('3');
  });
  await addManual(page, 'Game', 'Hades', async (p) => {
    await p.getByLabel('Progress scheme').selectOption('hours');
  });
  await addManual(page, 'Book', 'Piranesi', async (p) => {
    await p.getByLabel('Page count').fill('272');
    await p.getByLabel('Tags', { exact: true }).fill('fantasy');
    await p.getByLabel('Tags', { exact: true }).press('Enter');
  });
  await addManual(page, 'Book', 'Mystery Book'); // unknown page count

  // 3. Progress for each type.
  await page.goto('app://maybepile/index.html#/library');
  await page.getByRole('link', { name: /Arrival/ }).click();
  await page.getByRole('button', { name: 'Mark watched', exact: true }).click();
  await expect(page.getByText('Mark Completed', { exact: false })).toBeVisible(); // completion suggested, not forced
  await expect(page.locator('#item-status')).toHaveValue('planned');
  await page.getByRole('button', { name: 'Mark Completed' }).click();
  await expect(page.locator('#item-status')).toHaveValue('completed');

  await page.goto('app://maybepile/index.html#/library');
  await page.getByRole('link', { name: /Severance/ }).click();
  await page.getByRole('checkbox', { name: /^S1E1/ }).check();
  await expect(page.getByText('1 of 3 episodes').first()).toBeVisible();
  await page.getByRole('button', { name: 'Mark all up to S1E3 watched' }).click();
  await expect(page.getByText('3 of 3 episodes').first()).toBeVisible();

  await page.goto('app://maybepile/index.html#/library');
  await page.getByRole('link', { name: /Hades/ }).click();
  await page.getByLabel('Total hours played').fill('12.5');
  await page.getByRole('button', { name: 'Save progress' }).click();
  await expect(page.getByText('12.5 h played').first()).toBeVisible();

  await page.goto('app://maybepile/index.html#/library');
  await page.getByRole('link', { name: /Piranesi/ }).click();
  await page.getByLabel(/Current page/).fill('100');
  await page.getByRole('button', { name: 'Save progress' }).click();
  await expect(page.getByText('100 of 272 pages').first()).toBeVisible();
  // edit history entry
  await page.getByRole('button', { name: /Edit entry Page 100/ }).click();
  await page.getByRole('dialog', { name: 'Edit history entry' }).getByLabel('Page').fill('120');
  await page
    .getByRole('dialog', { name: 'Edit history entry' })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(page.getByText('120 of 272 pages').first()).toBeVisible();

  await page.goto('app://maybepile/index.html#/library');
  await page.getByRole('link', { name: /Mystery Book/ }).click();
  await page.getByRole('radio', { name: 'Percent' }).check();
  await page.getByLabel('Percent read').fill('40');
  await page.getByRole('button', { name: 'Save progress' }).click();
  await expect(page.getByText('40% read').first()).toBeVisible();

  // 4. Edit metadata → provenance becomes "edited by you".
  await page.getByRole('button', { name: 'Edit details' }).click();
  await page.getByLabel('Description').fill('A book with no known length.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('edited by you').first()).toBeVisible();

  // 5. Search / filter / sort.
  await page.goto('app://maybepile/index.html#/library');
  await page.getByLabel('Search library').fill('piran');
  await expect(page.getByText('1 item', { exact: true })).toBeVisible();
  await page.getByLabel('Search library').fill('');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('group', { name: 'Type' }).getByLabel('Books').check();
  await expect(page.getByText('2 items', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear all filters' }).first().click();
  await expect(page.getByText('5 items', { exact: true })).toBeVisible();
  await page.getByLabel('Sort by').selectOption('title');

  // 5b. Feature pack in the real app: command palette, lists, Pick for Me, Stats, game-list review.
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('hades');
  await palette.getByRole('combobox').press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Hades' })).toBeVisible();
  await page.getByRole('button', { name: 'Add to list…' }).click();
  const addToList = page.getByRole('dialog', { name: 'Add to list' });
  await addToList.getByLabel('List', { exact: true }).selectOption('__new');
  await addToList.getByLabel(/New list name/).fill('Roguelikes');
  await addToList.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('link', { name: /List: Roguelikes/ })).toBeVisible();
  await page.goto('app://maybepile/index.html#/pick');
  await page.getByRole('button', { name: 'Pick for me' }).click();
  await expect(page.getByText(/^Why:/)).toBeVisible();
  await page.goto('app://maybepile/index.html#/stats');
  await expect(page.getByRole('heading', { name: 'Completed per month' })).toBeVisible();
  await page.goto('app://maybepile/index.html#/import/sources');
  await page.getByRole('button', { name: 'Paste or upload a game list' }).click();
  const manualList = page.getByRole('dialog', { name: 'Paste or upload a game list' });
  await manualList.getByLabel(/^Titles/).fill('Tunic\nOuter Wilds');
  await manualList.getByRole('button', { name: 'Use pasted list' }).click();
  await expect(page.getByRole('listbox', { name: /My game list games/ }).getByRole('option')).toHaveCount(2);

  // 6. Quit and relaunch: no data loss.
  await app.close();
  ({ app, page } = await launch());
  await page.goto('app://maybepile/index.html#/library');
  await expect(page.getByText('5 items', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Piranesi/ }).click();
  await expect(page.getByText('120 of 272 pages').first()).toBeVisible();

  // 7. Theme + layout customization persists.
  await page.goto('app://maybepile/index.html#/settings/appearance');
  await page.getByLabel('Pile Dark (built-in, read-only)').check();
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mp-bg').trim()),
    )
    .toBe('#141517');
  await page.goto('app://maybepile/index.html#/settings/layout');
  await page.getByRole('button', { name: 'Move Library counts down' }).click();

  // 8. Exports and backup.
  const jsonPath = join(outDir, 'export.json');
  await page.goto('app://maybepile/index.html#/settings/backup');
  await stubSave(app, jsonPath);
  await page.getByRole('button', { name: 'Export JSON…' }).click();
  await expect(page.getByText(/JSON export saved/)).toBeVisible();
  expect(JSON.parse(readFileSync(jsonPath, 'utf8')).format).toBe('maybepile-export');
  const csvPath = join(outDir, 'export.csv');
  await stubSave(app, csvPath);
  await page.getByRole('button', { name: 'Export CSV…' }).click();
  await expect(page.getByText(/CSV export saved/)).toBeVisible();
  const backupPath = join(outDir, 'full.mpbackup');
  await stubSave(app, backupPath);
  await page.getByRole('button', { name: 'Create backup…' }).click();
  await expect(page.getByText(/Backup saved/)).toBeVisible();
  expect(existsSync(backupPath)).toBe(true);

  // 9. Change the library, then restore the backup with preview + typed confirmation.
  await page.goto('app://maybepile/index.html#/library');
  await addManual(page, 'Movie', 'Added After Backup');
  await page.goto('app://maybepile/index.html#/settings/backup');
  await stubOpen(app, backupPath);
  await page.getByRole('button', { name: 'Restore from backup…' }).click();
  const dlg = page.getByRole('dialog', { name: /Restore backup/ });
  await expect(dlg.getByText('After restore')).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Replace my library' })).toBeDisabled();
  await dlg.getByLabel(/Type RESTORE/).fill('RESTORE');
  await dlg.getByRole('button', { name: 'Replace my library' }).click();
  await expect(page.getByText(/Library restored/)).toBeVisible();
  expect(readdirSync(join(userData, 'backups')).some((f) => f.startsWith('pre-restore-'))).toBe(true);
  await page.goto('app://maybepile/index.html#/library');
  await expect(page.getByText('5 items', { exact: true })).toBeVisible();

  // 10. Injected failure: a corrupt backup is rejected and nothing changes.
  const bad = join(outDir, 'bad.mpbackup');
  writeFileSync(bad, readFileSync(backupPath).subarray(0, 500));
  await page.goto('app://maybepile/index.html#/settings/backup');
  await stubOpen(app, bad);
  await page.getByRole('button', { name: 'Restore from backup…' }).click();
  await expect(page.getByText(/damaged or truncated/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel — change nothing' }).click();
  await page.goto('app://maybepile/index.html#/library');
  await expect(page.getByText('5 items', { exact: true })).toBeVisible();

  expect(consoleErrors).toEqual([]);
  await app.close();
});
