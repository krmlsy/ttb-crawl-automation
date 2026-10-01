import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  CrawlResult,
  ResourceType,
} from './types.js';

type TestStatus =
  | 'passed'
  | 'retry-pass'
  | 'failed'
  | 'skipped';

interface NormalizedTestResult {
  url: string;
  type: 'html' | 'pdf' | 'image';
  status: TestStatus;
  httpStatus: number | null;
  contentType: string;
  responseTime: number | null;
  sizeBytes: number | null;
  finalUrl: string;
  redirected: boolean | null;
  pageTitle: string;
  imageFormat: string;
  signatureValid: boolean | null;
  duration: number;
  retries: number;
  error: string;
}

interface GraphNode {
  id: string;
  type: ResourceType;
  depth: number;
  status: TestStatus | 'untested';
  label: string;
  referencedBy: string[];
}

const crawlPath = path.resolve(
  process.cwd(),
  'data',
  'crawl-results.json',
);

const testPath = path.resolve(
  process.cwd(),
  'data',
  'test-results.json',
);

const outputPath = path.resolve(
  process.cwd(),
  'report',
  'website-health-report.html',
);

function annotationMap(
  annotations: any[],
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const annotation of annotations ?? []) {
    if (!annotation?.type) {
      continue;
    }

    result[annotation.type] =
      annotation.description ?? '';
  }

  return result;
}

