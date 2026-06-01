// Compare Tavily vs Parallel date extraction on the same domains
// Run: node scripts/compare-search-dates.js

require('dotenv').config();
const axios = require('axios');
const articleEnrichment = require('../server/services/articleEnrichment');

const TESTS = [
  { domain: 'io.net', query: 'site:io.net blog news' },
  { domain: 'fetch.ai', query: 'site:fetch.ai blog news' },
  { domain: 'near.org', query: 'site:near.org blog news' },
];

async function tavilySearch(query, apiKey, maxResults = 8) {
  const response = await axios.post(
    'https://api.tavily.com/search',
    {
      api_key: apiKey,
      query,
      search_depth: 'basic',
      topic: 'news',
      time_range: 'month',
      include_answer: false,
      include_raw_content: false,
      max_results: maxResults,
    },
    { timeout: 20000, headers: { 'Content-Type': 'application/json' } }
  );
  return response.data.results || [];
}

async function parallelSearch(query, apiKey, maxResults = 8) {
  const siteMatch = query.match(/site:(\S+)/i);
  const domain = siteMatch ? siteMatch[1].replace(/^www\./, '') : null;
  const cleanQuery = query.replace(/\bsite:\S+/gi, '').replace(/\s+/g, ' ').trim() || 'blog news';

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const afterDateStr = thirtyDaysAgo.toISOString().split('T')[0];

  const body = {
    objective: domain
      ? `Find recent blog posts and news from ${domain} in the last 30 days. Include publication dates when available.`
      : `Find recent articles about: ${cleanQuery}`,
    search_queries: domain
      ? [`${domain} blog news`, `${domain} recent articles`, `${domain} announcements`]
      : [cleanQuery, `${cleanQuery} news`, `${cleanQuery} updates`],
    mode: 'basic',
    advanced_settings: {
      max_results: maxResults,
      source_policy: {
        after_date: afterDateStr,
        ...(domain ? { include_domains: [domain] } : {}),
      },
    },
  };

  const response = await axios.post('https://api.parallel.ai/v1/search', body, {
    timeout: 25000,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
  });
  return response.data.results || [];
}

async function parallelExtractDates(urls, apiKey) {
  if (!urls.length) return new Map();
  const response = await axios.post(
    'https://api.parallel.ai/v1/extract',
    {
      urls: urls.slice(0, 10),
      objective: 'Find the publication date of this article',
      advanced_settings: { excerpt_settings: { max_chars_per_result: 500 } },
    },
    { timeout: 35000, headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey } }
  );
  const map = new Map();
  for (const r of response.data.results || []) {
    if (r.publish_date) map.set(r.url, r.publish_date);
  }
  return map;
}

async function htmlDates(urls) {
  const map = new Map();
  for (const url of urls.slice(0, 8)) {
    try {
      const resp = await axios.get(url, {
        timeout: 12000,
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScoopstreamBot/1.0)' },
        validateStatus: (s) => s < 500,
      });
      if (resp.status >= 400) {
        map.set(url, null);
        continue;
      }
      const iso = articleEnrichment.extractDateFromHtml(
        typeof resp.data === 'string' ? resp.data : ''
      );
      map.set(url, iso ? iso.slice(0, 10) : null);
    } catch {
      map.set(url, null);
    }
  }
  return map;
}

function summarize(label, results, dateField) {
  const total = results.length;
  const withDates = results.filter((r) => r[dateField]).length;
  const pct = total ? ((withDates / total) * 100).toFixed(0) : 0;
  return { label, total, withDates, pct };
}

function printResults(title, results, dateField) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  if (!results.length) {
    console.log('  (no results)');
    return;
  }
  results.forEach((r, i) => {
    const url = r.url || r.link || '?';
    const date = r[dateField] || 'NO DATE';
    const t = (r.title || 'No title').substring(0, 70);
    console.log(`  ${i + 1}. [${date}] ${t}`);
    console.log(`     ${url}`);
  });
}

