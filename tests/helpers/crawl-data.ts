import fs from 'node:fs';
import path from 'node:path';

import type {
  CrawlResult,
} from '../../src/types.js';

export function loadCrawlData(): CrawlResult {
  const relativePath =
    process.env.CRAWL_DATA ??
    'data/crawl-results.json';

  const absolutePath =
    path.resolve(
      relativePath,
    );

  if (
    !fs.existsSync(
      absolutePath,
    )
  ) {
    throw new Error(
      `Crawl JSON not found: ${absolutePath}\n` +
      'Run the crawler first, for example:\n' +
      'npm run crawl -- --url https://example.com',
    );
  }

  const raw =
    fs.readFileSync(
      absolutePath,
      'utf8',
    );

  const parsed =
    JSON.parse(
      raw,
    ) as CrawlResult;

  if (
    !Array.isArray(
      parsed.htmlUrls,
    ) ||
    !Array.isArray(
      parsed.pdfUrls,
    ) ||
    !Array.isArray(
      parsed.imageUrls,
    )
  ) {
    throw new Error(
      `Invalid crawl JSON format: ${absolutePath}`,
    );
  }

  return parsed;
}