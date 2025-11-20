#!/usr/bin/env node

/**
 * Script to inspect articles in the database
 * Usage: node inspect-db.js [options]
 * 
 * Options:
 *   --type SCRAPING|RSS    Filter by monitoring type
 *   --source "Source Name" Filter by source name
 *   --limit N              Limit results (default: 50)
 *   --no-date              Show only articles without dates
 *   --full                 Show full article content
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function inspectArticles() {
  const args = process.argv.slice(2);
  const limit = parseInt(args.find(a => a.startsWith('--limit'))?.split('=')[1]) || 50;
  const type = args.find(a => a.startsWith('--type'))?.split('=')[1];
  const sourceName = args.find(a => a.startsWith('--source'))?.split('=')[1];
  const noDate = args.includes('--no-date');
  const full = args.includes('--full');

  try {
    let query = `
      SELECT 
        a.id,
        a.title,
        a.link,
        a.pub_date,
        a.created_at,
        a.status,
        a.category,
        LENGTH(a.content) as content_length,
        LENGTH(a.preview) as preview_length,
        s.name as source_name,
        s.monitoring_type,
        s.url as source_url
      FROM articles a
      LEFT JOIN sources s ON a.source_id = s.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (type) {
      query += ` AND s.monitoring_type = $${paramCount}`;
      params.push(type);
      paramCount++;
    }

    if (sourceName) {
      query += ` AND s.name ILIKE $${paramCount}`;
      params.push(`%${sourceName}%`);
      paramCount++;
    }

    if (noDate) {
      query += ` AND a.pub_date IS NULL`;
    }

    query += ` ORDER BY COALESCE(a.pub_date, a.created_at) DESC LIMIT $${paramCount}`;
    params.push(limit);

    const result = await pool.query(query, params);
    const articles = result.rows;

    console.log('\n📊 Article Inspection Results\n');
    console.log(`Found ${articles.length} articles\n`);

    // Summary by source
    const bySource = {};
    articles.forEach(article => {
      const name = article.source_name || 'Unknown';
      if (!bySource[name]) {
        bySource[name] = {
          name,
          type: article.monitoring_type || 'RSS',
          url: article.source_url,
          count: 0,
          with_dates: 0,
          without_dates: 0,
          avg_content_length: 0,
          avg_preview_length: 0
        };
      }
      bySource[name].count++;
      if (article.pub_date) {
        bySource[name].with_dates++;
      } else {
        bySource[name].without_dates++;
      }
      bySource[name].avg_content_length += (article.content_length || 0);
      bySource[name].avg_preview_length += (article.preview_length || 0);
    });

    Object.values(bySource).forEach(source => {
      source.avg_content_length = Math.round(source.avg_content_length / source.count);
      source.avg_preview_length = Math.round(source.avg_preview_length / source.count);
    });

    console.log('📈 Summary by Source:');
    console.log('─'.repeat(80));
    Object.values(bySource).forEach(source => {
      console.log(`\n${source.name} (${source.type})`);
      console.log(`  URL: ${source.url}`);
      console.log(`  Articles: ${source.count}`);
      console.log(`  With dates: ${source.with_dates} | Without dates: ${source.without_dates}`);
      console.log(`  Avg content: ${source.avg_content_length} chars | Avg preview: ${source.avg_preview_length} chars`);
    });

    console.log('\n\n📰 Recent Articles:');
    console.log('─'.repeat(80));
    articles.forEach((article, index) => {
      console.log(`\n${index + 1}. ${article.title}`);
      console.log(`   Source: ${article.source_name} (${article.monitoring_type || 'RSS'})`);
      console.log(`   Link: ${article.link}`);
      console.log(`   Date: ${article.pub_date || 'NO DATE'} | Created: ${article.created_at}`);
      console.log(`   Status: ${article.status} | Category: ${article.category || 'None'}`);
      console.log(`   Content: ${article.content_length || 0} chars | Preview: ${article.preview_length || 0} chars`);
      
      if (full && article.content) {
        console.log(`   Content preview: ${article.content.substring(0, 200)}...`);
      }
    });

    // Issues found
    console.log('\n\n⚠️  Potential Issues:');
    console.log('─'.repeat(80));
    const issues = [];
    articles.forEach(article => {
      if (!article.pub_date) {
        issues.push(`Article "${article.title}" from ${article.source_name} has no date`);
      }
      if (!article.title || article.title.trim() === '') {
        issues.push(`Article from ${article.source_name} has empty title: ${article.link}`);
      }
      if ((article.content_length || 0) < 50) {
        issues.push(`Article "${article.title}" from ${article.source_name} has very short content (${article.content_length} chars)`);
      }
    });

    if (issues.length === 0) {
      console.log('✅ No obvious issues found!');
    } else {
      issues.forEach(issue => console.log(`  - ${issue}`));
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error);
    await pool.end();
    process.exit(1);
  }
}

inspectArticles();

