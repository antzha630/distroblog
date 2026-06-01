#!/usr/bin/env node
/**
 * Quick test of Parallel.ai API to see what it returns for a specific domain
 * This simulates what the playground does but shows us the raw data
 */

const axios = require('axios');

const PARALLEL_API_KEY = process.env.PARALLEL_API_KEY || 's0uUAkvIJxMF9oSYM9kpvMFU0eBLzsvGxVlYZdA_';
const SEARCH_URL = 'https://api.parallel.ai/v1/search';
const EXTRACT_URL = 'https://api.parallel.ai/v1/extract';

// Test domain - one that was returning 0 articles
const TEST_DOMAIN = process.argv[2] || '0g.ai';

async function testSearch() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing Parallel.ai Search API for: ${TEST_DOMAIN}`);
  console.log(`${'='.repeat(60)}\n`);

  // Calculate 30 days ago
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const afterDateStr = thirtyDaysAgo.toISOString().split('T')[0];
  
  const currentYear = new Date().getFullYear();
  
  const requestBody = {
    objective: `Find the most recent blog posts and news articles from ${TEST_DOMAIN} published in ${currentYear}. Focus on announcements, updates, and news from the past 30 days.`,
    search_queries: [
      `${TEST_DOMAIN} blog news ${currentYear}`,
      `${TEST_DOMAIN} announcements updates`
    ],
    mode: 'advanced',
    advanced_settings: {
      max_results: 10,
      source_policy: {
        include_domains: [TEST_DOMAIN],
        after_date: afterDateStr
      },
      fetch_policy: {
        max_age_seconds: 86400,
        timeout_seconds: 15,
        disable_cache_fallback: false
      }
    }
  };

  console.log('Request body:');
  console.log(JSON.stringify(requestBody, null, 2));
  console.log('\n');

  try {
    const response = await axios.post(SEARCH_URL, requestBody, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PARALLEL_API_KEY
      }
    });

    const results = response.data.results || [];
    console.log(`✅ Search returned ${results.length} results\n`);

    if (results.length === 0) {
      console.log('❌ No results found! The domain may not be indexed or has no recent content.\n');
      return [];
    }

    // Show results
    console.log('Results:');
    console.log('-'.repeat(60));
    
    results.forEach((r, i) => {
      console.log(`\n${i + 1}. ${r.title || '(no title)'}`);
      console.log(`   URL: ${r.url}`);
      console.log(`   Date: ${r.publish_date || '❌ NO DATE'}`);
      if (r.excerpts && r.excerpts.length > 0) {
        console.log(`   Excerpt: ${r.excerpts[0].substring(0, 150)}...`);
      }
    });

    // Summary
    const withDates = results.filter(r => r.publish_date).length;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SUMMARY: ${withDates}/${results.length} results have dates`);
    
    if (withDates > 0) {
      const dates = results.filter(r => r.publish_date).map(r => r.publish_date).sort();
      console.log(`Date range: ${dates[0]} to ${dates[dates.length - 1]}`);
      
      const recentCount = results.filter(r => {
        if (!r.publish_date) return false;
        return new Date(r.publish_date) >= thirtyDaysAgo;
      }).length;
      console.log(`Recent (within 30 days): ${recentCount}/${results.length}`);
    }
    console.log(`${'='.repeat(60)}\n`);

    return results;
  } catch (error) {
    console.error('❌ Search failed:', error.response?.data || error.message);
    return [];
  }
}

async function testExtract(urls) {
  if (!urls || urls.length === 0) {
    console.log('Skipping Extract test - no URLs to extract\n');
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing Parallel.ai Extract API for dates`);
  console.log(`${'='.repeat(60)}\n`);

  const urlsToExtract = urls.slice(0, 5);
  console.log(`Extracting dates from ${urlsToExtract.length} URLs...\n`);

  try {
    const response = await axios.post(EXTRACT_URL, {
      urls: urlsToExtract,
      objective: 'Find the publication date of this article',
      advanced_settings: {
        fetch_policy: {
          timeout_seconds: 30,
          disable_cache_fallback: false
        },
        excerpt_settings: {
          max_chars_per_result: 1000
        }
      }
    }, {
      timeout: 45000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PARALLEL_API_KEY
      }
    });

    const results = response.data.results || [];
    const errors = response.data.errors || [];

    console.log(`✅ Extract returned ${results.length} results, ${errors.length} errors\n`);

    results.forEach((r, i) => {
      console.log(`${i + 1}. ${r.url.split('/').pop().substring(0, 40)}...`);
      console.log(`   Date from Extract: ${r.publish_date || '❌ NO DATE'}`);
    });

    if (errors.length > 0) {
      console.log('\nErrors:');
      errors.forEach(e => {
        console.log(`   ❌ ${e.url}: ${e.error_type}`);
      });
    }

    const datesFound = results.filter(r => r.publish_date).length;
    console.log(`\nExtract found dates for ${datesFound}/${urlsToExtract.length} URLs`);

  } catch (error) {
    console.error('❌ Extract failed:', error.response?.data || error.message);
  }
}

async function main() {
  console.log('\n🔬 PARALLEL.AI API TEST');
  console.log(`Testing domain: ${TEST_DOMAIN}`);
  console.log(`Date filter: after ${new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]}`);
  
  const searchResults = await testSearch();
  
  // Test extract on URLs that don't have dates
  const urlsWithoutDates = searchResults
    .filter(r => !r.publish_date)
    .map(r => r.url);
  
  if (urlsWithoutDates.length > 0) {
    await testExtract(urlsWithoutDates);
  } else if (searchResults.length > 0) {
    console.log('\n✅ All search results already have dates - no need for Extract\n');
  }
}

main().catch(console.error);
