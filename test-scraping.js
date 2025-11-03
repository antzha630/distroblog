#!/usr/bin/env node

const FeedDiscovery = require('./server/services/feedDiscovery');

async function testScraping(url) {
  console.log('\n' + '='.repeat(70));
  console.log('Testing scraping for:', url);
  console.log('='.repeat(70));
  
  try {
    const discovery = new FeedDiscovery();
    
    // Try structured data first
    console.log('\n1. Trying structured data (JSON-LD)...');
    const structured = await discovery.extractStructuredData(url);
    console.log(`   Found ${structured.length} articles from structured data`);
    
    // Try blog section extraction
    console.log('\n2. Trying blog section HTML extraction...');
    const blogArticles = await discovery.extractArticlesFromBlogSection(url);
    console.log(`   Found ${blogArticles.length} articles from blog section`);
    
    // Merge results
    const merged = [...structured, ...blogArticles];
    
    // Deduplicate by URL
    const seen = new Set();
    const unique = merged.filter(a => {
      if (!a.url || seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });
    
    // Normalize to RSS-like format
    const normalized = unique.map(a => ({
      title: a.title || 'Untitled',
      link: a.url || '',
      preview: (a.description || '').substring(0, 200),
      pub_date: a.datePublished || null
    }));
    
    console.log('\n' + '='.repeat(70));
    console.log(`✅ RESULTS: Found ${normalized.length} unique articles`);
    console.log('='.repeat(70));
    
    if (normalized.length > 0) {
      console.log('\n📰 Sample articles:');
      normalized.slice(0, 5).forEach((article, i) => {
        console.log(`\n${i + 1}. ${article.title}`);
        console.log(`   Link: ${article.link}`);
        console.log(`   Preview: ${article.preview.substring(0, 100)}...`);
        console.log(`   Date: ${article.pub_date || 'Not available'}`);
      });
    } else {
      console.log('\n❌ No articles found. This could mean:');
      console.log('   - The site uses JavaScript rendering (needs headless browser)');
      console.log('   - The blog structure is different than expected');
      console.log('   - The site blocks scraping');
    }
    
    return normalized;
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    return [];
  }
}

// Test URLs
const testUrls = [
  'https://aethir.com/blog',
  'https://gensyn.ai',
  'https://blog.gensyn.ai'
];

(async () => {
  console.log('🧪 Testing Scraping Functionality\n');
  
  if (process.argv[2]) {
    // Test specific URL from command line
    await testScraping(process.argv[2]);
  } else {
    // Test default URLs
    for (const url of testUrls) {
      await testScraping(url);
      console.log('\n');
      await new Promise(r => setTimeout(r, 2000)); // Rate limit
    }
  }
})();