function booleanValue(
  value: string | undefined,
): boolean | null {
  if (value === undefined) {
    return null;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return null;
}

function numberValue(
  value: string | undefined,
): number | null {
  if (
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function detectTypeFromFile(
  file: string,
): 'html' | 'pdf' | 'image' | null {
  const lower = file.toLowerCase();

  if (lower.includes('html-urls')) {
    return 'html';
  }

  if (lower.includes('pdf-urls')) {
    return 'pdf';
  }

  if (lower.includes('image-urls')) {
    return 'image';
  }

  return null;
}

function extractUrlFromTitle(
  title: string,
): string {
  return title
    .replace(
      /^\[(HTML|PDF|IMAGE)\]\s*/i,
      '',
    )
    .trim();
}

function extractTests(
  report: any,
): NormalizedTestResult[] {
  const output: NormalizedTestResult[] = [];

  function walkSuites(
    suites: any[],
    parentFile = '',
  ) {
    for (const suite of suites ?? []) {
      const suiteFile =
        suite.file ?? parentFile;

      for (const spec of suite.specs ?? []) {
        const specFile =
          spec.file ??
          spec.location?.file ??
          suiteFile;

        for (
          const testCase of
          spec.tests ?? []
        ) {
          const annotations =
            annotationMap(
              testCase.annotations ?? [],
            );

          const type = (
            annotations.resourceType ??
            detectTypeFromFile(specFile)
          ) as
            | 'html'
            | 'pdf'
            | 'image'
            | null;

          if (!type) {
            continue;
          }

          const url =
            annotations.resourceUrl ??
            extractUrlFromTitle(
              spec.title ?? '',
            );

          if (
            !url.startsWith('http://') &&
            !url.startsWith('https://')
          ) {
            continue;
          }

          const results = [
            ...(testCase.results ?? []),
          ].sort(
            (a, b) =>
              (a.retry ?? 0) -
              (b.retry ?? 0),
          );

          const finalResult =
            results[results.length - 1];

          if (!finalResult) {
            continue;
          }

          let status: TestStatus;

          if (
            finalResult.status === 'passed'
          ) {
            status =
              results.length > 1
                ? 'retry-pass'
                : 'passed';
          } else if (
            finalResult.status === 'skipped'
          ) {
            status = 'skipped';
          } else {
            status = 'failed';
          }

          const errorMessages: string[] = [];

          if (finalResult.error?.message) {
            errorMessages.push(
              finalResult.error.message,
            );
          }

          for (
            const error of
            finalResult.errors ?? []
          ) {
            if (error?.message) {
              errorMessages.push(
                error.message,
              );
            }
          }

          output.push({
            url,
            type,
            status,

            httpStatus:
              numberValue(
                annotations.httpStatus,
              ),

            contentType:
              annotations.contentType ?? '',

            responseTime:
              numberValue(
                annotations.responseTime,
              ),

            sizeBytes:
              numberValue(
                annotations.sizeBytes,
              ),

            finalUrl:
              annotations.finalUrl ?? url,

            redirected:
              booleanValue(
                annotations.redirected,
              ),

            pageTitle:
              annotations.pageTitle ?? '',

            imageFormat:
              annotations.imageFormat ?? '',

            signatureValid:
              booleanValue(
                annotations.signatureValid,
              ),

            duration:
              results.reduce(
                (
                  sum,
                  result,
                ) =>
                  sum +
                  (result.duration ?? 0),
                0,
              ),

            retries:
              Math.max(
                0,
                results.length - 1,
              ),

            error: [
              ...new Set(errorMessages),
            ].join('\n'),
          });
        }
      }

      walkSuites(
        suite.suites ?? [],
        suiteFile,
      );
    }
  }

  walkSuites(report.suites ?? []);

  return output;
}

function shortLabel(
  url: string,
): string {
  try {
    const parsed = new URL(url);

    if (parsed.pathname === '/') {
      return parsed.hostname;
    }

    const parts =
      parsed.pathname
        .split('/')
        .filter(Boolean);

    const last =
      parts[parts.length - 1];

    return decodeURIComponent(
      last ?? parsed.hostname,
    ).slice(0, 50);
  } catch {
    return url.slice(0, 50);
  }
}

function escapeJsonForHtml(
  value: unknown,
): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function formatDuration(
  durationMs: number,
): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)} sn`;
  }

  return `${(durationMs / 60_000).toFixed(1)} dk`;
}

function typeSummary(
  tests: NormalizedTestResult[],
  type: 'html' | 'pdf' | 'image',
) {
  const list =
    tests.filter(
      (item) =>
        item.type === type,
    );

  const directPassed =
    list.filter(
      (item) =>
        item.status === 'passed',
    ).length;

  const retryPassed =
    list.filter(
      (item) =>
        item.status === 'retry-pass',
    ).length;

  const failed =
    list.filter(
      (item) =>
        item.status === 'failed',
    ).length;

  const skipped =
    list.filter(
      (item) =>
        item.status === 'skipped',
    ).length;

  return {
    total: list.length,
    directPassed,
    retryPassed,
    successful:
      directPassed + retryPassed,
    failed,
    skipped,
    successRate:
      list.length === 0
        ? 0
        : (
            (
              directPassed + retryPassed
            ) /
            list.length
          ) *
          100,
  };
}

async function main() {
  const crawl =
    JSON.parse(
      await fs.readFile(
        crawlPath,
        'utf-8',
      ),
    ) as CrawlResult;

  const playwrightReport =
    JSON.parse(
      await fs.readFile(
        testPath,
        'utf-8',
      ),
    );

  const tests =
    extractTests(playwrightReport);

  const resultByUrl =
    new Map(
      tests.map(
        (result) => [
          result.url,
          result,
        ],
      ),
    );

  const records =
    new Map<
      string,
      {
        type: ResourceType;
        depth: number;
        referencedBy: string[];
      }
    >();

  for (const item of crawl.html) {
    records.set(
      item.url,
      {
        type: 'html',
        depth: item.depth,
        referencedBy:
          item.referencedBy ?? [],
      },
    );
  }

  for (const item of crawl.pdf) {
    records.set(
      item.url,
      {
        type: 'pdf',
        depth: item.depth,
        referencedBy:
          item.referencedBy ?? [],
      },
    );
  }

  for (const item of crawl.images) {
    records.set(
      item.url,
      {
        type: 'image',
        depth: item.depth,
        referencedBy:
          item.referencedBy ?? [],
      },
    );
  }

  for (const edge of crawl.edges) {
    if (!records.has(edge.source)) {
      records.set(
        edge.source,
        {
          type: 'html',
          depth: 0,
          referencedBy: [],
        },
      );
    }

    if (!records.has(edge.target)) {
      const source =
        records.get(edge.source);

      records.set(
        edge.target,
        {
          type: edge.type,
          depth:
            (source?.depth ?? 0) + 1,
          referencedBy: [
            edge.source,
          ],
        },
      );
    }
  }

  const nodes: GraphNode[] = [
    ...records.entries(),
  ].map(
    ([url, record]) => ({
      id: url,
      type: record.type,
      depth: record.depth,
      status:
        resultByUrl.get(url)?.status ??
        'untested',
      label:
        shortLabel(url),
      referencedBy:
        record.referencedBy,
    }),
  );

  const htmlStats =
    typeSummary(tests, 'html');

  const pdfStats =
    typeSummary(tests, 'pdf');

  const imageStats =
    typeSummary(tests, 'image');

  const total = tests.length;

  const directPassed =
    tests.filter(
      (item) =>
        item.status === 'passed',
    ).length;

  const retryPassed =
    tests.filter(
      (item) =>
        item.status === 'retry-pass',
    ).length;

  const failed =
    tests.filter(
      (item) =>
        item.status === 'failed',
    ).length;

  const skipped =
    tests.filter(
      (item) =>
        item.status === 'skipped',
    ).length;

  const successful =
    directPassed + retryPassed;

  const wallDuration =
    Number(
      playwrightReport.stats
        ?.duration ??
        0,
    );

  const reportData = {
    generatedAt:
      new Date().toISOString(),

    rootUrl:
      crawl.rootUrl,

    summary: {
      total,
      directPassed,
      retryPassed,
      successful,
      failed,
      skipped,
      successRate:
        total === 0
          ? 0
          : successful /
            total *
            100,
      duration:
        wallDuration,
      edgeCount:
        crawl.edges.length,
    },

    typeStats: {
      html:
        htmlStats,
      pdf:
        pdfStats,
      image:
        imageStats,
    },

    tests,
    nodes,
    edges:
      crawl.edges,
    crawlSummary:
      crawl.summary,
  };

  const html = `
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Website Health & Site Map Report</title>

<style>
:root {
  --bg: #08111f;
  --surface: #101b2d;
  --surface-2: #17243a;
  --surface-3: #1d2d47;
  --border: #293a56;
  --text: #eef4fc;
  --muted: #94a6bf;
  --green: #35d07f;
  --red: #ff6363;
  --amber: #f4b942;
  --blue: #5aa3ff;
  --shadow: 0 20px 45px rgba(0,0,0,.22);
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
  background:
    radial-gradient(
      circle at top left,
      #132542,
      var(--bg) 35%
    );
  color: var(--text);
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

body {
  min-height: 100vh;
}

button,
input,
select {
  font: inherit;
}

a {
  color: #7eb6ff;
}

.shell {
  max-width: 1600px;
  margin: 0 auto;
  padding: 28px;
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}

.header h1 {
  margin: 0 0 7px;
  font-size: 28px;
}

.subtitle {
  color: var(--muted);
  font-size: 14px;
  line-height: 1.55;
}

.header-meta {
  text-align: right;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.tabs {
  display: flex;
  gap: 8px;
  margin: 0 0 20px;
}

.tab {
  border: 1px solid var(--border);
  color: var(--muted);
  background: var(--surface);
  padding: 10px 16px;
  border-radius: 10px;
  cursor: pointer;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  background: var(--surface-3);
  color: white;
  border-color: #4c6f9f;
}

.page {
  display: none;
}

.page.active {
  display: block;
}

.cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}

.card {
  background:
    linear-gradient(
      180deg,
      var(--surface-2),
      var(--surface)
    );
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow);
  padding: 19px;
}

.metric-label {
  color: var(--muted);
  font-size: 12px;
  letter-spacing: .07em;
  text-transform: uppercase;
}

.metric {
  margin: 6px 0;
  font-size: 34px;
  font-weight: 800;
}

.metric-note {
  color: var(--muted);
  font-size: 13px;
}

.green {
  color: var(--green);
}

.red {
  color: var(--red);
}

.amber {
  color: var(--amber);
}

.section {
  margin-top: 22px;
}

.section-title {
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 13px;
}

.type-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

.type-title {
  font-size: 19px;
  font-weight: 800;
  margin-bottom: 12px;
}

.type-summary {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 5px 9px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,.025);
  font-size: 12px;
}

