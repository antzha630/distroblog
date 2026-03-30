#!/usr/bin/env node
/**
 * Local diagnostic for SCOOPSTREAM_MODE=v2.
 *
 * What it does:
 * 1) Runs feedMonitor.checkAllFeeds(true)
 * 2) Queries the DB for articles created during the run
 * 3) Reports missing/invalid pub_date for SCRAPING sources (ADK path)
 *
 * Usage:
 *   SCOOPSTREAM_MODE=v2 node scripts/diagnose-v2-date-diagnostics.js
 */

require('dotenv').config();

if ((process.env.SCOOPSTREAM_MODE || '').toLowerCase() !== 'v2') {
  console.warn('⚠️  SCOOPSTREAM_MODE is not v2. Set it to v2 for accurate diagnostics.');
}

const database = require('../server/database-postgres');
const feedMonitor = require('../server/services/feedMonitor');

function safeIso(x) {
  if (!x) return null;
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

(async () => {
  const startedAt = new Date();
  const startedAtMs = startedAt.getTime();
  console.log(`\n🩺 [DIAG] Starting v2 date diagnostics at ${startedAt.toISOString()}`);

  let results;
  try {
    results = await feedMonitor.checkAllFeeds(true);
  } catch (e) {
    console.error(`❌ [DIAG] feedMonitor.checkAllFeeds failed: ${e.message}`);
    throw e;
  }

  const endedAt = new Date();
  console.log(`✅ [DIAG] feedMonitor completed at ${endedAt.toISOString()}`);

  // Query newly created articles during this window.
  // Using created_at avoids re-enrichment updates (which touch updated_at).
  const queryStart = new Date(startedAtMs - 10 * 1000); // small safety window
  const windowStartIso = queryStart.toISOString();

  const rows = await database.pool.query(
    `
    SELECT
      a.id,
      a.title,
      a.link,
      a.pub_date,
      a.created_at,
      a.status,
      s.monitoring_type,
      s.name AS source_name
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    WHERE a.created_at >= $1
    ORDER BY a.created_at DESC
    LIMIT 300
    `,
    [windowStartIso]
  );

  const articles = rows.rows || [];
  console.log(`🧾 [DIAG] Newly created articles in window: ${articles.length}`);

  const scraping = articles.filter((a) => (a.monitoring_type || '').toUpperCase() === 'SCRAPING');
  console.log(`📦 [DIAG] SCRAPING-created articles: ${scraping.length}`);

  const missingPubDate = scraping.filter((a) => !a.pub_date);
  const invalidPubDate = scraping.filter((a) => {
    if (!a.pub_date) return false;
    return safeIso(a.pub_date) === null;
  });

  console.log(`🎯 [DIAG] SCRAPING missing pub_date: ${missingPubDate.length}`);
  console.log(`⚠️  [DIAG] SCRAPING invalid pub_date: ${invalidPubDate.length}`);

  if (missingPubDate.length > 0) {
    console.log('\n--- Missing pub_date examples (up to 10) ---');
    missingPubDate.slice(0, 10).forEach((a) => {
      console.log(`- ${a.source_name}: ${a.title?.substring(0, 80) || 'Untitled'} | ${a.link}`);
    });
  }

  if (invalidPubDate.length > 0) {
    console.log('\n--- Invalid pub_date examples (up to 10) ---');
    invalidPubDate.slice(0, 10).forEach((a) => {
      console.log(`- ${a.source_name}: pub_date=${String(a.pub_date)} | ${a.link}`);
    });
  }

  // Extra: count how many of the inserted articles are actually "new"
  const createdNew = articles.filter((a) => (a.status || '').toLowerCase() === 'new').length;
  console.log(`🟦 [DIAG] Created articles with status=new: ${createdNew}`);

  console.log('\n🧪 [DIAG] Summary from checkAllFeeds():');
  if (Array.isArray(results)) {
    console.log(`- results count: ${results.length}`);
    const failures = results.filter((r) => !r.success);
    console.log(`- failed sources: ${failures.length}`);
  } else {
    console.log(results);
  }

  const exitCode = missingPubDate.length > 0 || invalidPubDate.length > 0 ? 1 : 0;
  console.log(`\n🏁 [DIAG] Exit code: ${exitCode}`);
  process.exit(exitCode);
})().catch((e) => {
  console.error(`❌ [DIAG] Fatal error: ${e.message}`);
  process.exit(1);
});

