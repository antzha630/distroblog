require('dotenv').config();
const axios = require('axios');

// Get URL from command line argument or environment variable
const SERVER_URL = process.argv[2] || process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000';

async function clearArticles() {
  try {
    console.log(`Clearing all articles from ${SERVER_URL}...`);
    const response = await axios.delete(`${SERVER_URL}/api/articles/clear`);
    console.log(`✅ Success: ${response.data.message}`);
    console.log(`   Deleted ${response.data.deletedCount} articles`);
  } catch (error) {
    if (error.response) {
      console.error(`❌ Error: ${error.response.status} - ${error.response.data.error || error.response.data.message}`);
    } else if (error.request) {
      console.error(`❌ Error: No response from server. Is it running at ${SERVER_URL}?`);
    } else {
      console.error(`❌ Error: ${error.message}`);
    }
    process.exit(1);
  }
}

clearArticles();

