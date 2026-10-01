import {
  defineConfig,
} from '@playwright/test';

function envBoolean(
  value: string | undefined,
  defaultValue = false,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return [
    'true',
    '1',
    'yes',
    'on',
  ].includes(
    value.toLowerCase(),
  );
}

export default defineConfig({
  testDir: './tests',

  fullyParallel: true,

  workers: Number(
    process.env.PW_WORKERS ?? 4,
  ),

  retries: Number(
    process.env.PW_RETRIES ?? 1,
  ),

  timeout: Number(
    process.env.TEST_TIMEOUT ??
      60_000,
  ),

  expect: {
    timeout: 10_000,
  },

  use: {
    ignoreHTTPSErrors:
      envBoolean(
        process.env
          .IGNORE_HTTPS_ERRORS,
      ),

    trace: 'retain-on-failure',
  },

  outputDir:
    'test-results',

  reporter: [
    [
      'list',
    ],

    [
      'html',
      {
        outputFolder:
          'playwright-report',

        open: 'never',
      },
    ],

    [
      'json',
      {
        outputFile:
          'data/test-results.json',
      },
    ],
  ],
});