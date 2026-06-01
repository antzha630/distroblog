#!/usr/bin/env node
/**
 * Quick test of Tavily API to compare with Parallel
 */

const axios = require('axios');

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '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';
const TAVILY_URL = 'https://api.tavily.com/search';

const TEST_DOMAIN = process.argv[2] || '0g.ai';

async function testTavily() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing Tavily API for: ${TEST_DOMAIN}`);
  console.log(`${'='.repeat(60)}\n`);

  const query = `site:${TEST_DOMAIN} blog OR news OR article`;

  console.log(`Query: ${query}`);
  console.log(`Options: topic=news, time_range=month\n`);

  try {
    const response = await axios.post(TAVILY_URL, {
      api_key: TAVILY_API_KEY,
      query: query,
      search_depth: 'basic',
      topic: 'news',         // Enables published_date in results
      time_range: 'month',   // Pre-filter to last 30 days
      include_answer: false,
      include_raw_content: false,
      max_results: 10,
    }, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });

    const results = response.data.results || [];
    console.log(`✅ Tavily returned ${results.length} results\n`);

    if (results.length === 0) {
      console.log('❌ No results found!\n');
      return;
    }

    console.log('Results:');
    console.log('-'.repeat(60));

    results.forEach((r, i) => {
      console.log(`\n${i + 1}. ${r.title || '(no title)'}`);
      console.log(`   URL: ${r.url}`);
      console.log(`   Date: ${r.published_date || '❌ NO DATE'}`);
      if (r.content) {
        console.log(`   Content: ${r.content.substring(0, 100)}...`);
      }
    });

    const withDates = results.filter(r => r.published_date).length;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SUMMARY: ${withDates}/${results.length} results have dates`);
    
    if (withDates > 0) {
      const dates = results.filter(r => r.published_date).map(r => r.published_date).sort();
      console.log(`Date range: ${dates[0]} to ${dates[dates.length - 1]}`);
    }
    console.log(`${'='.repeat(60)}\n`);

  } catch (error) {
    if (error.response?.status === 432 || error.response?.status === 429) {
      console.error('❌ Tavily quota exhausted! Status:', error.response.status);
    } else {
      console.error('❌ Tavily failed:', error.response?.data || error.message);
    }
  }
}

testTavily().catch(console.error);
