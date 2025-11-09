const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const config = require('./config');
require('dotenv').config();

const feedMonitor = require('./services/feedMonitor');
const FeedDiscovery = require('./services/feedDiscovery');
const WebScraper = require('./services/webScraper');
const llmService = require('./services/llmService');
const database = require('./database-postgres');

const webScraper = new WebScraper();

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
      
      // Parse scraping result for scraping sources
      let scrapingResult = null;
      if (s.monitoring_type === 'SCRAPING' && s.last_scraping_result) {
        try {
          scrapingResult = typeof s.last_scraping_result === 'string' 
            ? JSON.parse(s.last_scraping_result) 
            : s.last_scraping_result;
        } catch (e) {
          // Invalid JSON, ignore
        }
      }
      
      return { 
        ...s, 
        success_rate, 
        active,
        scraping_result: scrapingResult
      };
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

// Test scraping fallback for a given URL (does not persist)
app.post('/api/scrape/test', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const discovery = new FeedDiscovery();

    // Try structured data first, then blog section extraction
    const structured = await discovery.extractStructuredData(url);
    const blogArticles = await discovery.extractArticlesFromBlogSection(url);

    // Merge and normalize to the same shape used by RSS items
    const merged = [...structured, ...blogArticles];

    // De-dupe by url
    const seen = new Set();
    const unique = merged.filter(a => {
      const key = a.url;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const normalized = unique.map(a => ({
      title: a.title || 'Untitled',
      link: a.url || '',
      content: a.description || '',
      preview: a.description || '',
      pub_date: a.datePublished || null
    }));

    res.json({ count: normalized.length, articles: normalized });
  } catch (error) {
    console.error('Error in /api/scrape/test:', error.message);
    res.status(500).json({ error: 'Failed to scrape URL' });
  }
});

