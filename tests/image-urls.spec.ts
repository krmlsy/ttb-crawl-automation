import {
  expect,
  test,
} from '@playwright/test';

import {
  loadCrawlData,
} from './helpers/crawl-data.js';

const data =
  loadCrawlData();

function isPng(
  body: Buffer,
): boolean {
  if (
    body.length < 8
  ) {
    return false;
  }

  return (
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a
  );
}

function isJpeg(
  body: Buffer,
): boolean {
  if (
    body.length < 3
  ) {
    return false;
  }

  return (
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body[2] === 0xff
  );
}

function isGif(
  body: Buffer,
): boolean {
  if (
    body.length < 6
  ) {
    return false;
  }

  const signature =
    body
      .subarray(0, 6)
      .toString('ascii');

  return (
    signature === 'GIF87a' ||
    signature === 'GIF89a'
  );
}

function isWebp(
  body: Buffer,
): boolean {
  if (
    body.length < 12
  ) {
    return false;
  }

  const riff =
    body
      .subarray(0, 4)
      .toString('ascii');

  const webp =
    body
      .subarray(8, 12)
      .toString('ascii');

  return (
    riff === 'RIFF' &&
    webp === 'WEBP'
  );
}

function isSvg(
  body: Buffer,
): boolean {
  const beginning =
    body
      .subarray(
        0,
        Math.min(
          body.length,
          1000,
        ),
      )
      .toString('utf8')
      .trim()
      .toLowerCase();

  return (
    beginning.includes(
      '<svg',
    )
  );
}

function hasKnownImageSignature(
  body: Buffer,
): boolean {
  return (
    isPng(body) ||
    isJpeg(body) ||
    isGif(body) ||
    isWebp(body) ||
    isSvg(body)
  );
}

test.describe(
  'Image URL health checks',
  () => {
    for (
      const url of
      data.imageUrls
    ) {
      test(
        `Image is reachable and valid: ${url}`,
        async ({
          request,
        }) => {
          const response =
            await request.get(
              url,
              {
                failOnStatusCode:
                  false,

                timeout:
                  Number(
                    process.env
                      .IMAGE_TIMEOUT ??
                    60_000,
                  ),
              },
            );

          expect(
            response.status(),
            `Unexpected HTTP status for ${url}`,
          ).toBeLessThan(
            400,
          );

          const contentType =
            (
              response
                .headers()[
                  'content-type'
                ] ??
              ''
            ).toLowerCase();

          const body =
            await response.body();

          /*
           * Content-Type
           */
          const hasImageContentType =
            contentType.startsWith(
              'image/',
            );

          /*
           * Gerçek binary/image
           * signature kontrolü.
           */
          const hasValidSignature =
            hasKnownImageSignature(
              body,
            );

          expect(
            hasImageContentType ||
              hasValidSignature,

            `Expected image response for ${url}. ` +
            `content-type=${contentType}`,
          ).toBeTruthy();

          /*
           * Empty image kontrolü
           */
          expect(
            body.length,
            `Image body is empty for ${url}`,
          ).toBeGreaterThan(
            0,
          );
        },
      );
    }
  },
);