.checks {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.checks li {
  color: #c7d4e6;
  padding: 7px 0;
  font-size: 13px;
  border-bottom: 1px solid rgba(255,255,255,.05);
}

.checks li:last-child {
  border-bottom: 0;
}

.fail-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.fail-tab {
  cursor: pointer;
  padding: 8px 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
}

.fail-tab.active {
  background: var(--surface-3);
  color: white;
}

.fail-panel {
  display: none;
}

.fail-panel.active {
  display: block;
}

.table-wrap {
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: 11px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

th {
  position: sticky;
  top: 0;
  background: var(--surface-2);
  color: var(--muted);
  z-index: 1;
}

td.url-cell {
  max-width: 650px;
  overflow-wrap: anywhere;
}

.error {
  color: #ff9797;
  max-width: 440px;
  white-space: pre-wrap;
}

.map-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 330px;
  gap: 14px;
  height: calc(100vh - 180px);
  min-height: 680px;
}

.map-panel,
.detail-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
}

.map-panel {
  display: flex;
  flex-direction: column;
}

.map-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 11px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}

#mapSearch,
.map-toolbar select {
  border: 1px solid var(--border);
  color: var(--text);
  background: #0d1727;
  border-radius: 8px;
  padding: 8px 10px;
}

#mapSearch {
  min-width: 260px;
  flex: 1 1 320px;
}

.map-toolbar select {
  flex: 0 0 auto;
}

.map-toolbar input[type="checkbox"] {
  width: 16px;
  height: 16px;
  min-width: 16px;
  max-width: 16px;
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
  cursor: pointer;
  accent-color: #3788f2;
}

.toolbar-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  flex: 0 0 auto;
}

.response-filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  flex: 0 0 auto;
}

#responseTimeFilter {
  width: 90px;
  min-width: 90px;
  flex: 0 0 90px;
  border: 1px solid var(--border);
  color: var(--text);
  background: #0d1727;
  border-radius: 8px;
  padding: 8px 9px;
  text-align: right;
}

#responseTimeFilter:focus {
  outline: 2px solid #3788f2;
  outline-offset: 1px;
}

.small-button {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--surface-3);
  color: white;
  cursor: pointer;
  flex: 0 0 auto;
}

.small-button:hover {
  background: #263c5d;
}

.canvas-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  background:
    radial-gradient(
      circle at center,
      #0f1e34,
      #08111f
    );
}

#mapCanvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
}

#mapCanvas.dragging {
  cursor: grabbing;
}

.map-legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  background: rgba(8,17,31,.88);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 11px;
  color: var(--muted);
  pointer-events: none;
}

.legend-dot {
  width: 9px;
  height: 9px;
  display: inline-block;
  border-radius: 50%;
  margin-right: 4px;
}

.detail-panel {
  overflow: auto;
  padding: 16px;
}

.detail-title {
  margin: 0 0 12px;
  font-size: 17px;
}

.detail-url {
  overflow-wrap: anywhere;
  font-size: 12px;
  color: #a9c9f3;
  background: #0c1728;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px;
  margin-bottom: 12px;
}

.detail-row {
  display: grid;
  grid-template-columns: 105px 1fr;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid rgba(255,255,255,.055);
  font-size: 12px;
}

.detail-key {
  color: var(--muted);
}

.reference-list {
  margin: 8px 0 0;
  padding-left: 18px;
}

.reference-list li {
  margin: 6px 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.path-box {
  margin-top: 12px;
  border: 1px solid var(--border);
  background: #0b1627;
  border-radius: 9px;
  padding: 10px;
}

.path-node {
  font-size: 12px;
  overflow-wrap: anywhere;
  margin: 5px 0;
}

.path-arrow {
  color: var(--muted);
  margin-left: 4px;
}

.map-stats {
  color: var(--muted);
  font-size: 11px;
  margin-left: auto;
  white-space: nowrap;
  flex: 0 0 auto;
}

.open-link {
  display: inline-block;
  margin-top: 10px;
  background: #145da8;
  border: 1px solid #357dc8;
  color: white;
  text-decoration: none;
  padding: 8px 11px;
  border-radius: 8px;
  font-size: 12px;
}

.map-button {
  border: 1px solid #4c6d96;
  background: #1d3553;
  color: white;
  border-radius: 7px;
  padding: 5px 8px;
  cursor: pointer;
  white-space: nowrap;
}

@media (max-width: 1000px) {
  .cards,
  .type-grid {
    grid-template-columns: 1fr 1fr;
  }

  .map-layout {
    grid-template-columns: 1fr;
    height: auto;
  }

  .canvas-wrap {
    height: 650px;
  }
}

@media (max-width: 650px) {
  .shell {
    padding: 15px;
  }

  .cards,
  .type-grid {
    grid-template-columns: 1fr;
  }

  .header {
    flex-direction: column;
  }

  .header-meta {
    text-align: left;
  }

  #mapSearch {
    flex: 1 1 100%;
    min-width: 100%;
  }
}
</style>
</head>

