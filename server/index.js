const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const config = require('./config');
require('dotenv').config();

// Handle unhandled promise rejections to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  // Database connection timeout errors are expected and handled by the pool
  if (reason && (reason.code === 'ETIMEDOUT' || reason.code === 'ECONNRESET' || reason.syscall === 'read')) {
    console.log(`ℹ️  [Unhandled Rejection] Database connection timeout (expected with poolers): ${reason.message || reason.code}`);
    return; // Don't log as error, just continue
  }
  console.error('⚠️  [Unhandled Rejection]', reason);
  // Don't exit - let the app continue running
});

// Handle uncaught exceptions (but don't exit)
process.on('uncaughtException', (error) => {
  console.error('❌ [Uncaught Exception]', error);
  // Don't exit - let the app continue running (better than crashing)
});

const feedMonitor = require('./services/feedMonitor');
const FeedDiscovery = require('./services/feedDiscovery');
const WebScraper = require('./services/webScraper');
const ADKScraper = require('./services/adkScraper');
const llmService = require('./services/llmService');
const articleEnrichment = require('./services/articleEnrichment');
const database = require('./database-postgres');

const webScraper = new WebScraper();
const adkScraper = new ADKScraper(); // ADK scraper for AI-powered extraction

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.get('/api/health', async (req, res) => {
  // Check if database is initialized
  const dbStatus = database.pool ? 'connected' : 'not initialized';
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: dbStatus
  });
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

// Check if a URL has an RSS feed (step 1 of multi-step flow)
// IMPORTANT: This endpoint does NOT use Playwright to avoid memory issues
app.post('/api/sources/check-feed', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    let feedUrl = url;
    let isValid = false;
    
    // Try RSS/JSON Feed first (no Playwright, just HTTP requests)
    isValid = await feedMonitor.validateFeed(url);
    
    // If direct URL is not a feed, try to discover one (also no Playwright)
    if (!isValid) {
      const feedDiscovery = new FeedDiscovery();
      const discoveredFeed = await feedDiscovery.discoverFeedUrl(url);
      
      if (discoveredFeed) {
        // Double-check: reject sitemaps (they're not feeds!)
        if (discoveredFeed.includes('sitemap.xml') || discoveredFeed.includes('sitemap')) {
          console.log(`⚠️ Rejecting discovered sitemap URL: ${discoveredFeed}`);
        } else {
          feedUrl = discoveredFeed;
          isValid = await feedMonitor.validateFeed(discoveredFeed);
          if (isValid) {
            const isJSON = await feedMonitor.isJSONFeed(discoveredFeed);
            console.log(`✅ Discovered ${isJSON ? 'JSON' : 'RSS'} feed: ${discoveredFeed}`);
          } else {
            feedUrl = url; // Use original URL instead
          }
        }
      }
    }

    if (isValid) {
      return res.json({
        success: true,
        hasFeed: true,
        feedUrl: feedUrl,
        message: "OK, you're all set!"
      });
    } else {
      return res.json({
        success: true,
        hasFeed: false,
        message: "We did not find an RSS feed for this source. Would you like us to proceed with setting up a scraping for this source?"
      });
    }
  } catch (error) {
    console.error('Error checking feed:', error);
    res.status(500).json({ error: 'Failed to check for RSS feed' });
  }
});

// Set up scraping for a source (step 2 of multi-step flow)
// IMPORTANT: This endpoint includes explicit browser cleanup to prevent memory issues
app.post('/api/sources/setup-scraping', async (req, res) => {
  try {
    const { url, name, category } = req.body;
    
    if (!url || !name) {
      return res.status(400).json({ error: 'URL and name are required' });
    }

    // Add category if provided
    let categoryName = null;
    if (category && category.trim()) {
      const categoryRecord = await database.addCategory(category.trim());
      categoryName = categoryRecord.name;
    }

    // Add source with SCRAPING monitoring type first
    let source;
    let sourceId;
    try {
      source = await database.addSource(name, url, categoryName, 'SCRAPING');
      sourceId = source.id;
    } catch (dbError) {
      // Handle duplicate key error gracefully (no extra query needed)
      if (dbError.code === '23505' || dbError.message.includes('duplicate key')) {
        return res.status(400).json({ 
          success: false,
          error: 'This source already exists.',
          errorDetails: `A source with URL "${url}" is already being monitored.`,
          errorType: 'duplicate_source'
        });
      }
      throw dbError; // Re-throw if it's a different error
    }
    
    // Scrape articles using ADK (AI-powered extraction) - faster and more consistent
    let scrapingError = null;
    let articles = [];
    try {
      // Use ADK scraper for AI-powered extraction
      articles = await adkScraper.scrapeArticles({ id: sourceId, url, name, category: categoryName });
    } catch (scrapeErr) {
      scrapingError = scrapeErr;
      console.log(`⚠️ ADK scraping failed: ${scrapeErr.message}`);
      // Fallback to traditional scraping if ADK fails
      try {
        console.log(`🔄 Falling back to traditional scraping...`);
        articles = await webScraper.scrapeArticles({ id: sourceId, url, name, category: categoryName });
        await webScraper.close();
      } catch (fallbackErr) {
        scrapingError = fallbackErr;
        console.log(`⚠️ Fallback scraping also failed: ${fallbackErr.message}`);
      }
    }
    
    // Check if scraping worked
    if (articles.length === 0) {
      // If scraping fails, remove the source we just created
      try {
        await database.removeSource(sourceId);
      } catch (deleteErr) {
        console.error('Error deleting source after scraping failure:', deleteErr.message);
      }
    }
    
    // Check if scraping worked
    if (articles.length === 0) {
      // Provide more helpful error message
      let errorMsg = 'Unfortunately, we were unable to set up scraping for this source.';
      let errorDetails = null;
      
      if (scrapingError) {
        const errorMessage = scrapingError.message || scrapingError.toString();
        
        // Check for specific error types
        if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
          errorMsg = 'This website is blocking automated access (403 Forbidden).';
          errorDetails = 'The site may be using Cloudflare or similar security measures that prevent scraping.';
        } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
          errorMsg = 'Scraping timed out while trying to access the website.';
          errorDetails = 'The site may be slow or unresponsive. Please try again later.';
        } else if (errorMessage.includes('memory') || errorMessage.includes('Memory')) {
          errorMsg = 'Insufficient memory to scrape this source.';
          errorDetails = 'The server is running low on memory. This may be a temporary issue.';
        } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
          errorMsg = 'Could not connect to the website.';
          errorDetails = 'The URL may be incorrect or the site may be down.';
        } else if (errorMessage.includes('No articles found')) {
          errorMsg = 'No articles were found on this page.';
          errorDetails = 'The scraper could not detect any articles. The page structure may be different than expected.';
        } else {
          errorMsg = `Scraping failed: ${errorMessage}`;
          errorDetails = 'Please check the URL and try again.';
        }
      } else {
        errorMsg = 'No articles were found on this page.';
        errorDetails = 'The scraper could not detect any articles. The page structure may be different than expected, or the site may require JavaScript rendering.';
      }
      
      return res.status(400).json({ 
        success: false,
        error: errorMsg,
        errorDetails: errorDetails,
        errorType: scrapingError ? 'scraping_error' : 'no_articles'
      });
    }
    
    console.log(`✅ Scraping found ${articles.length} articles, proceeding with setup`);
    
    // Add the 3 most recent articles from the scraping result
    try {
      for (const article of articles.slice(0, 3)) {
        try {
          const exists = await database.articleExists(article.link);
          if (!exists) {
            // Ensure title is never null or empty (simple check, no heavy processing)
            const originalTitle = (article.title && article.title.trim()) ? article.title.trim() : 'Untitled Article';
            
            // Skip if link is invalid
            if (!article.link || typeof article.link !== 'string') {
              continue;
            }
            
            await database.addArticle(
              originalTitle,
              article.link,
              article.content || '',
              article.description || article.contentSnippet || '',
              article.pubDate || null,
              sourceId,
              source.name,
              categoryName,
              'new'
            );
          }
        } catch (articleError) {
          console.error(`Error adding article ${article.link}:`, articleError.message);
        }
      }
    } catch (fetchError) {
      console.error('Error fetching initial articles:', fetchError.message);
      // Don't fail the whole operation if we can't fetch articles
    }

    return res.json({
      success: true,
      message: "OK, you're all set!",
      source: source
    });
  } catch (error) {
    console.error('Error setting up scraping:', error);
    
    // Handle duplicate source error
    if (error.code === '23505' || error.message.includes('duplicate key')) {
      return res.status(400).json({ 
        success: false,
        error: 'This source already exists.',
        errorDetails: `A source with this URL is already being monitored.`,
        errorType: 'duplicate_source'
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to set up scraping' 
    });
  }
});

