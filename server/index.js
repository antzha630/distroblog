const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const config = require('./config');
require('dotenv').config();

const feedMonitor = require('./services/feedMonitor');
const FeedDiscovery = require('./services/feedDiscovery');
const llmService = require('./services/llmService');
const database = require('./database-postgres');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get all monitored sources
app.get('/api/sources', async (req, res) => {
  try {
    const sources = await database.getAllSources();
    // derive basic success/active metrics for UI
    const { rows: counts } = await database.pool.query(`
      SELECT source_id, COUNT(*)::int AS total,
             SUM(CASE WHEN status = 'new' OR status = 'selected' OR status = 'sent' THEN 1 ELSE 0 END)::int AS successes
      FROM articles
      GROUP BY source_id
    `);
    const bySourceId = new Map(counts.map(r => [r.source_id, r]));
    const enriched = sources.map(s => {
      const c = bySourceId.get(s.id) || { total: 0, successes: 0 };
      const success_rate = c.total > 0 ? c.successes / c.total : null;
      const active = s.last_checked ? (Date.now() - new Date(s.last_checked).getTime()) < (60 * 60 * 1000) : false;
      return { ...s, success_rate, active };
    });
    res.json(enriched);
  } catch (error) {
    console.error('Error fetching sources:', error);
    res.status(500).json({ error: 'Failed to fetch sources' });
  }
});

// Detect RSS feeds from a website URL
app.post('/api/sources/detect', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const detectedFeeds = await feedMonitor.detectRSSFeeds(url);
    res.json({ feeds: detectedFeeds });
  } catch (error) {
    console.error('Error detecting RSS feeds:', error);
    res.status(500).json({ error: 'Failed to detect RSS feeds' });
  }
});

// Add a new source to monitor
app.post('/api/sources', async (req, res) => {
  try {
    const { url, name, category } = req.body;
    
    if (!url || !name) {
      return res.status(400).json({ error: 'URL and name are required' });
    }

    // Validate RSS feed
    const isValid = await feedMonitor.validateFeed(url);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid or inaccessible RSS feed' });
    }

    // Add category if provided
    let categoryName = null;
    if (category && category.trim()) {
      const categoryRecord = await database.addCategory(category.trim());
      categoryName = categoryRecord.name;
    }

    const source = await database.addSource(name, url, categoryName);
    const sourceId = source.id;
    
    // Fetch 5 most recent articles from the new source
    try {
      await feedMonitor.checkFeedLimited({ id: sourceId, url, name, category: categoryName }, 5);
      console.log(`✅ Added 5 most recent articles from new source: ${name}`);
    } catch (error) {
      console.log('Could not fetch recent articles for new source:', error.message);
    }
    
    res.json({ id: sourceId, message: 'Source added successfully' });
  } catch (error) {
    console.error('Error adding source:', error);
    res.status(500).json({ error: 'Failed to add source' });
  }
});

// Remove a source and its articles
app.delete('/api/sources/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Valid source ID is required' });
    }

    // Get source info before deleting
    const source = await database.getSourceById(parseInt(id));
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }

    // Delete the source and its articles
    await database.removeSource(parseInt(id));
    
    res.json({ 
      message: `Source "${source.name}" and its articles have been removed successfully` 
    });
  } catch (error) {
    console.error('Error removing source:', error);
    res.status(500).json({ error: 'Failed to remove source' });
  }
});

// Pause a source
app.post('/api/sources/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Valid source ID is required' });
    }

    const source = await database.pauseSource(parseInt(id));
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    
    res.json({ 
      message: `Source "${source.name}" has been paused`,
      source: source
    });
  } catch (error) {
    console.error('Error pausing source:', error);
    res.status(500).json({ error: 'Failed to pause source' });
  }
});

// Reactivate a source
app.post('/api/sources/:id/reactivate', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Valid source ID is required' });
    }

    const source = await database.reactivateSource(parseInt(id));
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    
    res.json({ 
      message: `Source "${source.name}" has been reactivated`,
      source: source
    });
  } catch (error) {
    console.error('Error reactivating source:', error);
    res.status(500).json({ error: 'Failed to reactivate source' });
  }
});

// Update source category
app.put('/api/sources/:id/category', async (req, res) => {
  try {
    const { id } = req.params;
    const { category } = req.body;
    
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Valid source ID is required' });
    }

    const source = await database.updateSourceCategory(parseInt(id), category);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    
    res.json({ 
      message: `Source "${source.name}" category updated successfully`,
      source: source
    });
  } catch (error) {
    console.error('Error updating source category:', error);
    res.status(500).json({ error: 'Failed to update source category' });
  }
});

