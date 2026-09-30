import { expect, test } from '@playwright/test';
import { loadCrawlData } from './helpers/crawl-data.js';

const data = loadCrawlData();

test.describe('HTML URL health checks', () => {
  for (const url of data.htmlUrls) {
    test(`HTML is reachable: ${url}`, async ({ page }) => {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Number(process.env.NAVIGATION_TIMEOUT ?? 30_000),
      });

      expect(response, 'Navigation must return an HTTP response').not.toBeNull();
      expect(response!.status(), `Unexpected HTTP status for ${url}`).toBeLessThan(400);

      const contentType = (response!.headers()['content-type'] ?? '').toLowerCase();
      expect(
        contentType.includes('text/html') || contentType.includes('application/xhtml+xml'),
        `Expected HTML content-type for ${url}, got: ${contentType}`,
      ).toBeTruthy();

      expect(page.url(), 'Browser should remain on an HTTP(S) page').toMatch(/^https?:\/\//i);
    });
  }
});
