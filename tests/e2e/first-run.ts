import { expect, type Page } from '@playwright/test';

/**
 * 2.1: a brand-new install opens in Simple Mode with the welcome steps. These
 * specs exercise Full-mode features, so they skip the welcome (real first-run
 * UI) and switch to Full in Settings → Interface (real setting), then go Home.
 */
export async function skipWelcomeAndUseFullMode(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: /Welcome to Maybe Pile/ });
  await expect(welcome).toBeVisible();
  await welcome.getByRole('button', { name: 'Skip' }).click();
  await expect(welcome).toBeHidden();
  await page.evaluate(() => (window.location.hash = '#/settings/interface'));
  const full = page.getByRole('radio', { name: /^Full/ });
  await full.click(); // controlled input: it becomes checked once the setting is saved
  await expect(full).toBeChecked();
  await expect(page.getByRole('link', { name: 'Interface' })).toBeVisible();
  await page.evaluate(() => (window.location.hash = '#/dashboard'));
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}
