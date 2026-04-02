#!/usr/bin/env node
/**
 * Local ADK workflow inspector: prints full user prompt, full model text, and pipeline counts per attempt.
 * Does not affect Render. Requires GOOGLE_GENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY in .env
 *
 * Usage:
 *   npm run adk:inspect -- https://blog.example.com/ "My Source"
 *   npm run adk:inspect -- https://a.com/ https://b.com/   # batch (name = hostname each)
 *   npm run adk:inspect -- --file scripts/adk-inspect-sources.txt
 *   npm run adk:inspect -- --summary https://a.com/ https://b.com/   # compact per source + comparison table
 *   SCOOPSTREAM_MODE=v2 npm run adk:inspect -- https://thegraph.com/blog/
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

process.env.SCOOPSTREAM_MODE = process.env.SCOOPSTREAM_MODE || 'v2';
process.env.SCOOPSTREAM_ENABLE_ADK = process.env.SCOOPSTREAM_ENABLE_ADK || 'true';

const ADKScraper = require('../server/services/adkScraper');

function hostnameFromUrl(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}

function parseSourcesFile(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const text = fs.readFileSync(abs, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const pipe = t.indexOf('|');
    if (pipe > 0) {
      const url = t.slice(0, pipe).trim();
      const name = t.slice(pipe + 1).trim() || hostnameFromUrl(url);
      if (/^https?:\/\//i.test(url)) out.push({ url, name });
      continue;
    }
    const comma = t.indexOf(',');
    if (comma > 0 && /^https?:\/\//i.test(t)) {
      const url = t.slice(0, comma).trim();
      const name = t.slice(comma + 1).trim() || hostnameFromUrl(url);
      if (/^https?:\/\//i.test(url)) out.push({ url, name });
      continue;
    }
    if (/^https?:\/\//i.test(t)) out.push({ url: t, name: hostnameFromUrl(t) });
  }
  return out;
}

function parseArgv(argv) {
  let summaryOnly = false;
  let filePath = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--summary') {
      summaryOnly = true;
      continue;
    }
    if (a === '--file') {
      filePath = argv[++i];
      if (!filePath) {
        console.error('--file requires a path');
        process.exit(1);
      }
      continue;
    }
    rest.push(a);
  }

  if (filePath) {
    const sources = parseSourcesFile(filePath);
    if (sources.length === 0) {
      console.error('No sources in file (lines: url or url|name or url,name)');
      process.exit(1);
    }
    return { summaryOnly, sources };
  }

  if (rest.length === 0) return { usage: true };

  const allLookLikeUrls = rest.every((x) => /^https?:\/\//i.test(x));
  if (allLookLikeUrls) {
    if (rest.length === 1) {
      return { summaryOnly, sources: [{ url: rest[0], name: 'inspect' }] };
    }
    return {
      summaryOnly,
      sources: rest.map((url) => ({ url, name: hostnameFromUrl(url) })),
    };
  }

  const url = rest[0];
  if (!/^https?:\/\//i.test(url)) {
    return { usage: true };
  }
  const name = rest.length > 1 ? rest.slice(1).join(' ') : 'inspect';
  return { summaryOnly, sources: [{ url, name }] };
}

function printHelp() {
  console.error(`
ADK inspect — see exact agent prompts, model text, and pipeline counts (local only).

  npm run adk:inspect -- <url> [display name]
  npm run adk:inspect -- <url1> <url2> ...     # batch; name = hostname per URL
  npm run adk:inspect -- --summary <url> ...    # shorter output + comparison table at end
  npm run adk:inspect -- --file path.txt       # one source per line: url | name

Requires GOOGLE_GENAI_API_KEY or GEMINI_API_KEY in .env.
`);
}

function escOneLine(s, max = 120) {
  if (s == null || typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function printInspectReport(articles, inspection, { summaryOnly } = {}) {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║ ADK INSPECT — compare PROMPT vs MODEL TEXT vs PIPELINE (per attempt)         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
  console.log(`Model: ${inspection.model || 'unknown'}`);
  console.log(`Source: ${inspection.source.name} | ${inspection.source.url}`);
  console.log(`Total ms: ${inspection.msTotal != null ? inspection.msTotal : '?'}\n`);
  console.log(
    'Note: The user message names this source and asks for JSON only — inspect USER PROMPT below to see the exact instructions for that feed.\n'
  );

  if (inspection.error) {
    console.log('ERROR:', inspection.error);
  }

  const attempts = inspection.attempts || [];
  const toPrint = summaryOnly && attempts.length ? [attempts[attempts.length - 1]] : attempts;

  toPrint.forEach((a) => {
    const label = summaryOnly
      ? `\n──────── Last attempt (${a.attempt} / ${attempts.length}) ────────\n`
      : `\n──────── Attempt ${a.attempt} / ${attempts.length} ────────\n`;
    console.log(label);
    if (!summaryOnly) {
      console.log('>>> USER PROMPT (sent to agent — full text)\n');
      console.log(a.prompt);
    } else if (a.prompt) {
      const maxExcerpt = 1400;
      const excerpt =
        a.prompt.length > maxExcerpt
          ? `${a.prompt.slice(0, maxExcerpt)}\n… [truncated — run without --summary for full USER PROMPT]\n`
          : a.prompt;
      console.log('>>> USER PROMPT (excerpt — includes curator role + task for this source)\n');
      console.log(excerpt);
    }
    console.log('\n>>> MODEL TEXT (raw final concatenation from stream)\n');
    console.log(a.fullResponse === '' ? '(empty)' : a.fullResponse);
    console.log('\n>>> PARSED JSON ITEM COUNT (before URL normalize): ', a.articlesBeforeFilter);
    console.log(
      '>>> Pipeline: domain filter →',
      a.afterDomain,
      '| HTTP verify →',
      a.afterQuality,
      '| date filter →',
      a.afterDateFilter,
      '| final out →',
      a.finalOut
    );
    console.log(
      '>>> Stream: events=',
      a.eventCount,
      'tools=',
      a.toolCallCount + '/' + a.toolResponseCount,
      'ground=',
      a.groundingEventCount + '/' + a.groundingChunkCount
    );
    console.log('>>> filteredOut:', JSON.stringify(a.filteredOut));
  });

  console.log('\n──────── Final articles returned (' + articles.length + ') ────────\n');
  articles.forEach((x, i) => {
    console.log(`${i + 1}. ${x.title}`);
    console.log(`   ${x.url || x.link}`);
    console.log(`   date: ${x.datePublished || 'none'}\n`);
  });

  if (!summaryOnly) {
    console.log('\nHow to read this:');
    console.log('- If MODEL TEXT is [] or empty but PROMPT looks fine → search/model/prompt issue.');
    console.log('- If MODEL TEXT has URLs but pipeline drops them → domain rules, 404 quality pass, or date window.');
    console.log('- Production uses concise [ADK] start/done; this script shows full prompts and model text.\n');
  }
}

async function runOne(scraper, source) {
  const result = await scraper.scrapeArticles(source, { inspect: true });
  return result;
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  if (parsed.usage) {
    printHelp();
    process.exit(1);
  }

  const key =
    process.env.GOOGLE_GENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;
  if (!key) {
    console.error('Set GOOGLE_GENAI_API_KEY or GEMINI_API_KEY (or GOOGLE_API_KEY) in .env');
    process.exit(1);
  }

  const { sources, summaryOnly } = parsed;
  const scraper = new ADKScraper();
  const batchTable = [];

  try {
    for (let si = 0; si < sources.length; si++) {
      const source = sources[si];
      if (sources.length > 1) {
        console.error(
          `\n${'='.repeat(72)}\n ADK INSPECT [${si + 1}/${sources.length}] ${source.name} — ${source.url}\n${'='.repeat(72)}\n`
        );
      } else {
        console.error('Running ADK with { inspect: true } … (server logs may appear above the blocks below)\n');
      }

      let result;
      try {
        result = await runOne(scraper, { ...source, category: 'General' });
      } catch (e) {
        batchTable.push({
          name: source.name,
          url: source.url,
          articles: 0,
          ms: null,
          lastModel: '(error)',
          err: e.message,
        });
        console.error('Inspect error:', e.message);
        continue;
      }

      const { articles, inspection } = result;
      if (!inspection) {
        console.error('No inspection payload (internal error).');
        process.exit(1);
      }

      const attempts = inspection.attempts || [];
      const last = attempts.length ? attempts[attempts.length - 1] : null;
      batchTable.push({
        name: source.name,
        url: source.url,
        articles: articles.length,
        ms: inspection.msTotal,
        lastModel: last ? escOneLine(last.fullResponse, 100) : '',
        err: inspection.error || null,
      });

      printInspectReport(articles, inspection, { summaryOnly });
    }
  } finally {
    await scraper.close();
  }

  if (sources.length > 1) {
    console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║ BATCH COMPARISON (last attempt model preview — use full blocks above to dig in) ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');
    const wName = Math.max(12, ...batchTable.map((r) => r.name.length));
    console.log(
      `${'Source'.padEnd(wName)}  ${'arts'.padStart(4)}  ${'ms'.padStart(6)}  last model / error`
    );
    console.log('-'.repeat(Math.min(120, wName + 4 + 6 + 6 + 80)));
    for (const r of batchTable) {
      const line = `${r.name.padEnd(wName)}  ${String(r.articles).padStart(4)}  ${r.ms != null ? String(r.ms).padStart(6) : '     ?'}  ${r.err || r.lastModel}`;
      console.log(line);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
