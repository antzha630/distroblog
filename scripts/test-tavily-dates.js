// Quick test to compare Tavily date extraction
require('dotenv').config();
const axios = require('axios');

async function testTavilyDates() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.log('❌ TAVILY_API_KEY not set');
    return;
  }
  
  console.log('Testing Tavily date extraction...\n');
  
  try {
    const response = await axios.post('https://api.tavily.com/search', {
      api_key: apiKey,
      query: 'site:io.net blog news',
      search_depth: 'basic',
      topic: 'news',           // This enables published_date extraction
      time_range: 'month',     // Pre-filter to last 30 days
      include_answer: false,
      include_raw_content: false,
      max_results: 5,
    }, { timeout: 15000 });
    
    const results = response.data.results || [];
    const withDates = results.filter(r => r.published_date).length;
    
    console.log(`✅ Tavily returned ${results.length} results (${withDates} with dates)\n`);
    
    results.forEach((r, i) => {
      console.log(`${i + 1}. ${r.title || 'No title'}`);
      console.log(`   URL: ${r.url}`);
      console.log(`   Date: ${r.published_date || 'NO DATE'}`);
      console.log(`   Content: ${(r.content || '').substring(0, 80)}...\n`);
    });
  } catch (error) {
    if (error.response) {
      console.log(`❌ Error ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    } else {
      console.log(`❌ Error: ${error.message}`);
    }
  }
}

testTavilyDates();
