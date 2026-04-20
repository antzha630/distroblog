/**
 * Test Playwright enrichment on ADK/scraping sources
 */

// Mock database
const mockDb = {
  enrichArticle: async (id, data) => {
    console.log(`  [DB] Would update article ${id} with:`);
    console.log(`       date: ${data.pubDate || 'none'}`);
    console.log(`       content: ${data.content ? data.content.substring(0, 60) + '...' : 'none'}`);
    return true;
  }
};

require.cache[require.resolve('./server/database-postgres')] = { 
  exports: mockDb 
};

const articleEnrichment = require('./server/services/articleEnrichment');

const testArticles = [
  {
    id: 10645,
    title: 'Understanding Coinbase x402 and ERC-8004',
    link: 'https://thegraph.com/blog/understanding-x402-erc8004/',
    pub_date: null,
    content: '',
    source: 'The Graph'
  },
  {
    id: 10940,
    title: 'Value Loop Toolkit for peaq Builders',
    link: 'https://www.peaq.xyz/blog/introducing-the-value-loop-toolkit-for-peaq-builders',
    pub_date: null,
    content: '',
    source: 'Peaq'
  },
  {
    id: 10433,
    title: 'NEARCON 2026: Building an AI Economy Without Compromise',
    link: 'https://near.org/blog/nearcon-2026-building-an-ai-economy-without-compromise/',
    pub_date: null,
    content: '',
    source: 'Near Protocol'
  }
];

async function test() {
  console.log('🧪 Testing Playwright enrichment on ADK/scraping sources...\n');
  console.log(`📊 Initial memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB\n`);
  
  for (const article of testArticles) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📄 [${article.source}] ${article.title.substring(0, 50)}...`);
    console.log(`   URL: ${article.link}`);
    
    const startMem = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const startTime = Date.now();
    
    const result = await articleEnrichment.enrichWithPlaywright(article);
    
    const endMem = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const duration = Date.now() - startTime;
    
    console.log(`   ⏱️  Duration: ${duration}ms`);
    console.log(`   📊 Memory: ${startMem}MB → ${endMem}MB`);
    console.log(`   ✅ Success: ${result.success}`);
    if (result.date) console.log(`   📅 Date: ${result.date}`);
    if (result.description) console.log(`   📝 Desc: ${result.description.substring(0, 60)}...`);
    if (!result.success) console.log(`   ⚠️  Reason: ${result.reason}`);
    
    // Wait between tests for memory to settle
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('\n✅ Test complete!');
  console.log('📊 Final stats:', articleEnrichment.getStats());
  console.log(`📊 Final memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
}

test().catch(console.error);
