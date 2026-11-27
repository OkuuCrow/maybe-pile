/**
 * 2.1 Simple Mode in the real app: a fresh install lands in Simple Mode with
 * the 3-step welcome, a Home/Library/Settings sidebar, a two-step Add, and the
 * single Reminders card. In an unpackaged dev build background modes are
 * unavailable (nothing can be registered for a dev checkout) — asserted here.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const root = process.cwd();

test('Simple Mode: welcome, navigation, two-step add, reminders card', async () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  env['MAYBEPILE_USER_DATA'] = mkdtempSync(join(tmpdir(), 'mp-e2e-simple-'));
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    const welcome = page.getByRole('dialog', { name: /Welcome to Maybe Pile/ });
    await expect(welcome).toBeVisible();
    await welcome.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(welcome).toBeHidden();

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Home', 'Library', 'Settings']);
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();

    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add an item' });
    await dialog.getByLabel('What do you want to add?').fill('Dune');
    await dialog.getByRole('radio', { name: 'Book' }).check();
    await dialog.getByRole('button', { name: /Search|Next/ }).click();
    await dialog.getByRole('button', { name: 'Add without searching' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dune' })).toBeVisible();

    await page.evaluate(() => (window.location.hash = '#/settings/notifications'));
    await expect(page.getByRole('heading', { level: 3, name: 'Reminders' })).toBeVisible();
    await page.getByRole('switch', { name: /Reminders/ }).click();
    await expect(page.getByRole('switch', { name: /Reminders/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: /let my computer check/ })).toBeDisabled();
    await expect(page.getByText('“Yes” needs the installed Windows or Linux app.')).toBeVisible();
  } finally {
    await app.close();
  }
});