<body>
<div class="shell">

  <header class="header">
    <div>
      <h1>Website Health & Site Map</h1>
      <div class="subtitle">
        ${crawl.rootUrl}<br>
        Playwright tabanlı HTML, PDF ve görsel sağlık kontrolü
      </div>
    </div>

    <div class="header-meta">
      ${new Date().toLocaleString('tr-TR')}<br>
      Süre:
      <strong>${formatDuration(wallDuration)}</strong><br>
      Site ilişkisi:
      <strong>${crawl.edges.length.toLocaleString('tr-TR')}</strong>
    </div>
  </header>

  <div class="tabs">
    <button class="tab active" data-page="dashboard">
      Dashboard
    </button>
    <button class="tab" data-page="sitemap">
      Site Map
    </button>
  </div>

  <section id="page-dashboard" class="page active">

    <div class="cards">
      <div class="card">
        <div class="metric-label">Toplam Kontrol</div>
        <div class="metric">${total.toLocaleString('tr-TR')}</div>
        <div class="metric-note">URL / kaynak</div>
      </div>

      <div class="card">
        <div class="metric-label">Başarılı</div>
        <div class="metric green">${successful.toLocaleString('tr-TR')}</div>
        <div class="metric-note">
          %${(
            total === 0
              ? 0
              : successful / total * 100
          ).toFixed(1)}
        </div>
      </div>

      <div class="card">
        <div class="metric-label">Başarısız</div>
        <div class="metric red">${failed.toLocaleString('tr-TR')}</div>
        <div class="metric-note">
          %${(
            total === 0
              ? 0
              : failed / total * 100
          ).toFixed(1)}
        </div>
      </div>

      <div class="card">
        <div class="metric-label">Tekrar Koşumunda Başarılı</div>
        <div class="metric amber">${retryPassed.toLocaleString('tr-TR')}</div>
        <div class="metric-note">Retry sonrası başarılı</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">URL Türleri ve Kontroller</div>

      <div class="type-grid">
        <div class="card">
          <div class="type-title">🌐 HTML</div>
          <div class="type-summary">
            <span class="pill">Toplam: <strong>${htmlStats.total}</strong></span>
            <span class="pill green">Başarılı: ${htmlStats.successful}</span>
            <span class="pill red">Fail: ${htmlStats.failed}</span>
            <span class="pill">%${htmlStats.successRate.toFixed(1)}</span>
          </div>
          <ul class="checks">
            <li>✓ HTTP Status &lt; 400</li>
            <li>✓ Browser navigation</li>
            <li>✓ HTML Content-Type</li>
            <li>✓ Redirect / Final URL</li>
            <li>✓ Response time</li>
            <li>✓ Page title</li>
          </ul>
        </div>

        <div class="card">
          <div class="type-title">📄 PDF</div>
          <div class="type-summary">
            <span class="pill">Toplam: <strong>${pdfStats.total}</strong></span>
            <span class="pill green">Başarılı: ${pdfStats.successful}</span>
            <span class="pill red">Fail: ${pdfStats.failed}</span>
            <span class="pill">%${pdfStats.successRate.toFixed(1)}</span>
          </div>
          <ul class="checks">
            <li>✓ HTTP Status &lt; 400</li>
            <li>✓ PDF Content-Type</li>
            <li>✓ %PDF- signature</li>
            <li>✓ Dosya boş değil</li>
            <li>✓ Dosya boyutu</li>
            <li>✓ Response time</li>
          </ul>
        </div>

        <div class="card">
          <div class="type-title">🖼️ IMAGE</div>
          <div class="type-summary">
            <span class="pill">Toplam: <strong>${imageStats.total}</strong></span>
            <span class="pill green">Başarılı: ${imageStats.successful}</span>
            <span class="pill red">Fail: ${imageStats.failed}</span>
            <span class="pill">%${imageStats.successRate.toFixed(1)}</span>
          </div>
          <ul class="checks">
            <li>✓ HTTP Status &lt; 400</li>
            <li>✓ image/* Content-Type</li>
            <li>✓ JPEG / PNG / GIF</li>
            <li>✓ WEBP / SVG / ICO</li>
            <li>✓ BMP / AVIF</li>
            <li>✓ Dosya bütünlüğü</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Başarısız URL'ler</div>

      <div class="fail-tabs">
        <button class="fail-tab active" data-fail-type="html">HTML</button>
        <button class="fail-tab" data-fail-type="pdf">PDF</button>
        <button class="fail-tab" data-fail-type="image">Image</button>
      </div>

      <div id="fail-html" class="fail-panel active"></div>
      <div id="fail-pdf" class="fail-panel"></div>
      <div id="fail-image" class="fail-panel"></div>
    </div>
  </section>

  <section id="page-sitemap" class="page">
    <div class="map-layout">
      <div class="map-panel">
        <div class="map-toolbar">
          <input
            id="mapSearch"
            type="text"
            placeholder="URL ara..."
          >

          <select id="statusFilter">
            <option value="all">Tüm Node'lar</option>
            <option value="failed">Sadece Fail</option>
            <option value="fail-paths">Fail Yolları</option>
            <option value="successful">Sadece Başarılı</option>
          </select>

          <label class="toolbar-check">
            <input id="showHtml" type="checkbox" checked>
            HTML
          </label>

          <label class="toolbar-check">
            <input id="showPdf" type="checkbox" checked>
            PDF
          </label>

          <label class="toolbar-check">
            <input id="showImage" type="checkbox" checked>
            Image
          </label>

          <label class="response-filter">
            <span>Min Response</span>
            <input
              id="responseTimeFilter"
              type="number"
              min="0"
              step="100"
              placeholder="ms"
            >
            <span>ms</span>
          </label>

          <button id="fitButton" class="small-button">
            Fit
          </button>

          <span id="mapStats" class="map-stats"></span>
        </div>

        <div class="canvas-wrap">
          <canvas id="mapCanvas"></canvas>

          <div class="map-legend">
            <span><span class="legend-dot" style="background:#35d07f"></span>Başarılı</span>
            <span><span class="legend-dot" style="background:#ff6363"></span>Fail</span>
            <span><span class="legend-dot" style="background:#f4b942"></span>Retry Success</span>
            <span>○ HTML</span>
            <span>◇ PDF</span>
            <span>□ Image</span>
          </div>
        </div>
      </div>

      <aside id="detailPanel" class="detail-panel">
        <h3 class="detail-title">URL Detayı</h3>
        <div class="subtitle">Map üzerinde bir node seçin.</div>
      </aside>
    </div>
  </section>
</div>

<script>
const REPORT = ${escapeJsonForHtml(reportData)};

const tests = REPORT.tests;
const nodes = REPORT.nodes;
const edges = REPORT.edges;
const rootUrl = REPORT.rootUrl;

const nodeById = new Map(
  nodes.map(
    node => [node.id, node]
  )
);

const resultByUrl = new Map(
  tests.map(
    item => [item.url, item]
  )
);

const outgoing = new Map();
const incoming = new Map();

for (const edge of edges) {
  if (!outgoing.has(edge.source)) {
    outgoing.set(edge.source, []);
  }

  outgoing.get(edge.source).push(edge.target);

  if (!incoming.has(edge.target)) {
    incoming.set(edge.target, []);
  }

  incoming.get(edge.target).push(edge.source);
}

/* PAGE TABS */
document
  .querySelectorAll('.tab')
  .forEach(
    button => {
      button.addEventListener(
        'click',
        () => {
          activatePage(button.dataset.page);
        }
      );
    }
  );

