import { defineConfig } from '@playwright/test';

// E2E smoke tests drive the real packaged-layout app (dist/) via Playwright's Electron support.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
