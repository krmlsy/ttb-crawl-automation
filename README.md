# Playwright URL Crawler + URL Health Tests

Bu proje iki aşamalı çalışır:

1. Verilen başlangıç URL'sini Playwright ile crawl eder ve aynı site içindeki HTML/PDF URL'lerini `data/crawl-results.json` dosyasına yazar.
2. Playwright testleri bu JSON'u okuyarak HTML sayfalarının erişilebilirliğini ve PDF'lerin gerçekten indirilebilir/geçerli PDF yanıtı olup olmadığını kontrol eder.

## Gereksinimler

- Node.js 20+ (Node.js 22/24 uygundur)
- npm

Proje Playwright `1.63.0` ile hazırlanmıştır.

## Kurulum

```bash
npm install
npm run install:browsers
```

## 1. Crawl çalıştırma

```bash
npm run crawl -- --url https://www.turkticaretbankasi.com.tr/
```

Varsayılan çıktı:

```text
data/crawl-results.json
```

### Örnek gelişmiş kullanım

```bash
npm run crawl -- \
  --url https://www.turkticaretbankasi.com.tr/ \
  --max-pages 2000 \
  --max-depth 15 \
  --timeout 45000
```

Kurumsal/UAT ortamında self-signed sertifika varsa:

```bash
npm run crawl -- \
  --url https://uat.example.local/ \
  --ignore-https-errors true
```

Alt domainleri de crawl etmek için:

```bash
npm run crawl -- \
  --url https://example.com/ \
  --include-subdomains true
```

### Crawler parametreleri

| Parametre | Varsayılan | Açıklama |
|---|---:|---|
| `--url` | zorunlu | Başlangıç URL'si |
| `--output` | `data/crawl-results.json` | JSON çıktı dosyası |
| `--max-pages` | `1000` | Ziyaret edilecek maksimum URL |
| `--max-depth` | `10` | Maksimum link derinliği |
| `--timeout` | `30000` | Sayfa navigation timeout (ms) |
| `--include-subdomains` | `false` | Alt domainleri dahil et |
| `--ignore-https-errors` | `false` | TLS/sertifika hatalarını yok say |

Crawler `mailto:`, `tel:`, `javascript:` gibi HTTP dışı linkleri almaz. Fragment (`#...`) alanlarını ve yaygın tracking parametrelerini temizleyerek duplicate URL oluşmasını azaltır.

## JSON çıktısı

Örnek yapı:

```json
{
  "rootUrl": "https://example.com/",
  "summary": {
    "visitedCount": 120,
    "htmlCount": 90,
    "pdfCount": 20,
    "failedCount": 2,
    "externalCount": 30,
    "otherCount": 8
  },
  "htmlUrls": [
    "https://example.com/",
    "https://example.com/about"
  ],
  "pdfUrls": [
    "https://example.com/files/report.pdf"
  ]
}
```

JSON ayrıca HTML/PDF kayıtlarının status, content-type, depth ve `discoveredFrom` bilgilerini de içerir.

## 2. Testleri çalıştırma

Tüm testler:

```bash
npm test
```

Sadece HTML URL testleri:

```bash
npm run test:html
```

Sadece PDF testleri:

```bash
npm run test:pdf
```

HTML testleri her URL için gerçek Chromium navigation yapar ve:

- HTTP response geldiğini,
- HTTP status'un `< 400` olduğunu,
- response'un HTML content-type döndürdüğünü

kontrol eder.

PDF testleri her PDF URL için:

- HTTP status'un `< 400` olduğunu,
- `Content-Type: application/pdf` **veya** dosya içeriğinin `%PDF-` imzasıyla başladığını,
- response body'sinin boş olmadığını

kontrol eder.

## Test raporu

Test tamamlandıktan sonra:

```bash
npm run report
```

HTML raporu `playwright-report/` altında oluşur.

## Farklı bir JSON dosyasını test etmek

Crawler çıktısını farklı bir isimle oluşturabilirsiniz:

```bash
npm run crawl -- --url https://example.com --output data/example.json
```

macOS/Linux:

```bash
CRAWL_DATA=data/example.json npm test
```

PowerShell:

```powershell
$env:CRAWL_DATA="data/example.json"
npm test
```

## Faydalı environment değişkenleri

```text
WORKERS=4
RETRIES=1
HEADLESS=true
NAVIGATION_TIMEOUT=30000
PDF_TIMEOUT=60000
TEST_TIMEOUT=60000
IGNORE_HTTPS_ERRORS=false
CRAWL_DATA=data/crawl-results.json
```

Örnek:

```bash
WORKERS=8 RETRIES=2 npm test
```

## Önerilen akış

```bash
npm install
npm run install:browsers
npm run crawl -- --url https://www.turkticaretbankasi.com.tr/
npm test
npm run report
```

1-crawl
IGNORE_HTTPS_ERRORS=true npm run crawl -- \
  --url https://www.turkticaretbankasi.com.tr/ \
  --max-pages 2000 \
  --max-depth 15 \
  --timeout 45000

2-test
IGNORE_HTTPS_ERRORS=true npm test

3-report
npm run report:site 