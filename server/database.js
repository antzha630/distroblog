const { Pool } = require('pg');
const path = require('path');

class Database {
  constructor() {
    this.pool = null;
  }

  async init() {
    // Use PostgreSQL if DATABASE_URL is provided, otherwise fall back to SQLite
    if (process.env.DATABASE_URL) {
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
      });
      console.log('PostgreSQL connected successfully');
    } else {
      // Fallback to SQLite for local development
      const sqlite3 = require('sqlite3').verbose();
      const dbPath = path.join(__dirname, '../data/distroblog.db');
      this.db = new sqlite3.Database(dbPath);
      console.log('SQLite database initialized');
    }
    
    await this.createTables();
    console.log('Database tables created/verified');
  }

  async createTables() {
    const createSourcesTable = `
      CREATE TABLE IF NOT EXISTS sources (
        id SERIAL PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT,
        last_checked TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const createArticlesTable = `
      CREATE TABLE IF NOT EXISTS articles (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        preview TEXT,
        link TEXT UNIQUE NOT NULL,
        pub_date TIMESTAMP,
        source_id INTEGER,
        source_name TEXT,
        category TEXT,
        status TEXT DEFAULT 'new',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_id) REFERENCES sources (id)
      )
    `;

    if (this.pool) {
      // PostgreSQL
      await this.pool.query(createSourcesTable);
      await this.pool.query(createArticlesTable);
    } else {
      // SQLite fallback
      this.db.run(createSourcesTable);
      this.db.run(createArticlesTable);
    }

    // Attempt to add last_checked to existing sources table if missing
    this.db.run('ALTER TABLE sources ADD COLUMN last_checked DATETIME', (err) => {
      if (err && !/duplicate column name/i.test(err.message)) {
        console.error('Error adding last_checked column to sources:', err.message);
      }
    });

    // Add is_manual column to existing articles table if missing
    this.db.run('ALTER TABLE articles ADD COLUMN is_manual BOOLEAN DEFAULT 0', (err) => {
      if (err && !/duplicate column name/i.test(err.message)) {
        console.error('Error adding is_manual column to articles:', err.message);
      }
    });
  }

  // Source management
  async getSources() {
    if (this.pool) {
      // PostgreSQL
      const result = await this.pool.query('SELECT * FROM sources ORDER BY created_at DESC');
      return result.rows;
    } else {
      // SQLite fallback
      return new Promise((resolve, reject) => {
        this.db.all('SELECT * FROM sources ORDER BY created_at DESC', (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    }
  }

  async getSourceById(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM sources WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async addSource(url, name, category = null) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO sources (url, name, category) VALUES (?, ?, ?)',
        [url, name, category],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  async removeSource(id) {
    return new Promise((resolve, reject) => {
      // First, delete all articles associated with this source
      this.db.run('DELETE FROM articles WHERE source_id = ?', [id], function(err) {
        if (err) {
          reject(err);
          return;
        }
        
        // Then delete the source itself
        this.db.run('DELETE FROM sources WHERE id = ?', [id], function(err) {
          if (err) reject(err);
          else {
            console.log(`🗑️ Removed source ID ${id} and all associated articles`);
            resolve(this.changes);
          }
        }.bind(this));
      }.bind(this));
    });
  }

  async updateSourceLastChecked(id) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE sources SET last_checked = CURRENT_TIMESTAMP WHERE id = ?',
        [id],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  // Article management
  async addArticle(article) {
    return new Promise((resolve, reject) => {
      // Normalize incoming field names (handle both snake_case and camelCase)
      const normalized = {
        title: article.title,
        content: article.content,
        preview: article.preview,
        link: article.link,
        pub_date: article.pub_date || article.pubDate || null,
        source_id: article.source_id || article.sourceId || null,
        source_name: article.source_name || article.sourceName || null,
        category: article.category || null,
        status: article.status || 'new',
        is_manual: article.is_manual || article.isManual || false,
        ai_summary: article.ai_summary || article.aiSummary || null
      };

      this.db.run(
        `INSERT INTO articles (title, content, preview, link, pub_date, source_id, source_name, category, status, is_manual, ai_summary) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [normalized.title, normalized.content, normalized.preview, normalized.link, normalized.pub_date, 
         normalized.source_id, normalized.source_name, normalized.category, normalized.status, 
         normalized.is_manual, normalized.ai_summary],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  async articleExists(link) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT id FROM articles WHERE link = ?', [link], (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      });
    });
  }

  async getArticleById(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM articles WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async getArticleByLink(link) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM articles WHERE link = ?', [link], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async getNewArticles() {
    return new Promise((resolve, reject) => {
      // Get only unseen articles (never shown to journalist before)
      // Sort by publication date (most recent first), then by created_at as fallback
      this.db.all(
        'SELECT * FROM articles WHERE status = "new" AND seen = 0 ORDER BY COALESCE(pub_date, created_at) DESC',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Clear all articles (for resetting the system)
  async clearAllArticles() {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM articles', [], function(err) {
        if (err) reject(err);
        else {
          console.log(`🗑️ Cleared all articles from database`);
          resolve(this.changes);
        }
      });
    });
  }

  async getNewUnseenArticles() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM articles WHERE status = "new" AND viewed = 0 ORDER BY created_at DESC',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async getLast5ArticlesPerSource() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM articles 
         WHERE id IN (
           SELECT id FROM articles 
           ORDER BY source_id, COALESCE(pub_date, created_at) DESC
         )
         GROUP BY source_id
         ORDER BY COALESCE(pub_date, created_at) DESC
         LIMIT 5`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async getSelectedArticles() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM articles WHERE status = "selected" ORDER BY COALESCE(pub_date, created_at) DESC',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async updateArticleStatus(id, status) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE articles SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, id],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  async updateArticleContent(id, title, content, preview) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE articles SET title = ?, content = ?, preview = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [title, content, preview, id],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  async updateArticle(id, updates) {
    return new Promise((resolve, reject) => {
      const fields = Object.keys(updates);
      const values = Object.values(updates);
      const setClause = fields.map(field => `${field} = ?`).join(', ');
      
      this.db.run(
        `UPDATE articles SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [...values, id],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  async updateArticleByLink(link, updates) {
    return new Promise((resolve, reject) => {
      const fields = Object.keys(updates);
      const values = Object.values(updates);
      const setClause = fields.map(field => `${field} = ?`).join(', ');

      this.db.run(
        `UPDATE articles SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE link = ?`,
        [...values, link],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  async getArticlesByIds(ids) {
    return new Promise((resolve, reject) => {
      const placeholders = ids.map(() => '?').join(',');
      this.db.all(
        `SELECT * FROM articles WHERE id IN (${placeholders})`,
        ids,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async getArticlesByDateRange(days) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM articles 
         WHERE (pub_date IS NOT NULL AND pub_date >= datetime('now', '-${days} days'))
            OR (pub_date IS NULL AND created_at >= datetime('now', '-${days} days'))
         ORDER BY COALESCE(pub_date, created_at) DESC`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async getSentArticles() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM articles 
         WHERE status = 'sent'
         ORDER BY updated_at DESC
         LIMIT 50`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async markArticlesAsViewed(ids) {
    return new Promise((resolve, reject) => {
      const placeholders = ids.map(() => '?').join(',');
      this.db.run(
        `UPDATE articles SET viewed = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        ids,
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  async dismissAllCurrentArticles() {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE articles SET status = "dismissed", updated_at = CURRENT_TIMESTAMP WHERE status = "new"',
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  async clearCurrentSession() {
    return new Promise((resolve, reject) => {
      // Mark all articles without session IDs as dismissed (old articles)
      this.db.run(
        'UPDATE articles SET status = "dismissed", updated_at = CURRENT_TIMESTAMP WHERE status = "new" AND session_id IS NULL',
        function(err) {
          if (err) {
            reject(err);
            return;
          }
          
          const changes1 = this.changes;
          
          // Also mark any articles with very old session IDs as dismissed
          this.db.run(
            'UPDATE articles SET status = "dismissed", updated_at = CURRENT_TIMESTAMP WHERE status = "new" AND session_id IS NOT NULL AND created_at < datetime("now", "-1 day")',
            function(err2) {
              if (err2) {
                reject(err2);
                return;
              }
              resolve(changes1 + this.changes);
            }
          );
        }
      );
    });
  }

  async startNewSession() {
    return new Promise((resolve, reject) => {
      // Generate a new session ID
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Update all new articles to have this session ID
      this.db.run(
        'UPDATE articles SET session_id = ? WHERE status = "new" AND session_id IS NULL',
        [sessionId],
        function(err) {
          if (err) reject(err);
          else resolve(sessionId);
        }
      );
    });
  }

  async markArticlesAsSeen(articleIds) {
    return new Promise((resolve, reject) => {
      const placeholders = articleIds.map(() => '?').join(',');
      this.db.run(
        `UPDATE articles SET seen = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        articleIds,
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  async clearAllCurrentArticles() {
    return new Promise((resolve, reject) => {
      // Mark all current new articles as dismissed (both selected and unselected)
      this.db.run(
        'UPDATE articles SET status = "dismissed", updated_at = CURRENT_TIMESTAMP WHERE status = "new"',
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  // Maintenance: backfill missing source_name from sources table
  async backfillArticleSourceNames() {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE articles 
         SET source_name = (
           SELECT name FROM sources WHERE sources.id = articles.source_id
         )
         WHERE source_id IS NOT NULL 
           AND (source_name IS NULL OR source_name = '')`,
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  // Maintenance: backfill missing source_id/source_name by matching article link domain to source URL domain
  async backfillArticleSourcesByDomain() {
    const getAllSources = () => new Promise((resolve, reject) => {
      this.db.all('SELECT id, url, name FROM sources', (err, rows) => {
        if (err) reject(err); else resolve(rows);
      });
    });

    const updateForSource = (sourceId, name, domainVariants) => new Promise((resolve, reject) => {
      const likeClauses = domainVariants.map(() => 'link LIKE ?').join(' OR ');
      const params = domainVariants.map(d => `${d}%`);
      const sql = `UPDATE articles SET source_id = ?, source_name = ? WHERE (source_name IS NULL OR source_name = '') AND (${likeClauses})`;
      this.db.run(sql, [sourceId, name, ...params], function(err) {
        if (err) reject(err); else resolve(this.changes || 0);
      });
    });

    try {
      const sources = await getAllSources();
      let totalUpdated = 0;
      for (const src of sources) {
        try {
          const u = new URL(src.url);
          const host = u.hostname.replace(/^www\./, '');
          const domainVariants = [
            `https://${host}/`,
            `http://${host}/`,
            `https://www.${host}/`,
            `http://www.${host}/`
          ];
          const updated = await updateForSource(src.id, src.name, domainVariants);
          totalUpdated += updated;
        } catch (_e) {
          // skip invalid source URLs
        }
      }
      return totalUpdated;
    } catch (e) {
      throw e;
    }
  }
}

module.exports = new Database();
