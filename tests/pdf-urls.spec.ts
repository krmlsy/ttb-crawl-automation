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
      'crawl-results.json bulunamadı. Önce crawler çalıştırılmalıdır.',
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

function hasPdfSignature(
  body: Buffer,
): boolean {
  if (
    body.length < 5
  ) {
    return false;
  }

  return (
    body
      .subarray(0, 5)
      .toString('ascii') ===
    '%PDF-'
  );
}

const data =
  loadCrawlData();

const timeout =
  Number(
    process.env.PDF_TIMEOUT ??
      60_000,
  );

test.describe(
  'PDF URL Health',
  () => {
    test.describe.configure({
      mode: 'parallel',
    });

    for (
      const record of data.pdf
    ) {
      test(
        `[PDF] ${record.url}`,
        async ({
          request,
        }, testInfo) => {
          annotation(
            testInfo,
            'resourceType',
            'pdf',
          );

          annotation(
            testInfo,
            'resourceUrl',
            record.url,
          );

          const start =
            Date.now();

          const response =
            await request.get(
              record.url,
              {
                failOnStatusCode:
                  false,

                timeout,
              },
            );

          const responseTime =
            Date.now() -
            start;

          const status =
            response.status();

          const headers =
            response.headers();

          const contentType =
            headers[
              'content-type'
            ] ?? '';

          const finalUrl =
            response.url();

          const redirected =
            finalUrl !==
            record.url;

          const body =
            await response.body();

          const sizeBytes =
            body.length;

          const signatureValid =
            hasPdfSignature(
              body,
            );

          const validContentType =
            contentType
              .toLowerCase()
              .includes(
                'application/pdf',
              ) ||
            contentType
              .toLowerCase()
              .includes(
                'application/octet-stream',
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
            'sizeBytes',
            sizeBytes,
          );

          annotation(
            testInfo,
            'signatureValid',
            signatureValid,
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

          expect(
            status,
            `PDF HTTP status başarısız: ${status} - ${record.url}`,
          ).toBeLessThan(
            400,
          );

          expect(
            body.length,
            `PDF response body boş: ${record.url}`,
          ).toBeGreaterThan(
            0,
          );

          expect(
            validContentType,
            `Beklenmeyen PDF Content-Type: ${contentType} - ${record.url}`,
          ).toBeTruthy();

          expect(
            signatureValid,
            `Geçerli PDF signature bulunamadı: ${record.url}`,
          ).toBeTruthy();
        },
      );
    }
  },
);