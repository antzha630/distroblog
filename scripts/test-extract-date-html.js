#!/usr/bin/env node
/**
 * Synthetic tests for articleEnrichment.extractDateFromHtml (no network, no API keys).
 * Run: npm run test:extract-date
 * CI-friendly: exits 1 on failure.
 */

const assert = require('assert');
const articleEnrichment = require('../server/services/articleEnrichment');

function ymd(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function run() {
  // og:published_time
  let html = `<!DOCTYPE html><html><head>
<meta property="og:published_time" content="2025-06-15T12:00:00Z">
</head><body></body></html>`;
  let got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2025-06-15', `og:published_time: got ${got}`);

  // article:published_time
  html = `<head><meta property="article:published_time" content="2024-03-01T08:00:00+00:00"></head>`;
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2024-03-01', `article:published_time: got ${got}`);

  // JSON-LD BlogPosting
  html =
    '<script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2023-11-20T10:00:00Z"}</script>';
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2023-11-20', `JSON-LD BlogPosting: got ${got}`);

  // JSON-LD @graph NewsArticle
  html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"X"},{"@type":"NewsArticle","headline":"Hi","datePublished":"2022-05-10"}]}</script>`;
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2022-05-10', `@graph NewsArticle: got ${got}`);

  // @type array
  html =
    '<script type="application/ld+json">{"@type":["NewsArticle","Thing"],"datePublished":"2021-01-31"}</script>';
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2021-01-31', `@type array: got ${got}`);

  // JSON-LD datePublished as { start: "YYYY-MM-DD" }
  html =
    '<script type="application/ld+json">{"@type":"BlogPosting","datePublished":{"start":"2020-07-01"}}</script>';
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2020-07-01', `JSON-LD datePublished.start: got ${got}`);

  // Next.js __NEXT_DATA__ (e.g. react.dev meta.date)
  html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { meta: { date: '2024/12/05', title: 'Post' } } },
  })}</script>`;
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2024-12-05', `__NEXT_DATA__ meta.date: got ${got}`);

  // __NEXT_DATA__ with many datePublished fields (index page) — should not guess
  html = `<script id="__NEXT_DATA__">${JSON.stringify({
    props: {
      pageProps: {
        posts: [1, 2, 3].map((i) => ({
          title: `p${i}`,
          datePublished: `2024-0${i}-0${i}T00:00:00Z`,
        })),
      },
    },
  })}</script>`;
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(got, null, `listing-like NEXT_DATA: expected null, got ${got}`);

  // Inline JS datePublishedRaw (e.g. sites that inject JSON-LD on DOMContentLoaded)
  html = `
    <html><body>
      <script>
        const datePublishedRaw = "Feb 06, 2026";
        const datePublished = toISO(datePublishedRaw);
      </script>
    </body></html>
  `;
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2026-02-06', `inline js datePublishedRaw: got ${got}`);

  // ld+json type with charset parameter
  html =
    '<script type="application/ld+json; charset=utf-8">{"@type":"Article","datePublished":"2019-06-15"}</script>';
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2019-06-15', `ld+json charset param: got ${got}`);

  // Single <article> body text fallback (no structured meta)
  html =
    '<html><body><article><p>Published March 3, 2022 in our blog.</p></article></body></html>';
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(ymd(got), '2022-03-03', `single article body: got ${got}`);

  // Two <article> nodes: do not pick a date from listing-like markup
  html = `<html><body><article><p>Jan 1, 2024</p></article><article><p>Feb 2, 2024</p></article></body></html>`;
  got = articleEnrichment.extractDateFromHtml(html);
  assert.strictEqual(got, null, `two articles: expected null, got ${got}`);

  assert.strictEqual(articleEnrichment.extractDateFromHtml(''), null, 'empty string');
  assert.strictEqual(articleEnrichment.extractDateFromHtml(null), null, 'null input');

  console.log('✅ test-extract-date-html: all checks passed');
}

try {
  run();
  process.exit(0);
} catch (e) {
  console.error('❌ test-extract-date-html failed:', e.message);
  if (e.actual !== undefined) console.error('  actual:', e.actual);
  if (e.expected !== undefined) console.error('  expected:', e.expected);
  process.exit(1);
}
