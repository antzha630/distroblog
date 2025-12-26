#!/usr/bin/env node

/**
 * Local test script for ADK agent
 * Run: node scripts/test-adk-local.js
 * This allows you to test the ADK agent locally and see full responses
 */

require('dotenv').config();
const ADKScraper = require('../server/services/adkScraper');

async function testADKLocal() {
  console.log('🧪 Testing ADK Agent Locally...\n');
  
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ Error: GOOGLE_API_KEY or GEMINI_API_KEY not found');
    process.exit(1);
  }
  
  const adkScraper = new ADKScraper();
  
  const testSource = {
    id: 1,
    name: 'Test Source',
    url: 'https://aethir.com/blog',
    category: 'Test'
  };
  
  console.log(`🔍 Testing with: ${testSource.url}\n`);
  
  try {
    const articles = await adkScraper.scrapeArticles(testSource);
    
    console.log(`\n✅ Test completed`);
    console.log(`📊 Found ${articles.length} articles:\n`);
    
    articles.forEach((article, i) => {
      console.log(`${i + 1}. ${article.title}`);
      console.log(`   URL: ${article.link}`);
      console.log(`   Date: ${article.datePublished || 'No date'}`);
      console.log('');
    });
    
    await adkScraper.close();
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error('\nStack:', error.stack);
    }
    process.exit(1);
  }
}

testADKLocal();

