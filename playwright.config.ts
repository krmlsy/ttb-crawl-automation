import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: Number(process.env.TEST_TIMEOUT ?? 60_000),
  expect: {
    timeout: 10_000,
  },
  retries: Number(process.env.RETRIES ?? 1),
  workers: Number(process.env.WORKERS ?? 4),
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    headless: process.env.HEADLESS !== 'false',
    ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === 'true',
    navigationTimeout: Number(process.env.NAVIGATION_TIMEOUT ?? 30_000),
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: 'test-results',
});
