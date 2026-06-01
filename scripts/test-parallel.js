// Quick test script for Parallel.ai integration
// Run with: PARALLEL_API_KEY=your_key node scripts/test-parallel.js
// Or set PARALLEL_API_KEY in your .env file

require('dotenv').config();

const axios = require('axios');

const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1/search';
const PARALLEL_EXTRACT_URL = 'https://api.parallel.ai/v1/extract';

async function testSearch() {
  const apiKey = process.env.PARALLEL_API_KEY;
  
  if (!apiKey) {
    console.log('❌ PARALLEL_API_KEY not set. Please set it in .env or pass via environment variable.');
    console.log('   Example: PARALLEL_API_KEY=your_key node scripts/test-parallel.js');
    return false;
  }
  
  console.log(`✅ API Key found: ${apiKey.substring(0, 8)}...`);
  console.log('\n--- Testing Parallel.ai Search API ---\n');
  
  try {
    const testDomain = 'io.net';
    const requestBody = {
      objective: `Find recent blog posts and news articles from ${testDomain}. Focus on announcements, updates, and news from the past 30 days.`,
      search_queries: [
        `${testDomain} blog news`,
        `${testDomain} announcements updates`
      ],
      mode: 'basic',
      advanced_settings: {
        max_results: 5,
        source_policy: {
          include_domains: [testDomain]
        }
      }
    };
    
    console.log('Request:', JSON.stringify(requestBody, null, 2));
    console.log('\nSending request to Parallel Search API...\n');
    
    const response = await axios.post(PARALLEL_SEARCH_URL, requestBody, {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      }
    });
    
    console.log('✅ Search API Response:');
    console.log(`   Search ID: ${response.data.search_id}`);
    console.log(`   Results: ${response.data.results?.length || 0}`);
    
    if (response.data.results && response.data.results.length > 0) {
      console.log('\n   Articles found:');
      response.data.results.forEach((r, i) => {
        console.log(`   ${i + 1}. ${r.title || 'No title'}`);
        console.log(`      URL: ${r.url}`);
        console.log(`      Date: ${r.publish_date || 'No date'}`);
        console.log(`      Excerpts: ${r.excerpts?.length || 0} (${(r.excerpts?.[0] || '').substring(0, 100)}...)`);
      });
    }
    
    return response.data.results;
  } catch (error) {
    if (error.response) {
      console.log(`❌ Search API Error ${error.response.status}:`);
      console.log(JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(`❌ Search Error: ${error.message}`);
    }
    return null;
  }
}

async function testExtract(urls) {
  const apiKey = process.env.PARALLEL_API_KEY;
  if (!apiKey || !urls || urls.length === 0) return;
  
  console.log('\n--- Testing Parallel.ai Extract API ---\n');
  
  try {
    const testUrl = urls[0]?.url || 'https://io.net/blog/gpu-vs-cpu-for-ai';
    
    const requestBody = {
      urls: [testUrl],
      objective: 'Extract the full article content',
      advanced_settings: {
        full_content: {
          max_chars_per_result: 3000
        }
      }
    };
    
    console.log(`Extracting content from: ${testUrl}\n`);
    
    const response = await axios.post(PARALLEL_EXTRACT_URL, requestBody, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      }
    });
    
    console.log('✅ Extract API Response:');
    console.log(`   Extract ID: ${response.data.extract_id}`);
    console.log(`   Results: ${response.data.results?.length || 0}`);
    console.log(`   Errors: ${response.data.errors?.length || 0}`);
    
    if (response.data.results && response.data.results.length > 0) {
      const result = response.data.results[0];
      console.log(`\n   Title: ${result.title || 'No title'}`);
      console.log(`   Publish Date: ${result.publish_date || 'No date'}`);
      console.log(`   Excerpts: ${result.excerpts?.length || 0}`);
      console.log(`   Full Content: ${result.full_content ? result.full_content.length + ' chars' : 'Not returned'}`);
      if (result.full_content) {
        console.log(`\n   Content Preview:\n   ${result.full_content.substring(0, 500)}...`);
      }
    }
  } catch (error) {
    if (error.response) {
      console.log(`❌ Extract API Error ${error.response.status}:`);
      console.log(JSON.stringify(error.response.data, null, 2));
    } else {
      console.log(`❌ Extract Error: ${error.message}`);
    }
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Parallel.ai Integration Test');
  console.log('='.repeat(60));
  
  const searchResults = await testSearch();
  
  if (searchResults && searchResults.length > 0) {
    await testExtract(searchResults);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Test Complete');
  console.log('='.repeat(60));
}

main().catch(console.error);
