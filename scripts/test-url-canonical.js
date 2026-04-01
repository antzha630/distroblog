#!/usr/bin/env node
/**
 * Unit tests (no network) + optional live checks for HTML canonical URL merging (ADK quality path).
 * Run: node scripts/test-url-canonical.js
 * Live: same (fetches Medium + NEAR); requires network.
 */
const assert = require('assert');
const axios = require('axios');
const {
  extractCanonicalUrlFromHtml,
  pickPreferredArticleUrl,
  getAxiosFinalUrl,
} = require('../server/services/adkScraper');

const QUALITY_UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; ScoopstreamBot/1.0)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function testExtractCanonical() {
  const html = `<!doctype html><html><head>
    <link rel="canonical" href="https://medium.com/pub/a-b-c-123" />
  </head><body>x</body></html>`;
  assert.strictEqual(
    extractCanonicalUrlFromHtml(html),
    'https://medium.com/pub/a-b-c-123'
  );

  const og = `<head><meta property="og:url" content="https://example.com/post/hello" /></head>`;
  assert.strictEqual(extractCanonicalUrlFromHtml(og), 'https://example.com/post/hello');

  const amp = `<link rel="canonical" href="https://x.com/y?foo=1&amp;bar=2"/>`;
  assert.strictEqual(extractCanonicalUrlFromHtml(amp), 'https://x.com/y?foo=1&bar=2');

  console.log('ok extractCanonicalUrlFromHtml');
}

function testPickPreferred() {
  const src = 'https://medium.com/lumerin-blog';
  const fetchUrl =
    'https://medium.com/lumerin-blog/how-to-use-decentralized-hashpower-futures-to-create-advanced-trading-plans-b49b8684293d';
  const afterRedirect = fetchUrl;
  const html = `<link rel="canonical" href="https://medium.com/lumerin-blog/from-speculation-to-strategy-incorporating-hashpower-futures-into-advanced-trading-plans-a3061359fc43" />`;
  const out = pickPreferredArticleUrl(fetchUrl, afterRedirect, html, src);
  assert.strictEqual(
    out,
    'https://medium.com/lumerin-blog/from-speculation-to-strategy-incorporating-hashpower-futures-into-advanced-trading-plans-a3061359fc43'
  );

  // Wrong publication → keep base
  const badPub = pickPreferredArticleUrl(
    fetchUrl,
    afterRedirect,
    `<link rel="canonical" href="https://medium.com/other-pub/some-post-abc" />`,
    src
  );
  assert.strictEqual(badPub, fetchUrl);

  console.log('ok pickPreferredArticleUrl');
}

async function testLive() {
  const req = {
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (s) => s < 500,
    headers: QUALITY_UA_HEADERS,
  };

  const good =
    'https://medium.com/lumerin-blog/from-speculation-to-strategy-incorporating-hashpower-futures-into-advanced-trading-plans-a3061359fc43';
  const bad =
    'https://medium.com/lumerin-blog/how-to-use-decentralized-hashpower-futures-to-create-advanced-trading-plans-b49b8684293d';
  const near = 'https://www.near.org/blog/legion-city-nodes';

  for (const label of ['medium_good', 'medium_bad', 'near_short']) {
    const url = label === 'medium_good' ? good : label === 'medium_bad' ? bad : near;
    const sourceBase =
      label === 'near_short' ? 'https://www.near.org/blog' : 'https://medium.com/lumerin-blog';
    const resp = await axios.get(url, req);
    const after = getAxiosFinalUrl(resp, url);
    const html = typeof resp.data === 'string' ? resp.data : '';
    const preferred = pickPreferredArticleUrl(url, after, html, sourceBase);
    const status = resp.status;
    console.log(
      `[live ${label}] status=${status} afterRedirect=${after.slice(0, 80)}… preferred=${preferred.slice(0, 80)}…`
    );
    if (label.startsWith('medium')) {
      assert.ok(preferred.includes('medium.com/lumerin-blog/'));
    } else {
      assert.ok(preferred.includes('near.org/blog/'));
    }
  }

  console.log('ok live HTTP + pickPreferred');
}

async function main() {
  testExtractCanonical();
  testPickPreferred();
  await testLive();
  console.log('\nAll URL canonical tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
