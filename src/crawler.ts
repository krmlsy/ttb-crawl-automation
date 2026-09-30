import { chromium, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import type {
  CrawlOptions,
  CrawlResult,
  FailedUrlRecord,
  UrlRecord,
} from './types.js';

type QueueItem = {
  url: string;
  depth: number;
  discoveredFrom: string | null;
};

const DEFAULT_OUTPUT = 'data/crawl-results.json';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'msclkid',
  '_ga',
  '_gl',
]);

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

function printUsage(): void {
  console.log(`
Usage:
  npm run crawl -- --url https://example.com

Options:
  --output <path>
  Default: ${DEFAULT_OUTPUT}

  --max-pages <n>
  Default: 1000

  --max-depth <n>
  Default: 10

  --timeout <ms>
  Default: 30000

  --include-subdomains <boolean>
  Default: false

  --ignore-https-errors <boolean>
  Default: false

Example:

  npm run crawl -- \
    --url https://www.example.com \
    --max-pages 2000 \
    --max-depth 15
`);
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'y'].includes(
    value.toLowerCase(),
  );
}

function parseArgs(argv: string[]): CrawlOptions {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      continue;
    }

    const [rawKey, inlineValue] = arg
      .slice(2)
      .split('=', 2);

    const next = argv[i + 1];

    const value =
      inlineValue ??
      (next && !next.startsWith('--')
        ? next
        : 'true');

    values.set(rawKey, value);

    if (
      inlineValue === undefined &&
      next &&
      !next.startsWith('--')
    ) {
      i++;
    }
  }

  const rootUrlRaw = values.get('url');

  if (!rootUrlRaw) {
    printUsage();
    throw new Error('Missing required parameter: --url');
  }

  const rootUrl = new URL(rootUrlRaw).toString();

  return {
    rootUrl,
    output: values.get('output') ?? DEFAULT_OUTPUT,
    maxPages: Number(values.get('max-pages') ?? 1000),
    maxDepth: Number(values.get('max-depth') ?? 10),
    timeoutMs: Number(values.get('timeout') ?? 30_000),
    includeSubdomains: parseBoolean(
      values.get('include-subdomains'),
      false,
    ),
    ignoreHttpsErrors: parseBoolean(
      values.get('ignore-https-errors'),
      false,
    ),
  };
}

function canonicalHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^www\./, '');
}

function isHttpUrl(url: URL): boolean {
  return (
    url.protocol === 'http:' ||
    url.protocol === 'https:'
  );
}

function normalizeUrl(
  rawUrl: string,
  baseUrl?: string,
): string | null {
  try {
    const url = baseUrl
      ? new URL(rawUrl, baseUrl)
      : new URL(rawUrl);

    if (!isHttpUrl(url)) {
      return null;
    }

    // Fragmentleri kaldır.
    url.hash = '';

    // Tracking parametrelerini temizle.
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }

    // Default portları kaldır.
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }

    // /foo/ => /foo
    if (
      url.pathname.length > 1 &&
      url.pathname.endsWith('/')
    ) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }

    // Query parametrelerini sıralayarak duplicate azalt.
    const sortedParams = [...url.searchParams.entries()]
      .sort(([aKey, aValue], [bKey, bValue]) => {
        return (
          aKey.localeCompare(bKey) ||
          aValue.localeCompare(bValue)
        );
      });

    url.search = '';

    for (const [key, value] of sortedParams) {
      url.searchParams.append(key, value);
    }

    return url.toString();
  } catch {
    return null;
  }
}

function isSameSite(
  candidate: URL,
  root: URL,
  includeSubdomains: boolean,
): boolean {
  const candidateHost = canonicalHostname(
    candidate.hostname,
  );

  const rootHost = canonicalHostname(
    root.hostname,
  );

  // www.example.com ve example.com aynı kabul edilir.
  if (candidateHost === rootHost) {
    return true;
  }

  if (!includeSubdomains) {
    return false;
  }

  return candidateHost.endsWith(`.${rootHost}`);
}

function getPathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function looksLikePdf(
  url: string,
  contentType = '',
): boolean {
  const pathname = getPathname(url);

  return (
    pathname.endsWith('.pdf') ||
    contentType
      .toLowerCase()
      .includes('application/pdf')
  );
}

function looksLikeImage(
  url: string,
  contentType = '',
): boolean {
  const pathname = getPathname(url);

  const extensionMatch = IMAGE_EXTENSIONS.some(
    (extension) => pathname.endsWith(extension),
  );

  const contentTypeMatch = contentType
    .toLowerCase()
    .startsWith('image/');

  return extensionMatch || contentTypeMatch;
}

function isHtmlContentType(
  contentType: string,
): boolean {
  if (!contentType) {
    return false;
  }

  const value = contentType.toLowerCase();

  return (
    value.includes('text/html') ||
    value.includes('application/xhtml+xml')
  );
}

function uniqueSorted(
  values: Iterable<string>,
): string[] {
  return [...new Set(values)].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Sayfanın gerçekten HTML olup olmadığını daha toleranslı kontrol eder.
 *
 * Önce Content-Type'a bakar.
 * Sonra document resource type'a bakar.
 * Son olarak DOM'da <html> olup olmadığını kontrol eder.
 */
async function isHtmlPage(
  page: Page,
  contentType: string,
  resourceType: string,
): Promise<boolean> {
  if (isHtmlContentType(contentType)) {
    return true;
  }

  if (resourceType === 'document') {
    const htmlCount = await page
      .locator('html')
      .count()
      .catch(() => 0);

    if (htmlCount > 0) {
      return true;
    }
  }

  return false;
}

async function extractLinks(
  page: Page,
  currentUrl: string,
): Promise<string[]> {
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((anchors) => {
      return anchors
        .map((anchor) => anchor.getAttribute('href'))
        .filter(
          (href): href is string =>
            Boolean(href && href.trim()),
        );
    });

  const normalized = hrefs
    .map((href) => normalizeUrl(href, currentUrl))
    .filter((url): url is string => Boolean(url));

  return uniqueSorted(normalized);
}

async function extractImages(
  page: Page,
  currentUrl: string,
): Promise<string[]> {
  const rawImages = await page
    .locator(
      [
        'img',
        'source',
        'meta[property="og:image"]',
        'meta[name="twitter:image"]',
        'link[rel~="icon"]',
        'link[rel="apple-touch-icon"]',
      ].join(','),
    )
    .evaluateAll((elements) => {
      const result: string[] = [];

      for (const element of elements) {
        /*
         * IMG
         */
        if (element.tagName.toLowerCase() === 'img') {
          const img = element as HTMLImageElement;

          const src = img.getAttribute('src');
          const currentSrc = img.currentSrc;
          const dataSrc = img.getAttribute('data-src');
          const dataLazySrc =
            img.getAttribute('data-lazy-src');
          const dataOriginal =
            img.getAttribute('data-original');
          const dataImage =
            img.getAttribute('data-image');

          if (src?.trim()) {
            result.push(src.trim());
          }

          if (currentSrc?.trim()) {
            result.push(currentSrc.trim());
          }

          if (dataSrc?.trim()) {
            result.push(dataSrc.trim());
          }

          if (dataLazySrc?.trim()) {
            result.push(dataLazySrc.trim());
          }

          if (dataOriginal?.trim()) {
            result.push(dataOriginal.trim());
          }

          if (dataImage?.trim()) {
            result.push(dataImage.trim());
          }

          const srcset =
            img.getAttribute('srcset');

          if (srcset) {
            for (const item of srcset.split(',')) {
              const candidate =
                item.trim().split(/\s+/)[0];

              if (candidate) {
                result.push(candidate);
              }
            }
          }

          const dataSrcset =
            img.getAttribute('data-srcset');

          if (dataSrcset) {
            for (const item of dataSrcset.split(',')) {
              const candidate =
                item.trim().split(/\s+/)[0];

              if (candidate) {
                result.push(candidate);
              }
            }
          }
        }

        /*
         * SOURCE / PICTURE
         */
        if (
          element.tagName.toLowerCase() ===
          'source'
        ) {
          const src =
            element.getAttribute('src');

          if (src?.trim()) {
            result.push(src.trim());
          }

          const srcset =
            element.getAttribute('srcset');

          if (srcset) {
            for (const item of srcset.split(',')) {
              const candidate =
                item.trim().split(/\s+/)[0];

              if (candidate) {
                result.push(candidate);
              }
            }
          }
        }

        /*
         * OG / TWITTER IMAGE
         */
        if (
          element.tagName.toLowerCase() ===
          'meta'
        ) {
          const content =
            element.getAttribute('content');

          if (content?.trim()) {
            result.push(content.trim());
          }
        }

        /*
         * FAVICON / APPLE ICON
         */
        if (
          element.tagName.toLowerCase() ===
          'link'
        ) {
          const href =
            element.getAttribute('href');

          if (href?.trim()) {
            result.push(href.trim());
          }
        }
      }

      return result;
    });

  const normalized = rawImages
    .map((imageUrl) =>
      normalizeUrl(
        imageUrl,
        currentUrl,
      ),
    )
    .filter(
      (imageUrl): imageUrl is string =>
        Boolean(imageUrl),
    );

  return uniqueSorted(normalized);
}

async function crawl(
  options: CrawlOptions,
): Promise<CrawlResult> {
  const root = new URL(options.rootUrl);

  console.log('\n================================');
  console.log(' URL CRAWLER');
  console.log('================================');
  console.log(`Root URL   : ${options.rootUrl}`);
  console.log(`Max pages  : ${options.maxPages}`);
  console.log(`Max depth  : ${options.maxDepth}`);
  console.log(
    `Subdomains : ${options.includeSubdomains}`,
  );
  console.log('================================\n');

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: options.ignoreHttpsErrors,

    userAgent:
      'Mozilla/5.0 (compatible; PlaywrightUrlCrawler/1.2)',
  });

  const page = await context.newPage();

  page.setDefaultNavigationTimeout(
    options.timeoutMs,
  );

  const rootNormalized = normalizeUrl(
    options.rootUrl,
  );

  if (!rootNormalized) {
    throw new Error(
      `Invalid root URL: ${options.rootUrl}`,
    );
  }

  const queue: QueueItem[] = [
    {
      url: rootNormalized,
      depth: 0,
      discoveredFrom: null,
    },
  ];

  const queued = new Set<string>([
    rootNormalized,
  ]);

  const visited = new Set<string>();
  const external = new Set<string>();

  const html = new Map<string, UrlRecord>();
  const pdf = new Map<string, UrlRecord>();
  const images = new Map<string, UrlRecord>();
  const other = new Map<string, UrlRecord>();
  const failed = new Map<
    string,
    FailedUrlRecord
  >();

  try {
    while (
      queue.length > 0 &&
      visited.size < options.maxPages
    ) {
      const item = queue.shift()!;

      if (visited.has(item.url)) {
        continue;
      }

      visited.add(item.url);

      console.log('');
      console.log(
        `🌐 [${visited.size}/${options.maxPages}]`,
      );
      console.log(`   Depth : ${item.depth}`);
      console.log(`   URL   : ${item.url}`);

      try {
        const response = await page.goto(
          item.url,
          {
            waitUntil: 'domcontentloaded',
            timeout: options.timeoutMs,
          },
        );

        /*
         * JS framework hydration için kısa süre.
         * Network idle zorunlu değil.
         */
        await page
          .waitForLoadState('networkidle', {
            timeout: 2_000,
          })
          .catch(() => undefined);

        await page
          .waitForTimeout(200)
          .catch(() => undefined);

        const finalUrl =
          normalizeUrl(page.url()) ?? item.url;

        const status = response?.status() ?? null;

        const headers = response?.headers() ?? {};

        const contentType =
          headers['content-type'] ?? '';

        const resourceType =
          response?.request().resourceType() ??
          'document';

        console.log(
          `   Status: ${status ?? 'N/A'}`,
        );

        console.log(
          `   Type  : ${contentType || 'unknown'}`,
        );

        if (
          status !== null &&
          status >= 400
        ) {
          console.log(
            `   ❌ HTTP ${status}`,
          );

          failed.set(item.url, {
            url: item.url,
            discoveredFrom:
              item.discoveredFrom,
            depth: item.depth,
            status,
            error: `HTTP ${status}`,
          });

          continue;
        }

        /*
         * PDF
         */
        if (
          looksLikePdf(finalUrl, contentType) ||
          looksLikePdf(item.url, contentType)
        ) {
          console.log('   📄 PDF');

          pdf.set(finalUrl, {
            url: finalUrl,
            status,
            contentType,
            discoveredFrom:
              item.discoveredFrom,
            depth: item.depth,
          });

          continue;
        }

        /*
         * IMAGE
         */
        if (
          looksLikeImage(
            finalUrl,
            contentType,
          ) ||
          looksLikeImage(
            item.url,
            contentType,
          )
        ) {
          console.log('   🖼️ IMAGE');

          images.set(finalUrl, {
            url: finalUrl,
            status,
            contentType,
            discoveredFrom:
              item.discoveredFrom,
            depth: item.depth,
          });

          continue;
        }

        /*
         * HTML kontrolü
         *
         * Burada önceki sürüm çok katıydı.
         */
        const htmlPage = await isHtmlPage(
          page,
          contentType,
          resourceType,
        );

        if (!htmlPage) {
          console.log(
            '   ⚪ OTHER CONTENT',
          );

          other.set(finalUrl, {
            url: finalUrl,
            status,
            contentType,
            discoveredFrom:
              item.discoveredFrom,
            depth: item.depth,
          });

          continue;
        }

        const title = await page
          .title()
          .catch(() => '');

        html.set(finalUrl, {
          url: finalUrl,
          status,
          contentType,
          discoveredFrom:
            item.discoveredFrom,
          depth: item.depth,
          title,
        });

        console.log(`   ✅ HTML`);
        console.log(
          `   Title : ${title || '-'}`,
        );

        /*
         * =============================
         * IMAGE DISCOVERY
         * =============================
         */

        const discoveredImages =
          await extractImages(
            page,
            finalUrl,
          );

        let internalImageCount = 0;
        let externalImageCount = 0;

        for (const imageUrl of discoveredImages) {
          const parsed = new URL(imageUrl);

          if (
            !isSameSite(
              parsed,
              root,
              options.includeSubdomains,
            )
          ) {
            external.add(imageUrl);
            externalImageCount++;
            continue;
          }

          internalImageCount++;

          if (!images.has(imageUrl)) {
            images.set(imageUrl, {
              url: imageUrl,
              status: null,
              contentType:
                'image/* (discovered from DOM)',
              discoveredFrom: finalUrl,
              depth: item.depth + 1,
            });
          }
        }

        console.log(
          `   🖼️ Images: ${discoveredImages.length}` +
            ` | Internal: ${internalImageCount}` +
            ` | External: ${externalImageCount}`,
        );

        /*
         * Max depth'e geldiysek
         * buradan sonrasını crawl etme.
         */
        if (item.depth >= options.maxDepth) {
          console.log(
            '   ⛔ Max depth reached',
          );

          continue;
        }

        /*
         * =============================
         * LINK DISCOVERY
         * =============================
         */

        const links = await extractLinks(
          page,
          finalUrl,
        );

        console.log(
          `   🔗 Links discovered: ${links.length}`,
        );

        let internalLinks = 0;
        let externalLinks = 0;
        let queuedLinks = 0;
        let pdfLinks = 0;
        let imageLinks = 0;

        for (const link of links) {
          const parsed = new URL(link);

          /*
           * External
           */
          if (
            !isSameSite(
              parsed,
              root,
              options.includeSubdomains,
            )
          ) {
            external.add(link);
            externalLinks++;
            continue;
          }

          internalLinks++;

          /*
           * PDF
           */
          if (looksLikePdf(link)) {
            pdfLinks++;

            if (!pdf.has(link)) {
              pdf.set(link, {
                url: link,
                status: null,
                contentType:
                  'application/pdf (inferred from URL)',
                discoveredFrom: finalUrl,
                depth: item.depth + 1,
              });
            }

            continue;
          }

          /*
           * IMAGE
           */
          if (looksLikeImage(link)) {
            imageLinks++;

            if (!images.has(link)) {
              images.set(link, {
                url: link,
                status: null,
                contentType:
                  'image/* (inferred from URL)',
                discoveredFrom: finalUrl,
                depth: item.depth + 1,
              });
            }

            continue;
          }

          /*
           * HTML adayını queue'ya ekle.
           */
          if (
            !queued.has(link) &&
            !visited.has(link)
          ) {
            queued.add(link);

            queue.push({
              url: link,
              depth: item.depth + 1,
              discoveredFrom: finalUrl,
            });

            queuedLinks++;
          }
        }

        console.log(
          `   ├─ Internal : ${internalLinks}`,
        );

        console.log(
          `   ├─ External : ${externalLinks}`,
        );

        console.log(
          `   ├─ PDF      : ${pdfLinks}`,
        );

        console.log(
          `   ├─ Images   : ${imageLinks}`,
        );

        console.log(
          `   └─ Queued   : ${queuedLinks}`,
        );

        console.log(
          `   📥 Queue size: ${queue.length}`,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        console.log(
          `   ❌ ERROR: ${message}`,
        );

        failed.set(item.url, {
          url: item.url,
          discoveredFrom:
            item.discoveredFrom,
          depth: item.depth,
          status: null,
          error: message,
        });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  /*
   * =============================
   * RESULT
   * =============================
   */

  const htmlRecords = [...html.values()].sort(
    (a, b) => a.url.localeCompare(b.url),
  );

  const pdfRecords = [...pdf.values()].sort(
    (a, b) => a.url.localeCompare(b.url),
  );

  const imageRecords = [
    ...images.values(),
  ].sort((a, b) =>
    a.url.localeCompare(b.url),
  );

  const failedRecords = [
    ...failed.values(),
  ].sort((a, b) =>
    a.url.localeCompare(b.url),
  );

  const otherRecords = [
    ...other.values(),
  ].sort((a, b) =>
    a.url.localeCompare(b.url),
  );

  const externalUrls = uniqueSorted(external);

  return {
    generatedAt: new Date().toISOString(),

    rootUrl: options.rootUrl,

    options: {
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      timeoutMs: options.timeoutMs,
      includeSubdomains:
        options.includeSubdomains,
      ignoreHttpsErrors:
        options.ignoreHttpsErrors,
    },

    summary: {
      visitedCount: visited.size,
      htmlCount: htmlRecords.length,
      pdfCount: pdfRecords.length,
      imageCount: imageRecords.length,
      failedCount: failedRecords.length,
      externalCount: externalUrls.length,
      otherCount: otherRecords.length,
    },

    htmlUrls: htmlRecords.map(
      (record) => record.url,
    ),

    pdfUrls: pdfRecords.map(
      (record) => record.url,
    ),

    imageUrls: imageRecords.map(
      (record) => record.url,
    ),

    html: htmlRecords,
    pdf: pdfRecords,
    images: imageRecords,
    failed: failedRecords,
    externalUrls,
    otherUrls: otherRecords,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(
    process.argv.slice(2),
  );

  const result = await crawl(options);

  const outputPath = path.resolve(
    options.output,
  );

  await fs.mkdir(
    path.dirname(outputPath),
    {
      recursive: true,
    },
  );

  await fs.writeFile(
    outputPath,
    `${JSON.stringify(
      result,
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log('\n');
  console.log('================================');
  console.log(' CRAWL COMPLETED');
  console.log('================================');

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
    `Failed   : ${result.summary.failedCount}`,
  );

  console.log(
    `External : ${result.summary.externalCount}`,
  );

  console.log(
    `Other    : ${result.summary.otherCount}`,
  );

  console.log('--------------------------------');

  console.log(
    `Output   : ${outputPath}`,
  );

  console.log('================================');
}

main().catch((error) => {
  console.error('\nCrawler failed:');

  console.error(
    error instanceof Error
      ? error.stack
      : error,
  );

  process.exitCode = 1;
});