// Get all categories
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await database.getAllCategories();
    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Add a new category
app.post('/api/categories', async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const category = await database.addCategory(name.trim());
    res.json(category);
  } catch (error) {
    console.error('Error adding category:', error);
    res.status(500).json({ error: 'Failed to add category' });
  }
});

// Clear all articles (for resetting the system)
app.delete('/api/articles/clear', async (req, res) => {
  try {
    const deletedCount = await database.clearAllArticles();
    res.json({ 
      message: `Cleared ${deletedCount} articles from database`,
      deletedCount: deletedCount
    });
  } catch (error) {
    console.error('Error clearing articles:', error);
    res.status(500).json({ error: 'Failed to clear articles' });
  }
});

// Get new articles (unseen)
app.get('/api/articles/new', async (req, res) => {
  try {
    const articles = await database.getNewArticles();
    
    // Format articles for professional display
    const formattedArticles = articles.map(article => {
      // For the first page, show ONLY the RSS description (author's hook)
      // NOT the scraped content or AI summaries
      let actualPreview = article.publisher_description || article.preview;
      let actualLink = article.link;
      
      // Handle corrupted preview data - use RSS description as primary source
      if (!actualPreview || actualPreview === '9' || actualPreview === '9...') {
        actualPreview = "No description available";
      }
      
      return {
        id: article.id,
        author: "Author Name", // Default author name
        more_info_url: actualLink,
        source: article.source_name || "Unknown Source",
        cost: 10, // Default cost
        preview: actualPreview, // This is the RSS description (author's hook)
        title: article.title,
        content: "Content will be generated when summaries are created", // Placeholder
        // Additional fields for display
        source_name: article.source_name || "Unknown Source",
        created_at: article.created_at,
        pub_date: article.pub_date,
        category: article.category,
        publisher_description: article.publisher_description || actualPreview,
        ai_summary: article.ai_summary // This will be null until AI summaries are generated
      };
    });
    
    // Don't mark as seen immediately - let the frontend handle this
    
    res.json(formattedArticles);
  } catch (error) {
    console.error('Error fetching new articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// Mark articles as reviewed/selected
app.post('/api/articles/review', async (req, res) => {
  try {
    const { articleIds, action } = req.body; // action: 'select' or 'dismiss'
    
    for (const id of articleIds) {
      await database.updateArticleStatus(id, action === 'select' ? 'selected' : 'dismissed');
    }
    
    res.json({ message: `Articles ${action}ed successfully` });
  } catch (error) {
    console.error('Error updating articles:', error);
    res.status(500).json({ error: 'Failed to update articles' });
  }
});

// Revert articles back to 'new' status (for back button functionality)
app.post('/api/articles/revert', async (req, res) => {
  try {
    const { articleIds } = req.body;
    
    for (const id of articleIds) {
      await database.updateArticleStatus(id, 'new');
    }
    
    res.json({ message: 'Articles reverted to new status successfully' });
  } catch (error) {
    console.error('Error reverting articles:', error);
    res.status(500).json({ error: 'Failed to revert articles' });
  }
});

// Get selected articles for editing
app.get('/api/articles/selected', async (req, res) => {
  try {
    const articles = await database.getSelectedArticles();
    res.json(articles);
  } catch (error) {
    console.error('Error fetching selected articles:', error);
    res.status(500).json({ error: 'Failed to fetch selected articles' });
  }
});

// Update article content after editing
app.put('/api/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, preview } = req.body;
    
    await database.updateArticleContent(id, title, content, preview);
    res.json({ message: 'Article updated successfully' });
  } catch (error) {
    console.error('Error updating article:', error);
    res.status(500).json({ error: 'Failed to update article' });
  }
});

// Send articles (generate JSON payload)
app.post('/api/articles/send', async (req, res) => {
  try {
    const { articleIds, userInfo } = req.body;
    
    const articles = await database.getArticlesByIds(articleIds);
    
    // Send each article individually to the external API
    const results = [];
    
    for (const article of articles) {
      const payload = {
        user_info: {
          name: userInfo.name || "Author Name"
        },
        more_info_url: article.link,
        source: article.source_name,
        cost: 10,
        preview: article.preview,
        title: article.title,
        content: article.content
      };
      
      try {
                const response = await axios.post(config.distro.apiEndpoint, payload, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.distro.apiKey}`,
            'X-API-Key': config.distro.apiKey
          },
          timeout: 10000
        });
        
        console.log(`External API response for "${article.title}":`, response.data);
        results.push({ success: true, article: article.title, response: response.data });
        
      } catch (externalError) {
        console.error(`Error sending "${article.title}" to external API:`, externalError.message);
        console.error('External API response status:', externalError.response?.status);
        console.error('External API response data:', externalError.response?.data);
        console.error('Payload we sent:', payload);
        results.push({ success: false, article: article.title, error: externalError.message });
      }
    }
    
    // Mark all articles as sent (regardless of API success/failure)
    for (const id of articleIds) {
      await database.updateArticleStatus(id, 'sent');
    }
    
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    
    // Create detailed response message
    let responseMessage;
    if (successCount === 0 && failureCount > 0) {
      responseMessage = `Failed to send ${failureCount} article${failureCount > 1 ? 's' : ''} to Distro. Please check your API key and endpoint.`;
    } else if (successCount > 0 && failureCount > 0) {
      responseMessage = `Successfully sent ${successCount} article${successCount > 1 ? 's' : ''} to Distro, but ${failureCount} failed.`;
    } else if (successCount > 0) {
      responseMessage = `Successfully sent ${successCount} article${successCount > 1 ? 's' : ''} to Distro!`;
    } else {
      responseMessage = `No articles were sent. Please check your configuration.`;
    }

    res.json({ 
      message: responseMessage,
      results: results,
      count: articles.length,
      successCount: successCount,
      failureCount: failureCount,
      success: successCount > 0
    });
  } catch (error) {
    console.error('Error preparing articles for send:', error);
    res.status(500).json({ error: 'Failed to prepare articles for sending' });
  }
});

// Manual trigger for feed monitoring (for testing)
app.post('/api/monitor/trigger', async (req, res) => {
  try {
    const results = await feedMonitor.checkAllFeeds();
    res.json({ message: 'Feed monitoring completed', results });
  } catch (error) {
    console.error('Error during manual monitoring:', error);
    res.status(500).json({ error: 'Failed to check feeds' });
  }
});

// Test RSS feed discovery for a website
app.post('/api/feed/discover', async (req, res) => {
  try {
    const { websiteUrl } = req.body;
    
    if (!websiteUrl) {
      return res.status(400).json({ error: 'Website URL is required' });
    }
    
    const feedDiscovery = new FeedDiscovery();
    const feedUrl = await feedDiscovery.discoverFeedUrl(websiteUrl);
    
    if (feedUrl) {
      const testResult = await feedDiscovery.testFeed(feedUrl);
      res.json({
        success: true,
        feedUrl: feedUrl,
        testResult: testResult
      });
    } else {
      res.json({
        success: false,
        message: 'No RSS feed found for this website'
      });
    }
  } catch (error) {
    console.error('Error discovering feed:', error);
    res.status(500).json({ error: 'Failed to discover feed' });
  }
});

// Get new unseen articles (minimal feed workflow)
app.get('/api/articles/new-unseen', async (req, res) => {
  try {
    const articles = await database.getNewUnseenArticles();
    res.json(articles);
  } catch (error) {
    console.error('Error fetching new unseen articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// Get last 5 articles from each source (initial load)
app.get('/api/articles/last5-per-source', async (req, res) => {
  try {
    const articles = await database.getLast5ArticlesPerSource();
    
    // Format articles for professional display (same as /api/articles/new)
    const formattedArticles = articles.map(article => {
      // For the first page, show ONLY the RSS description (author's hook)
      // NOT the scraped content or AI summaries
      let actualPreview = article.publisher_description || article.preview;
      let actualLink = article.link;
      
      // Handle corrupted preview data - use RSS description as primary source
      if (!actualPreview || actualPreview === '9' || actualPreview === '9...') {
        actualPreview = "No description available";
      }
      
      return {
        id: article.id,
        author: "Author Name", // Default author name
        more_info_url: actualLink,
        source: article.source_name || "Unknown Source",
        cost: 10, // Default cost
        preview: actualPreview, // This is the RSS description (author's hook)
        title: article.title,
        content: "Content will be generated when summaries are created", // Placeholder
        // Additional fields for display
        source_name: article.source_name || "Unknown Source",
        created_at: article.created_at,
        pub_date: article.pub_date,
        category: article.category,
        publisher_description: article.publisher_description || actualPreview,
        ai_summary: article.ai_summary // This will be null until AI summaries are generated
      };
    });
    
    res.json(formattedArticles);
  } catch (error) {
    console.error('Error fetching last 5 articles per source:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// Get articles from the last N days
app.get('/api/articles/recent/:days', async (req, res) => {
  try {
    const days = parseInt(req.params.days);
    if (isNaN(days) || days < 1) {
      return res.status(400).json({ error: 'Invalid days parameter' });
    }
    
    const articles = await database.getArticlesByDateRange(days);
    
    // Format articles for professional display
    const formattedArticles = articles.map(article => {
      let actualPreview = article.publisher_description || article.preview;
      let actualLink = article.link;
      
      // Handle corrupted preview data
      if (!actualPreview || actualPreview === '9' || actualPreview === '9...') {
        actualPreview = "No description available";
      }
      
      return {
        id: article.id,
        author: "Author Name",
        more_info_url: actualLink,
        source: article.source_name || "Unknown Source",
        cost: 10,
        preview: actualPreview,
        title: article.title,
        content: "Content will be generated when summaries are created",
        source_name: article.source_name || "Unknown Source",
        created_at: article.created_at,
        pub_date: article.pub_date, // Only use publication date for display
        category: article.category,
        publisher_description: article.publisher_description || actualPreview,
        ai_summary: article.ai_summary
      };
    });
    
    res.json(formattedArticles);
  } catch (error) {
    console.error(`Error fetching articles from last ${req.params.days} days:`, error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// Get sent articles
app.get('/api/articles/sent', async (req, res) => {
  try {
    const articles = await database.getSentArticles();
    
    // Format articles for professional display
    const formattedArticles = articles.map(article => {
      let actualPreview = article.publisher_description || article.preview;
      let actualLink = article.link;
      
      // Handle corrupted preview data
      if (!actualPreview || actualPreview === '9' || actualPreview === '9...') {
        actualPreview = "No description available";
      }
      
      return {
        id: article.id,
        author: "Author Name",
        more_info_url: actualLink,
        source: article.source_name || "Unknown Source",
        cost: 10,
        preview: actualPreview,
        title: article.title,
        content: "Content will be generated when summaries are created",
        source_name: article.source_name || "Unknown Source",
        created_at: article.created_at,
        pub_date: article.pub_date,
        category: article.category,
        publisher_description: actualPreview,
        ai_summary: article.ai_summary,
        status: article.status,
        updated_at: article.updated_at
      };
    });
    
    res.json(formattedArticles);
  } catch (error) {
    console.error('Error fetching sent articles:', error);
    res.status(500).json({ error: 'Failed to fetch sent articles' });
  }
});

// Maintenance endpoint to backfill missing source names on existing articles
app.post('/api/maintenance/backfill-source-names', async (req, res) => {
  try {
    const updated = await database.backfillArticleSourceNames();
    res.json({ success: true, updated });
  } catch (error) {
    console.error('Error backfilling source names:', error);
    res.status(500).json({ success: false, error: 'Failed to backfill source names' });
  }
});

// Maintenance: domain-based backfill for source_id/source_name
app.post('/api/maintenance/backfill-source-domains', async (req, res) => {
  try {
    const updated = await database.backfillArticleSourcesByDomain();
    res.json({ success: true, updated });
  } catch (error) {
    console.error('Error backfilling source domains:', error);
    res.status(500).json({ success: false, error: 'Failed to backfill source domains' });
  }
});

// Maintenance: backfill missing pub_date by re-parsing RSS items and matching by link
app.post('/api/maintenance/backfill-pubdates', async (req, res) => {
  try {
    const sources = await database.getAllSources();
    const Parser = require('rss-parser');
    const parser = new Parser();
    let fixed = 0;

    for (const source of sources) {
      try {
        const feed = await parser.parseURL(source.url);
        for (const item of feed.items) {
          const dateFields = [item.pubDate, item.isoDate, item.date, item.published, item['dc:date'], item['atom:published']];
          let parsed = null;
          for (const f of dateFields) {
            if (f) {
              const d = new Date(f);
              if (!isNaN(d.getTime())) { parsed = d.toISOString(); break; }
            }
          }
          if (parsed) {
            // approximate link match (ignoring query string) and only fill missing
            const updatedCount = await database.updateArticlePubDateByApproxLink(item.link, parsed);
            fixed += updatedCount;
          }
        }
      } catch (e) {
        console.warn(`Backfill pubdates skipped for ${source.name}:`, e.message);
      }
    }

    res.json({ success: true, fixed });
  } catch (error) {
    console.error('Error backfilling pub dates:', error);
    res.status(500).json({ success: false, error: 'Failed to backfill pub dates' });
  }
});

// Mark articles as viewed
app.post('/api/articles/mark-viewed', async (req, res) => {
  try {
    const { articleIds } = req.body;
    if (!articleIds || !Array.isArray(articleIds)) {
      return res.status(400).json({ error: 'Article IDs array is required' });
    }
    
    const result = await database.markArticlesAsViewed(articleIds);
    res.json({ message: `${result} articles marked as viewed` });
  } catch (error) {
    console.error('Error marking articles as viewed:', error);
    res.status(500).json({ error: 'Failed to mark articles as viewed' });
  }
});

// Dismiss all current articles (clean slate)
app.post('/api/articles/dismiss-all', async (req, res) => {
  try {
    const result = await database.dismissAllCurrentArticles();
    res.json({ message: `${result} articles dismissed`, dismissed: result });
  } catch (error) {
    console.error('Error dismissing all articles:', error);
    res.status(500).json({ error: 'Failed to dismiss articles' });
  }
});

// Generate AI summaries for selected articles
app.post('/api/articles/generate-summaries', async (req, res) => {
  try {
    const { articleIds } = req.body;
    
    if (!articleIds || !Array.isArray(articleIds)) {
      return res.status(400).json({ error: 'Article IDs array is required' });
    }
    
    const articles = await database.getArticlesByIds(articleIds);
    const feedMonitor = require('./services/feedMonitor');
    const llmService = require('./services/llmService');
    
    const results = [];
    
    for (const article of articles) {
      try {
        // Fetch full article content by scraping the website
        const fullContent = await feedMonitor.fetchFullArticleContent(article.link);
        
        // Generate AI summary using the full content
        const aiSummary = await llmService.summarizeArticle(
          article.title, 
          fullContent || article.content, 
          article.source_name
        );
        
        // Update the article with the AI summary
        await database.updateArticle(article.id, { ai_summary: aiSummary });
        
        results.push({
          success: true,
          articleId: article.id,
          title: article.title,
          summary: aiSummary
        });
        
      } catch (error) {
        console.error(`Error generating summary for article ${article.id}:`, error.message);
        results.push({
          success: false,
          articleId: article.id,
          title: article.title,
          error: error.message
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    
    res.json({
      message: `Generated summaries for ${successCount} articles, ${failureCount} failed`,
      results: results,
      successCount: successCount,
      failureCount: failureCount
    });
    
  } catch (error) {
    console.error('Error generating AI summaries:', error);
    res.status(500).json({ error: 'Failed to generate AI summaries' });
  }
});

// Add manual URL article
app.post('/api/articles/fetch-url', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Check if article already exists
    const existingArticle = await database.getArticleByLink(url);
    if (existingArticle) {
      return res.json({
        success: true,
        article: existingArticle,
        message: 'Article already exists in database'
      });
    }
    
    const feedMonitor = require('./services/feedMonitor');
    const llmService = require('./services/llmService');
    
    // Extract article metadata
    const metadata = await feedMonitor.extractArticleMetadata(url);
    
    // Generate AI summary for detailed view (not for preview)
    const aiSummary = await llmService.summarizeArticle(
      metadata.title, 
      metadata.content, 
      metadata.sourceName
    );
    
    // Add to database
    const articleId = await database.addArticle({
      title: metadata.title,
      content: metadata.content,
      preview: metadata.description, // Use RSS-style description as preview
      link: url,
      pub_date: metadata.pubDate,
      source_id: null, // Manual entry
      source_name: metadata.sourceName, // Use actual source name
      category: 'Manual',
      status: 'new',
      is_manual: true,
      ai_summary: aiSummary // Store AI summary separately
    });
    
    // Get the created article
    const createdArticle = await database.getArticleById(articleId);
    
    res.json({
      success: true,
      article: createdArticle,
      message: 'Article added successfully'
    });
    
  } catch (error) {
    console.error('Error fetching URL:', error);
    res.status(500).json({ 
      error: 'Failed to fetch article from URL',
      details: error.message 
    });
  }
});

// Clear current session and start fresh
app.post('/api/articles/clear-session', async (req, res) => {
  try {
    const dismissed = await database.clearCurrentSession();
    const sessionId = await database.startNewSession();
    res.json({ 
      message: `Session cleared. ${dismissed} articles dismissed. New session started.`,
      dismissed: dismissed,
      sessionId: sessionId
    });
  } catch (error) {
    console.error('Error clearing session:', error);
    res.status(500).json({ error: 'Failed to clear session' });
  }
});

// Serve static files (both development and production)
app.use(express.static(path.join(__dirname, '../client/build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});

// Start the server
const startServer = async () => {
  try {
    // Initialize database first
    await database.init();
    console.log('Database initialized successfully');
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`Distro Scoopstream server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      
      // Start feed monitoring
      feedMonitor.startMonitoring();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = app;