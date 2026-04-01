#!/usr/bin/env node
/**
 * Measures how often HTML canonical merging helps (same pipeline as ADK quality pass).
 * Run: node scripts/eval-url-canonical-effectiveness.js
 */
const axios = require('axios');
const {
  extractCanonicalUrlFromHtml,
  pickPreferredArticleUrl,
  getAxiosFinalUrl,
  fetchArticleForQuality,
  canonicalizeKnownBlogUrl,
} = require('../server/services/adkScraper');

const BROWSER_UA = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const MEDIUM_GOOD =
  'https://medium.com/lumerin-blog/from-speculation-to-strategy-incorporating-hashpower-futures-into-advanced-trading-plans-a3061359fc43';

const CASES = [
  {
    id: 'medium_good',
    url: MEDIUM_GOOD,
    sourceBase: 'https://medium.com/lumerin-blog',
  },
  {
    id: 'medium_bad',
    url: 'https://medium.com/lumerin-blog/how-to-use-decentralized-hashpower-futures-to-create-advanced-trading-plans-b49b8684293d',
    sourceBase: 'https://medium.com/lumerin-blog',
  },
  {
    id: 'near_short_ok',
    url: 'https://www.near.org/blog/legion-city-nodes',
    sourceBase: 'https://www.near.org/blog',
  },
  {
    id: 'near_long_slug_404_repair',
    url: 'https://www.near.org/blog/near-legion-nodes-bring-the-near-protocol-blockchain-to-your-local-community',
    sourceBase: 'https://www.near.org/blog',
  },
];

function normalizeU(u) {
  try {
    return new URL(u).href.replace(/\/$/, '');
  } catch {
    return u;
  }
}

async function fetchLikeQuality(profile, resolved) {
  if (profile === 'scoopstream_bot') {
    return fetchArticleForQuality(resolved);
  }
  const req = {
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500,
    headers: BROWSER_UA,
  };
  let resp = await axios.get(resolved, req);
  let finalUrl = resolved;
  let used404Fallback = false;
  if (resp.status === 404) {
    const r2 = await fetchArticleForQuality(resolved);
    return r2;
  }
  return { resp, finalUrl, used404Fallback };
}

async function evalProfile(profile) {
  console.log(`\n========== ${profile} ==========\n`);

  for (const c of CASES) {
    const resolved = canonicalizeKnownBlogUrl(c.url);
    let resp;
    let finalUrl;
    let used404Fallback;

    try {
      ({ resp, finalUrl, used404Fallback } = await fetchLikeQuality(profile, resolved));
    } catch (e) {
      console.log(JSON.stringify({ id: c.id, error: e.message, resolved: resolved.slice(0, 100) }, null, 2));
      continue;
    }

    const afterRedirect = getAxiosFinalUrl(resp, finalUrl);
    const html = typeof resp.data === 'string' ? resp.data : '';
    const canonicalFromHtml = extractCanonicalUrlFromHtml(html);
    const preferred = pickPreferredArticleUrl(resolved, afterRedirect, html, c.sourceBase);
    const mergeChanged = preferred !== afterRedirect;

    const out = {
      id: c.id,
      httpStatus: resp.status,
      used404Fallback,
      htmlChars: html.length,
      afterRedirect: afterRedirect.slice(0, 110),
      canonicalFromHtml: canonicalFromHtml ? canonicalFromHtml.slice(0, 110) : null,
      preferredStored: preferred.slice(0, 110),
      canonicalMergeChangedUrl: mergeChanged,
    };

    if (c.id === 'medium_bad' || c.id === 'medium_good') {
      out.preferredMatchesMediumGood = normalizeU(preferred) === normalizeU(MEDIUM_GOOD);
    }

    console.log(JSON.stringify(out, null, 2));
  }
}

async function main() {
  console.log('URL canonical effectiveness (mirrors ADK quality pass + pickPreferredArticleUrl).\n');
  console.log('Reference Medium “good” URL:', MEDIUM_GOOD, '\n');

  await evalProfile('scoopstream_bot');
  await evalProfile('browser_chrome_ua');

  console.log(`
--- How to read ---
• canonicalFromHtml: non-null means we can merge; preferredStored may replace afterRedirect.
• preferredMatchesMediumGood: true means stored URL equals the known-good Medium article (bad→good fix).
• used404Fallback: NEAR long-slug repair found an alternate URL (existing behavior).
• If httpStatus is 403 and htmlChars is tiny, Medium blocked the bot — try browser_chrome_ua row.
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
