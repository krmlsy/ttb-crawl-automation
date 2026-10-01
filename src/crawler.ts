import {
  chromium,
  type Page,
} from '@playwright/test';

import fs from 'node:fs/promises';

import path from 'node:path';

import type {
  CrawlEdge,
  CrawlOptions,
  CrawlResult,
  FailedUrlRecord,
  ResourceType,
  UrlRecord,
} from './types.js';

type QueueItem = {
  url: string;
  depth: number;
  discoveredFrom: string | null;
};

const IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.svg',
  '.ico',
  '.bmp',
  '.avif',
];

function parseBoolean(
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
    'y',
    'on',
  ].includes(value.toLowerCase());
}

function getArgument(
  name: string,
): string | undefined {
  const index =
    process.argv.indexOf(name);

  if (
    index === -1 ||
    index + 1 >= process.argv.length
  ) {
    return undefined;
  }

  return process.argv[index + 1];
}

function hasArgument(
  name: string,
): boolean {
  return process.argv.includes(name);
}

function parseOptions(): CrawlOptions {
  const rootUrl =
    getArgument('--url');

  if (!rootUrl) {
    throw new Error(
      'Missing required argument: --url',
    );
  }

  const output =
    getArgument('--output') ??
    path.resolve(
      process.cwd(),
      'data',
      'crawl-results.json',
    );

  const maxPages = Number(
    getArgument('--max-pages') ??
      '500',
  );

  const maxDepth = Number(
    getArgument('--max-depth') ??
      '10',
  );

  const timeoutMs = Number(
    getArgument('--timeout') ??
      '30000',
  );

  const includeSubdomains =
    hasArgument(
      '--include-subdomains',
    ) ||
    parseBoolean(
      process.env
        .INCLUDE_SUBDOMAINS,
    );

  /*
   * Öncelik:
   *
   * --ignore-https-errors true
   *
   * yoksa:
   *
   * IGNORE_HTTPS_ERRORS=true
   */
  const ignoreHttpsErrors =
    getArgument(
      '--ignore-https-errors',
    ) !== undefined
      ? parseBoolean(
          getArgument(
            '--ignore-https-errors',
          ),
        )
      : parseBoolean(
          process.env
            .IGNORE_HTTPS_ERRORS,
        );

  return {
    rootUrl,
    output,
    maxPages,
    maxDepth,
    timeoutMs,
    includeSubdomains,
    ignoreHttpsErrors,
  };
}

function canonicalHostname(
  hostname: string,
): string {
  return hostname
    .toLowerCase()
    .replace(/^www\./, '');
}

function normalizeUrl(
  rawUrl: string,
  baseUrl: string,
): string | null {
  try {
    const value =
      rawUrl.trim();

    if (!value) {
      return null;
    }

    const lower =
      value.toLowerCase();

    if (
      lower.startsWith(
        'javascript:',
      ) ||
      lower.startsWith(
        'mailto:',
      ) ||
      lower.startsWith(
        'tel:',
      ) ||
      lower.startsWith(
        'data:',
      ) ||
      lower.startsWith(
        'blob:',
      ) ||
      lower.startsWith('#')
    ) {
      return null;
    }

    const url = new URL(
      value,
      baseUrl,
    );

    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    ) {
      return null;
    }

    /*
     * Sitemap açısından fragment
     * yeni bir kaynak değildir.
     */
    url.hash = '';

    return url.toString();
  } catch {
    return null;
  }
}

