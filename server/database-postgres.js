const { Pool } = require('pg');

class Database {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/distroblog',
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
  }

  async init() {
    try {
      // Test connection
      const client = await this.pool.connect();
      console.log('PostgreSQL connected successfully');
      client.release();

      // Create tables
      await this.createTables();
      console.log('Database tables created/verified');
    } catch (err) {
      console.error('Database connection failed:', err);
      throw err;
    }
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
          last_checked TIMESTAMP,
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

  async addSource(name, url) {
    const result = await this.pool.query(
      'INSERT INTO sources (name, url) VALUES ($1, $2) RETURNING *',
      [name, url]
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
    const result = await this.pool.query(`
      SELECT a.*, s.name as source_name 
      FROM articles a 
      LEFT JOIN sources s ON a.source_id = s.id 
      WHERE a.pub_date >= NOW() - INTERVAL '${days} days'
      ORDER BY a.pub_date DESC
    `);
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
