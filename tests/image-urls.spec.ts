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

type ImageFormat =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'svg'
  | 'ico'
  | 'bmp'
  | 'avif'
  | 'unknown';

function detectImageFormat(
  body: Buffer,
): ImageFormat {
  /*
   * PNG
   */
  if (
    body.length >= 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a
  ) {
    return 'png';
  }

  /*
   * JPEG
   */
  if (
    body.length >= 3 &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body[2] === 0xff
  ) {
    return 'jpeg';
  }

  /*
   * GIF
   */
  if (
    body.length >= 6
  ) {
    const gif =
      body
        .subarray(0, 6)
        .toString('ascii');

    if (
      gif === 'GIF87a' ||
      gif === 'GIF89a'
    ) {
      return 'gif';
    }
  }

  /*
   * WEBP
   */
  if (
    body.length >= 12 &&
    body
      .subarray(0, 4)
      .toString('ascii') ===
      'RIFF' &&
    body
      .subarray(8, 12)
      .toString('ascii') ===
      'WEBP'
  ) {
    return 'webp';
  }

  /*
   * ICO
   *
   * 00 00 01 00
   */
  if (
    body.length >= 4 &&
    body[0] === 0x00 &&
    body[1] === 0x00 &&
    body[2] === 0x01 &&
    body[3] === 0x00
  ) {
    return 'ico';
  }

  /*
   * BMP
   */
  if (
    body.length >= 2 &&
    body[0] === 0x42 &&
    body[1] === 0x4d
  ) {
    return 'bmp';
  }

  /*
   * AVIF
   *
   * ISO BMFF:
   * ....ftypavif
   * ....ftypavis
   */
  if (
    body.length >= 12
  ) {
    const box =
      body
        .subarray(
          4,
          Math.min(
            body.length,
            32,
          ),
        )
        .toString('ascii')
        .toLowerCase();

    if (
      box.includes(
        'ftypavif',
      ) ||
      box.includes(
        'ftypavis',
      )
    ) {
      return 'avif';
    }
  }

  /*
   * SVG
   */
  if (
    body.length > 0
  ) {
    const text =
      body
        .subarray(
          0,
          Math.min(
            body.length,
            2000,
          ),
        )
        .toString('utf-8')
        .replace(
          /^\uFEFF/,
          '',
        )
        .trim()
        .toLowerCase();

    if (
      text.includes(
        '<svg',
      )
    ) {
      return 'svg';
    }
  }

  return 'unknown';
}

const data =
  loadCrawlData();

const timeout =
  Number(
    process.env.IMAGE_TIMEOUT ??
      60_000,
  );

test.describe(
  'Image URL Health',
  () => {
    test.describe.configure({
      mode: 'parallel',
    });

    for (
      const record of
      data.images
    ) {
      test(
        `[IMAGE] ${record.url}`,
        async ({
          request,
        }, testInfo) => {
          annotation(
            testInfo,
            'resourceType',
            'image',
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

          const imageFormat =
            detectImageFormat(
              body,
            );

          const signatureValid =
            imageFormat !==
            'unknown';

          const validContentType =
            contentType
              .toLowerCase()
              .startsWith(
                'image/',
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
            'imageFormat',
            imageFormat,
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
            `Image HTTP status başarısız: ${status} - ${record.url}`,
          ).toBeLessThan(
            400,
          );

          expect(
            body.length,
            `Image response body boş: ${record.url}`,
          ).toBeGreaterThan(
            0,
          );

          /*
           * Bazı sunucular doğru image dosyasını
           * application/octet-stream gibi
           * yanlış Content-Type ile döndürebiliyor.
           *
           * Bu nedenle Content-Type VEYA gerçek
           * image signature yeterlidir.
           */
          expect(
            validContentType ||
              signatureValid,
            [
              'Response geçerli image olarak doğrulanamadı.',
              `URL: ${record.url}`,
              `Content-Type: ${contentType}`,
              `Detected format: ${imageFormat}`,
            ].join('\n'),
          ).toBeTruthy();
        },
      );
    }
  },
);