function isSameSite(
  candidate: string,
  rootUrl: URL,
  includeSubdomains: boolean,
): boolean {
  try {
    const url =
      new URL(candidate);

    const candidateHost =
      canonicalHostname(
        url.hostname,
      );

    const rootHost =
      canonicalHostname(
        rootUrl.hostname,
      );

    if (
      candidateHost ===
      rootHost
    ) {
      return true;
    }

    if (
      includeSubdomains &&
      candidateHost.endsWith(
        `.${rootHost}`,
      )
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function isPdfUrl(
  url: string,
): boolean {
  try {
    return new URL(url)
      .pathname.toLowerCase()
      .endsWith('.pdf');
  } catch {
    return false;
  }
}

function isImageUrl(
  url: string,
): boolean {
  try {
    const pathname =
      new URL(url)
        .pathname.toLowerCase();

    return IMAGE_EXTENSIONS.some(
      (extension) =>
        pathname.endsWith(
          extension,
        ),
    );
  } catch {
    return false;
  }
}

function typeFromContentType(
  contentType: string,
): ResourceType {
  const lower =
    contentType.toLowerCase();

  if (
    lower.includes(
      'application/pdf',
    )
  ) {
    return 'pdf';
  }

  if (
    lower.startsWith(
      'image/',
    )
  ) {
    return 'image';
  }

  if (
    lower.includes(
      'text/html',
    ) ||
    lower.includes(
      'application/xhtml+xml',
    )
  ) {
    return 'html';
  }

  return 'other';
}

function guessedType(
  url: string,
): ResourceType {
  if (isPdfUrl(url)) {
    return 'pdf';
  }

  if (isImageUrl(url)) {
    return 'image';
  }

  return 'html';
}

function uniqueSorted(
  values: string[],
): string[] {
  return [
    ...new Set(values),
  ].sort((a, b) =>
    a.localeCompare(b),
  );
}

async function extractLinks(
  page: Page,
  currentUrl: string,
): Promise<string[]> {
  const anchors =
    page.locator('a[href]');

  const count =
    await anchors.count();

  const result: string[] = [];

  for (
    let index = 0;
    index < count;
    index++
  ) {
    const anchor =
      anchors.nth(index);

    const href =
      await anchor
        .getAttribute('href')
        .catch(() => null);

    if (!href) {
      continue;
    }

    const normalized =
      normalizeUrl(
        href,
        currentUrl,
      );

    if (normalized) {
      result.push(
        normalized,
      );
    }
  }

  return uniqueSorted(
    result,
  );
}

function parseSrcSet(
  value: string | null,
): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) =>
      entry
        .trim()
        .split(/\s+/)[0],
    )
    .filter(Boolean);
}

async function extractImages(
  page: Page,
  currentUrl: string,
): Promise<string[]> {
  const result: string[] = [];

  function add(
    rawUrl:
      | string
      | null
      | undefined,
  ) {
    if (!rawUrl) {
      return;
    }

    const normalized =
      normalizeUrl(
        rawUrl,
        currentUrl,
      );

    if (normalized) {
      result.push(
        normalized,
      );
    }
  }

  /*
   * IMG
   */
  const images =
    page.locator('img');

  const imageCount =
    await images.count();

  for (
    let index = 0;
    index < imageCount;
    index++
  ) {
    const image =
      images.nth(index);

    add(
      await image
        .getAttribute('src')
        .catch(() => null),
    );

    add(
      await image
        .getAttribute(
          'data-src',
        )
        .catch(() => null),
    );

    add(
      await image
        .getAttribute(
          'data-lazy-src',
        )
        .catch(() => null),
    );

    add(
      await image
        .getAttribute(
          'data-original',
        )
        .catch(() => null),
    );

    add(
      await image
        .getAttribute(
          'data-image',
        )
        .catch(() => null),
    );

    const srcset =
      await image
        .getAttribute(
          'srcset',
        )
        .catch(() => null);

    for (
      const item of
      parseSrcSet(srcset)
    ) {
      add(item);
    }

    const dataSrcset =
      await image
        .getAttribute(
          'data-srcset',
        )
        .catch(() => null);

    for (
      const item of
      parseSrcSet(
        dataSrcset,
      )
    ) {
      add(item);
    }
  }

  /*
   * PICTURE / SOURCE
   */
  const sources =
    page.locator(
      'source',
    );

  const sourceCount =
    await sources.count();

  for (
    let index = 0;
    index < sourceCount;
    index++
  ) {
    const source =
      sources.nth(index);

    add(
      await source
        .getAttribute('src')
        .catch(() => null),
    );

    const srcset =
      await source
        .getAttribute(
          'srcset',
        )
        .catch(() => null);

    for (
      const item of
      parseSrcSet(srcset)
    ) {
      add(item);
    }
  }

  /*
   * OpenGraph / Twitter
   */
  const metaImages =
    page.locator(
      [
        'meta[property="og:image"]',
        'meta[property="og:image:url"]',
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:src"]',
      ].join(','),
    );

  const metaCount =
    await metaImages.count();

  for (
    let index = 0;
    index < metaCount;
    index++
  ) {
    add(
      await metaImages
        .nth(index)
        .getAttribute(
          'content',
        )
        .catch(() => null),
    );
  }

  /*
   * Favicons
   */
  const icons =
    page.locator(
      [
        'link[rel~="icon"]',
        'link[rel="apple-touch-icon"]',
        'link[rel="apple-touch-icon-precomposed"]',
      ].join(','),
    );

  const iconCount =
    await icons.count();

  for (
    let index = 0;
    index < iconCount;
    index++
  ) {
    add(
      await icons
        .nth(index)
        .getAttribute(
          'href',
        )
        .catch(() => null),
    );
  }

  return uniqueSorted(
    result,
  );
}

