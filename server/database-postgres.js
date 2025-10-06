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
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
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

  async removeSource(id) {
    await this.pool.query('DELETE FROM sources WHERE id = $1', [id]);
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
      article.pub_date,
      article.source_id || article.sourceId || null,
      article.source_name || article.sourceName || 'Unknown Source',
      article.category,
      article.status || 'new',
      article.is_manual || false,
      article.ai_summary
    ]);
    return result.rows[0];
  }

  async getArticleById(id) {
    const result = await this.pool.query('SELECT * FROM articles WHERE id = $1', [id]);
    return result.rows[0];
  }

  async getArticleByLink(link) {
    const result = await this.pool.query('SELECT * FROM articles WHERE link = $1', [link]);
    return result.rows[0];
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

  async close() {
    await this.pool.end();
  }
}

module.exports = new Database();
