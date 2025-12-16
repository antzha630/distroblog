// Quick script to test extractDateStatic on specific article URLs using cheerio (no Playwright).
// Run with: node scripts/check-dates.js

const path = require('path');
const fm = require('../server/services/feedMonitor');

const articles = [
  { source: 'Allora Labs', url: 'https://www.allora.network/blog/allora-brings-decentralized-predictive-intelligence-to-solana' },
  { source: 'Allora Labs', url: 'https://www.allora.network/blog/sei-meets-allora-collective-intelligence-for-high-speed-defi-applications' },
  { source: 'Giza', url: 'https://www.gizatech.xyz/blog/swarm-finance' },
  { source: 'Giza', url: 'https://www.gizatech.xyz/blog/giza-tokenomics-report' },
  { source: 'Io.net', url: 'https://io.net/blog/leonardo-ai-case-study' },
  { source: 'Io.net', url: 'https://io.net/blog/gpu-vs-cpu-for-ai' },
  { source: 'Fetch', url: 'https://fetch.ai/blog/the-dawn-of-the-age-of-agents' },
  { source: 'Olas Network', url: 'https://olas.network/blog/introducing-the-autonomous-keeper-service' },
  { source: 'Theoriq', url: 'https://www.theoriq.ai/blog/theoriq-alphavault-is-live-earn-eth-yield-and-thq-rewards-full-details' },
  { source: 'Aethir', url: 'https://aethir.com/blog-posts/aethir-brings-instant-play-to-reality-and-doctor-who-worlds-apart' },
];

async function main() {
  for (const item of articles) {
    try {
      const date = await fm.extractDateStatic(item.url);
      console.log(`✔ ${item.source}: ${item.url}`);
      console.log(`   Date: ${date || 'NO DATE FOUND'}`);
    } catch (e) {
      console.log(`✖ ${item.source}: ${item.url}`);
      console.log(`   Error: ${e.message}`);
    }
  }
  process.exit(0);
}

main();

