// Quick local test for ADK with Custom Search API
// Run: node test-adk-local.js

require('dotenv').config();

const ADKScraper = require('./server/services/adkScraper');

async function testADK() {
  console.log('=== ADK Local Test ===\n');
  
  // Check env vars (try multiple possible key names)
  const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;
  
  const tavilyKey = process.env.TAVILY_API_KEY;
  
  console.log('Environment check:');
  console.log(`  GOOGLE_GENAI_API_KEY: ${apiKey ? '✅ Set (' + apiKey.substring(0, 8) + '...)' : '❌ Missing'}`);
  console.log(`  TAVILY_API_KEY: ${tavilyKey ? '✅ Set (' + tavilyKey.substring(0, 8) + '...)' : '❌ Missing'}`);
  
  if (!apiKey) {
    console.error('\n❌ No API key found. Set GOOGLE_GENAI_API_KEY or GEMINI_API_KEY');
    process.exit(1);
  }
  
  if (!tavilyKey) {
    console.warn('\n⚠️  No TAVILY_API_KEY found - will use grounding fallback (likely won\'t work well)');
  }
  
  console.log('\n--- Initializing ADK Scraper ---');
  const scraper = new ADKScraper();
  
  try {
    await scraper.initialize();
    console.log('✅ ADK Scraper initialized\n');
  } catch (err) {
    console.error('❌ Failed to initialize:', err.message);
    process.exit(1);
  }
  
  // Test with multiple sources
  const testSources = [
    { name: 'The Graph', url: 'https://thegraph.com/blog/', type: 'scraping' },
    { name: 'Near Protocol', url: 'https://near.org/blog', type: 'scraping' },
    { name: 'Nous Research', url: 'https://nousresearch.com/blog/', type: 'scraping' },
  ];
  
  const testSource = testSources[0]; // Test first one, can change index
  
  console.log(`--- Testing source: ${testSource.name} ---`);
  console.log(`URL: ${testSource.url}\n`);
  
  const startTime = Date.now();
  
  try {
    const articles = await scraper.scrapeArticles(testSource, { 
      daysBack: 30,
      maxItems: 5 
    });
    
    const elapsed = Date.now() - startTime;
    
    console.log(`\n--- Results (${elapsed}ms) ---`);
    console.log(`Found ${articles.length} articles:\n`);
    
    if (articles.length > 0) {
      articles.forEach((a, i) => {
        console.log(`${i + 1}. ${a.title}`);
        console.log(`   URL: ${a.url}`);
        console.log(`   Date: ${a.pub_date || 'unknown'}`);
        console.log('');
      });
    } else {
      console.log('No articles found. Check logs above for [ADK] Tool EXECUTE and [CSE] Search lines.');
    }
  } catch (err) {
    console.error('❌ Scrape error:', err.message);
  }
  
  // Cleanup
  try {
    await scraper.cleanup();
  } catch (e) {
    // ignore cleanup errors
  }
  
  console.log('\n=== Test Complete ===');
}

testADK().catch(console.error);
