export interface CrawlOptions {
  rootUrl: string;
  output: string;
  maxPages: number;
  maxDepth: number;
  timeoutMs: number;
  includeSubdomains: boolean;
  ignoreHttpsErrors: boolean;
}

export interface UrlRecord {
  url: string;
  status: number | null;
  contentType: string;
  discoveredFrom: string | null;
  depth: number;
  title?: string;
}

export interface FailedUrlRecord {
  url: string;
  discoveredFrom: string | null;
  depth: number;
  status: number | null;
  error: string;
}

export interface CrawlResult {
  generatedAt: string;
  rootUrl: string;

  options: Omit<CrawlOptions, 'rootUrl' | 'output'>;

  summary: {
    visitedCount: number;
    htmlCount: number;
    pdfCount: number;
    imageCount: number;
    failedCount: number;
    externalCount: number;
    otherCount: number;
  };

  htmlUrls: string[];
  pdfUrls: string[];
  imageUrls: string[];

  html: UrlRecord[];
  pdf: UrlRecord[];
  images: UrlRecord[];

  failed: FailedUrlRecord[];
  externalUrls: string[];
  otherUrls: UrlRecord[];
}