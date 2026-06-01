// End-to-end test of ADK scraper with Parallel.ai integration
// Run with: node scripts/test-adk-parallel.js

require('dotenv').config();

const ADKScraper = require('../server/services/adkScraper');

async function main() {
  console.log('='.repeat(60));
  console.log('ADK Scraper + Parallel.ai End-to-End Test');
  console.log('='.repeat(60));
  
  // Check config
  const config = require('../server/config');
  console.log('\nConfiguration:');
  console.log(`  Mode: ${config.mode}`);
  console.log(`  Search Providers: ${config.search?.providers?.join(' → ') || 'not configured'}`);
  console.log(`  Parallel API Key: ${config.search?.parallelApiKey ? config.search.parallelApiKey.substring(0, 8) + '...' : 'not set'}`);
  console.log(`  Tavily API Key: ${config.search?.tavilyApiKey ? config.search.tavilyApiKey.substring(0, 8) + '...' : 'not set'}`);
  
  // Create scraper instance
  const scraper = new ADKScraper();
  
  // Test source
  const testSource = {
    id: 999,
    name: 'io.net (Test)',
    url: 'https://io.net/blog',
    type: 'SCRAPING',
    category: 'DeAI'
  };
  
  console.log(`\nTest Source: ${testSource.name}`);
  console.log(`URL: ${testSource.url}`);
  console.log('\nInitializing ADK scraper...');
  
  try {
    // Initialize
    await scraper.initialize();
    console.log('✅ ADK scraper initialized\n');
    
    // Scrape articles
    console.log('Scraping articles (this may take 10-20 seconds)...\n');
    const startTime = Date.now();
    
    const articles = await scraper.scrapeArticles(testSource);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Scraping completed in ${elapsed}s`);
    console.log(`   Found ${articles.length} articles\n`);
    
    if (articles.length > 0) {
      console.log('Articles:');
      articles.forEach((a, i) => {
        console.log(`\n${i + 1}. ${a.title}`);
        console.log(`   URL: ${a.link || a.url}`);
        console.log(`   Date: ${a.datePublished || 'No date'}`);
        console.log(`   Description: ${(a.description || a.content || '').substring(0, 100)}...`);
      });
    }
    
    // Cleanup
    await scraper.close();
    console.log('\n✅ Scraper closed');
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    console.error(error.stack);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Test Complete');
  console.log('='.repeat(60));
}

main().catch(console.error);
