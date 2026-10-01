import {
  expect,
  test,
  type TestInfo,
} from '@playwright/test';

import fs from 'node:fs';

import path from 'node:path';

import type {
  CrawlResult,
} from '../src/types.js';

const CRAWL_RESULT_PATH =
  path.resolve(
    process.cwd(),
    'data',
    'crawl-results.json',
  );

function loadCrawlData(): CrawlResult {
  if (
    !fs.existsSync(
      CRAWL_RESULT_PATH,
    )
  ) {
    throw new Error(
      [
        'crawl-results.json bulunamadı.',
        '',
        'Önce crawler çalıştırılmalıdır:',
        '',
        'npm run crawl -- --url https://example.com',
      ].join('\n'),
    );
  }

  return JSON.parse(
    fs.readFileSync(
      CRAWL_RESULT_PATH,
      'utf-8',
    ),
  ) as CrawlResult;
}

function annotation(
  testInfo: TestInfo,
  type: string,
  value:
    | string
    | number
    | boolean,
) {
  testInfo.annotations.push({
    type,
    description:
      String(value),
  });
}

const data =
  loadCrawlData();

const timeout =
  Number(
    process.env.HTML_TIMEOUT ??
      60_000,
  );

test.describe(
  'HTML URL Health',
  () => {
    test.describe.configure({
      mode: 'parallel',
    });

    for (
      const record of data.html
    ) {
      test(
        `[HTML] ${record.url}`,
        async ({
          page,
        }, testInfo) => {
          annotation(
            testInfo,
            'resourceType',
            'html',
          );

          annotation(
            testInfo,
            'resourceUrl',
            record.url,
          );

          const start =
            Date.now();

          const response =
            await page.goto(
              record.url,
              {
                waitUntil:
                  'domcontentloaded',

                timeout,
              },
            );

          const responseTime =
            Date.now() -
            start;

          const status =
            response
              ?.status() ?? 0;

          const headers =
            response
              ?.headers() ?? {};

          const contentType =
            headers[
              'content-type'
            ] ?? '';

          const finalUrl =
            page.url();

          const redirected =
            finalUrl !==
            record.url;

          const title =
            await page
              .title()
              .catch(
                () => '',
              );

          annotation(
            testInfo,
            'httpStatus',
            status,
          );

          annotation(
            testInfo,
            'contentType',
            contentType,
          );

          annotation(
            testInfo,
            'responseTime',
            responseTime,
          );

          annotation(
            testInfo,
            'finalUrl',
            finalUrl,
          );

          annotation(
            testInfo,
            'redirected',
            redirected,
          );

          annotation(
            testInfo,
            'pageTitle',
            title,
          );

          expect(
            response,
            `HTML response alınamadı: ${record.url}`,
          ).not.toBeNull();

          expect(
            status,
            `HTTP status başarısız: ${status} - ${record.url}`,
          ).toBeLessThan(
            400,
          );

          expect(
            contentType
              .toLowerCase(),
            `HTML Content-Type bekleniyordu: ${contentType}`,
          ).toMatch(
            /text\/html|application\/xhtml\+xml/,
          );

          expect(
            finalUrl,
          ).toBeTruthy();
        },
      );
    }
  },
);