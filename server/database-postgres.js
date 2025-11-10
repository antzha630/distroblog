const { Pool } = require('pg');

class Database {
  constructor() {
    let connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/distroblog';
    this.originalConnectionString = connectionString; // Store original for logging
    this.fixedConnectionString = null; // Will store the fixed connection string
    
    // Check if using Supabase and fix connection string if needed
    // Supabase direct connections (port 5432) don't work from Render - must use pooler (port 6543)
    if (connectionString.includes('supabase')) {
      try {
        const url = new URL(connectionString);
        const port = url.port || '5432';
        
        // If using pooler hostname but wrong port, fix it
        if (url.hostname.includes('pooler.supabase.com') && port === '5432') {
          console.log('⚠️ WARNING: Detected pooler hostname but port 5432. Auto-fixing to port 6543...');
          // Reconstruct URL with correct port
          const fixedUrl = new URL(connectionString);
          fixedUrl.port = '6543';
          connectionString = fixedUrl.toString();
          this.fixedConnectionString = connectionString; // Store fixed connection string
          console.log('✅ Auto-fixed: Changed port from 5432 to 6543');
          console.log(`   New connection: ${fixedUrl.hostname}:6543`);
        }
        // If using direct connection (db.supabase.co), convert to pooler
        else if (url.hostname.includes('db.') && url.hostname.includes('.supabase.co') && port === '5432') {
          console.log('⚠️ WARNING: Detected Supabase direct connection (port 5432). Converting to pooler...');
          
          // Extract project ref from hostname (e.g., db.abc123xyz.supabase.co -> abc123xyz)
          const projectRef = url.hostname.match(/db\.([^.]+)\.supabase\.co/)?.[1];
          if (projectRef) {
            // Construct pooler URL - try to detect region from hostname or use default
            let poolerHost = 'aws-1-us-east-1.pooler.supabase.com'; // Default region
            // Try to extract region if present in original hostname
            const regionMatch = url.hostname.match(/\.([a-z0-9-]+)\.supabase\.co/);
            if (regionMatch && regionMatch[1] !== projectRef) {
              // If region is in hostname, use it
              poolerHost = `aws-1-${regionMatch[1]}.pooler.supabase.com`;
            }
            
            // Build pooler URL with correct format
            const password = url.password ? `:${url.password}` : '';
            const poolerUrl = `${url.protocol}//postgres.${projectRef}${password}@${poolerHost}:6543${url.pathname}${url.search || ''}`;
            console.log(`🔄 Converting to pooler connection: ${poolerHost}:6543`);
            connectionString = poolerUrl;
            this.fixedConnectionString = connectionString; // Store fixed connection string
          } else {
            console.log('⚠️ Could not extract project ref from hostname. Please use pooler URL manually.');
          }
        }
      } catch (e) {
        // URL parsing failed, check if we can still detect the issue
        if (connectionString.includes(':5432') && connectionString.includes('supabase')) {
          console.log('⚠️ WARNING: Supabase connection string contains port 5432.');
          console.log('   Please update DATABASE_URL to use port 6543 (connection pooler).');
          console.log('   Format: postgresql://postgres.xxx:[PASSWORD]@aws-1-us-east-1.pooler.supabase.com:6543/postgres');
        }
      }
    }
    
    // Configure pool for Supabase/Render with better connection handling
    this.pool = new Pool({
      connectionString: connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Connection pool settings for Supabase
      max: 10, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 10000, // Return an error after 10 seconds if connection cannot be established
      // Handle connection errors gracefully
      allowExitOnIdle: false,
      // Force IPv4 (avoid IPv6 issues on Render)
      family: 4
    });

    // Handle pool errors (don't crash the app)
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      // Don't throw - let the pool handle reconnection
    });
  }

  async init() {
    let retries = 3;
    let lastError = null;
    
    // Log connection info for debugging (use the fixed connection string, not the original)
    const connectionStringToLog = this.fixedConnectionString || this.pool.options.connectionString || process.env.DATABASE_URL || '';
    if (connectionStringToLog) {
      try {
        const url = new URL(connectionStringToLog);
        const host = url.hostname;
        const port = url.port || (url.protocol.includes('postgres') ? '5432' : '5432');
        console.log(`🔌 Attempting to connect to database: ${host}:${port}`);
        
        // Check if using correct port for Supabase
        if (host.includes('supabase')) {
          if (port === '6543') {
            console.log('✅ Using Supabase connection pooler on port 6543 (correct for Render)');
          } else if (port === '5432') {
            console.error('❌ ERROR: Still using port 5432 after auto-fix attempt.');
            console.error('   Please update DATABASE_URL in Render dashboard to use port 6543.');
          } else {
            console.log(`⚠️ Using port ${port} for Supabase (expected 6543 for pooler)`);
          }
        }
      } catch (e) {
        // URL parsing failed, continue anyway
        console.log('🔌 Attempting to connect to database (connection string format unclear)');
      }
    }
    
    while (retries > 0) {
      try {
        // Test connection with timeout
        const client = await Promise.race([
          this.pool.connect(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout')), 15000)
          )
        ]);
        
        console.log('PostgreSQL connected successfully');
        client.release();

        // Create tables
        await this.createTables();
        console.log('Database tables created/verified');
        return; // Success!
      } catch (err) {
        lastError = err;
        retries--;
        
        // Provide helpful error messages
        if (err.code === 'ENETUNREACH' && err.address && err.port === 5432) {
          console.error(`❌ Database connection failed (${retries} retries left): Network unreachable on port 5432`);
          console.error('   This usually means you are using Supabase direct connection instead of pooler.');
          console.error('   SOLUTION: Use Connection Pooler URL (port 6543) from Supabase dashboard.');
        } else {
          console.error(`Database connection failed (${retries} retries left):`, err.message);
          if (err.code) {
            console.error(`   Error code: ${err.code}`);
          }
        }
        
        if (retries > 0) {
          // Wait before retrying (exponential backoff)
          const delay = (4 - retries) * 1000; // 1s, 2s, 3s
          console.log(`Retrying database connection in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // If we get here, all retries failed
    console.error('Database connection failed after retries:', lastError);
    if (lastError && lastError.code === 'ENETUNREACH' && lastError.port === 5432) {
      console.error('');
      console.error('═══════════════════════════════════════════════════════════════');
      console.error('FIX: Use Supabase Connection Pooler (port 6543)');
      console.error('═══════════════════════════════════════════════════════════════');
      console.error('1. Go to: https://app.supabase.com → Your Project → Settings → Database');
      console.error('2. Scroll to "Connection string" section');
      console.error('3. Select "Connection pooling" → "Transaction" mode');
      console.error('4. Copy the connection string (should have port 6543)');
      console.error('5. Update DATABASE_URL in Render dashboard with this connection string');
      console.error('6. Make sure password is URL-encoded (@ → %40)');
      console.error('═══════════════════════════════════════════════════════════════');
    }
    throw lastError;
  }

  async createTables() {
    const client = await this.pool.connect();
    try {
      // Create sources table
      await client.query(`
        CREATE TABLE IF NOT EXISTS sources (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          url VARCHAR(500) NOT NULL UNIQUE,
          category VARCHAR(255),
          last_checked TIMESTAMP,
          is_paused BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create categories table
      await client.query(`
        CREATE TABLE IF NOT EXISTS categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL UNIQUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create articles table
      await client.query(`
        CREATE TABLE IF NOT EXISTS articles (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT,
          preview TEXT,
          link VARCHAR(500) NOT NULL UNIQUE,
          pub_date TIMESTAMP,
          source_id INTEGER REFERENCES sources(id),
          source_name VARCHAR(255),
          category VARCHAR(100),
          status VARCHAR(50) DEFAULT 'new',
          is_manual BOOLEAN DEFAULT FALSE,
          ai_summary TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Add updated_at column if it doesn't exist (for existing tables)
      await client.query(`
        ALTER TABLE articles 
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      `);

      // Add is_paused column if it doesn't exist (for existing tables)
      await client.query(`
        ALTER TABLE sources 
        ADD COLUMN IF NOT EXISTS is_paused BOOLEAN DEFAULT FALSE
      `);

      // Add category column if it doesn't exist (for existing tables)
      await client.query(`
        ALTER TABLE sources 
        ADD COLUMN IF NOT EXISTS category VARCHAR(255)
      `);

      // Add monitoring_type column if it doesn't exist (for existing tables)
      await client.query(`
        ALTER TABLE sources 
        ADD COLUMN IF NOT EXISTS monitoring_type VARCHAR(20) DEFAULT 'RSS'
      `);

      // Add last_scraping_result column to track scraping health
      await client.query(`
        ALTER TABLE sources 
        ADD COLUMN IF NOT EXISTS last_scraping_result JSONB
      `);

      // Create indexes for better performance
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_articles_pub_date ON articles(pub_date);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_articles_source_id ON articles(source_id);
      `);

    } finally {
      client.release();
    }
  }

  // Sources methods
  async getAllSources() {
    const result = await this.pool.query('SELECT * FROM sources ORDER BY name');
    return result.rows;
  }

  async addSource(name, url, category = null, monitoringType = 'RSS') {
    const result = await this.pool.query(
      'INSERT INTO sources (name, url, category, monitoring_type) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, url, category, monitoringType]
    );
    return result.rows[0];
  }

  async getSourceById(id) {
    const result = await this.pool.query('SELECT * FROM sources WHERE id = $1', [id]);
    return result.rows[0];
  }

  async removeSource(id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM articles WHERE source_id = $1', [id]);
      await client.query('DELETE FROM sources WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async updateSourceLastChecked(id) {
    await this.pool.query(
      'UPDATE sources SET last_checked = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );
  }

  async updateScrapingResult(id, result) {
    await this.pool.query(
      'UPDATE sources SET last_scraping_result = $1, last_checked = CURRENT_TIMESTAMP WHERE id = $2',
      [JSON.stringify(result), id]
    );
  }

  async pauseSource(id) {
    const result = await this.pool.query(
      'UPDATE sources SET is_paused = TRUE WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0];
  }

  async reactivateSource(id) {
    const result = await this.pool.query(
      'UPDATE sources SET is_paused = FALSE WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0];
  }

  async updateSourceCategory(id, category) {
    const result = await this.pool.query(
      'UPDATE sources SET category = $1 WHERE id = $2 RETURNING *',
      [category, id]
    );
    return result.rows[0];
  }

  async updateArticlesCategoryBySource(sourceId, category) {
    const result = await this.pool.query(
      'UPDATE articles SET category = $1 WHERE source_id = $2',
      [category, sourceId]
    );
    return result.rowCount;
  }

  // Articles methods
  async getAllArticles() {
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      ORDER BY a.created_at DESC
    `);
    return result.rows;
  }

  async getArticlesByStatus(status) {
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      WHERE a.status = $1 
      ORDER BY a.created_at DESC
    `, [status]);
    return result.rows;
  }

  async getArticlesByDateRange(days) {
    // Get articles where pub_date is within the last N days
    // ONLY use pub_date - no fallback to created_at
    // Articles without publication dates will NOT show in dashboard
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      WHERE a.pub_date IS NOT NULL 
        AND a.pub_date >= NOW() - INTERVAL '${days} days'
      ORDER BY a.pub_date DESC
    `);
    
    // Log for debugging
    console.log(`📊 Database query: Found ${result.rows.length} articles with pub_date from last ${days} days`);
    
    return result.rows;
  }
  
  // Get all articles (for verification/debugging)
  async getAllArticles(limit = 100) {
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      ORDER BY COALESCE(a.pub_date, a.created_at) DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }

  async getSentArticles() {
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      WHERE a.status = 'sent' 
      ORDER BY a.created_at DESC
    `);
    return result.rows;
  }

  async addArticle(article) {
    const result = await this.pool.query(`
      INSERT INTO articles (
        title, content, preview, link, pub_date, source_id, source_name, 
        category, status, is_manual, ai_summary
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
      RETURNING *
    `, [
      article.title,
      article.content,
      article.preview,
      article.link,
      article.pub_date || article.pubDate || null,
      article.source_id || article.sourceId || null,
      article.source_name || article.sourceName || 'Unknown Source',
      article.category,
      article.status || 'new',
      article.is_manual || false,
      article.ai_summary
    ]);
    return result.rows[0].id;
  }

  async getArticleById(id) {
    const result = await this.pool.query('SELECT * FROM articles WHERE id = $1', [id]);
    return result.rows[0];
  }

  async getArticleByLink(link) {
    const result = await this.pool.query('SELECT * FROM articles WHERE link = $1', [link]);
    return result.rows[0];
  }

  async articleExists(link) {
    const result = await this.pool.query('SELECT id FROM articles WHERE link = $1', [link]);
    return result.rows.length > 0;
  }

  async updateArticle(id, updates) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (fields.length === 0) return null;

    values.push(id);
    const query = `UPDATE articles SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
    
    const result = await this.pool.query(query, values);
    return result.rows[0];
  }

  async updateArticleStatus(id, status) {
    const result = await this.pool.query(
      'UPDATE articles SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    return result.rows[0];
  }

  async clearAllCurrentArticles() {
    await this.pool.query("UPDATE articles SET status = 'dismissed' WHERE status = 'new'");
  }

  async backfillSourceNames() {
    const result = await this.pool.query(`
      UPDATE articles 
      SET source_id = s.id, source_name = s.name
      FROM sources s 
      WHERE articles.source_id IS NULL 
      AND (articles.link LIKE '%' || REPLACE(REPLACE(s.url, 'https://', ''), 'http://', '') || '%')
    `);
    return result.rowCount;
  }

  async backfillPubDates() {
    // This would need to be implemented with RSS parsing
    // For now, just return 0
    return 0;
  }

  // Additional methods needed by the application
  async getNewArticles() {
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      WHERE a.status = 'new' AND (a.seen = false OR a.seen IS NULL)
      ORDER BY COALESCE(a.pub_date, a.created_at) DESC
    `);
    return result.rows;
  }

  async getSelectedArticles() {
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      WHERE a.status = 'selected'
      ORDER BY COALESCE(a.pub_date, a.created_at) DESC
    `);
    return result.rows;
  }

  async getNewUnseenArticles() {
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      WHERE a.status = 'new' AND (a.viewed = false OR a.viewed IS NULL)
      ORDER BY a.created_at DESC
    `);
    return result.rows;
  }

  async getLast5ArticlesPerSource() {
    const result = await this.pool.query(`
      WITH ranked AS (
        SELECT 
          a.*, 
          s.name AS source_name,
          ROW_NUMBER() OVER (PARTITION BY a.source_id ORDER BY COALESCE(a.pub_date, a.created_at) DESC) AS rn
        FROM articles a
        LEFT JOIN sources s ON a.source_id = s.id
      )
      SELECT *
      FROM ranked
      WHERE rn <= 5
      ORDER BY COALESCE(pub_date, created_at) DESC
    `);
    return result.rows;
  }

  async getArticlesByIds(ids) {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      WHERE a.id IN (${placeholders})
      ORDER BY COALESCE(a.pub_date, a.created_at) DESC
    `, ids);
    return result.rows;
  }

  async updateArticleContent(id, title, content, preview) {
    const result = await this.pool.query(`
      UPDATE articles 
      SET title = $1, content = $2, preview = $3, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $4 
      RETURNING *
    `, [title, content, preview, id]);
    return result.rows[0];
  }

  async updateArticleByLink(link, updates) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (fields.length === 0) return null;

    values.push(link);
    const query = `UPDATE articles SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE link = $${paramCount} RETURNING *`;
    
    const result = await this.pool.query(query, values);
    return result.rows[0];
  }

  async updateArticlePubDateByApproxLink(link, pubDateIso) {
    // Match exact link or same link without query params; only fill when missing
    const result = await this.pool.query(`
      UPDATE articles
      SET pub_date = $1, updated_at = CURRENT_TIMESTAMP
      WHERE (link = $2 OR split_part(link,'?',1) = split_part($2,'?',1))
        AND (pub_date IS NULL)
      RETURNING *
    `, [pubDateIso, link]);
    return result.rowCount;
  }

  async markArticlesAsViewed(ids) {
    if (ids.length === 0) return 0;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const result = await this.pool.query(`
      UPDATE articles 
      SET viewed = true, updated_at = CURRENT_TIMESTAMP 
      WHERE id IN (${placeholders})
    `, ids);
    return result.rowCount;
  }

  async dismissAllCurrentArticles() {
    const result = await this.pool.query(`
      UPDATE articles 
      SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP 
      WHERE status = 'new'
    `);
    return result.rowCount;
  }

  async clearAllArticles() {
    const result = await this.pool.query('DELETE FROM articles');
    return result.rowCount;
  }

  async clearCurrentSession() {
    const result = await this.pool.query(`
      UPDATE articles 
      SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP 
      WHERE status = 'new' AND (session_id IS NULL OR created_at < NOW() - INTERVAL '1 day')
    `);
    return result.rowCount;
  }

  async startNewSession() {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await this.pool.query(`
      UPDATE articles 
      SET session_id = $1 
      WHERE status = 'new' AND session_id IS NULL
    `, [sessionId]);
    return sessionId;
  }

  async markArticlesAsSeen(articleIds) {
    if (articleIds.length === 0) return 0;
    const placeholders = articleIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await this.pool.query(`
      UPDATE articles 
      SET seen = true, updated_at = CURRENT_TIMESTAMP 
      WHERE id IN (${placeholders})
    `, articleIds);
    return result.rowCount;
  }

  async clearAllCurrentArticles() {
    const result = await this.pool.query(`
      UPDATE articles 
      SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP 
      WHERE status = 'new'
    `);
    return result.rowCount;
  }

  async backfillArticleSourceNames() {
    const result = await this.pool.query(`
      UPDATE articles 
      SET source_name = s.name
      FROM sources s 
      WHERE articles.source_id = s.id 
      AND (articles.source_name IS NULL OR articles.source_name = '')
    `);
    return result.rowCount;
  }

  async backfillArticleSourcesByDomain() {
    // This is a simplified version - in practice you'd want more sophisticated domain matching
    const result = await this.pool.query(`
      UPDATE articles 
      SET source_id = s.id, source_name = s.name
      FROM sources s 
      WHERE articles.source_id IS NULL 
      AND (articles.link LIKE '%' || REPLACE(REPLACE(s.url, 'https://', ''), 'http://', '') || '%')
    `);
    return result.rowCount;
  }

  // Categories methods
  async getAllCategories() {
    const result = await this.pool.query('SELECT * FROM categories ORDER BY name');
    return result.rows;
  }

  async addCategory(name) {
    try {
      const result = await this.pool.query(
        'INSERT INTO categories (name) VALUES ($1) RETURNING *',
        [name]
      );
      return result.rows[0];
    } catch (error) {
      if (error.code === '23505') { // Unique constraint violation
        // Category already exists, return it
        const result = await this.pool.query('SELECT * FROM categories WHERE name = $1', [name]);
        return result.rows[0];
      }
      throw error;
    }
  }

  async getCategoryByName(name) {
    const result = await this.pool.query('SELECT * FROM categories WHERE name = $1', [name]);
    return result.rows[0];
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = new Database();