function mergeReferences(
  existing: string[],
  incoming: string[],
): string[] {
  return uniqueSorted([
    ...existing,
    ...incoming,
  ]);
}

async function main() {
  const options =
    parseOptions();

  const rootUrl =
    new URL(
      options.rootUrl,
    );

  const normalizedRoot =
    normalizeUrl(
      options.rootUrl,
      options.rootUrl,
    );

  if (!normalizedRoot) {
    throw new Error(
      `Invalid root URL: ${options.rootUrl}`,
    );
  }

  console.log('');
  console.log(
    '================================',
  );
  console.log(
    ' URL CRAWLER',
  );
  console.log(
    '================================',
  );
  console.log(
    `Root URL   : ${normalizedRoot}`,
  );
  console.log(
    `Max pages  : ${options.maxPages}`,
  );
  console.log(
    `Max depth  : ${options.maxDepth}`,
  );
  console.log(
    `Subdomains : ${options.includeSubdomains}`,
  );
  console.log(
    `Ignore TLS : ${options.ignoreHttpsErrors}`,
  );
  console.log(
    '================================',
  );
  console.log('');

  const browser =
    await chromium.launch({
      headless: true,
    });

  const context =
    await browser.newContext({
      ignoreHTTPSErrors:
        options.ignoreHttpsErrors,
    });

  const page =
    await context.newPage();

  page.setDefaultTimeout(
    options.timeoutMs,
  );

  page.setDefaultNavigationTimeout(
    options.timeoutMs,
  );

  /*
   * URL → Record
   */
  const htmlMap =
    new Map<
      string,
      UrlRecord
    >();

  const pdfMap =
    new Map<
      string,
      UrlRecord
    >();

  const imageMap =
    new Map<
      string,
      UrlRecord
    >();

  const otherMap =
    new Map<
      string,
      UrlRecord
    >();

  /*
   * source|target → edge
   */
  const edgeMap =
    new Map<
      string,
      CrawlEdge
    >();

  /*
   * target URL → source URL listesi
   */
  const references =
    new Map<
      string,
      Set<string>
    >();

  const failed:
    FailedUrlRecord[] = [];

  const externalUrls =
    new Set<string>();

  const visited =
    new Set<string>();

  const queued =
    new Set<string>();

  const queue:
    QueueItem[] = [
      {
        url: normalizedRoot,
        depth: 0,
        discoveredFrom: null,
      },
    ];

  queued.add(
    normalizedRoot,
  );

  function getReferences(
    target: string,
  ): string[] {
    return uniqueSorted([
      ...(
        references.get(
          target,
        ) ?? []
      ),
    ]);
  }

  function addReference(
    source: string,
    target: string,
  ) {
    if (
      source === target
    ) {
      return;
    }

    let sources =
      references.get(
        target,
      );

    if (!sources) {
      sources =
        new Set<string>();

      references.set(
        target,
        sources,
      );
    }

    sources.add(source);
  }

  function addEdge(
    source: string,
    target: string,
    type: ResourceType,
  ) {
    if (
      source === target
    ) {
      return;
    }

    addReference(
      source,
      target,
    );

    const key =
      `${source}\n${target}`;

    const existing =
      edgeMap.get(key);

    /*
     * Bir URL ilk anda HTML tahmin edilmiş,
     * daha sonra Content-Type ile PDF/Image
     * olduğu anlaşılmış olabilir.
     */
    if (existing) {
      existing.type =
        type;

      return;
    }

    edgeMap.set(
      key,
      {
        source,
        target,
        type,
      },
    );
  }

  function updateIncomingEdgeType(
    item: QueueItem,
    type: ResourceType,
  ) {
    if (
      !item.discoveredFrom
    ) {
      return;
    }

    addEdge(
      item.discoveredFrom,
      item.url,
      type,
    );
  }

  function addOrUpdateRecord(
    map: Map<
      string,
      UrlRecord
    >,
    record: UrlRecord,
  ) {
    const existing =
      map.get(record.url);

    const refs =
      getReferences(
        record.url,
      );

    if (!existing) {
      map.set(
        record.url,
        {
          ...record,

          referencedBy:
            mergeReferences(
              record
                .referencedBy,
              refs,
            ),
        },
      );

      return;
    }

    existing.status =
      record.status ??
      existing.status;

    existing.contentType =
      record.contentType ||
      existing.contentType;

    existing.depth =
      Math.min(
        existing.depth,
        record.depth,
      );

    existing.title =
      record.title ??
      existing.title;

    existing.finalUrl =
      record.finalUrl ??
      existing.finalUrl;

    existing.redirected =
      record.redirected ??
      existing.redirected;

    existing.referencedBy =
      mergeReferences(
        existing.referencedBy,
        refs,
      );

    if (
      !existing.discoveredFrom &&
      record.discoveredFrom
    ) {
      existing.discoveredFrom =
        record.discoveredFrom;
    }
  }

  function createProvisionalRecord(
    url: string,
    depth: number,
    discoveredFrom: string,
  ): UrlRecord {
    return {
      url,
      status: null,
      contentType: '',
      discoveredFrom,
      referencedBy:
        getReferences(url),
      depth,
    };
  }

  while (
    queue.length > 0 &&
    visited.size <
      options.maxPages
  ) {
    const item =
      queue.shift();

    if (!item) {
      break;
    }

    if (
      visited.has(
        item.url,
      )
    ) {
      continue;
    }

    if (
      item.depth >
      options.maxDepth
    ) {
      continue;
    }

    visited.add(
      item.url,
    );

    console.log(
      `🌐 [${visited.size}/${options.maxPages}]`,
    );

    console.log(
      `   Depth : ${item.depth}`,
    );

    console.log(
      `   URL   : ${item.url}`,
    );

    try {
      const response =
        await page.goto(
          item.url,
          {
            waitUntil:
              'domcontentloaded',

            timeout:
              options.timeoutMs,
          },
        );

      /*
       * Dinamik sayfalar için kısa süre
       * networkidle beklemeyi deniyoruz.
       * Başarısız olması crawl'ı bozmaz.
       */
      await page
        .waitForLoadState(
          'networkidle',
          {
            timeout: 2000,
          },
        )
        .catch(() => {
          // ignore
        });

      await page
        .waitForTimeout(200)
        .catch(() => {
          // ignore
        });

      const status =
        response
          ? response.status()
          : null;

      const contentType =
        response
          ?.headers()[
          'content-type'
        ] ?? '';

      const finalUrl =
        normalizeUrl(
          page.url(),
          item.url,
        ) ?? item.url;

      const redirected =
        finalUrl !==
        item.url;

      let type =
        typeFromContentType(
          contentType,
        );

      /*
       * Content-Type hatalı veya boş
       * dönen sitelerde extension
       * üzerinden destekleyelim.
       */
      if (
        type === 'other'
      ) {
        if (
          isPdfUrl(
            item.url,
          )
        ) {
          type = 'pdf';
        } else if (
          isImageUrl(
            item.url,
          )
        ) {
          type = 'image';
        } else {
          /*
           * Browser gerçekten HTML
           * oluşturmuş mu?
           */
          const htmlCount =
            await page
              .locator('html')
              .count()
              .catch(
                () => 0,
              );

          if (
            htmlCount > 0
          ) {
            type = 'html';
          }
        }
      }

      console.log(
        `   Status: ${status}`,
      );

      console.log(
        `   Type  : ${
          contentType ||
          '(empty)'
        }`,
      );

      updateIncomingEdgeType(
        item,
        type,
      );

      /*
       * PDF
       */
      if (
        type === 'pdf'
      ) {
        addOrUpdateRecord(
          pdfMap,
          {
            url: item.url,
            status,
            contentType,
            discoveredFrom:
              item.discoveredFrom,
            referencedBy:
              getReferences(
                item.url,
              ),
            depth:
              item.depth,
            finalUrl,
            redirected,
          },
        );

        console.log(
          '   📄 PDF',
        );

        console.log('');

        continue;
      }

      /*
       * IMAGE
       */
      if (
        type === 'image'
      ) {
        addOrUpdateRecord(
          imageMap,
          {
            url: item.url,
            status,
            contentType,
            discoveredFrom:
              item.discoveredFrom,
            referencedBy:
              getReferences(
                item.url,
              ),
            depth:
              item.depth,
            finalUrl,
            redirected,
          },
        );

        console.log(
          '   🖼️ IMAGE',
        );

        console.log('');

        continue;
      }

      /*
       * OTHER
       */
      if (
        type !== 'html'
      ) {
        addOrUpdateRecord(
          otherMap,
          {
            url: item.url,
            status,
            contentType,
            discoveredFrom:
              item.discoveredFrom,
            referencedBy:
              getReferences(
                item.url,
              ),
            depth:
              item.depth,
            finalUrl,
            redirected,
          },
        );

        console.log(
          '   ⚪ OTHER',
        );

        console.log('');

        continue;
      }

      /*
       * HTML
       */
      const title =
        await page
          .title()
          .catch(
            () => '',
          );

      addOrUpdateRecord(
        htmlMap,
        {
          url: item.url,
          status,
          contentType,
          discoveredFrom:
            item.discoveredFrom,
          referencedBy:
            getReferences(
              item.url,
            ),
          depth:
            item.depth,
          title,
          finalUrl,
          redirected,
        },
      );

      console.log(
        '   ✅ HTML',
      );

      console.log(
        `   Title : ${
          title ||
          '(empty)'
        }`,
      );

      /*
       * IMAGES
       */
      const images =
        await extractImages(
          page,
          finalUrl,
        );

      let internalImageCount =
        0;

      let externalImageCount =
        0;

      for (
        const imageUrl of
        images
      ) {
        if (
          !isSameSite(
            imageUrl,
            rootUrl,
            options.includeSubdomains,
          )
        ) {
          externalUrls.add(
            imageUrl,
          );

          externalImageCount++;

          continue;
        }

        internalImageCount++;

        addEdge(
          item.url,
          imageUrl,
          'image',
        );

        addOrUpdateRecord(
          imageMap,
          createProvisionalRecord(
            imageUrl,
            item.depth + 1,
            item.url,
          ),
        );
      }

      console.log(
        `   🖼️ Images discovered: ${images.length}`,
      );

      console.log(
        `      Internal: ${internalImageCount}`,
      );

      console.log(
        `      External: ${externalImageCount}`,
      );

      /*
       * LINKS
       */
      const links =
        await extractLinks(
          page,
          finalUrl,
        );

      let internalCount = 0;

      let externalCount = 0;

      let pdfCount = 0;

      let imageLinkCount =
        0;

      let queuedCount = 0;

      for (
        const link of links
      ) {
        if (
          !isSameSite(
            link,
            rootUrl,
            options.includeSubdomains,
          )
        ) {
          externalUrls.add(
            link,
          );

          externalCount++;

          continue;
        }

        internalCount++;

        const type =
          guessedType(
            link,
          );

        /*
         * PDF
         */
        if (
          type === 'pdf'
        ) {
          pdfCount++;

          addEdge(
            item.url,
            link,
            'pdf',
          );

          addOrUpdateRecord(
            pdfMap,
            createProvisionalRecord(
              link,
              item.depth + 1,
              item.url,
            ),
          );

          continue;
        }

        /*
         * IMAGE link
         */
        if (
          type === 'image'
        ) {
          imageLinkCount++;

          addEdge(
            item.url,
            link,
            'image',
          );

          addOrUpdateRecord(
            imageMap,
            createProvisionalRecord(
              link,
              item.depth + 1,
              item.url,
            ),
          );

          continue;
        }

        /*
         * HTML link
         */
        addEdge(
          item.url,
          link,
          'html',
        );

        if (
          item.depth + 1 >
          options.maxDepth
        ) {
          continue;
        }

        if (
          visited.has(
            link,
          ) ||
          queued.has(
            link,
          )
        ) {
          continue;
        }

        queued.add(
          link,
        );

        queue.push({
          url: link,
          depth:
            item.depth + 1,
          discoveredFrom:
            item.url,
        });

        queuedCount++;
      }

      console.log(
        `   🔗 Links discovered: ${links.length}`,
      );

      console.log(
        `      Internal: ${internalCount}`,
      );

      console.log(
        `      External: ${externalCount}`,
      );

      console.log(
        `      PDF     : ${pdfCount}`,
      );

      console.log(
        `      Images  : ${imageLinkCount}`,
      );

      console.log(
        `      Queued  : ${queuedCount}`,
      );

      console.log(
        `   📥 Queue size: ${queue.length}`,
      );

      console.log(
        `   🕸️ Edges: ${edgeMap.size}`,
      );

      console.log('');
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.log(
        `   ❌ ERROR: ${message}`,
      );

      const status =
        null;

      const failedRecord:
        FailedUrlRecord = {
          url: item.url,

          discoveredFrom:
            item.discoveredFrom,

          referencedBy:
            getReferences(
              item.url,
            ),

          depth:
            item.depth,

          status,

          error:
            message,
        };

      failed.push(
        failedRecord,
      );

      console.log('');
    }
  }

  /*
   * Son aşamada referencedBy alanlarını
   * güncelliyoruz.
   *
   * Çünkü bir URL ilk bulunduğunda tek
   * referansı olabilirken ilerleyen
   * sayfalarda başka referanslar da
   * keşfedilmiş olabilir.
   */
  for (
    const map of [
      htmlMap,
      pdfMap,
      imageMap,
      otherMap,
    ]
  ) {
    for (
      const record of
      map.values()
    ) {
      record.referencedBy =
        getReferences(
          record.url,
        );

      if (
        !record.discoveredFrom &&
        record
          .referencedBy
          .length > 0
      ) {
        record.discoveredFrom =
          record
            .referencedBy[0];
      }
    }
  }

  for (
    const fail of failed
  ) {
    fail.referencedBy =
      getReferences(
        fail.url,
      );
  }

  const html =
    [...htmlMap.values()]
      .sort((a, b) =>
        a.url.localeCompare(
          b.url,
        ),
      );

  const pdf =
    [...pdfMap.values()]
      .sort((a, b) =>
        a.url.localeCompare(
          b.url,
        ),
      );

  const images =
    [...imageMap.values()]
      .sort((a, b) =>
        a.url.localeCompare(
          b.url,
        ),
      );

  const otherUrls =
    [...otherMap.values()]
      .sort((a, b) =>
        a.url.localeCompare(
          b.url,
        ),
      );

  const edges =
    [...edgeMap.values()]
      .sort((a, b) => {
        const sourceCompare =
          a.source.localeCompare(
            b.source,
          );

        if (
          sourceCompare !== 0
        ) {
          return sourceCompare;
        }

        return a.target.localeCompare(
          b.target,
        );
      });

  const result:
    CrawlResult = {
      generatedAt:
        new Date()
          .toISOString(),

      rootUrl:
        normalizedRoot,

      options: {
        maxPages:
          options.maxPages,

        maxDepth:
          options.maxDepth,

        timeoutMs:
          options.timeoutMs,

        includeSubdomains:
          options.includeSubdomains,

        ignoreHttpsErrors:
          options.ignoreHttpsErrors,
      },

      summary: {
        visitedCount:
          visited.size,

        htmlCount:
          html.length,

        pdfCount:
          pdf.length,

        imageCount:
          images.length,

        failedCount:
          failed.length,

        externalCount:
          externalUrls.size,

        otherCount:
          otherUrls.length,

        edgeCount:
          edges.length,
      },

      htmlUrls:
        html.map(
          (item) =>
            item.url,
        ),

      pdfUrls:
        pdf.map(
          (item) =>
            item.url,
        ),

      imageUrls:
        images.map(
          (item) =>
            item.url,
        ),

      html,

      pdf,

      images,

      failed,

      externalUrls:
        uniqueSorted([
          ...externalUrls,
        ]),

      otherUrls,

      edges,
    };

  await fs.mkdir(
    path.dirname(
      options.output,
    ),
    {
      recursive: true,
    },
  );

  await fs.writeFile(
    options.output,
    JSON.stringify(
      result,
      null,
      2,
    ),
    'utf-8',
  );

  await browser.close();

  console.log('');
  console.log(
    '================================',
  );
  console.log(
    ' CRAWL COMPLETED',
  );
  console.log(
    '================================',
  );

  console.log(
    `Visited  : ${result.summary.visitedCount}`,
  );

  console.log(
    `HTML     : ${result.summary.htmlCount}`,
  );

  console.log(
    `PDF      : ${result.summary.pdfCount}`,
  );

  console.log(
    `Images   : ${result.summary.imageCount}`,
  );

  console.log(
    `Edges    : ${result.summary.edgeCount}`,
  );

  console.log(
    `Failed   : ${result.summary.failedCount}`,
  );

  console.log(
    `External : ${result.summary.externalCount}`,
  );

  console.log(
    `Other    : ${result.summary.otherCount}`,
  );

  console.log(
    '--------------------------------',
  );

  console.log(
    `Output   : ${options.output}`,
  );

  console.log(
    '================================',
  );

  console.log('');
}

main().catch(
  (error) => {
    console.error(
      error,
    );

    process.exit(1);
  },
);