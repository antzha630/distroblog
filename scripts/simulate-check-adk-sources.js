#!/usr/bin/env node
/**
 * Run ADK scrapeArticles() for every active non-paused source whose monitoring type
 * uses the Tavily path (SCRAPING or ADK), similar to production "Check now" on v2.
 *
 * Does not run RSS sources or insert articles into the articles table; it does call
 * updateScrapingResult when source rows have ids (same as normal ADK).
 *
 * Usage (from repo root):
 *   node scripts/simulate-check-adk-sources.js
 *   node scripts/simulate-check-adk-sources.js --limit 5
 *   node scripts/simulate-check-adk-sources.js --offset 10 --limit 5
 *   node scripts/simulate-check-adk-sources.js --dry-run
 *   ADK_SKIP_POST_PROCESSING=true node scripts/simulate-check-adk-sources.js --limit 3
 *
 * Env: same as server — DATABASE_URL, TAVILY_API_KEY, GOOGLE_GENAI_API_KEY / GEMINI_API_KEY,
 * SCOOPSTREAM_MODE=v2 (defaults to v2 in this script if unset).
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.SCOOPSTREAM_MODE) {
  process.env.SCOOPSTREAM_MODE = 'v2';
}

const database = require('../server/database-postgres');
const ADKScraper = require('../server/services/adkScraper');
const config = require('../server/config');

const SKIP_SOURCES = [
  'hypercycle.ai',
  'www.hypercycle.ai',
  'Hyper Cycle',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    limit: null,
    offset: 0,
    dryRun: false,
    includeSkipped: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
    else if (args[i] === '--offset' && args[i + 1]) opts.offset = parseInt(args[++i], 10);
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--include-skipped') opts.includeSkipped = true;
  }
  return opts;
}

function shouldSkipSource(source) {
  if (SKIP_SOURCES.some(
    (p) =>
      source.name.toLowerCase().includes(p.toLowerCase()) ||
      (source.url && source.url.toLowerCase().includes(p.toLowerCase()))
  )) {
    return 'known problematic (feedMonitor SKIP_SOURCES)';
  }
  return null;
}

function isAdkMonitoringType(monitoringType) {
  const t = (monitoringType || 'RSS').toUpperCase();
  return t === 'SCRAPING' || t === 'ADK';
}

async function main() {
  const opts = parseArgs();

  console.log(`\n🔧 [simulate-check-adk] SCOOPSTREAM_MODE=${config.mode} ADK enabled=${config.adk?.enabled}`);
  if (!config.adk?.enabled) {
    console.warn(
      '⚠️  ADK is disabled (need SCOOPSTREAM_MODE=v2 and SCOOPSTREAM_ENABLE_ADK not false). Exiting.'
    );
    process.exit(1);
  }

  const apiKey =
    process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error('❌ Set GOOGLE_GENAI_API_KEY or GEMINI_API_KEY');
    process.exit(1);
  }
  if (!process.env.TAVILY_API_KEY) {
    console.warn('⚠️  TAVILY_API_KEY missing — web_search will fail or fall back poorly.');
  }

  const all = await database.getAllSources();
  const active = all.filter((s) => !s.is_paused);
  let targets = active.filter((s) => isAdkMonitoringType(s.monitoring_type));

  if (!opts.includeSkipped) {
    targets = targets.filter((s) => !shouldSkipSource(s));
  }

  if (opts.offset > 0) {
    targets = targets.slice(opts.offset);
  }
  if (opts.limit != null && opts.limit > 0) {
    targets = targets.slice(0, opts.limit);
  }

  console.log(
    `📋 [simulate-check-adk] Active ADK-eligible sources (after filters): ${targets.length} ` +
      `(total active non-paused: ${active.length})`
  );

  if (opts.dryRun) {
    targets.forEach((s, i) => {
      const skip = shouldSkipSource(s);
      console.log(`  ${i + 1}. ${s.name} [${s.monitoring_type}] ${s.url}${skip ? ` (would skip: ${skip})` : ''}`);
    });
    process.exit(0);
  }

  const scraper = new ADKScraper();
  const summary = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      const source = targets[i];
      const skipReason = !opts.includeSkipped ? shouldSkipSource(source) : null;
      if (skipReason) {
        console.log(`\n⏭️  [${i + 1}/${targets.length}] Skip ${source.name}: ${skipReason}`);
        summary.push({
          name: source.name,
          url: source.url,
          monitoring_type: source.monitoring_type,
          skipped: true,
          reason: skipReason,
          articleCount: 0,
          ms: 0,
        });
        continue;
      }

      console.log(`\n📊 [${i + 1}/${targets.length}] ADK: ${source.name} (${source.monitoring_type})`);
      const t0 = Date.now();
      let articles = [];
      let err = null;
      try {
        articles = await scraper.scrapeArticles(source);
      } catch (e) {
        err = e.message;
        console.error(`❌ [simulate-check-adk] ${source.name}: ${e.message}`);
      }
      const ms = Date.now() - t0;
      summary.push({
        name: source.name,
        url: source.url,
        monitoring_type: source.monitoring_type,
        skipped: false,
        articleCount: articles.length,
        ms,
        error: err || null,
      });
      console.log(
        `✅ [simulate-check-adk] ${source.name}: ${articles.length} articles in ${ms}ms` +
          (err ? ` (error logged above)` : '')
      );
    }
  } finally {
    if (typeof scraper.close === 'function') {
      try {
        await scraper.close();
      } catch (_) {
        /* ignore */
      }
    }
    try {
      await database.pool.end();
    } catch (_) {
      /* ignore */
    }
  }

  const ok = summary.filter((s) => !s.skipped && !s.error && s.articleCount > 0).length;
  const failed = summary.filter((s) => !s.skipped && (s.error || s.articleCount === 0)).length;
  console.log(`\n📌 [simulate-check-adk] Done. With articles: ${ok}, empty/error: ${failed}, skipped: ${summary.filter((s) => s.skipped).length}`);
  console.log(JSON.stringify({ summary }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
