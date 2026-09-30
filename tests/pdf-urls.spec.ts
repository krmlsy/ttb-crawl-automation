import { expect, test } from '@playwright/test';
import { loadCrawlData } from './helpers/crawl-data.js';

const data = loadCrawlData();

test.describe('PDF URL health checks', () => {
  for (const url of data.pdfUrls) {
    test(`PDF is reachable and valid: ${url}`, async ({ request }) => {
      const response = await request.get(url, {
        failOnStatusCode: false,
        timeout: Number(process.env.PDF_TIMEOUT ?? 60_000),
      });

      expect(response.status(), `Unexpected HTTP status for ${url}`).toBeLessThan(400);

      const contentType = (response.headers()['content-type'] ?? '').toLowerCase();
      const body = await response.body();
      const startsWithPdfSignature = body.subarray(0, 5).toString('ascii') === '%PDF-';
      const hasPdfContentType = contentType.includes('application/pdf');

      expect(
        hasPdfContentType || startsWithPdfSignature,
        `Expected a PDF response for ${url}. content-type=${contentType}, signature=${body.subarray(0, 5).toString('ascii')}`,
      ).toBeTruthy();

      expect(body.length, `PDF body is empty for ${url}`).toBeGreaterThan(5);
    });
  }
});