function activatePage(page) {
  document
    .querySelectorAll('.tab')
    .forEach(
      button =>
        button.classList.toggle(
          'active',
          button.dataset.page === page
        )
    );

  document
    .querySelectorAll('.page')
    .forEach(
      element =>
        element.classList.toggle(
          'active',
          element.id === 'page-' + page
        )
    );

  if (page === 'sitemap') {
    setTimeout(
      () => {
        resizeCanvas();
        fitGraph();
        draw();
      },
      0
    );
  }
}

/* FAIL TABLES */
function escapeText(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function shortError(error) {
  if (!error) {
    return '';
  }

  return error.length > 500
    ? error.slice(0, 500) + '...'
    : error;
}

function renderFailTable(type) {
  const container =
    document.getElementById('fail-' + type);

  const failures =
    tests.filter(
      item =>
        item.type === type &&
        item.status === 'failed'
    );

  if (failures.length === 0) {
    container.innerHTML =
      '<div class="card green">Başarısız URL bulunmamaktadır.</div>';
    return;
  }

  const rows = failures.map(
    item => {
      const node = nodeById.get(item.url);
      const references = node?.referencedBy?.length ?? 0;

      return \`
        <tr>
          <td>
            <strong class="red">
              \${item.httpStatus ?? '-'}
            </strong>
          </td>

          <td class="url-cell">
            <a
              href="\${escapeText(item.url)}"
              target="_blank"
              rel="noopener noreferrer"
            >
              \${escapeText(item.url)}
            </a>
          </td>

          <td>\${references}</td>

          <td class="error">
            \${escapeText(shortError(item.error))}
          </td>

          <td>
            <button
              class="map-button"
              onclick="showOnMap('\${encodeURIComponent(item.url)}')"
            >
              Map
            </button>
          </td>
        </tr>
      \`;
    }
  ).join('');

  container.innerHTML = \`
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>URL</th>
            <th>Kullanıldığı Sayfa</th>
            <th>Hata</th>
            <th>Map</th>
          </tr>
        </thead>
        <tbody>
          \${rows}
        </tbody>
      </table>
    </div>
  \`;
}

renderFailTable('html');
renderFailTable('pdf');
renderFailTable('image');

document
  .querySelectorAll('.fail-tab')
  .forEach(
    button => {
      button.addEventListener(
        'click',
        () => {
          const type = button.dataset.failType;

          document
            .querySelectorAll('.fail-tab')
            .forEach(
              item => item.classList.remove('active')
            );

          document
            .querySelectorAll('.fail-panel')
            .forEach(
              item => item.classList.remove('active')
            );

          button.classList.add('active');

          document
            .getElementById('fail-' + type)
            .classList.add('active');
        }
      );
    }
  );

/* GRAPH */
const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
const searchInput = document.getElementById('mapSearch');
const statusFilter = document.getElementById('statusFilter');
const showHtml = document.getElementById('showHtml');
const showPdf = document.getElementById('showPdf');
const showImage = document.getElementById('showImage');
const responseTimeFilter = document.getElementById('responseTimeFilter');
const mapStats = document.getElementById('mapStats');
const detailPanel = document.getElementById('detailPanel');

let scale = 1;
let offsetX = 0;
let offsetY = 0;
let selectedId = null;
let selectionAnimationProgress = 1;
let selectionAnimationFrame = null;
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let startOffsetX = 0;
let startOffsetY = 0;

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function stopSelectionAnimation() {
  if (selectionAnimationFrame !== null) {
    cancelAnimationFrame(selectionAnimationFrame);
    selectionAnimationFrame = null;
  }
}

function animateSelectionFocus() {
  stopSelectionAnimation();

  const duration = 360;
  const startedAt = performance.now();

  selectionAnimationProgress = 0;

  function frame(now) {
    const elapsed = now - startedAt;
    const linear = Math.min(1, elapsed / duration);

    selectionAnimationProgress =
      easeOutCubic(linear);

    draw();

    if (linear < 1) {
      selectionAnimationFrame =
        requestAnimationFrame(frame);
    } else {
      selectionAnimationProgress = 1;
      selectionAnimationFrame = null;
      draw();
    }
  }

  selectionAnimationFrame =
    requestAnimationFrame(frame);
}

function resetSelectionState() {
  stopSelectionAnimation();
  selectionAnimationProgress = 1;
  selectedId = null;
}

const positionedNodes = layoutNodes(nodes);

const positionById = new Map(
  positionedNodes.map(
    node => [node.id, node]
  )
);

function layoutNodes(sourceNodes) {
  const groups = new Map();

  for (const node of sourceNodes) {
    const depth = Math.max(
      0,
      Number(node.depth ?? 0)
    );

    if (!groups.has(depth)) {
      groups.set(depth, []);
    }

    groups.get(depth).push(node);
  }

  const result = [];

  for (const [depth, group] of groups) {
    group.sort(
      (a, b) => a.id.localeCompare(b.id)
    );

    if (depth === 0) {
      group.forEach(
        (node, index) => {
          result.push({
            ...node,
            x: index * 50,
            y: 0
          });
        }
      );
      continue;
    }

    const perRing = 100;
    const ringCount = Math.ceil(group.length / perRing);

    for (let ring = 0; ring < ringCount; ring++) {
      const start = ring * perRing;
      const entries = group.slice(start, start + perRing);
      const radius = depth * 230 + ring * 70;

      entries.forEach(
        (node, index) => {
          const angle =
            Math.PI * 2 * index / entries.length +
            depth * 0.35 +
            ring * 0.17;

          result.push({
            ...node,
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius
          });
        }
      );
    }
  }

  return result;
}

function failedNodes() {
  return new Set(
    nodes
      .filter(node => node.status === 'failed')
      .map(node => node.id)
  );
}

function buildFailPathSet() {
  const visible = failedNodes();
  const queue = [...visible];

  while (queue.length) {
    const target = queue.shift();
    const parents = incoming.get(target) ?? [];

    for (const parent of parents) {
      if (visible.has(parent)) {
        continue;
      }

      visible.add(parent);
      queue.push(parent);
    }
  }

  return visible;
}

const failPathSet = buildFailPathSet();

function typeVisible(type) {
  if (type === 'html') {
    return showHtml.checked;
  }

  if (type === 'pdf') {
    return showPdf.checked;
  }

  if (type === 'image') {
    return showImage.checked;
  }

  return false;
}

function responseTimeVisible(node) {
  const rawValue =
    responseTimeFilter.value.trim();

  if (rawValue === '') {
    return true;
  }

  const minimum = Number(rawValue);

  if (
    !Number.isFinite(minimum) ||
    minimum <= 0
  ) {
    return true;
  }

  const result = resultByUrl.get(node.id);

  if (
    !result ||
    result.responseTime == null
  ) {
    return false;
  }

  return result.responseTime >= minimum;
}

function getVisibleNodeSet() {
  const filter = statusFilter.value;
  const query = searchInput.value.trim().toLowerCase();
  const visible = new Set();

  for (const node of positionedNodes) {
    if (!typeVisible(node.type)) {
      continue;
    }

    if (!responseTimeVisible(node)) {
      continue;
    }

    if (
      filter === 'failed' &&
      node.status !== 'failed'
    ) {
      continue;
    }

    if (
      filter === 'successful' &&
      node.status !== 'passed' &&
      node.status !== 'retry-pass'
    ) {
      continue;
    }

    if (
      filter === 'fail-paths' &&
      !failPathSet.has(node.id)
    ) {
      continue;
    }

    if (
      query &&
      !node.id.toLowerCase().includes(query)
    ) {
      continue;
    }

    visible.add(node.id);
  }

  return visible;
}

function getSelectionActiveSet() {
  if (!selectedId) {
    return null;
  }

  const active = new Set([selectedId]);

  for (
    const source of
    incoming.get(selectedId) ?? []
  ) {
    active.add(source);
  }

  for (
    const target of
    outgoing.get(selectedId) ?? []
  ) {
    active.add(target);
  }

  return active;
}

function statusColor(status) {
  if (status === 'failed') {
    return '#ff6363';
  }

  if (status === 'retry-pass') {
    return '#f4b942';
  }

  if (status === 'passed') {
    return '#35d07f';
  }

  return '#637590';
}

function worldToScreen(x, y) {
  return {
    x: x * scale + offsetX,
    y: y * scale + offsetY
  };
}

function resizeCanvas() {
  const rect =
    canvas.parentElement.getBoundingClientRect();

  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.max(
    1,
    Math.floor(rect.width * dpr)
  );

  canvas.height = Math.max(
    1,
    Math.floor(rect.height * dpr)
  );

  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

  ctx.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );
}

function fitGraph() {
  const visible = getVisibleNodeSet();

  const list =
    positionedNodes.filter(
      node => visible.has(node.id)
    );

  if (list.length === 0) {
    scale = 1;
    offsetX = canvas.clientWidth / 2;
    offsetY = canvas.clientHeight / 2;
    return;
  }

  const xs = list.map(node => node.x);
  const ys = list.map(node => node.y);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const width = Math.max(200, maxX - minX);
  const height = Math.max(200, maxY - minY);

  scale = Math.min(
    canvas.clientWidth / (width + 200),
    canvas.clientHeight / (height + 200)
  );

  scale = Math.min(
    1.5,
    Math.max(0.04, scale)
  );

  offsetX =
    canvas.clientWidth / 2 -
    (minX + maxX) / 2 * scale;

  offsetY =
    canvas.clientHeight / 2 -
    (minY + maxY) / 2 * scale;
}

function drawNode(
  node,
  x,
  y,
  dimmed = false
) {
  const selected = node.id === selectedId;
  const radius = node.status === 'failed' ? 7 : 5;

  ctx.save();

  if (dimmed) {
    ctx.globalAlpha =
      1 -
      (0.70 * selectionAnimationProgress);
  }

  ctx.beginPath();

  if (node.type === 'pdf') {
    ctx.moveTo(x, y - radius);
    ctx.lineTo(x + radius, y);
    ctx.lineTo(x, y + radius);
    ctx.lineTo(x - radius, y);
    ctx.closePath();
  } else if (node.type === 'image') {
    ctx.rect(
      x - radius,
      y - radius,
      radius * 2,
      radius * 2
    );
  } else {
    ctx.arc(
      x,
      y,
      radius,
      0,
      Math.PI * 2
    );
  }

  ctx.fillStyle =
    dimmed
      ? '#667085'
      : statusColor(node.status);

  ctx.fill();

  if (selected) {
    ctx.globalAlpha = 1;

    /*
     * Seçimde kısa süreli, hafif halo animasyonu.
     * Sürekli çalışmaz; sadece seçim anında ~360 ms sürer.
     */
    const haloPulse =
      Math.sin(
        selectionAnimationProgress *
        Math.PI
      );

    const haloRadius =
      radius +
      5 +
      (haloPulse * 4);

    ctx.beginPath();
    ctx.arc(
      x,
      y,
      haloRadius,
      0,
      Math.PI * 2
    );

    ctx.lineWidth =
      1.5 +
      (haloPulse * 1.5);

    ctx.strokeStyle =
      'rgba(126,182,255,' +
      (0.20 + haloPulse * 0.55) +
      ')';

    ctx.stroke();

    ctx.beginPath();

    if (node.type === 'pdf') {
      ctx.moveTo(x, y - radius);
      ctx.lineTo(x + radius, y);
      ctx.lineTo(x, y + radius);
      ctx.lineTo(x - radius, y);
      ctx.closePath();
    } else if (node.type === 'image') {
      ctx.rect(
        x - radius,
        y - radius,
        radius * 2,
        radius * 2
      );
    } else {
      ctx.arc(
        x,
        y,
        radius,
        0,
        Math.PI * 2
      );
    }

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  } else if (
    !dimmed &&
    node.status === 'failed'
  ) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffd3d3';
    ctx.stroke();
  }

  ctx.restore();
}

function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  ctx.clearRect(0, 0, width, height);

  const visible = getVisibleNodeSet();
  const activeSelection = getSelectionActiveSet();
  const thresholdValue = responseTimeFilter.value.trim();

  mapStats.textContent =
    visible.size +
    ' / ' +
    nodes.length +
    ' node' +
    (
      thresholdValue
        ? ' • ≥ ' +
          thresholdValue +
          ' ms'
        : ''
    );

  for (const edge of edges) {
    if (
      !visible.has(edge.source) ||
      !visible.has(edge.target)
    ) {
      continue;
    }

    const source = positionById.get(edge.source);
    const target = positionById.get(edge.target);

    if (!source || !target) {
      continue;
    }

    const s = worldToScreen(source.x, source.y);
    const t = worldToScreen(target.x, target.y);

    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);

    const selectedEdge =
      selectedId &&
      (
        edge.source === selectedId ||
        edge.target === selectedId
      );

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);

    if (
      selectedId &&
      !selectedEdge
    ) {
      const passiveAlpha =
        0.14 -
        (0.09 * selectionAnimationProgress);

      ctx.strokeStyle =
        'rgba(110,125,145,' +
        passiveAlpha +
        ')';

      ctx.lineWidth = 1;
    } else if (selectedEdge) {
      const selectedStatus =
        sourceNode?.status === 'failed'
          ? sourceNode.status
          : targetNode?.status;

      ctx.strokeStyle =
        selectedStatus
          ? statusColor(selectedStatus)
          : '#7fa4d1';

      ctx.lineWidth =
        1 +
        (1.3 * selectionAnimationProgress);

      ctx.shadowBlur =
        8 * selectionAnimationProgress;

      ctx.shadowColor =
        ctx.strokeStyle;
    } else if (
      targetNode?.status === 'failed'
    ) {
      ctx.strokeStyle = 'rgba(255,99,99,.55)';
      ctx.lineWidth = 1;
    } else {
      ctx.strokeStyle = 'rgba(116,145,184,.14)';
      ctx.lineWidth = 1;
    }

    ctx.stroke();
    ctx.restore();
  }

  for (const node of positionedNodes) {
    if (!visible.has(node.id)) {
      continue;
    }

    const screen = worldToScreen(node.x, node.y);

    if (
      screen.x < -20 ||
      screen.y < -20 ||
      screen.x > width + 20 ||
      screen.y > height + 20
    ) {
      continue;
    }

    const dimmed =
      activeSelection !== null &&
      !activeSelection.has(node.id);

    drawNode(
      node,
      screen.x,
      screen.y,
      dimmed
    );
  }
}

function nearestNode(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const visible = getVisibleNodeSet();

  let nearest = null;
  let nearestDistance = 14;

  for (const node of positionedNodes) {
    if (!visible.has(node.id)) {
      continue;
    }

    const screen = worldToScreen(node.x, node.y);
    const dx = screen.x - x;
    const dy = screen.y - y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function findPath(target) {
  if (target === rootUrl) {
    return [rootUrl];
  }

  const queue = [rootUrl];
  const visited = new Set([rootUrl]);
  const parent = new Map();

  while (queue.length) {
    const current = queue.shift();

    for (
      const next of
      outgoing.get(current) ?? []
    ) {
      if (visited.has(next)) {
        continue;
      }

      visited.add(next);
      parent.set(next, current);

      if (next === target) {
        const path = [target];
        let cursor = target;

        while (parent.has(cursor)) {
          cursor = parent.get(cursor);
          path.push(cursor);
        }

        return path.reverse();
      }

      queue.push(next);
    }
  }

  return [];
}

function selectNode(node) {
  selectedId = node.id;
  selectionAnimationProgress = 0;
  renderDetail(node);
  animateSelectionFocus();
}

function clearSelection() {
  resetSelectionState();

  detailPanel.innerHTML = \`
    <h3 class="detail-title">URL Detayı</h3>
    <div class="subtitle">Map üzerinde bir node seçin.</div>
  \`;

  draw();
}

function centerNode(node) {
  offsetX =
    canvas.clientWidth / 2 -
    node.x * scale;

  offsetY =
    canvas.clientHeight / 2 -
    node.y * scale;

  draw();
}

function renderDetail(node) {
  const result = resultByUrl.get(node.id);
  const references = node.referencedBy ?? [];
  const path = findPath(node.id);

  const referencesHtml =
    references.length
      ? \`
        <ul class="reference-list">
          \${references.map(
            url => \`
              <li>
                <a
                  href="\${escapeText(url)}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  \${escapeText(url)}
                </a>
              </li>
            \`
          ).join('')}
        </ul>
      \`
      : '<div class="subtitle">Referans bulunamadı.</div>';

  const pathHtml =
    path.length
      ? path.map(
          (url, index) => \`
            <div class="path-node">
              <a
                href="\${escapeText(url)}"
                target="_blank"
                rel="noopener noreferrer"
              >
                \${escapeText(url)}
              </a>

              \${
                index < path.length - 1
                  ? '<div class="path-arrow">↓</div>'
                  : ''
              }
            </div>
          \`
        ).join('')
      : '<div class="subtitle">Root üzerinden yol bulunamadı.</div>';

  detailPanel.innerHTML = \`
    <h3 class="detail-title">URL Detayı</h3>

    <div class="detail-url">
      \${escapeText(node.id)}
    </div>

    <div class="detail-row">
      <div class="detail-key">Type</div>
      <div>\${escapeText(node.type)}</div>
    </div>

    <div class="detail-row">
      <div class="detail-key">Status</div>
      <div>\${escapeText(node.status)}</div>
    </div>

    <div class="detail-row">
      <div class="detail-key">Depth</div>
      <div>\${node.depth}</div>
    </div>

    <div class="detail-row">
      <div class="detail-key">HTTP</div>
      <div>\${result?.httpStatus ?? '-'}</div>
    </div>

    <div class="detail-row">
      <div class="detail-key">Response</div>
      <div>
        \${
          result?.responseTime != null
            ? result.responseTime + ' ms'
            : '-'
        }
      </div>
    </div>

    <div class="detail-row">
      <div class="detail-key">Content-Type</div>
      <div>\${escapeText(result?.contentType ?? '-')}</div>
    </div>

    <div class="detail-row">
      <div class="detail-key">Size</div>
      <div>
        \${
          result?.sizeBytes != null
            ? result.sizeBytes.toLocaleString('tr-TR') + ' byte'
            : '-'
        }
      </div>
    </div>

    \${
      result?.error
        ? \`
          <div class="detail-row">
            <div class="detail-key">Error</div>
            <div class="red">
              \${escapeText(shortError(result.error))}
            </div>
          </div>
        \`
        : ''
    }

    <a
      class="open-link"
      href="\${escapeText(node.id)}"
      target="_blank"
      rel="noopener noreferrer"
    >
      URL'yi Aç
    </a>

    <h4>
      Kullanıldığı Sayfalar
      (\${references.length})
    </h4>

    \${referencesHtml}

    <div class="path-box">
      <strong>Ana Sayfadan Ulaşım Yolu</strong>
      \${pathHtml}
    </div>
  \`;
}

window.showOnMap = function(encodedUrl) {
  const url = decodeURIComponent(encodedUrl);

  activatePage('sitemap');

  statusFilter.value = 'all';
  searchInput.value = '';
  responseTimeFilter.value = '';

  showHtml.checked = true;
  showPdf.checked = true;
  showImage.checked = true;

  const node = positionById.get(url);

  if (!node) {
    return;
  }

  selectedId = url;
  selectionAnimationProgress = 0;

  setTimeout(
    () => {
      resizeCanvas();
      scale = Math.max(scale, .7);
      centerNode(node);
      renderDetail(node);
      animateSelectionFocus();
    },
    20
  );
};

/* CANVAS EVENTS */
canvas.addEventListener(
  'mousedown',
  event => {
    dragging = true;
    canvas.classList.add('dragging');

    dragStartX = event.clientX;
    dragStartY = event.clientY;
    startOffsetX = offsetX;
    startOffsetY = offsetY;
  }
);

window.addEventListener(
  'mouseup',
  () => {
    dragging = false;
    canvas.classList.remove('dragging');
  }
);

window.addEventListener(
  'mousemove',
  event => {
    if (!dragging) {
      return;
    }

    offsetX =
      startOffsetX +
      (event.clientX - dragStartX);

    offsetY =
      startOffsetY +
      (event.clientY - dragStartY);

    draw();
  }
);

canvas.addEventListener(
  'click',
  event => {
    if (
      Math.abs(event.clientX - dragStartX) > 4 ||
      Math.abs(event.clientY - dragStartY) > 4
    ) {
      return;
    }

    const node =
      nearestNode(
        event.clientX,
        event.clientY
      );

    if (node) {
      selectNode(node);
      return;
    }

    clearSelection();
  }
);

canvas.addEventListener(
  'dblclick',
  event => {
    const node =
      nearestNode(
        event.clientX,
        event.clientY
      );

    if (node) {
      window.open(
        node.id,
        '_blank',
        'noopener'
      );
    }
  }
);

canvas.addEventListener(
  'wheel',
  event => {
    event.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const worldX = (mouseX - offsetX) / scale;
    const worldY = (mouseY - offsetY) / scale;

    const factor = event.deltaY < 0 ? 1.15 : 0.87;

    scale = Math.max(
      0.03,
      Math.min(5, scale * factor)
    );

    offsetX = mouseX - worldX * scale;
    offsetY = mouseY - worldY * scale;

    draw();
  },
  {
    passive: false
  }
);

searchInput.addEventListener(
  'input',
  () => {
    resetSelectionState();
    draw();
  }
);

statusFilter.addEventListener(
  'change',
  () => {
    resetSelectionState();
    fitGraph();
    draw();
  }
);

[
  showHtml,
  showPdf,
  showImage
].forEach(
  checkbox => {
    checkbox.addEventListener(
      'change',
      () => {
        resetSelectionState();
        fitGraph();
        draw();
      }
    );
  }
);

responseTimeFilter.addEventListener(
  'input',
  () => {
    resetSelectionState();

    detailPanel.innerHTML = \`
      <h3 class="detail-title">URL Detayı</h3>
      <div class="subtitle">Map üzerinde bir node seçin.</div>
    \`;

    fitGraph();
    draw();
  }
);

document
  .getElementById('fitButton')
  .addEventListener(
    'click',
    () => {
      fitGraph();
      draw();
    }
  );

window.addEventListener(
  'resize',
  () => {
    resizeCanvas();
    draw();
  }
);

resizeCanvas();
fitGraph();
draw();
</script>

</body>
</html>
`;

  await fs.mkdir(
    path.dirname(outputPath),
    {
      recursive: true,
    },
  );

  await fs.writeFile(
    outputPath,
    html,
    'utf-8',
  );

  console.log('');
  console.log('========================================');
  console.log(' WEBSITE HEALTH REPORT');
  console.log('========================================');
  console.log(`Total       : ${total}`);
  console.log(`Successful  : ${successful}`);
  console.log(`Retry Pass  : ${retryPassed}`);
  console.log(`Failed      : ${failed}`);
  console.log(`HTML        : ${htmlStats.total}`);
  console.log(`PDF         : ${pdfStats.total}`);
  console.log(`IMAGE       : ${imageStats.total}`);
  console.log(`Nodes       : ${nodes.length}`);
  console.log(`Edges       : ${crawl.edges.length}`);
  console.log('----------------------------------------');
  console.log(`Report: ${outputPath}`);
  console.log('========================================');
  console.log('');
}

main().catch(
  error => {
    console.error(error);
    process.exit(1);
  },
);