// Add a new source to monitor
app.post('/api/sources', async (req, res) => {
  try {
    const { url, name, category } = req.body;
    
    if (!url || !name) {
      return res.status(400).json({ error: 'URL and name are required' });
    }

    let monitoringType = 'RSS';
    let feedUrl = url;
    
    // Try RSS/JSON Feed first
    let isValid = await feedMonitor.validateFeed(url);
    
    // If direct URL is not a feed, try to discover one
    if (!isValid) {
      const feedDiscovery = new FeedDiscovery();
      const discoveredFeed = await feedDiscovery.discoverFeedUrl(url);
      
      if (discoveredFeed) {
        // Double-check: reject sitemaps (they're not feeds!)
        if (discoveredFeed.includes('sitemap.xml') || discoveredFeed.includes('sitemap')) {
          console.log(`⚠️ Rejecting discovered sitemap URL: ${discoveredFeed}`);
          discoveredFeed = null; // Don't use sitemap as feed
        } else {
          feedUrl = discoveredFeed;
          isValid = await feedMonitor.validateFeed(discoveredFeed);
          if (isValid) {
            const isJSON = await feedMonitor.isJSONFeed(discoveredFeed);
            console.log(`✅ Discovered ${isJSON ? 'JSON' : 'RSS'} feed: ${discoveredFeed}`);
          } else {
            // If discovered feed is invalid, don't use it
            console.log(`⚠️ Discovered feed is invalid: ${discoveredFeed}`);
            feedUrl = url; // Use original URL instead
          }
        }
      }
    }

    // If still no feed found, try scraping as fallback
    if (!isValid) {
      console.log(`📝 No RSS/JSON Feed found for ${url}, trying scraping fallback...`);
      monitoringType = 'SCRAPING';
      
      // Test if scraping works (use original URL, not discovered sitemap)
      const testArticles = await webScraper.scrapeArticles({ url, name, category: category || null });
      
      if (testArticles.length === 0) {
        // Provide more helpful error message
        let errorMsg = 'No RSS/JSON Feed found and scraping returned no articles.';
        
        // Check if a sitemap was found (which is not a feed)
        if (feedUrl && feedUrl.includes('sitemap.xml')) {
          errorMsg = 'A sitemap was found, but no RSS/JSON feed was available. The system tried scraping but found no articles. Please check the URL or provide a direct RSS feed URL.';
        }
        
        return res.status(400).json({ 
          error: errorMsg
        });
      }
      
      console.log(`✅ Scraping found ${testArticles.length} articles, using scraping fallback`);
    }

    // Add category if provided
    let categoryName = null;
    if (category && category.trim()) {
      const categoryRecord = await database.addCategory(category.trim());
      categoryName = categoryRecord.name;
    }

    const source = await database.addSource(name, feedUrl || url, categoryName, monitoringType);
    const sourceId = source.id;
    
    // Fetch 3 most recent articles from the new source
    try {
      if (monitoringType === 'SCRAPING') {
        // Scraping: get 3 most recent articles
        const articles = await webScraper.scrapeArticles({ id: sourceId, url, name, category: categoryName });
        
        for (const article of articles.slice(0, 3)) {
          try {
            const exists = await database.articleExists(article.link);
            if (!exists) {
              // Generate AI-enhanced content (same as RSS)
              const enhancedContent = await feedMonitor.enhanceArticleContent(article);
              
              const articleObj = {
                sourceId: sourceId,
                title: enhancedContent.title || article.title || 'Untitled',
                link: article.link,
                content: enhancedContent.content || article.content || '',
                preview: enhancedContent.preview || article.preview || '',
                pubDate: article.pubDate || article.isoDate || null,
                sourceName: name,
                category: categoryName || 'General',
                status: 'new'
              };
              
              if (articleObj.title !== 'Untitled' && articleObj.link) {
                await database.addArticle(articleObj);
              }
            }
          } catch (err) {
            // Skip duplicates or errors
          }
        }
        
        console.log(`✅ Added ${Math.min(articles.length, 3)} most recent articles from scraping: ${name}`);
      } else {
        // RSS/JSON Feed
        await feedMonitor.checkFeedLimited({ id: sourceId, url: feedUrl, name, category: categoryName }, 3);
        console.log(`✅ Added 3 most recent articles from RSS/JSON Feed: ${name}`);
      }
    } catch (error) {
      console.log('Could not fetch recent articles for new source:', error.message);
    }
    
    res.json({ 
      id: sourceId, 
      message: 'Source added successfully',
      monitoring_type: monitoringType
    });
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

    // Add category to categories table if it doesn't exist
    if (category && category.trim()) {
      await database.addCategory(category.trim());
    }

    const source = await database.updateSourceCategory(parseInt(id), category);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }

    // Update all existing articles from this source with the new category
    await database.updateArticlesCategoryBySource(parseInt(id), category);
    
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
      // Priority: AI summary > author's note (publisher_description) > preview > fallback
      let actualPreview = null;
      
      // 1. Try AI summary first (if available)
      if (article.ai_summary && article.ai_summary.trim().length > 0) {
        actualPreview = article.ai_summary;
      }
      // 2. Try author's note (publisher description) - this is the RSS description
      else if (article.publisher_description && article.publisher_description.trim().length > 0 && 
               article.publisher_description !== '9' && article.publisher_description !== '9...') {
        actualPreview = article.publisher_description;
      }
      // 3. Try preview
      else if (article.preview && article.preview.trim().length > 0 && 
               article.preview !== '9' && article.preview !== '9...') {
        actualPreview = article.preview;
      }
      // 4. Fallback
      else {
        actualPreview = "No description available";
      }
      
      let actualLink = article.link;
      
      return {
        id: article.id,
        author: "Author Name", // Default author name
        more_info_url: actualLink,
        source: article.source_name || "Unknown Source",
        cost: 10, // Default cost
        preview: actualPreview, // AI summary > author's note > preview
        title: article.title,
        content: article.content || "Content will be generated when summaries are created",
        // Additional fields for display
        source_name: article.source_name || "Unknown Source",
        created_at: article.created_at,
        pub_date: article.pub_date,
        category: article.category,
        publisher_description: article.publisher_description || actualPreview,
        ai_summary: article.ai_summary // AI-generated summary (shown if available)
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
    
    console.log(`📊 Found ${articles.length} articles from last ${days} days`);
    
    // Format articles for professional display
    const formattedArticles = articles.map(article => {
      // Priority: AI summary > author's note (publisher_description) > preview > fallback
      let actualPreview = null;
      
      // 1. Try AI summary first (if available)
      if (article.ai_summary && article.ai_summary.trim().length > 0) {
        actualPreview = article.ai_summary;
      }
      // 2. Try author's note (publisher description) - this is the RSS description
      else if (article.publisher_description && article.publisher_description.trim().length > 0 && 
               article.publisher_description !== '9' && article.publisher_description !== '9...') {
        actualPreview = article.publisher_description;
      }
      // 3. Try preview
      else if (article.preview && article.preview.trim().length > 0 && 
               article.preview !== '9' && article.preview !== '9...') {
        actualPreview = article.preview;
      }
      // 4. Fallback
      else {
        actualPreview = "No description available";
      }
      
      let actualLink = article.link;
      
      return {
        id: article.id,
        author: "Author Name",
        more_info_url: actualLink,
        source: article.source_name || "Unknown Source",
        cost: 10,
        preview: actualPreview, // AI summary > author's note > preview
        title: article.title,
        content: article.content || "Content will be generated when summaries are created",
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

// Get all articles (for verification/debugging)
app.get('/api/articles/all', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const articles = await database.getAllArticles(limit);
    
    // Format articles for display
    const formattedArticles = articles.map(article => ({
      id: article.id,
      title: article.title,
      link: article.link,
      pub_date: article.pub_date,
      created_at: article.created_at,
      source_name: article.source_name || 'Unknown',
      category: article.category,
      status: article.status,
      has_content: !!(article.content && article.content.length > 0),
      content_length: article.content ? article.content.length : 0
    }));
    
    res.json({
      total: formattedArticles.length,
      articles: formattedArticles
    });
  } catch (error) {
    console.error('Error fetching all articles:', error);
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

// Maintenance: backfill article categories from source categories
app.post('/api/maintenance/backfill-article-categories', async (req, res) => {
  try {
    const sources = await database.getAllSources();
    let updated = 0;

    for (const source of sources) {
      if (source.category) {
        const updatedCount = await database.updateArticlesCategoryBySource(source.id, source.category);
        updated += updatedCount;
        console.log(`Updated ${updatedCount} articles for source "${source.name}" with category "${source.category}"`);
      }
    }

    res.json({ success: true, updated });
  } catch (error) {
    console.error('Error backfilling article categories:', error);
    res.status(500).json({ success: false, error: 'Failed to backfill article categories' });
  }
});

// Maintenance: add all source categories to categories table
app.post('/api/maintenance/backfill-categories-table', async (req, res) => {
  try {
    const sources = await database.getAllSources();
    let added = 0;

    for (const source of sources) {
      if (source.category) {
        try {
          await database.addCategory(source.category);
          added++;
          console.log(`Added category "${source.category}" to categories table`);
        } catch (error) {
          // Category might already exist, which is fine
          if (!error.message.includes('duplicate key')) {
            console.error(`Error adding category "${source.category}":`, error.message);
          }
        }
      }
    }

    res.json({ success: true, added });
  } catch (error) {
    console.error('Error backfilling categories table:', error);
    res.status(500).json({ success: false, error: 'Failed to backfill categories table' });
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

// Debug endpoint to check scraping sources and articles
app.get('/api/debug/scraping', async (req, res) => {
  try {
    // Get all scraping sources
    const scrapingSources = await database.pool.query(`
      SELECT id, name, url, monitoring_type, last_checked, created_at
      FROM sources
      WHERE monitoring_type = 'SCRAPING'
      ORDER BY created_at DESC
    `);

    // Get articles from scraping sources
    const scrapingArticles = await database.pool.query(`
      SELECT a.id, a.title, a.link, a.pub_date, a.created_at, a.source_name, a.preview,
             s.monitoring_type, s.name as source_name_from_table
      FROM articles a
      LEFT JOIN sources s ON a.source_id = s.id
      WHERE s.monitoring_type = 'SCRAPING' OR a.source_name = 'Vana'
      ORDER BY a.created_at DESC
      LIMIT 20
    `);

    // Get Vana-specific info
    const vanaSource = scrapingSources.rows.find(s => s.name === 'Vana');
    const vanaArticles = scrapingArticles.rows.filter(a => 
      a.source_name === 'Vana' || a.source_name_from_table === 'Vana'
    );

    res.json({
      scrapingSources: scrapingSources.rows,
      scrapingArticles: scrapingArticles.rows,
      vana: {
        source: vanaSource || null,
        articles: vanaArticles,
        articleCount: vanaArticles.length
      },
      summary: {
        totalScrapingSources: scrapingSources.rows.length,
        totalScrapingArticles: scrapingArticles.rows.length
      }
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch debug info' });
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