// Add a new source to monitor (for RSS feeds found in step 1)
// This endpoint is now only for adding RSS feeds (scraping is handled by /api/sources/setup-scraping)
app.post('/api/sources', async (req, res) => {
  try {
    const { url, name, category, feedUrl } = req.body;
    
    if (!url || !name) {
      return res.status(400).json({ error: 'URL and name are required' });
    }

    // This endpoint is now only for adding RSS feeds
    // feedUrl should be provided from the check-feed endpoint
    const finalFeedUrl = feedUrl || url;
    
    // Validate the feed one more time
    const isValid = await feedMonitor.validateFeed(finalFeedUrl);
    if (!isValid) {
      return res.status(400).json({ 
        error: 'Invalid RSS feed. Please check the URL and try again.' 
      });
    }

    // Add category if provided
    let categoryName = null;
    if (category && category.trim()) {
      const categoryRecord = await database.addCategory(category.trim());
      categoryName = categoryRecord.name;
    }

    // Add RSS feed source
    let source;
    let sourceId;
    try {
      source = await database.addSource(name, finalFeedUrl, categoryName, 'RSS');
      sourceId = source.id;
    } catch (dbError) {
      // Handle duplicate key error gracefully
      if (dbError.code === '23505' || dbError.message.includes('duplicate key')) {
        return res.status(400).json({ 
          success: false,
          error: 'This source already exists.',
          errorDetails: `A source with URL "${finalFeedUrl}" is already being monitored.`,
          errorType: 'duplicate_source'
        });
      }
      throw dbError;
    }
    
    // Fetch 3 most recent articles from the new RSS feed
    try {
      await feedMonitor.checkFeedLimited({ id: sourceId, url: finalFeedUrl, name, category: categoryName }, 3);
      console.log(`✅ Added 3 most recent articles from RSS/JSON Feed: ${name}`);
    } catch (error) {
      console.log('Could not fetch recent articles for new source:', error.message);
    }
    
    res.json({ 
      success: true,
      id: sourceId, 
      message: "OK, you're all set!",
      source: source
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

// Send article to Telegram
app.post('/api/articles/send-telegram', async (req, res) => {
  const startTime = Date.now();
  console.log(`\n📱 [TELEGRAM] Send request received at ${new Date().toISOString()}`);
  console.log(`📱 [TELEGRAM] Request body:`, req.body);
  
  try {
    const { articleId } = req.body;
    
    if (!articleId) {
      console.error(`❌ [TELEGRAM] Missing articleId in request`);
      return res.status(400).json({ 
        success: false, 
        error: 'Article ID is required' 
      });
    }

    console.log(`📱 [TELEGRAM] Looking up article ID: ${articleId}`);

    // Get article from database
    const article = await database.getArticleById(articleId);
    if (!article) {
      console.error(`❌ [TELEGRAM] Article not found with ID: ${articleId}`);
      return res.status(404).json({ 
        success: false, 
        error: 'Article not found' 
      });
    }

    console.log(`✅ [TELEGRAM] Article found: "${article.title}" (ID: ${article.id})`);
    console.log(`📱 [TELEGRAM] Article link: ${article.link}`);

    // Check Telegram configuration
    console.log(`📱 [TELEGRAM] Checking configuration...`);
    console.log(`📱 [TELEGRAM] Bot token present: ${!!config.telegram.botToken} (length: ${config.telegram.botToken?.length || 0})`);
    console.log(`📱 [TELEGRAM] Channel ID: ${config.telegram.channelId || 'NOT SET'}`);
    console.log(`📱 [TELEGRAM] Thread ID: ${config.telegram.messageThreadId || 'NOT SET'}`);
    
    if (!config.telegram.botToken || !config.telegram.channelId) {
      console.error(`❌ [TELEGRAM] Configuration missing! Bot token: ${!!config.telegram.botToken}, Channel ID: ${!!config.telegram.channelId}`);
      return res.status(500).json({ 
        success: false, 
        error: 'Telegram bot token or channel ID not configured. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID in environment variables.' 
      });
    }

    // Format message for Telegram
    console.log(`📱 [TELEGRAM] Formatting message...`);
    // Use preview/description if available, otherwise use content (truncated)
    const preview = article.ai_summary || article.publisher_description || article.preview || article.content || 'No preview available';
    
    // Escape HTML special characters for Telegram HTML parse mode
    const escapeHtml = (text) => {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };
    
    // Format the message with title, preview, source, and link
    // Using HTML parse mode for better formatting control and simpler escaping
    const title = escapeHtml(article.title || 'Untitled Article');
    const source = escapeHtml(article.source_name || 'Unknown');
    const link = escapeHtml(article.link);
    
    // Calculate the exact overhead for the message structure:
    // 📰 <b>title</b>\n\n + preview + \n\n🔗 <a href="link">Read more</a>\n📊 Source: source
    // Base structure: 📰 <b> + title + </b>\n\n + preview + \n\n🔗 <a href=" + link + ">Read more</a>\n📊 Source: + source
    const baseOverhead = `📰 <b></b>\n\n\n\n🔗 <a href="">Read more</a>\n📊 Source: `.length;
    // Account for actual title, link, and source lengths (already escaped)
    const variableOverhead = title.length + link.length + source.length;
    const totalOverhead = baseOverhead + variableOverhead;
    
    // Telegram has a 4096 character limit, reserve some buffer (50 chars) for safety
    const maxMessageLength = 4096;
    const safetyBuffer = 50;
    const maxPreviewLength = maxMessageLength - totalOverhead - safetyBuffer;
    
    // Escape preview
    let previewText = escapeHtml(preview);
    const originalPreviewLength = previewText.length; // Store original length for logging
    
    // Build the full message first to check actual length
    const buildMessage = (previewContent) => {
      return `📰 <b>${title}</b>\n\n${previewContent}\n\n🔗 <a href="${link}">Read more</a>\n📊 Source: ${source}`;
    };
    
    // Truncate preview if needed, ensuring the full message stays under limit
    let finalMessage = buildMessage(previewText);
    
    // Helper function to find a good truncation point
    const findTruncationPoint = (text, targetLength) => {
      if (text.length <= targetLength) return text.length;
      
      // Look backwards from targetLength to find the last sentence boundary (period + space)
      // Search in the last 1000 characters before the target
      const searchStart = Math.max(0, targetLength - 1000);
      const searchText = text.substring(searchStart, Math.min(text.length, targetLength + 100));
      
      // Try to find sentence end (period followed by space/newline)
      // Look backwards from the end of the search area
      let lastSentenceEnd = -1;
      for (let i = searchText.length - 1; i >= 0; i--) {
        if (searchText[i] === '.' && (i + 1 < searchText.length) && /\s/.test(searchText[i + 1])) {
          lastSentenceEnd = searchStart + i + 1; // +1 to include the period
          if (lastSentenceEnd <= targetLength) {
            break;
          }
        }
      }
      
      if (lastSentenceEnd > searchStart && lastSentenceEnd <= targetLength) {
        return lastSentenceEnd;
      }
      
      // Try to find word boundary (space) in the last 500 chars
      const wordSearchStart = Math.max(0, targetLength - 500);
      const wordSearchText = text.substring(wordSearchStart, Math.min(text.length, targetLength + 50));
      const lastSpace = wordSearchText.lastIndexOf(' ');
      
      if (lastSpace > 0) {
        const spacePos = wordSearchStart + lastSpace;
        if (spacePos > wordSearchStart && spacePos <= targetLength) {
          return spacePos;
        }
      }
      
      // Last resort: just truncate at target length
      return targetLength;
    };
    
    if (finalMessage.length > maxMessageLength) {
      // Calculate how much we need to trim from the preview (accounting for ellipsis)
      const excess = finalMessage.length - maxMessageLength + safetyBuffer;
      const ellipsisLength = 3; // "..."
      const targetPreviewLength = Math.max(100, previewText.length - excess - ellipsisLength);
      
      // Find a good truncation point
      const truncationPoint = findTruncationPoint(previewText, targetPreviewLength);
      previewText = previewText.substring(0, truncationPoint).trim();
      previewText += '...';
      
      // Rebuild message with truncated preview
      finalMessage = buildMessage(previewText);
      
      // Final safety check - if still too long, truncate more aggressively
      if (finalMessage.length > maxMessageLength) {
        const finalExcess = finalMessage.length - maxMessageLength + safetyBuffer;
        // Remove ellipsis temporarily to recalculate
        const textWithoutEllipsis = previewText.slice(0, -3);
        const newTargetLength = Math.max(100, textWithoutEllipsis.length - finalExcess);
        const finalTruncationPoint = findTruncationPoint(textWithoutEllipsis, newTargetLength);
        previewText = textWithoutEllipsis.substring(0, finalTruncationPoint).trim();
        previewText += '...';
        finalMessage = buildMessage(previewText);
        
        // Absolute final check - hard truncate if still too long (shouldn't happen, but be safe)
        if (finalMessage.length > maxMessageLength) {
          const hardExcess = finalMessage.length - maxMessageLength + 10;
          const textBeforeEllipsis = previewText.slice(0, -3);
          previewText = textBeforeEllipsis.substring(0, Math.max(50, textBeforeEllipsis.length - hardExcess)).trim();
          previewText += '...';
          finalMessage = buildMessage(previewText);
        }
      }
      
      console.log(`⚠️ [TELEGRAM] WARNING: Message was truncated from ${originalPreviewLength} to ${previewText.length - 3} chars (ellipsis added). User should have been prevented from sending this!`);
    }
    
    console.log(`📱 [TELEGRAM] Preview length: ${previewText.length} chars`);
    console.log(`📱 [TELEGRAM] Message formatted (${finalMessage.length} chars, limit: ${maxMessageLength})`);
    console.log(`📱 [TELEGRAM] Message preview: ${finalMessage.substring(0, 150)}...`);

    // Send to Telegram using Bot API
    const telegramApiUrl = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
    console.log(`📱 [TELEGRAM] Telegram API URL: https://api.telegram.org/bot***/sendMessage (token hidden)`);
    
    // Handle channel ID format - Telegram channels need -100 prefix for numeric IDs
    let chatId = config.telegram.channelId;
    let messageThreadId = config.telegram.messageThreadId;
    
    console.log(`📱 [TELEGRAM] Original channel ID: ${chatId}`);
    console.log(`📱 [TELEGRAM] Original thread ID: ${messageThreadId || 'none'}`);
    
    // Check if channel ID contains thread ID (format: -1001234567890_529)
    if (chatId.includes('_')) {
      const parts = chatId.split('_');
      chatId = parts[0]; // Channel ID is the part before underscore
      messageThreadId = parts[1]; // Thread ID is the part after underscore
      console.log(`📱 [TELEGRAM] Parsed channel ID: ${chatId}, thread ID: ${messageThreadId}`);
    }
    
    // If it's a plain numeric ID (not starting with @ or -), try adding -100 prefix for channels
    if (/^\d+$/.test(chatId)) {
      // It's a plain number, try with -100 prefix (standard for Telegram channels)
      chatId = `-100${chatId}`;
      console.log(`📱 [TELEGRAM] Added -100 prefix: ${chatId}`);
    }
    
    const payload = {
      chat_id: chatId,
      text: finalMessage,
      parse_mode: 'HTML', // Use HTML for simpler formatting
      disable_web_page_preview: false
    };

    // Add message_thread_id if configured (for topics in channels)
    if (messageThreadId) {
      payload.message_thread_id = parseInt(messageThreadId);
      console.log(`📱 [TELEGRAM] Added thread ID to payload: ${messageThreadId}`);
    }
    
    console.log(`📱 [TELEGRAM] Final payload:`, {
      chat_id: payload.chat_id,
      message_thread_id: payload.message_thread_id || 'none',
      parse_mode: payload.parse_mode,
      text_length: payload.text.length
    });

    const results = {
      telegram: { success: false, error: null },
      externalApi: { success: false, error: null }
    };

    // Step 1: Send to Telegram
    console.log(`📱 [TELEGRAM] Sending to Telegram API...`);
    const telegramStartTime = Date.now();
    try {
      const telegramResponse = await axios.post(telegramApiUrl, payload, {
        timeout: 10000
      });

      const telegramDuration = Date.now() - telegramStartTime;
      console.log(`📱 [TELEGRAM] Telegram API response received in ${telegramDuration}ms`);
      console.log(`📱 [TELEGRAM] Response status: ${telegramResponse.status}`);
      console.log(`📱 [TELEGRAM] Response data:`, JSON.stringify(telegramResponse.data, null, 2));

      if (telegramResponse.data.ok) {
        console.log(`✅ [TELEGRAM] Article "${article.title}" sent to Telegram successfully`);
        console.log(`✅ [TELEGRAM] Message ID: ${telegramResponse.data.result.message_id}`);
        results.telegram.success = true;
        results.telegram.messageId = telegramResponse.data.result.message_id;
        // Mark article as sent when Telegram succeeds
        await database.updateArticleStatus(article.id, 'sent');
      } else {
        console.error(`❌ [TELEGRAM] Telegram API returned ok=false`);
        console.error(`❌ [TELEGRAM] Error description: ${telegramResponse.data.description}`);
        throw new Error(telegramResponse.data.description || 'Unknown Telegram API error');
      }
    } catch (telegramError) {
      const telegramDuration = Date.now() - telegramStartTime;
      console.error(`❌ [TELEGRAM] Error after ${telegramDuration}ms`);
      console.error(`❌ [TELEGRAM] Error type: ${telegramError.name}`);
      console.error(`❌ [TELEGRAM] Error message: ${telegramError.message}`);
      
      let errorMessage = 'Failed to send to Telegram';
      
      if (telegramError.response) {
        console.error(`❌ [TELEGRAM] Response status: ${telegramError.response.status}`);
        console.error(`❌ [TELEGRAM] Response data:`, JSON.stringify(telegramError.response.data, null, 2));
        
        // Extract error description from Telegram API response
        const errorData = telegramError.response.data;
        if (errorData) {
          if (errorData.description) {
            errorMessage = errorData.description;
          } else if (errorData.error_code) {
            // Common Telegram API errors:
            // 400: Bad Request (wrong chat_id, etc.)
            // 401: Unauthorized (invalid bot token)
            // 403: Forbidden (bot not admin, etc.)
            // 404: Not Found (chat not found)
            const errorCodes = {
              400: 'Bad Request - Check your channel ID or message format',
              401: 'Unauthorized - Check your bot token',
              403: 'Forbidden - Bot may not have permission to post to channel',
              404: 'Chat not found - Check your channel ID'
            };
            errorMessage = errorCodes[errorData.error_code] || errorData.description || `Telegram API error ${errorData.error_code}`;
          }
        }
      } else if (telegramError.request) {
        console.error(`❌ [TELEGRAM] No response received from Telegram API`);
        console.error(`❌ [TELEGRAM] Request config:`, {
          url: telegramError.config?.url?.replace(/\/bot[^/]+/, '/bot***'), // Hide token in logs
          method: telegramError.config?.method,
          timeout: telegramError.config?.timeout
        });
        errorMessage = 'No response from Telegram API - Check your internet connection or Telegram API status';
      } else if (telegramError.message) {
        errorMessage = telegramError.message;
      }
      
      console.error(`❌ [TELEGRAM] Final error message: ${errorMessage}`);
      results.telegram.error = errorMessage;
    }

    // Step 2: Send to external API (pulse-chain)
    console.log(`📱 [TELEGRAM] Sending to external API: ${config.distro.apiEndpoint}`);
    const externalStartTime = Date.now();
    try {
      const externalPayload = {
        user_info: {
          name: "Distro DeAI News Flash"
        },
        more_info_url: article.link,
        source: article.source_name || 'Unknown',
        cost: 10,
        preview: article.ai_summary || article.publisher_description || article.preview || '',
        title: article.title,
        content: article.content || ''
      };

      console.log(`📱 [TELEGRAM] External API payload:`, {
        title: externalPayload.title,
        source: externalPayload.source,
        preview_length: externalPayload.preview.length,
        content_length: externalPayload.content.length
      });

      const externalResponse = await axios.post(config.distro.apiEndpoint, externalPayload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.distro.apiKey}`,
          'X-API-Key': config.distro.apiKey
        },
        timeout: 10000
      });

      const externalDuration = Date.now() - externalStartTime;
      console.log(`✅ [TELEGRAM] Article "${article.title}" sent to external API successfully in ${externalDuration}ms`);
      console.log(`✅ [TELEGRAM] External API response:`, JSON.stringify(externalResponse.data, null, 2));
      results.externalApi.success = true;
      results.externalApi.response = externalResponse.data;
    } catch (externalError) {
      const externalDuration = Date.now() - externalStartTime;
      console.error(`❌ [TELEGRAM] Error sending to external API after ${externalDuration}ms`);
      console.error(`❌ [TELEGRAM] Error: ${externalError.message}`);
      if (externalError.response) {
        console.error(`❌ [TELEGRAM] External API response status: ${externalError.response.status}`);
        console.error(`❌ [TELEGRAM] External API response data:`, JSON.stringify(externalError.response.data, null, 2));
      }
      results.externalApi.error = externalError.message;
    }

    // Return combined results
    const totalDuration = Date.now() - startTime;
    const telegramSuccess = results.telegram.success;
    const externalSuccess = results.externalApi.success;
    
    console.log(`\n📱 [TELEGRAM] Summary (${totalDuration}ms total):`);
    console.log(`📱 [TELEGRAM] Telegram: ${telegramSuccess ? '✅ Success' : '❌ Failed'}`);
    console.log(`📱 [TELEGRAM] External API: ${externalSuccess ? '✅ Success' : '❌ Failed'}`);
    
    if (telegramSuccess && externalSuccess) {
      console.log(`✅ [TELEGRAM] Both services succeeded`);
      res.json({ 
        success: true, 
        message: 'Article sent to Telegram and external API successfully',
        telegram: results.telegram,
        externalApi: results.externalApi
      });
    } else if (telegramSuccess) {
      console.log(`⚠️  [TELEGRAM] Telegram succeeded, external API failed`);
      res.json({ 
        success: true, 
        message: 'Article sent to Telegram successfully, but failed to send to external API',
        telegram: results.telegram,
        externalApi: results.externalApi
      });
    } else if (externalSuccess) {
      console.log(`⚠️  [TELEGRAM] External API succeeded, Telegram failed`);
      res.json({ 
        success: false, 
        error: results.telegram.error || 'Failed to send to Telegram',
        message: 'Article sent to external API successfully, but failed to send to Telegram',
        telegram: results.telegram,
        externalApi: results.externalApi
      });
    } else {
      console.log(`❌ [TELEGRAM] Both services failed`);
      const errorMsg = results.telegram.error || results.externalApi.error || 'Failed to send to both Telegram and external API';
      res.status(500).json({ 
        success: false, 
        error: errorMsg,
        message: 'Failed to send to both Telegram and external API',
        telegram: results.telegram,
        externalApi: results.externalApi
      });
    }
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    console.error(`❌ [TELEGRAM] Unexpected error after ${totalDuration}ms:`, error);
    console.error(`❌ [TELEGRAM] Error stack:`, error.stack);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to send article to Telegram',
      details: error.message
    });
  }
});

// Get the most recent last_checked timestamp from all sources
app.get('/api/monitor/last-checked', async (req, res) => {
  try {
    // Use queryWithRetry to handle connection timeouts
    const result = await database.queryWithRetry(
      'SELECT MAX(last_checked) as last_checked FROM sources WHERE last_checked IS NOT NULL',
      [],
      2 // Only 2 retries for this non-critical query
    );
    
    const lastChecked = result.rows[0]?.last_checked || null;
    res.json({ last_checked: lastChecked });
  } catch (error) {
    // Don't log timeout errors as errors - they're expected with connection poolers
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET' || error.message.includes('timeout')) {
      console.log(`ℹ️  [API] Database timeout fetching last checked time (expected with poolers)`);
      // Return null instead of error - frontend can handle this gracefully
      res.json({ last_checked: null });
    } else {
      console.error('Error fetching last checked time:', error.message);
      res.status(500).json({ error: 'Failed to fetch last checked time' });
    }
  }
});

// Manual trigger for feed monitoring (for "Check Now" button)
app.post('/api/monitor/trigger', async (req, res) => {
  const startTime = Date.now();
  console.log(`\n🔔 [TRIGGER] Manual feed check triggered at ${new Date().toISOString()}`);
  
    try {
      // Pass allowManual=true to bypass monitoring check
      const results = await feedMonitor.checkAllFeeds(true);
      const duration = Date.now() - startTime;
      
      // Handle cancelled operation
      if (results && results.cancelled) {
        console.log(`🛑 [TRIGGER] Manual feed check was cancelled after ${duration}ms`);
        return res.json({
          success: true,
          cancelled: true,
          message: results.message,
          summary: {
            processedSources: results.processedSources,
            totalSources: results.totalSources,
            cancelled: true,
            duration: `${duration}ms`
          },
          results: results.results || []
        });
      }
      
      const summary = {
        totalSources: results.length,
        successfulSources: results.filter(r => r.success).length,
        failedSources: results.filter(r => !r.success).length,
        totalNewArticles: results.reduce((sum, r) => sum + (r.newArticles || 0), 0),
        duration: `${duration}ms`,
        results: results
      };
      
      console.log(`✅ [TRIGGER] Manual feed check completed in ${duration}ms`);
      console.log(`📊 [TRIGGER] Summary: ${summary.successfulSources}/${summary.totalSources} sources successful, ${summary.totalNewArticles} new articles`);
      
      res.json({ 
        success: true,
        message: 'Feed check completed successfully', 
        summary: summary,
        results: results
      });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ [TRIGGER] Error during manual feed check (${duration}ms):`, error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to check feeds',
      message: error.message,
      duration: `${duration}ms`
    });
  }
});

// Cancel the current "Check Now" operation
app.post('/api/monitor/cancel', async (req, res) => {
  console.log(`\n🛑 [CANCEL] Cancel request received at ${new Date().toISOString()}`);
  
  try {
    const result = feedMonitor.cancelCheckNow();
    
    if (result.success) {
      console.log(`✅ [CANCEL] Cancellation request accepted`);
      res.json({
        success: true,
        message: result.message
      });
    } else {
      console.log(`ℹ️  [CANCEL] ${result.message}`);
      res.json({
        success: false,
        message: result.message
      });
    }
  } catch (error) {
    console.error(`❌ [CANCEL] Error processing cancel request:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel operation',
      message: error.message
    });
  }
});

// Get status of current "Check Now" operation
app.get('/api/monitor/status', async (req, res) => {
  try {
    const operation = feedMonitor.currentCheckOperation;
    
    if (operation) {
      res.json({
        inProgress: true,
        processedSources: operation.processedSources,
        totalSources: operation.totalSources,
        startTime: operation.startTime,
        elapsedMs: Date.now() - operation.startTime
      });
    } else {
      res.json({
        inProgress: false
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get status',
      message: error.message
    });
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
    
    console.log(`📊 Found ${articles.length} articles with pub_date from last ${days} days (articles without dates are excluded)`);
    
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
    const limit = parseInt(req.query.limit) || 200;
    const monitoringType = req.query.type; // 'SCRAPING' or 'RSS'
    
    const articles = monitoringType 
      ? await database.getArticlesByMonitoringType(monitoringType, limit)
      : await database.getAllArticles(limit);
    
    // Format articles for display
    const formattedArticles = articles.map(article => ({
      id: article.id,
      title: article.title,
      link: article.link,
      pub_date: article.pub_date,
      created_at: article.created_at,
      source_name: article.source_name || 'Unknown',
      source_url: article.source_url,
      monitoring_type: article.monitoring_type || 'RSS',
      category: article.category,
      status: article.status,
      has_content: !!(article.content && article.content.length > 0),
      content_length: article.content ? article.content.length : 0,
      preview_length: article.preview ? article.preview.length : 0,
      has_pub_date: !!article.pub_date,
      days_ago: article.pub_date ? Math.floor((new Date() - new Date(article.pub_date)) / (1000 * 60 * 60 * 24)) : null
    }));
    
    // Count articles with/without pub_date
    const withDates = formattedArticles.filter(a => a.has_pub_date).length;
    const withoutDates = formattedArticles.length - withDates;
    
    // Group by source
    const bySource = {};
    formattedArticles.forEach(article => {
      const sourceName = article.source_name || 'Unknown';
      if (!bySource[sourceName]) {
        bySource[sourceName] = {
          name: sourceName,
          url: article.source_url,
          type: article.monitoring_type,
          count: 0,
          with_dates: 0,
          without_dates: 0
        };
      }
      bySource[sourceName].count++;
      if (article.has_pub_date) {
        bySource[sourceName].with_dates++;
      } else {
        bySource[sourceName].without_dates++;
      }
    });
    
    res.json({
      total: formattedArticles.length,
      with_pub_date: withDates,
      without_pub_date: withoutDates,
      filtered_by_type: monitoringType || 'all',
      by_source: Object.values(bySource),
      articles: formattedArticles
    });
  } catch (error) {
    console.error('Error fetching all articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// Re-scrape a source and update existing articles with improved titles/dates
app.post('/api/sources/:id/re-scrape', async (req, res) => {
  const { id } = req.params;
  const source = await database.getSourceById(parseInt(id));
  
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }
  
  if (source.monitoring_type !== 'SCRAPING') {
    return res.status(400).json({ error: 'Re-scraping is only available for scraping sources' });
  }
  
  console.log(`\n🔄 [Re-scrape] Starting re-scrape for source: ${source.name} (${source.url})`);
  
  // CRITICAL: Close feedMonitor's browser BEFORE setting lock to free memory
  if (feedMonitor.webScraper && feedMonitor.webScraper.browser) {
    console.log('🔒 [Re-scrape] Closing feedMonitor browser before re-scrape...');
    await feedMonitor.webScraper.close();
  }
  
  // Set lock to prevent automatic feed monitoring from running during re-scrape
  feedMonitor.isScrapingInProgress = true;
  console.log('🔒 [Re-scrape] Pausing automatic feed monitoring during re-scrape');
  
  try {
      // Extract articles using ADK (AI-powered extraction) - faster and more consistent
      const articles = await adkScraper.scrapeArticles(source);
      
      // MEMORY FIX: Clean up both scrapers to free memory
      await webScraper.close();
      await adkScraper.close();
      
      console.log(`📰 [Re-scrape] Found ${articles.length} articles from listing page, checking for existing ones to update...`);
      if (articles.length > 0) {
        articles.forEach((article, i) => {
          console.log(`   ${i + 1}. "${article.title.substring(0, 50)}..." (date: ${article.datePublished || 'none'})`);
        });
      }
      
      let updated = 0;
      let deleted = 0;
      let errors = 0;
      const updates = [];
      
      // CRITICAL: Get existing articles for this source from database
      // This ensures we check old bad articles even if they're no longer in current scrape
      // MEMORY OPTIMIZATION: Limit to 100 articles per source to avoid memory issues
      const allExistingArticles = await database.getArticlesBySourceId(source.id, 100);
      console.log(`📋 [Re-scrape] Checking ${allExistingArticles.length} existing articles in database for ${source.name}`);
      
      // MEMORY OPTIMIZATION: Pre-fetch duplicate title check data ONCE (not per article)
      let duplicateTitleCache = null;
      const getDuplicateTitles = async (title) => {
        if (!duplicateTitleCache) {
          // Load once, not per article
          // MEMORY OPTIMIZATION: Reduced from 1000 to 200 to prevent memory issues
          const allArticles = await database.getAllArticles(200);
          duplicateTitleCache = new Map();
          allArticles.forEach(a => {
            const key = (a.title || '').toLowerCase().trim();
            if (key) {
              if (!duplicateTitleCache.has(key)) {
                duplicateTitleCache.set(key, []);
              }
              duplicateTitleCache.get(key).push(a);
            }
          });
        }
        const key = (title || '').toLowerCase().trim();
        if (!key) return [];
        const matches = duplicateTitleCache.get(key) || [];
        return matches;
      };
      
      // First pass: Check ALL existing articles for bad titles/URLs and delete them
      console.log(`\n🔍 [Re-scrape] First pass: Checking all existing articles for bad titles/URLs...`);
      const batchSize = 3; // Reduced from 5 to save memory
      for (let i = 0; i < allExistingArticles.length; i += batchSize) {
        const batch = allExistingArticles.slice(i, i + batchSize);
        
        for (const existing of batch) {
          try {
            if (!existing.link || !existing.title) continue;
            
            // Check if this is a non-article page (should be deleted)
            try {
              const urlObj = new URL(existing.link);
              const pathname = urlObj.pathname.toLowerCase();
              const isNonArticlePage = pathname === '/search' ||
                                      pathname.startsWith('/c/') ||
                                      pathname.match(/^\/[a-z]{2}$/i) ||
                                      pathname.match(/^\/tag[s]?\/|\/category\/|\/archive\/|\/author\//i) ||
                                      pathname.includes('/search?') ||
                                      // Check for category pages like /blog/blockchain-web3
                                      pathname.match(/\/blog\/(blockchain-web3|cybersecurity|company-updates|io-intelligence|ai-infrastructure-compute|ai-startup-corner|developer-resources)/i);
              
              if (isNonArticlePage) {
                console.log(`🗑️  [Re-scrape] Deleting non-article page: ${existing.link}`);
                await database.deleteArticleByLink(existing.link);
                deleted++;
                continue;
              }
            } catch (urlError) {
              // Invalid URL, skip
            }
            
            // Check for generic titles (category pages)
            const currentTitleLower = (existing.title || '').toLowerCase().trim();
            if (currentTitleLower) {
              const isGenericTitle = currentTitleLower.length < 25 && (
                currentTitleLower === 'blockchain web3' ||
                currentTitleLower === 'cybersecurity' ||
                currentTitleLower === 'company updates' ||
                currentTitleLower === 'io intelligence' ||
                currentTitleLower === 'ai infrastructure compute' ||
                currentTitleLower === 'ai startup corner' ||
                currentTitleLower === 'developer resources'
              );
              
              if (isGenericTitle) {
                console.log(`🗑️  [Re-scrape] Deleting article with generic title: "${existing.title}" (URL: ${existing.link})`);
                await database.deleteArticleByLink(existing.link);
                deleted++;
                continue;
              }
              
              // Check for duplicate titles (same title = likely category pages)
              // Use cached duplicate check to avoid loading all articles repeatedly
              const duplicateTitles = await getDuplicateTitles(currentTitleLower);
              const otherDuplicates = duplicateTitles.filter(a => a.id !== existing.id);
              
              // If more than 2 articles share this exact title, it's likely a category page
              if (otherDuplicates.length > 2) {
                console.log(`🗑️  [Re-scrape] Deleting article with duplicate generic title (${otherDuplicates.length + 1} total): "${existing.title}" (URL: ${existing.link})`);
                await database.deleteArticleByLink(existing.link);
                deleted++;
                continue;
              }
            }
          } catch (err) {
            console.error(`❌ [Re-scrape] Error checking existing article ${existing.link}:`, err);
            errors++;
          }
        }
        
        // Small delay between batches
        if (i + batchSize < allExistingArticles.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      // Clear duplicate cache after first pass to free memory
      duplicateTitleCache = null;
      
      console.log(`✅ [Re-scrape] First pass complete: Deleted ${deleted} bad articles`);
      
      // Second pass: Process current scrape results to update/improve existing articles
      // LIMIT to 5 articles per source to save memory
      console.log(`\n🔍 [Re-scrape] Second pass: Processing current scrape results to update existing articles...`);
      const articlesToProcess = articles.slice(0, 5); // Reduced from 30 to 5
      
      for (let i = 0; i < articlesToProcess.length; i += batchSize) {
        const batch = articlesToProcess.slice(i, i + batchSize);
        
        // Process batch sequentially (not parallel) to control memory
        for (const article of batch) {
          try {
            if (!article.link || !article.title) continue;
            
            // Check if article exists
            const existing = await database.getArticleByLink(article.link);
            if (!existing) continue; // Skip new articles (they'll be added normally)
            
            // Check if this is a non-article page (should be deleted)
            try {
              const urlObj = new URL(article.link);
              const pathname = urlObj.pathname.toLowerCase();
              const isNonArticlePage = pathname === '/search' ||
                                      pathname.startsWith('/c/') || // Category pages
                                      pathname.match(/^\/[a-z]{2}$/i) || // Language codes
                                      pathname.match(/^\/tag[s]?\/|\/category\/|\/archive\/|\/author\//i) || // Tag/category/archive/author pages
                                      pathname.includes('/search?');
              
              if (isNonArticlePage) {
                console.log(`🗑️  Deleting non-article page: ${article.link}`);
                await database.deleteArticleByLink(article.link);
                deleted++;
                continue;
              }
            } catch (urlError) {
              // Invalid URL, skip
            }
            
            // Check for duplicate titles (same title = likely category pages)
            const currentTitleLower = (existing.title || '').toLowerCase().trim();
            if (currentTitleLower) {
              // Check if this title appears on multiple articles (likely a category page)
              // Use cached duplicate check to avoid loading all articles repeatedly
              const duplicateTitles = await getDuplicateTitles(currentTitleLower);
              const otherDuplicates = duplicateTitles.filter(a => a.id !== existing.id);
              
              // If more than 2 articles share this exact title, it's likely a category page
              if (otherDuplicates.length > 2) {
                console.log(`🗑️  [Re-scrape] Deleting article with duplicate generic title (${otherDuplicates.length + 1} total): "${existing.title}" (URL: ${article.link})`);
                await database.deleteArticleByLink(article.link);
                deleted++;
                continue;
              }
            }
            
            // CRITICAL: Fetch metadata from article page for better title/date
            // This is what makes re-scrape actually improve the data
            let improvedTitle = article.title.trim();
            let improvedDate = article.datePublished ? new Date(article.datePublished) : null;
            let shouldDelete = false;
            
              try {
                console.log(`🔍 [Re-scrape] Fetching article page metadata for: ${article.link.substring(0, 60)}...`);
                const metadata = await feedMonitor.extractArticleMetadata(article.link);
                
                // MEMORY OPTIMIZATION: Small delay after each metadata fetch to allow browser cleanup
                await new Promise(resolve => setTimeout(resolve, 500));
              
              // Use article page title if available and better
              if (metadata.title && metadata.title.trim().length > 10) {
                const newTitle = metadata.title.trim();
                const newTitleLower = newTitle.toLowerCase();
                const isGeneric = newTitleLower.includes('blog') ||
                                 newTitleLower.includes('all posts') ||
                                 newTitleLower.includes('latest by topic') ||
                                 newTitleLower.includes('mothership') ||
                                 newTitleLower.includes('backbone of ai infrastructure') ||
                                 (newTitle.length < 25 && (
                                   newTitleLower === 'blockchain web3' ||
                                   newTitleLower === 'cybersecurity' ||
                                   newTitleLower === 'company updates' ||
                                   newTitleLower === 'io intelligence' ||
                                   newTitleLower === 'ai infrastructure compute' ||
                                   newTitleLower === 'ai startup corner' ||
                                   newTitleLower === 'developer resources' ||
                                   (newTitleLower.includes('swarm community call') && newTitleLower.includes('recap'))
                                 ));
                
                if (!isGeneric) {
                  improvedTitle = newTitle;
                  console.log(`📝 [Re-scrape] Found better title: "${improvedTitle.substring(0, 60)}..." (was: "${existing.title?.substring(0, 60)}...")`);
                } else {
                  // If we can't get a good title from article page, mark for deletion
                  console.log(`⚠️  [Re-scrape] Article page also has generic title, marking for deletion: ${article.link}`);
                  shouldDelete = true;
                }
              } else {
                // No title found on article page, check if current title is generic
                const currentTitleLower = existing.title?.toLowerCase() || '';
                const isCurrentGeneric = currentTitleLower.length < 25 && (
                  currentTitleLower === 'blockchain web3' ||
                  currentTitleLower === 'cybersecurity' ||
                  currentTitleLower === 'company updates' ||
                  currentTitleLower === 'io intelligence' ||
                  currentTitleLower === 'ai infrastructure compute' ||
                  currentTitleLower === 'ai startup corner' ||
                  currentTitleLower === 'developer resources' ||
                  (currentTitleLower.includes('swarm community call') && currentTitleLower.includes('recap'))
                );
                
                if (isCurrentGeneric) {
                  console.log(`🗑️  [Re-scrape] Deleting article with generic title that can't be fixed: ${article.link}`);
                  shouldDelete = true;
                } else {
                  console.log(`⚠️  [Re-scrape] No title found on article page, keeping existing: "${existing.title?.substring(0, 60)}..."`);
                }
              }
              
              // Use article page date if available
              if (metadata.pubDate) {
                try {
                  const articlePageDate = new Date(metadata.pubDate);
                  if (!isNaN(articlePageDate.getTime())) {
                    improvedDate = articlePageDate;
                    console.log(`📅 [Re-scrape] Found date from article page: ${improvedDate.toISOString()} (was: ${existing.pub_date || 'none'})`);
                  } else {
                    console.log(`⚠️  [Re-scrape] Invalid date format: ${metadata.pubDate}`);
                  }
                } catch (e) {
                  console.log(`⚠️  [Re-scrape] Date parsing error: ${e.message}`);
                }
              } else {
                console.log(`⚠️  [Re-scrape] No date found on article page (current: ${existing.pub_date || 'none'})`);
              }
              
              // Check if content is too short (likely not a real article)
              if (metadata.content && metadata.content.length < 100 && !improvedDate) {
                console.log(`⚠️  [Re-scrape] Article has very short content (${metadata.content.length} chars) and no date: ${article.link}`);
                // Don't delete yet - might be a real article with minimal content
              }
            } catch (metadataError) {
              // If fetching metadata fails, check if current article is clearly bad
              const currentTitleLower = (existing.title || '').toLowerCase();
              const isBadTitle = currentTitleLower.length < 25 && (
                currentTitleLower === 'blockchain web3' ||
                currentTitleLower === 'cybersecurity' ||
                currentTitleLower === 'company updates' ||
                currentTitleLower === 'io intelligence' ||
                currentTitleLower === 'ai infrastructure compute' ||
                currentTitleLower === 'ai startup corner' ||
                currentTitleLower === 'developer resources' ||
                (currentTitleLower.includes('swarm community call') && currentTitleLower.includes('recap'))
              );
              
              // Also check if URL suggests it's a non-article page
              const urlSuggestsNonArticle = article.link.includes('/search') ||
                                           article.link.includes('/c/') ||
                                           article.link.match(/\/tag[s]?\/|\/category\/|\/archive\/|\/author\//i);
              
              if (isBadTitle || urlSuggestsNonArticle) {
                console.log(`🗑️  [Re-scrape] Deleting bad article (can't fetch metadata): ${article.link} (error: ${metadataError.message})`);
                shouldDelete = true;
              } else {
                console.log(`⚠️  [Re-scrape] Could not fetch article page metadata: ${metadataError.message}`);
              }
            }
            
            // Delete bad articles
            if (shouldDelete) {
              await database.deleteArticleByLink(article.link);
              deleted++;
              continue;
            }
            
            // Prepare updates
            const updatesToApply = {};
            let hasUpdates = false;
            
            // Update title if new one is better (longer, not generic)
            const currentTitle = existing.title || '';
            const isGeneric = improvedTitle.toLowerCase().includes('latest by topic') ||
                             improvedTitle.toLowerCase().includes('mothership of ai') ||
                             improvedTitle.toLowerCase().includes('backbone of ai infrastructure') ||
                             (improvedTitle.length < 25 && (
                               improvedTitle.toLowerCase() === 'blockchain web3' ||
                               improvedTitle.toLowerCase() === 'cybersecurity' ||
                               improvedTitle.toLowerCase() === 'company updates' ||
                               improvedTitle.toLowerCase() === 'io intelligence' ||
                               improvedTitle.toLowerCase() === 'ai infrastructure compute' ||
                               improvedTitle.toLowerCase() === 'ai startup corner' ||
                               improvedTitle.toLowerCase() === 'developer resources' ||
                               (improvedTitle.toLowerCase().includes('swarm community call') && improvedTitle.toLowerCase().includes('recap'))
                             ));
            
            if (improvedTitle && 
                improvedTitle.length > 10 && 
                !isGeneric &&
                (improvedTitle !== currentTitle) &&
                (improvedTitle.length > currentTitle.length || currentTitle.length < 20)) {
              updatesToApply.title = improvedTitle;
              hasUpdates = true;
            }
            
            // Update date if we found one and existing doesn't have one
            if (improvedDate && !existing.pub_date) {
              try {
                if (!isNaN(improvedDate.getTime())) {
                  updatesToApply.pub_date = improvedDate.toISOString();
                  hasUpdates = true;
                }
              } catch (e) {
                // Invalid date, skip
              }
            }
            
            // Apply updates if any
            if (hasUpdates) {
              await database.updateArticleByLink(article.link, updatesToApply);
              updated++;
              updates.push({
                link: article.link,
                title: updatesToApply.title || existing.title,
                pub_date: updatesToApply.pub_date || existing.pub_date
              });
            }
          } catch (err) {
            console.error(`Error updating article ${article.link}:`, err.message);
            errors++;
          }
        }
        
        // Small delay between batches to prevent memory spikes
        if (i + batchSize < articlesToProcess.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      console.log(`\n✅ [Re-scrape] Complete for ${source.name}: Updated ${updated} articles, deleted ${deleted} bad articles, ${errors} errors`);
      
      res.json({
        success: true,
        message: `Re-scraped ${source.name}`,
        total_articles_found: articles.length,
        articles_updated: updated,
        articles_deleted: deleted,
        errors: errors,
        updates: updates.slice(0, 20) // Return first 20 updates as examples
      });
    } catch (error) {
      console.error('Error re-scraping source:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to re-scrape source',
        details: error.message
      });
    } finally {
      // Always clear the lock, even if re-scrape fails
      feedMonitor.isScrapingInProgress = false;
      console.log('🔓 Resuming automatic feed monitoring');
    }
});

// Re-scrape all scraping sources (bulk operation)
app.post('/api/sources/re-scrape-all', async (req, res) => {
  try {
    console.log('\n🔄 [Bulk Re-scrape] Starting bulk re-scrape of all scraping sources...');
    
    // Get all scraping sources (active = not paused)
    const allSources = await database.getAllSources();
    const scrapingSources = allSources.filter(s => s.monitoring_type === 'SCRAPING' && !s.is_paused);
    
    if (scrapingSources.length === 0) {
      console.log('⚠️  [Bulk Re-scrape] No active scraping sources found');
      return res.json({
        success: true,
        message: 'No active scraping sources found',
        sources_processed: 0,
        results: []
      });
    }
    
    console.log(`📋 [Bulk Re-scrape] Found ${scrapingSources.length} active scraping sources to re-scrape`);
    scrapingSources.forEach((source, i) => {
      console.log(`   ${i + 1}. ${source.name} (${source.url})`);
    });
    
    // Set lock to prevent automatic feed monitoring
    feedMonitor.isScrapingInProgress = true;
    console.log('🔒 [Bulk Re-scrape] Pausing automatic feed monitoring during bulk re-scrape');
    
    const results = [];
    let totalUpdated = 0;
    let totalDeleted = 0;
    let totalErrors = 0;
    
    // Process sources sequentially to avoid memory issues
    for (let i = 0; i < scrapingSources.length; i++) {
      const source = scrapingSources[i];
    console.log(`\n[${i + 1}/${scrapingSources.length}] [Bulk Re-scrape] Processing: ${source.name} (${source.url})`);
    
    // CRITICAL: Close any existing browsers before starting new scrape
    if (feedMonitor.webScraper && feedMonitor.webScraper.browser) {
      console.log('🔒 [Bulk Re-scrape] Closing feedMonitor browser before scraping...');
      await feedMonitor.webScraper.close();
    }
    
    try {
      // Extract articles using ADK (AI-powered extraction) - faster and more consistent
      const articles = await adkScraper.scrapeArticles(source);
      
      // MEMORY FIX: Clean up both scrapers to free memory
      await webScraper.close();
      await adkScraper.close();
        
        let updated = 0;
        let deleted = 0;
        let errors = 0;
        
        // CRITICAL: Get existing articles for this source from database
        // This ensures we check old bad articles even if they're no longer in current scrape
        // MEMORY OPTIMIZATION: Limit to 100 articles per source to avoid memory issues
        const allExistingArticles = await database.getArticlesBySourceId(source.id, 100);
        console.log(`📋 [Bulk Re-scrape] Checking ${allExistingArticles.length} existing articles in database for ${source.name}`);
        
        // MEMORY OPTIMIZATION: Pre-fetch duplicate title check data ONCE per source (not per article)
        // This avoids loading 1000 articles into memory repeatedly
        let duplicateTitleCache = null;
        const getDuplicateTitles = async (title) => {
          if (!duplicateTitleCache) {
            // Load once per source, not per article
            // MEMORY OPTIMIZATION: Reduced from 1000 to 200 to prevent memory issues
          const allArticles = await database.getAllArticles(200);
            duplicateTitleCache = new Map();
            allArticles.forEach(a => {
              const key = (a.title || '').toLowerCase().trim();
              if (key) {
                if (!duplicateTitleCache.has(key)) {
                  duplicateTitleCache.set(key, []);
                }
                duplicateTitleCache.get(key).push(a);
              }
            });
          }
          const key = (title || '').toLowerCase().trim();
          if (!key) return [];
          const matches = duplicateTitleCache.get(key) || [];
          return matches;
        };
        
        // First pass: Check ALL existing articles for bad titles/URLs and delete them
        console.log(`\n🔍 [Bulk Re-scrape] First pass: Checking all existing articles for bad titles/URLs...`);
        const batchSize = 3; // Reduced from 5 to save memory
        for (let j = 0; j < allExistingArticles.length; j += batchSize) {
          const batch = allExistingArticles.slice(j, j + batchSize);
          
          for (const existing of batch) {
            try {
              if (!existing.link || !existing.title) continue;
              
              // Check if this is a non-article page (should be deleted)
              try {
                const urlObj = new URL(existing.link);
                const pathname = urlObj.pathname.toLowerCase();
                const isNonArticlePage = pathname === '/search' ||
                                        pathname.startsWith('/c/') ||
                                        pathname.match(/^\/[a-z]{2}$/i) ||
                                        pathname.match(/^\/tag[s]?\/|\/category\/|\/archive\/|\/author\//i) ||
                                        pathname.includes('/search?') ||
                                        // Check for category pages like /blog/blockchain-web3
                                        pathname.match(/\/blog\/(blockchain-web3|cybersecurity|company-updates|io-intelligence|ai-infrastructure-compute|ai-startup-corner|developer-resources)/i);
                
                if (isNonArticlePage) {
                  console.log(`🗑️  [Bulk Re-scrape] Deleting non-article page: ${existing.link}`);
                  await database.deleteArticleByLink(existing.link);
                  deleted++;
                  continue;
                }
              } catch (urlError) {
                // Invalid URL, skip
              }
              
              // Check for generic titles (category pages)
              const currentTitleLower = (existing.title || '').toLowerCase().trim();
              if (currentTitleLower) {
                const isGenericTitle = currentTitleLower.length < 25 && (
                  currentTitleLower === 'blockchain web3' ||
                  currentTitleLower === 'cybersecurity' ||
                  currentTitleLower === 'company updates' ||
                  currentTitleLower === 'io intelligence' ||
                  currentTitleLower === 'ai infrastructure compute' ||
                  currentTitleLower === 'ai startup corner' ||
                  currentTitleLower === 'developer resources'
                );
                
                if (isGenericTitle) {
                  console.log(`🗑️  [Bulk Re-scrape] Deleting article with generic title: "${existing.title}" (URL: ${existing.link})`);
                  await database.deleteArticleByLink(existing.link);
                  deleted++;
                  continue;
                }
                
                // Check for duplicate titles (same title = likely category pages)
                // Use cached duplicate check to avoid loading all articles repeatedly
                const duplicateTitles = await getDuplicateTitles(currentTitleLower);
                const otherDuplicates = duplicateTitles.filter(a => a.id !== existing.id);
                
                // If more than 2 articles share this exact title, it's likely a category page
                if (otherDuplicates.length > 2) {
                  console.log(`🗑️  [Bulk Re-scrape] Deleting article with duplicate generic title (${otherDuplicates.length + 1} total): "${existing.title}" (URL: ${existing.link})`);
                  await database.deleteArticleByLink(existing.link);
                  deleted++;
                  continue;
                }
              }
            } catch (err) {
              console.error(`❌ [Bulk Re-scrape] Error checking existing article ${existing.link}:`, err);
              errors++;
            }
          }
          
          // Small delay between batches to allow garbage collection
          if (j + batchSize < allExistingArticles.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        
        // Clear duplicate cache after first pass to free memory
        duplicateTitleCache = null;
        
        console.log(`✅ [Bulk Re-scrape] First pass complete for ${source.name}: Deleted ${deleted} bad articles`);
        
        // Second pass: Process current scrape results to update/improve existing articles
        // LIMIT to 5 articles per source to save memory
        console.log(`\n🔍 [Bulk Re-scrape] Second pass: Processing current scrape results to update existing articles...`);
        const articlesToProcess = articles.slice(0, 5); // Reduced from 10 to 5
        
        for (let j = 0; j < articlesToProcess.length; j += batchSize) {
          const batch = articlesToProcess.slice(j, j + batchSize);
          
          for (const article of batch) {
            try {
              if (!article.link || !article.title) continue;
              
              const existing = await database.getArticleByLink(article.link);
              if (!existing) continue;
              
              // Check if this is a non-article page (should be deleted)
              try {
                const urlObj = new URL(article.link);
                const pathname = urlObj.pathname.toLowerCase();
                const isNonArticlePage = pathname === '/search' ||
                                        pathname.startsWith('/c/') ||
                                        pathname.match(/^\/[a-z]{2}$/i) ||
                                        pathname.match(/^\/tag[s]?\/|\/category\/|\/archive\/|\/author\//i) ||
                                        pathname.includes('/search?');
                
                if (isNonArticlePage) {
                  console.log(`🗑️  Deleting non-article page: ${article.link}`);
                  await database.deleteArticleByLink(article.link);
                  deleted++;
                  continue;
                }
              } catch (urlError) {
                // Invalid URL, skip
              }
              
              // Check for duplicate titles (same title = likely category pages)
              const currentTitleLower = (existing.title || '').toLowerCase().trim();
              if (currentTitleLower) {
                // MEMORY OPTIMIZATION: Reduced from 1000 to 200 to prevent memory issues
          const allArticles = await database.getAllArticles(200);
                const duplicateTitles = allArticles.filter(a => 
                  a.id !== existing.id && 
                  a.title && 
                  a.title.toLowerCase().trim() === currentTitleLower
                );
                
                if (duplicateTitles.length > 2) {
                  console.log(`🗑️  Deleting article with duplicate generic title (${duplicateTitles.length + 1} total): "${existing.title}"`);
                  await database.deleteArticleByLink(article.link);
                  deleted++;
                  continue;
                }
              }
              
              // CRITICAL: Fetch metadata from article page for better title/date
              let improvedTitle = article.title.trim();
              let improvedDate = article.datePublished ? new Date(article.datePublished) : null;
              let shouldDelete = false;
              
              try {
                const metadata = await feedMonitor.extractArticleMetadata(article.link);
                
                // MEMORY OPTIMIZATION: Small delay after each metadata fetch to allow browser cleanup
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Use article page title if available and better
                if (metadata.title && metadata.title.trim().length > 10) {
                  const newTitle = metadata.title.trim();
                  const newTitleLower = newTitle.toLowerCase();
                  const isGeneric = newTitleLower.includes('blog') ||
                                   newTitleLower.includes('all posts') ||
                                   newTitleLower.includes('latest by topic') ||
                                   (newTitle.length < 25 && (
                                     newTitleLower === 'blockchain web3' ||
                                     newTitleLower === 'cybersecurity' ||
                                     newTitleLower === 'company updates' ||
                                     newTitleLower === 'io intelligence' ||
                                     newTitleLower === 'ai infrastructure compute' ||
                                     newTitleLower === 'ai startup corner' ||
                                     newTitleLower === 'developer resources' ||
                                     (newTitleLower.includes('swarm community call') && newTitleLower.includes('recap'))
                                   ));
                  
                  if (!isGeneric) {
                    improvedTitle = newTitle;
                  } else {
                    // Can't get good title, mark for deletion
                    shouldDelete = true;
                  }
                } else {
                  // Check if current title is generic
                  const currentTitleLower = (existing.title || '').toLowerCase();
                  const isCurrentGeneric = currentTitleLower.length < 25 && (
                    currentTitleLower === 'blockchain web3' ||
                    currentTitleLower === 'cybersecurity' ||
                    currentTitleLower === 'company updates' ||
                    currentTitleLower === 'io intelligence' ||
                    currentTitleLower === 'ai infrastructure compute' ||
                    currentTitleLower === 'ai startup corner' ||
                    currentTitleLower === 'developer resources' ||
                    (currentTitleLower.includes('swarm community call') && currentTitleLower.includes('recap'))
                  );
                  
                  if (isCurrentGeneric) {
                    shouldDelete = true;
                  }
                }
                
                // Use article page date if available
                if (metadata.pubDate) {
                  try {
                    const articlePageDate = new Date(metadata.pubDate);
                    if (!isNaN(articlePageDate.getTime())) {
                      improvedDate = articlePageDate;
                    }
                  } catch (e) {
                    // Invalid date, skip
                  }
                }
              } catch (metadataError) {
                // If fetching fails, check if current article is clearly bad
                const currentTitleLower = (existing.title || '').toLowerCase();
                const isBadTitle = currentTitleLower.length < 25 && (
                  currentTitleLower === 'blockchain web3' ||
                  currentTitleLower === 'cybersecurity' ||
                  currentTitleLower === 'company updates' ||
                  currentTitleLower === 'io intelligence' ||
                  currentTitleLower === 'ai infrastructure compute' ||
                  currentTitleLower === 'ai startup corner' ||
                  currentTitleLower === 'developer resources' ||
                  (currentTitleLower.includes('swarm community call') && currentTitleLower.includes('recap'))
                );
                
                const urlSuggestsNonArticle = article.link.includes('/search') ||
                                             article.link.includes('/c/') ||
                                             article.link.match(/\/tag[s]?\/|\/category\/|\/archive\/|\/author\//i);
                
                if (isBadTitle || urlSuggestsNonArticle) {
                  shouldDelete = true;
                }
              }
              
              // Delete bad articles
              if (shouldDelete) {
                await database.deleteArticleByLink(article.link);
                deleted++;
                continue;
              }
              
              const updatesToApply = {};
              let hasUpdates = false;
              
              // Update title if better
              const currentTitle = existing.title || '';
              const isGeneric = improvedTitle.toLowerCase().includes('latest by topic') ||
                               improvedTitle.toLowerCase().includes('mothership of ai') ||
                               improvedTitle.toLowerCase().includes('backbone of ai infrastructure') ||
                               (improvedTitle.length < 25 && (
                                 improvedTitle.toLowerCase() === 'blockchain web3' ||
                                 improvedTitle.toLowerCase() === 'cybersecurity' ||
                                 improvedTitle.toLowerCase() === 'company updates'
                               ));
              
              if (improvedTitle && 
                  improvedTitle.length > 10 && 
                  !isGeneric &&
                  (improvedTitle !== currentTitle) &&
                  (improvedTitle.length > currentTitle.length || currentTitle.length < 20)) {
                updatesToApply.title = improvedTitle;
                hasUpdates = true;
              }
              
              // Update date if missing
              if (improvedDate && !existing.pub_date) {
                try {
                  if (!isNaN(improvedDate.getTime())) {
                    updatesToApply.pub_date = improvedDate.toISOString();
                    hasUpdates = true;
                  }
                } catch (e) {
                  // Invalid date, skip
                }
              }
              
              if (hasUpdates) {
                await database.updateArticleByLink(article.link, updatesToApply);
                updated++;
              }
            } catch (err) {
              errors++;
            }
          }
          
          // Small delay between batches
          if (j + batchSize < Math.min(articles.length, 10)) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        
        totalUpdated += updated;
        totalDeleted += deleted;
        totalErrors += errors;
        
        results.push({
          source_id: source.id,
          source_name: source.name,
          articles_found: articles.length,
          articles_updated: updated,
          articles_deleted: deleted,
          errors: errors,
          success: true
        });
        
        console.log(`✅ [Bulk Re-scrape] [${source.name}] Complete: Updated ${updated} articles, deleted ${deleted} bad articles, ${errors} errors`);
        
        // CRITICAL: Force garbage collection between sources by adding a longer delay
        // This allows Node.js to clean up memory (Playwright, articles, etc.) before processing next source
        if (i < scrapingSources.length - 1) {
          console.log(`⏸️  [Bulk Re-scrape] Pausing 3 seconds before next source to allow memory cleanup...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        console.error(`❌ Error re-scraping ${source.name}:`, error.message);
        totalErrors++;
        results.push({
          source_id: source.id,
          source_name: source.name,
          success: false,
          error: error.message
        });
      }
    }
    
    console.log(`\n✅ Bulk re-scrape complete: ${totalUpdated} articles updated, ${totalDeleted} bad articles deleted, ${totalErrors} errors`);
    
    res.json({
      success: true,
      message: `Re-scraped ${scrapingSources.length} sources`,
      sources_processed: scrapingSources.length,
      total_articles_updated: totalUpdated,
      total_articles_deleted: totalDeleted,
      total_errors: totalErrors,
      results: results
    });
  } catch (error) {
    console.error('Error in bulk re-scrape:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to re-scrape sources',
      details: error.message
    });
  } finally {
    feedMonitor.isScrapingInProgress = false;
    console.log('🔓 Resuming automatic feed monitoring');
  }
});

// Get scraping status for a source (for verification)
app.get('/api/sources/:id/scraping-status', async (req, res) => {
  try {
    const { id } = req.params;
    const source = await database.getSourceById(parseInt(id));
    
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    
    // Get recent articles from this source
    const recentArticles = await database.pool.query(`
      SELECT id, title, link, pub_date, created_at, status
      FROM articles
      WHERE source_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [id]);
    
    // Parse scraping result if available
    let scrapingResult = null;
    if (source.last_scraping_result) {
      try {
        scrapingResult = typeof source.last_scraping_result === 'string' 
          ? JSON.parse(source.last_scraping_result)
          : source.last_scraping_result;
      } catch (e) {
        // Invalid JSON, ignore
      }
    }
    
    res.json({
      source: {
        id: source.id,
        name: source.name,
        url: source.url,
        monitoring_type: source.monitoring_type,
        last_checked: source.last_checked,
        is_paused: source.is_paused
      },
      scraping_result: scrapingResult,
      recent_articles: recentArticles.rows.map(a => ({
        id: a.id,
        title: a.title,
        link: a.link,
        pub_date: a.pub_date,
        created_at: a.created_at,
        status: a.status,
        has_pub_date: !!a.pub_date
      }))
    });
  } catch (error) {
    console.error('Error fetching scraping status:', error);
    res.status(500).json({ error: 'Failed to fetch scraping status' });
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

// Maintenance: Clean up old articles to prevent database bloat
app.post('/api/maintenance/cleanup-old-articles', async (req, res) => {
  try {
    const daysOld = parseInt(req.body.daysOld) || 90; // Default: 90 days
    const deletedCount = await database.cleanupOldArticles(daysOld);
    res.json({ 
      success: true, 
      message: `Cleaned up ${deletedCount} old articles (older than ${daysOld} days)`,
      deletedCount 
    });
  } catch (error) {
    console.error('Error cleaning up old articles:', error);
    res.status(500).json({ success: false, error: 'Failed to clean up old articles' });
  }
});

// Maintenance: List junk/placeholder articles (preview only)
app.get('/api/maintenance/junk-articles', async (req, res) => {
  try {
    if (typeof database.getJunkArticles !== 'function') {
      return res.status(501).json({ success: false, error: 'getJunkArticles not available (Postgres only)' });
    }
    const articles = await database.getJunkArticles();
    res.json({ success: true, count: articles.length, articles });
  } catch (error) {
    console.error('Error listing junk articles:', error);
    res.status(500).json({ success: false, error: 'Failed to list junk articles' });
  }
});

// Maintenance: Delete junk/placeholder articles (placeholder URLs, "No results found", "FeaturedArticles", etc.)
app.post('/api/maintenance/cleanup-junk-articles', async (req, res) => {
  try {
    if (typeof database.cleanupJunkArticles !== 'function') {
      return res.status(501).json({ success: false, error: 'cleanupJunkArticles not available (Postgres only)' });
    }
    const deletedCount = await database.cleanupJunkArticles();
    res.json({ 
      success: true, 
      message: `Removed ${deletedCount} junk/placeholder articles`,
      deletedCount 
    });
  } catch (error) {
    console.error('Error cleaning up junk articles:', error);
    res.status(500).json({ success: false, error: 'Failed to clean up junk articles' });
  }
});

// Maintenance: Get database statistics
app.get('/api/maintenance/database-stats', async (req, res) => {
  try {
    const stats = await database.getDatabaseStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error getting database stats:', error);
    res.status(500).json({ success: false, error: 'Failed to get database stats' });
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

// ADK Web UI - Test agent with custom prompt
app.post('/api/adk/test', async (req, res) => {
  try {
    const { url, customInstruction } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Initialize ADK scraper
    if (!adkScraper.initialized) {
      await adkScraper.initialize();
    }

    if (!adkScraper.agent || !adkScraper.runner) {
      return res.status(500).json({ error: 'ADK agent not initialized. Check GOOGLE_API_KEY environment variable.' });
    }

    // Create a test source
    const testSource = {
      url: url,
      name: 'Test Source',
      category: 'Test'
    };

    // If custom instruction provided, create a temporary agent with it
    const originalAgent = adkScraper.agent;
    let testRunner = adkScraper.runner;
    
    // Default instruction matches adkScraper.js - conversational, natural language
    const defaultInstruction = `You are a research assistant that helps find recent blog posts and articles from websites.

When asked about a website, search Google for their latest blog posts or news articles.

Output format: Return a JSON array of articles. Each article should have:
- title: article headline
- url: direct link to the article (must be the actual article URL, not a redirect)
- description: brief summary
- datePublished: date in YYYY-MM-DD format, or null

Return valid JSON only. If you can't find articles, return [].`;
    
    // Use custom instruction if provided, otherwise use default
    const agentInstruction = customInstruction || defaultInstruction;
    
    try {
      const adk = await import('@google/adk');
      const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      
      // Create a test agent - always create fresh to use the instruction
      const llm = new adk.Gemini({
        model: adkScraper.modelName || 'gemini-2.0-flash',  // Fixed: use GA model, not deprecated -exp
        apiKey: apiKey
      });
      
      const testAgent = new adk.LlmAgent({
        name: 'article_finder_test',
        model: llm,
        description: 'Agent that finds recent blog posts and articles from websites using Google Search.',
        instruction: agentInstruction,
        tools: [adk.GOOGLE_SEARCH]
      });
      
      testRunner = new adk.InMemoryRunner({
        agent: testAgent,
        appName: 'distroblog-test'
      });
    } catch (error) {
      return res.status(500).json({ error: `Failed to create test agent: ${error.message}` });
    }

    // Capture detailed debug info
    const debugInfo = {
      events: [],
      functionCalls: [],
      functionResponses: [],
      rawResponse: '',
      articles: [],
      errors: [],
      metrics: {
        eventCount: 0,
        functionCallCount: 0,
        functionResponseCount: 0,
        startTime: Date.now(),
        endTime: null,
        duration: null
      }
    };

    try {
      // Create a session
      const session = await testRunner.sessionService.createSession({
        appName: 'distroblog-test',
        userId: 'test-user',
        state: {}
      });

      const domain = new URL(url).hostname;
      const baseDomain = domain.replace(/^www\./, '');
      
      // Calculate date cutoff (7 days ago) - same as adkScraper.js
      const today = new Date();
      const cutoffDate = new Date(today);
      cutoffDate.setDate(cutoffDate.getDate() - 7);
      const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
      const todayStr = today.toISOString().split('T')[0];
      
      // Use natural, conversational prompt - matches improved adkScraper.js style
      const searchQuery = `Find the most recent blog posts or articles from the ${baseDomain} website.

I'm looking for articles published in the last week (after ${cutoffDateStr}). Today is ${todayStr}.

Please search and return up to 3 recent articles as a JSON array with these fields:
- title: the headline
- url: the direct link to the article on ${baseDomain}
- description: a short summary  
- datePublished: the publication date (YYYY-MM-DD format), or null if not visible

Important: I need the actual article URLs from ${baseDomain}, not Google redirect links.

Return only the JSON array, no other text.`;

      // Run the agent and capture all events
      let fullResponse = '';
      let articles = [];
      
      for await (const event of testRunner.runAsync({
        userId: session.userId,
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [{ text: searchQuery }]
        },
        runConfig: {
          maxLlmCalls: 5
        }
      })) {
        debugInfo.metrics.eventCount++;
        
        // Capture event details
        const eventInfo = {
          eventNumber: debugInfo.metrics.eventCount,
          author: event.author,
          partial: event.partial || false,
          hasContent: !!event.content,
          contentRole: event.content?.role,
          partsCount: event.content?.parts?.length || 0,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage
        };
        
        // Check for errors
        if (event.errorCode || event.errorMessage) {
          debugInfo.errors.push({
            code: event.errorCode,
            message: event.errorMessage,
            eventNumber: debugInfo.metrics.eventCount
          });
        }
        
        // Extract function calls and responses
        if (event.content && event.content.parts) {
          for (const part of event.content.parts) {
            if (part.functionCall) {
              debugInfo.metrics.functionCallCount++;
              debugInfo.functionCalls.push({
                eventNumber: debugInfo.metrics.eventCount,
                name: part.functionCall.name,
                args: part.functionCall.args
              });
            }
            
            if (part.functionResponse) {
              debugInfo.metrics.functionResponseCount++;
              debugInfo.functionResponses.push({
                eventNumber: debugInfo.metrics.eventCount,
                name: part.functionResponse.name,
                response: typeof part.functionResponse.response === 'string' 
                  ? part.functionResponse.response.substring(0, 1000) 
                  : JSON.stringify(part.functionResponse.response).substring(0, 1000)
              });
            }
            
            if (part.text) {
              fullResponse += part.text + '\n';
            }
          }
        }
        
        debugInfo.events.push(eventInfo);
      }

      debugInfo.rawResponse = fullResponse;
      debugInfo.metrics.endTime = Date.now();
      debugInfo.metrics.duration = debugInfo.metrics.endTime - debugInfo.metrics.startTime;

      // Try to parse articles from response
      try {
        let text = fullResponse.trim();
        if (text.includes('```json')) {
          text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        } else if (text.includes('```')) {
          text = text.replace(/```\n?/g, '').trim();
        }
        
        text = text.replace(/[\x00-\x1F\x7F]/g, '');
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            articles = parsed;
          }
        }
      } catch (e) {
        // Couldn't parse JSON, that's okay
      }

      debugInfo.articles = articles;

      res.json({
        success: true,
        url,
        model: adkScraper.modelName,
        debugInfo,
        articles,
        message: articles.length > 0 
          ? `Found ${articles.length} articles` 
          : 'No articles found in response'
      });
    } catch (error) {
      debugInfo.metrics.endTime = Date.now();
      debugInfo.metrics.duration = debugInfo.metrics.endTime - debugInfo.metrics.startTime;
      debugInfo.errors.push({
        code: error.code || 'UNKNOWN',
        message: error.message,
        stack: error.stack
      });
      
      res.status(500).json({
        success: false,
        error: error.message,
        debugInfo
      });
    }
  } catch (error) {
    console.error('Error testing ADK:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
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

// Maintenance: Enrich articles with missing dates and descriptions
// This fetches article pages to extract dates/descriptions that weren't captured during initial scraping
app.post('/api/maintenance/enrich-articles', async (req, res) => {
  try {
    const limit = parseInt(req.body.limit) || 20;
    console.log(`🔄 [API] Starting article enrichment (limit: ${limit})...`);
    
    const result = await articleEnrichment.runEnrichmentBatch(limit);
    
    res.json({ 
      success: true, 
      message: `Enriched ${result.enriched} of ${result.processed} articles`,
      ...result,
      stats: articleEnrichment.getStats()
    });
  } catch (error) {
    console.error('Error enriching articles:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Maintenance: Get articles needing enrichment
app.get('/api/maintenance/articles-needing-enrichment', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const articles = await database.getArticlesNeedingEnrichment(limit);
    
    // Count by type
    const needsDate = articles.filter(a => a.needs_date).length;
    const needsDescription = articles.filter(a => a.needs_description).length;
    
    res.json({ 
      success: true, 
      total: articles.length,
      needsDate,
      needsDescription,
      articles: articles.map(a => ({
        id: a.id,
        title: a.title.substring(0, 60),
        link: a.link,
        needsDate: a.needs_date,
        needsDescription: a.needs_description,
        source: a.source_name
      }))
    });
  } catch (error) {
    console.error('Error fetching articles needing enrichment:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Maintenance: Get enrichment stats
app.get('/api/maintenance/enrichment-stats', async (req, res) => {
  try {
    const stats = articleEnrichment.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error getting enrichment stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Maintenance: Playwright-based enrichment for JS-rendered pages
// Use this for articles where static enrichment failed (e.g., Vue/React sites)
app.post('/api/maintenance/enrich-articles-playwright', async (req, res) => {
  try {
    const { limit = 3 } = req.body; // Default to just 3 for memory safety
    console.log(`📡 [API] Playwright enrichment requested (limit: ${limit})`);
    
    // Check current memory before starting
    const currentMem = process.memoryUsage ? Math.round(process.memoryUsage().rss / 1024 / 1024) : 0;
    if (currentMem > 350) {
      return res.status(503).json({ 
        success: false, 
        error: `Memory too high (${currentMem}MB), try again later`,
        currentMemoryMB: currentMem
      });
    }
    
    const result = await articleEnrichment.runPlaywrightEnrichmentBatch(Math.min(limit, 5)); // Cap at 5 for safety
    const stats = articleEnrichment.getStats();
    
    res.json({
      success: true,
      message: `Enriched ${result.enriched} of ${result.processed} articles with Playwright`,
      ...result,
      stats,
      memoryAfterMB: process.memoryUsage ? Math.round(process.memoryUsage().rss / 1024 / 1024) : 0
    });
  } catch (error) {
    console.error('Error in Playwright enrichment:', error);
    res.status(500).json({ success: false, error: error.message });
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

// Enrich metadata (dates, titles, descriptions) for scraping articles using Playwright
app.post('/api/articles/enrich-metadata', async (req, res) => {
  const startTime = Date.now();
  const feedMonitor = require('./services/feedMonitor');
  
  // Memory monitoring helper
  const getMemoryMB = () => {
    if (process.memoryUsage) {
      const memUsage = process.memoryUsage();
      return Math.round(memUsage.rss / 1024 / 1024);
    }
    return 0;
  };
  
  const MEMORY_LIMIT_MB = 380; // Bail if memory gets too high (stay under 400MB heap limit)
  const BATCH_SIZE = 3; // Process 3 articles at a time
  const MAX_ARTICLES = parseInt(req.query.limit) || 30; // Default to 30 articles max
  
  try {
    console.log(`🔍 [ENRICH] Starting metadata enrichment for up to ${MAX_ARTICLES} articles...`);
    
    // Get articles with missing dates from scraping sources
    const articles = await database.getArticlesWithMissingDates(MAX_ARTICLES);
    
    if (articles.length === 0) {
      return res.json({
        success: true,
        message: 'No articles with missing dates found',
        processed: 0,
        enriched: 0,
        skipped: 0,
        duration: Date.now() - startTime
      });
    }
    
    console.log(`📊 [ENRICH] Found ${articles.length} articles with missing dates`);
    
    let processed = 0;
    let enriched = 0;
    let skipped = 0;
    const errors = [];
    
    // Process in batches
    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
      const batch = articles.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(articles.length / BATCH_SIZE);
      
      console.log(`\n🔄 [ENRICH] Processing batch ${batchNum}/${totalBatches} (${batch.length} articles)`);
      
      // Check memory before processing batch
      const memoryBefore = getMemoryMB();
      if (memoryBefore > MEMORY_LIMIT_MB) {
        console.log(`⚠️  [ENRICH] Memory too high (${memoryBefore}MB), stopping enrichment`);
        break;
      }
      
      // Process each article in the batch
      for (const article of batch) {
        try {
          processed++;
          console.log(`\n📄 [ENRICH] [${processed}/${articles.length}] Processing: ${article.title?.substring(0, 50)}...`);
          console.log(`   URL: ${article.link}`);
          
          // Use extractArticleMetadata which uses Playwright to get full metadata
          const metadata = await feedMonitor.extractArticleMetadata(article.link);
          
          if (!metadata) {
            console.log(`   ⚠️  No metadata extracted, skipping`);
            skipped++;
            continue;
          }
          
          // Update article with new metadata
          const updates = {};
          let hasUpdates = false;
          
          if (metadata.datePublished) {
            updates.pub_date = metadata.datePublished;
            console.log(`   ✅ Found date: ${metadata.datePublished}`);
            hasUpdates = true;
          }
          
          if (metadata.title && metadata.title.trim().length > 10) {
            updates.title = metadata.title.trim();
            console.log(`   ✅ Updated title: ${metadata.title.substring(0, 50)}...`);
            hasUpdates = true;
          }
          
          if (metadata.description && metadata.description.trim().length > 20) {
            updates.preview = metadata.description.trim().substring(0, 500);
            console.log(`   ✅ Updated preview (${updates.preview.length} chars)`);
            hasUpdates = true;
          }
          
          if (hasUpdates) {
            await database.updateArticle(article.id, updates);
            enriched++;
            console.log(`   ✨ Article enriched successfully`);
          } else {
            console.log(`   ⚠️  No useful metadata found, skipping update`);
            skipped++;
          }
          
          // Small delay between articles to allow GC
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error(`   ❌ Error processing article ${article.id}:`, error.message);
          errors.push({ articleId: article.id, title: article.title, error: error.message });
          skipped++;
        }
        
        // Check memory after each article
        const memoryAfter = getMemoryMB();
        if (memoryAfter > MEMORY_LIMIT_MB) {
          console.log(`⚠️  [ENRICH] Memory exceeded limit (${memoryAfter}MB), stopping enrichment`);
          break;
        }
      }
      
      // Delay between batches to allow garbage collection
      if (i + BATCH_SIZE < articles.length) {
        console.log(`\n⏸️  [ENRICH] Waiting 2 seconds before next batch (allowing GC)...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
          const memoryAfterGC = getMemoryMB();
          console.log(`   ♻️  Memory after GC: ${memoryAfterGC}MB`);
        }
      }
    }
    
    const duration = Date.now() - startTime;
    const finalMemory = getMemoryMB();
    
    console.log(`\n✅ [ENRICH] Enrichment completed in ${duration}ms`);
    console.log(`📊 [ENRICH] Summary: ${processed} processed, ${enriched} enriched, ${skipped} skipped`);
    console.log(`💾 [ENRICH] Final memory: ${finalMemory}MB`);
    
    res.json({
      success: true,
      message: `Enrichment completed: ${enriched} articles enriched, ${skipped} skipped`,
      processed,
      enriched,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      duration,
      finalMemory: finalMemory
    });
    
  } catch (error) {
    console.error('❌ [ENRICH] Error in metadata enrichment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to enrich metadata',
      message: error.message
    });
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
    // Start the server immediately (non-blocking) so Render knows it's ready
    // Database initialization will happen in the background
    app.listen(PORT, async () => {
      console.log(`Distro Scoopstream server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      
      // Initialize database in the background (non-blocking)
      database.init()
        .then(() => {
          console.log('Database initialized successfully');
          
          // Start feed monitoring (only if ENABLE_AUTO_MONITORING is set)
      // DISABLED BY DEFAULT to prevent memory issues on Render (512MB limit)
      // Automatic monitoring runs every 30 minutes and can cause memory spikes
      if (process.env.ENABLE_AUTO_MONITORING === 'true') {
        console.log('⚠️  Automatic feed monitoring enabled (runs every 30 minutes)');
        feedMonitor.startMonitoring();
      } else {
        console.log('ℹ️  Automatic feed monitoring disabled (use ENABLE_AUTO_MONITORING=true to enable)');
        console.log('ℹ️  Use "Check Now" button for manual feed checks');
      }
      
      // Optional: Run automatic cleanup of old articles (if enabled)
      // This helps prevent database bloat and memory issues from accumulating articles
      if (process.env.ENABLE_AUTO_CLEANUP === 'true') {
        const cleanupDays = parseInt(process.env.CLEANUP_DAYS_OLD) || 90;
        const cleanupInterval = parseInt(process.env.CLEANUP_INTERVAL_HOURS) || 24; // Default: daily
        
        console.log(`🧹 Automatic cleanup enabled: removing articles older than ${cleanupDays} days every ${cleanupInterval} hours`);
        
        // Run cleanup immediately on startup
        database.cleanupOldArticles(cleanupDays).catch(err => {
          console.error('Error in initial cleanup:', err);
        });
        
        // Then run cleanup on schedule
        setInterval(() => {
          database.cleanupOldArticles(cleanupDays).catch(err => {
            console.error('Error in scheduled cleanup:', err);
          });
        }, cleanupInterval * 60 * 60 * 1000);
      } else {
          console.log('ℹ️  Automatic cleanup disabled (use ENABLE_AUTO_CLEANUP=true to enable)');
          console.log('ℹ️  Use POST /api/maintenance/cleanup-old-articles for manual cleanup');
        }
        
        // Optional: Start automatic article enrichment (fills in missing dates/descriptions)
        // This runs periodically to enrich articles that were scraped without dates
        if (process.env.ENABLE_AUTO_ENRICHMENT === 'true') {
          const enrichmentInterval = parseInt(process.env.ENRICHMENT_INTERVAL_MINUTES) || 30;
          console.log(`📅 Automatic enrichment enabled: running every ${enrichmentInterval} minutes`);
          articleEnrichment.startPeriodicEnrichment(enrichmentInterval);
        } else {
          console.log('ℹ️  Automatic enrichment disabled (use ENABLE_AUTO_ENRICHMENT=true to enable)');
          console.log('ℹ️  Use POST /api/maintenance/enrich-articles for manual enrichment');
        }
        })
        .catch(err => {
          console.error('Database initialization failed:', err);
          // Don't exit - server can still serve static files and health checks
          // Database-dependent endpoints will handle errors gracefully
        });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = app;