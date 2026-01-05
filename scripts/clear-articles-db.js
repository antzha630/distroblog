require('dotenv').config();
const database = require('../server/database-postgres');

async function clearArticles() {
  try {
    console.log('Connecting to database...');
    await database.init();
    console.log('✅ Database connected');
    
    console.log('Clearing all articles...');
    const deletedCount = await database.clearAllArticles();
    console.log(`✅ Successfully cleared ${deletedCount} articles from database`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

clearArticles();