async function main() {
  const tavilyKey = process.env.TAVILY_API_KEY;
  const parallelKey = process.env.PARALLEL_API_KEY;

  console.log('='.repeat(70));
  console.log('Tavily vs Parallel — Date Extraction Comparison');
  console.log('='.repeat(70));
  console.log(`Tavily key:   ${tavilyKey ? tavilyKey.slice(0, 8) + '...' : 'NOT SET'}`);
  console.log(`Parallel key: ${parallelKey ? parallelKey.slice(0, 8) + '...' : 'NOT SET'}`);

  const summary = {
    tavily: { ok: false, domains: [] },
    parallelSearch: { ok: false, domains: [] },
    parallelExtract: { ok: false, domains: [] },
    html: { ok: true, domains: [] },
  };

  for (const test of TESTS) {
    console.log('\n' + '='.repeat(70));
    console.log(`Domain: ${test.domain}`);
    console.log('='.repeat(70));

    let tavilyResults = [];
    let parallelResults = [];

    // Tavily
    if (tavilyKey) {
      try {
        tavilyResults = await tavilySearch(test.query, tavilyKey);
        const s = summarize('Tavily', tavilyResults, 'published_date');
        summary.tavily.ok = true;
        summary.tavily.domains.push(s);
        printResults(`Tavily (${s.withDates}/${s.total} with dates, ${s.pct}%)`, tavilyResults, 'published_date');
      } catch (e) {
        const status = e.response?.status;
        const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.log(`\nTavily: FAILED ${status || ''} — ${msg}`);
        if (status === 432 || status === 429) {
          summary.tavily.error = 'quota_exhausted';
        }
      }
    }

    // Parallel Search
    if (parallelKey) {
      try {
        parallelResults = await parallelSearch(test.query, parallelKey);
        const s = summarize('Parallel Search', parallelResults, 'publish_date');
        summary.parallelSearch.ok = true;
        summary.parallelSearch.domains.push(s);
        printResults(
          `Parallel Search (${s.withDates}/${s.total} with dates, ${s.pct}%)`,
          parallelResults,
          'publish_date'
        );

        // Parallel Extract on URLs missing dates
        const missing = parallelResults.filter((r) => !r.publish_date).map((r) => r.url);
        if (missing.length) {
          try {
            const extractMap = await parallelExtractDates(missing, parallelKey);
            let added = 0;
            parallelResults = parallelResults.map((r) => {
              if (!r.publish_date && extractMap.has(r.url)) {
                added++;
                return { ...r, publish_date: extractMap.get(r.url) };
              }
              return r;
            });
            const s2 = summarize('Parallel Search+Extract', parallelResults, 'publish_date');
            summary.parallelExtract.ok = true;
            summary.parallelExtract.domains.push(s2);
            console.log(
              `\nParallel Extract added dates for ${added}/${missing.length} URLs without search dates`
            );
            printResults(
              `Parallel after Extract (${s2.withDates}/${s2.total} with dates, ${s2.pct}%)`,
              parallelResults,
              'publish_date'
            );
          } catch (e) {
            console.log(`\nParallel Extract: FAILED — ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
          }
        }
      } catch (e) {
        console.log(`\nParallel Search: FAILED — ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
      }
    }

    // HTML baseline on union of URLs
    const urls = [...new Set([
      ...tavilyResults.map((r) => r.url),
      ...parallelResults.map((r) => r.url),
    ].filter(Boolean))];

    if (urls.length) {
      console.log(`\nHTML metadata extraction (baseline) on ${Math.min(urls.length, 8)} URLs...`);
      const htmlMap = await htmlDates(urls);
      let htmlWithDates = 0;
      urls.slice(0, 8).forEach((url, i) => {
        const d = htmlMap.get(url);
        if (d) htmlWithDates++;
        console.log(`  ${i + 1}. [${d || 'NO DATE'}] ${url.substring(0, 90)}`);
      });
      summary.html.domains.push({
        domain: test.domain,
        total: Math.min(urls.length, 8),
        withDates: htmlWithDates,
        pct: urls.length ? ((htmlWithDates / Math.min(urls.length, 8)) * 100).toFixed(0) : 0,
      });
    }
  }

  // Aggregate summary
  console.log('\n' + '='.repeat(70));
  console.log('AGGREGATE SUMMARY');
  console.log('='.repeat(70));

  function avgPct(domains) {
    if (!domains.length) return 'N/A';
    const sum = domains.reduce((a, d) => a + Number(d.pct || 0), 0);
    return (sum / domains.length).toFixed(0) + '%';
  }

  if (summary.tavily.ok) {
    console.log(`Tavily search dates:           avg ${avgPct(summary.tavily.domains)} of results had published_date`);
  } else if (summary.tavily.error === 'quota_exhausted') {
    console.log('Tavily:                        QUOTA EXHAUSTED — could not run live comparison');
  } else {
    console.log('Tavily:                        not tested (no key or all requests failed)');
  }

  if (summary.parallelSearch.ok) {
    console.log(`Parallel search dates:           avg ${avgPct(summary.parallelSearch.domains)} of results had publish_date`);
  }
  if (summary.parallelExtract.ok) {
    console.log(`Parallel search+extract dates:   avg ${avgPct(summary.parallelExtract.domains)} after Extract API`);
  }
  if (summary.html.domains.length) {
    const htmlPct = summary.html.domains.reduce((a, d) => a + Number(d.pct), 0) / summary.html.domains.length;
    console.log(`HTML metadata (our fallback):    avg ${htmlPct.toFixed(0)}% on article pages`);
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
