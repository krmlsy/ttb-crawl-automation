export interface CrawlOptions {
  rootUrl: string;
  output: string;
  maxPages: number;
  maxDepth: number;
  timeoutMs: number;
  includeSubdomains: boolean;
  ignoreHttpsErrors: boolean;
}

export type ResourceType =
  | 'html'
  | 'pdf'
  | 'image'
  | 'other';

export interface CrawlEdge {
  /**
   * Linkin veya kaynağın bulunduğu sayfa.
   */
  source: string;

  /**
   * Source içerisinden ulaşılan URL.
   */
  target: string;

  /**
   * Target kaynağının tipi.
   */
  type: ResourceType;
}

export interface UrlRecord {
  url: string;

  status: number | null;

  contentType: string;

  /**
   * URL'nin crawler tarafından ilk bulunduğu sayfa.
   * Geriye dönük uyumluluk için tutuluyor.
   */
  discoveredFrom: string | null;

  /**
   * URL'ye referans veren tüm sayfalar.
   *
   * Özellikle sitemap ve fail analizi için kullanılacak.
   */
  referencedBy: string[];

  depth: number;

  title?: string;

  /**
   * Redirect varsa browser'ın ulaştığı son URL.
   */
  finalUrl?: string;

  redirected?: boolean;
}

export interface FailedUrlRecord {
  url: string;

  discoveredFrom: string | null;

  referencedBy: string[];

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

    /**
     * Sitemap içerisinde oluşan source → target
     * bağlantılarının toplam sayısı.
     */
    edgeCount: number;
  };

  /**
   * Testlerin mevcut yapısını bozmamak için
   * bu alanlar aynen korunuyor.
   */
  htmlUrls: string[];

  pdfUrls: string[];

  imageUrls: string[];

  html: UrlRecord[];

  pdf: UrlRecord[];

  images: UrlRecord[];

  failed: FailedUrlRecord[];

  externalUrls: string[];

  otherUrls: UrlRecord[];

  /**
   * Sitemap'in temel datası.
   *
   * Örnek:
   *
   * Ana Sayfa
   *    ↓
   * Krediler
   *    ↓
   * document.pdf
   */
  edges: CrawlEdge[];
}