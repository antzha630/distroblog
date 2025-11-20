const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const database = require('../database-postgres');
const FeedDiscovery = require('./feedDiscovery');
const WebScraper = require('./webScraper');

const parser = new Parser();

class FeedMonitor {
  constructor() {
    this.isMonitoring = false;
    this.monitoringInterval = null;
    this.feedDiscovery = new FeedDiscovery();
    this.webScraper = new WebScraper();
    this.isScrapingInProgress = false; // Lock to prevent concurrent scraping
  }

  // Detect RSS feeds from a website URL using robust discovery
  async detectRSSFeeds(url) {
    try {
      console.log(`🔍 Detecting RSS feeds for: ${url}`);
      const feedUrl = await this.feedDiscovery.discoverFeedUrl(url);
      
      if (feedUrl) {
        // Test the feed to make sure it works
        const testResult = await this.feedDiscovery.testFeed(feedUrl);
        if (testResult.success) {
          console.log(`✅ Valid feed found: ${feedUrl}`);
          return [{ url: feedUrl, type: 'RSS', status: 'valid' }];
        } else {
          console.log(`❌ Feed found but invalid: ${feedUrl} - ${testResult.error}`);
          
          // Provide more specific error messages
          if (testResult.status === 429) {
            return [{ 
              url: feedUrl, 
              type: 'RSS', 
              status: 'rate_limited',
              error: 'Website is rate limiting requests. Please try again later or enter the RSS URL directly.'
            }];
          } else if (testResult.status >= 500) {
            return [{ 
              url: feedUrl, 
              type: 'RSS', 
              status: 'server_error',
              error: 'Website server error. Please try again later.'
            }];
          } else {
            return [{ 
              url: feedUrl, 
              type: 'RSS', 
              status: 'invalid',
              error: 'RSS feed found but appears to be invalid or inaccessible.'
            }];
          }
        }
      }
      
      return [{ 
        url: url, 
        type: 'RSS', 
        status: 'not_found',
        error: 'No RSS feeds found on this website. Try entering the direct RSS URL.'
      }];
    } catch (error) {
      console.error('Error detecting RSS feeds:', error.message);
      
      // Provide user-friendly error messages
      if (error.code === 'ENOTFOUND') {
        return [{ 
          url: url, 
          type: 'RSS', 
          status: 'network_error',
          error: 'Website not found. Please check the URL and try again.'
        }];
      } else if (error.code === 'ECONNREFUSED') {
        return [{ 
          url: url, 
          type: 'RSS', 
          status: 'connection_error',
          error: 'Cannot connect to website. Please check the URL and try again.'
        }];
      } else {
        return [{ 
          url: url, 
          type: 'RSS', 
          status: 'error',
          error: 'Error detecting RSS feeds. Please try entering the direct RSS URL.'
        }];
      }
    }
  }

  // Validate if a URL is a valid RSS/Atom feed
  async validateFeed(url) {
    try {
      // First, try to get the raw content to check if it's a valid feed format
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RSS Feed Validator)'
        }
      });
      
      const content = response.data;
      const contentType = response.headers['content-type'] || '';
      
      // Check if it's a JSON Feed
      if (contentType.includes('json') || contentType.includes('application/json') || contentType.includes('application/feed+json')) {
        try {
          const jsonFeed = typeof content === 'string' ? JSON.parse(content) : content;
          if (jsonFeed && jsonFeed.version && (jsonFeed.items || jsonFeed.item)) {
            return jsonFeed.items && jsonFeed.items.length > 0;
          }
        } catch (parseError) {
          // Not JSON Feed
        }
      }
      
      // Check if it looks like a feed based on content type
      if (contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom')) {
        // Try to parse with the RSS parser
        try {
          const feed = await parser.parseString(content);
          return feed && feed.items && feed.items.length > 0;
        } catch (parseError) {
          // If parsing fails, check if it's a malformed but valid feed
          if (this.isMalformedButValidFeed(content, parseError.message)) {
            console.log(`⚠️ RSS feed has XML formatting issues but appears valid: ${url}`);
            return true;
          }
          return false;
        }
      }
      
      // If content type doesn't indicate XML, check content for feed indicators
      if (this.feedDiscovery.isValidFeed(content)) {
        // Check if it's JSON Feed first
        if (typeof content === 'string') {
          try {
            const jsonFeed = JSON.parse(content);
            if (jsonFeed && jsonFeed.version && (jsonFeed.items || jsonFeed.item)) {
              return jsonFeed.items && jsonFeed.items.length > 0;
            }
          } catch (e) {
            // Not JSON, continue to RSS parsing
          }
        }
        
        try {
          const feed = await parser.parseString(content);
          return feed && feed.items && feed.items.length > 0;
        } catch (parseError) {
          if (this.isMalformedButValidFeed(content, parseError.message)) {
            console.log(`⚠️ RSS feed has XML formatting issues but appears valid: ${url}`);
            return true;
          }
          return false;
        }
      }
      
      return false;
    } catch (error) {
      console.error('Error validating feed:', error.message);
      
      // Handle specific error cases
      if (error.response?.status === 404) {
        return false;
      } else if (error.response?.status === 403) {
        console.log(`⚠️ Feed access forbidden (403): ${url}`);
        return false;
      } else if (error.code === 'ENOTFOUND') {
        return false;
      }
      
      return false;
    }
  }

  isMalformedButValidFeed(content, errorMessage) {
    const lowerContent = content.toLowerCase();
    
    // Check for common XML parsing errors that don't invalidate the feed
    const commonXmlErrors = [
      'invalid character in entity name',
      'malformed',
      'unexpected end of file',
      'unclosed token',
      'invalid character reference',
      'unescaped &',
      'xml declaration allowed only at the start'
    ];
    
    const hasXmlError = commonXmlErrors.some(error => 
      errorMessage.toLowerCase().includes(error)
    );
    
    // Check if content still looks like a feed despite the error
    const feedIndicators = [
      '<rss',
      '<feed',
      '<channel',
      '<item',
      '<entry',
      '<?xml'
    ];
    
    const hasFeedIndicators = feedIndicators.some(indicator => 
      lowerContent.includes(indicator)
    );
    
    return hasXmlError && hasFeedIndicators;
  }

  // Check all monitored sources for new articles
  async checkAllFeeds() {
    if (!this.isMonitoring) {
      console.log('Feed monitoring is stopped, skipping check');
      return [];
    }
    
    // Skip if scraping is in progress (re-scrape or other scraping operations)
    if (this.isScrapingInProgress) {
      console.log('⏸️  Feed monitoring paused: scraping operation in progress');
      return [];
    }

    try {
      const sources = await database.getAllSources();
      if (sources.length === 0) {
        console.log('No sources to check');
        return [];
      }

      // Filter out paused sources
      const activeSources = sources.filter(source => !source.is_paused);
      const pausedSources = sources.filter(source => source.is_paused);
      
      if (pausedSources.length > 0) {
        console.log(`⏸️ Skipping ${pausedSources.length} paused sources: ${pausedSources.map(s => s.name).join(', ')}`);
      }

      if (activeSources.length === 0) {
        console.log('No active sources to check');
        return [];
      }

      console.log(`🔍 Checking ${activeSources.length} active sources for new articles...`);
      const results = [];
      
      for (const source of activeSources) {
        try {
          const monitoringType = source.monitoring_type || 'RSS';
          let newArticles = [];
          
          if (monitoringType === 'SCRAPING') {
            // Scraping: get articles and check for new ones
            console.log(`🔍 Checking scraping source: ${source.name} (${source.url})`);
            const articles = await this.webScraper.scrapeArticles(source);
            
            console.log(`📰 Found ${articles.length} articles from ${source.name}, checking for new ones...`);
            
            for (const article of articles) {
              try {
                const exists = await database.articleExists(article.link);
                if (!exists) {
                  // Ensure title is never null or empty (simple check)
                  const originalTitle = (article.title && article.title.trim()) ? article.title.trim() : 'Untitled Article';
                  
                  // Skip if link is invalid
                  if (!article.link || typeof article.link !== 'string') {
                    continue;
                  }
                  
                  // Generate AI-enhanced content for preview/summary only
                  const enhancedContent = await this.enhanceArticleContent(article);
                  
                  const articleObj = {
                    sourceId: source.id,
                    title: originalTitle, // Use original scraped title, guaranteed not null/empty
                    link: article.link,
                    content: enhancedContent.content || article.content || '',
                    preview: enhancedContent.preview || article.description || article.contentSnippet || '',
                    pubDate: article.pubDate || article.isoDate || null,
                    sourceName: source.name || 'Unknown Source',
                    category: source.category || 'General',
                    status: 'new'
                  };
                  
                  if (articleObj.title && articleObj.title.trim() !== '' && articleObj.link) {
                    await database.addArticle(articleObj);
                    newArticles.push({
                      id: articleObj.sourceId,
                      title: articleObj.title,
                      link: articleObj.link,
                      pubDate: articleObj.pubDate
                    });
                    
                    // Log new article found
                    console.log(`✨ NEW ARTICLE: "${articleObj.title}" | Date: ${articleObj.pubDate || 'NO DATE'} | Link: ${articleObj.link.substring(0, 60)}...`);
                  }
                } else {
                  // Article already exists - skip
                  console.log(`⏭️  Article already exists: ${article.link.substring(0, 60)}...`);
                }
              } catch (err) {
                console.error(`Error processing article from ${source.name}:`, err.message);
                // Skip duplicates or errors
              }
            }
            
            if (newArticles.length > 0) {
              console.log(`✅ Added ${newArticles.length} new article(s) from ${source.name}`);
            } else {
              console.log(`ℹ️  No new articles found for ${source.name} (${articles.length} articles checked, all already in database)`);
            }
            
            // Update last_checked timestamp (scraping result is already stored by webScraper)
            await database.updateSourceLastChecked(source.id);
          } else {
            // RSS/JSON Feed: use existing method
            newArticles = await this.checkFeedLimited(source, 5);
          }
          
          results.push({
            source: source.name,
            url: source.url,
            newArticles: newArticles.length,
            success: true,
            monitoring_type: monitoringType
          });
        } catch (error) {
          console.error(`Error checking ${source.monitoring_type || 'RSS'} source ${source.name}:`, error.message);
          results.push({
            source: source.name,
            url: source.url,
            newArticles: 0,
            success: false,
            error: error.message
          });
        }
      }
      
      console.log(`✅ Feed check completed. ${results.filter(r => r.success).length}/${results.length} active sources successful`);
      return results;
    } catch (error) {
      console.error('Error checking all feeds:', error);
      throw error;
    }
  }

  // Check a single feed for new articles
  // Convert JSON Feed to RSS-like format for compatibility
  async parseJSONFeed(url) {
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RSS Feed Parser)'
        }
      });
      
      const jsonFeed = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      
      if (!jsonFeed || !jsonFeed.version || !jsonFeed.items) {
        throw new Error('Invalid JSON Feed format');
      }
      
      // Convert JSON Feed to RSS-like format
      const rssLikeFeed = {
        title: jsonFeed.title || '',
        description: jsonFeed.description || '',
        link: jsonFeed.home_page_url || jsonFeed.feed_url || url,
        items: jsonFeed.items.map(item => ({
          title: item.title || '',
          link: item.url || item.id || '',
          pubDate: item.date_published || item.date_modified || null,
          isoDate: item.date_published || item.date_modified || null,
          content: item.content_html || item.content_text || item.summary || '',
          contentSnippet: item.content_text || item.summary || '',
          description: item.summary || item.content_text || '',
          author: item.authors && item.authors.length > 0 ? item.authors[0].name : null,
          id: item.id || item.url || ''
        }))
      };
      
      return rssLikeFeed;
    } catch (error) {
      console.error('Error parsing JSON Feed:', error.message);
      throw error;
    }
  }

  // Check if URL is a JSON Feed
  async isJSONFeed(url) {
    try {
      const response = await axios.get(url, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RSS Feed Checker)'
        },
        validateStatus: (status) => status < 500
      });
      
      const contentType = (response.headers['content-type'] || '').toLowerCase();
      if (contentType.includes('json') || contentType.includes('application/feed+json')) {
        const jsonFeed = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        return jsonFeed && jsonFeed.version && (jsonFeed.items || jsonFeed.item);
      }
      
      // Also check content if URL suggests JSON Feed
      if (url.includes('.json') || url.includes('/feed.json')) {
        const jsonFeed = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        return jsonFeed && jsonFeed.version && (jsonFeed.items || jsonFeed.item);
      }
      
      return false;
    } catch (error) {
      return false;
    }
  }

  // Check feed with limited number of articles (for new sources)
  async checkFeedLimited(source, maxArticles = 5) {
    try {
      // Check if it's a JSON Feed first
      let feed;
      const isJSON = await this.isJSONFeed(source.url);
      
      if (isJSON) {
        feed = await this.parseJSONFeed(source.url);
      } else {
        feed = await parser.parseURL(source.url);
      }
      
      const newArticles = [];
      
      // Generate session ID for this batch of articles
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Limit to only the most recent articles
      const limitedItems = feed.items.slice(0, maxArticles);
      console.log(`📰 Processing ${limitedItems.length} most recent articles from ${source.name}`);
      
      for (const item of limitedItems) {
        // Check if article already exists
        const exists = await database.articleExists(item.link);
        if (!exists) {
          // Generate AI-enhanced content
          const enhancedContent = await this.enhanceArticleContent(item);
          
          // Extract publication date from multiple possible fields
          let pubDate = null;
          const dateFields = [
            item.pubDate,
            item.isoDate,
            item.date,
            item.published,
            item['dc:date'],
            item['atom:published']
          ];
          
          // Debug: Log available date fields for first few articles
          if (newArticles.length < 3) {
            console.log(`Debug - Available date fields for "${item.title}":`, {
              pubDate: item.pubDate,
              isoDate: item.isoDate,
              date: item.date,
              published: item.published,
              'dc:date': item['dc:date'],
              'atom:published': item['atom:published']
            });
          }
          
          for (const dateField of dateFields) {
            if (dateField) {
              try {
                pubDate = new Date(dateField);
                if (!isNaN(pubDate.getTime())) {
                  if (newArticles.length < 3) {
                    console.log(`Debug - Using date field: ${dateField} -> ${pubDate.toISOString()}`);
                  }
                  break; // Valid date found
                }
              } catch (e) {
                // Continue to next date field
              }
            }
          }
          
          // If no valid date found, leave as null so UI shows "Date unavailable"
          if (!pubDate || isNaN(pubDate.getTime())) {
            pubDate = null;
          }

          // Extract author information from RSS fields
          let author = item.creator || item.author || item['dc:creator'] || null;
          if (author && typeof author === 'object' && author.name) {
            author = author.name;
          }

          // Use description as publisher description (limit to 300 chars)
          let publisherDescription = item.description || item.contentSnippet || null;
          if (publisherDescription && publisherDescription.length > 300) {
            publisherDescription = publisherDescription.substring(0, 300);
          }

          const article = {
            sourceId: source.id,
            title: enhancedContent.title || item.title || 'Untitled',
            link: item.link || '',
            content: enhancedContent.content || item.contentSnippet || item.content || item.description || '',
            preview: enhancedContent.preview || (item.contentSnippet || item.content || item.description || '').substring(0, 200) + '...',
            enhanced_content: enhancedContent,
            pubDate: pubDate ? pubDate.toISOString() : null,
            sourceName: source.name || 'Unknown Source',
            category: source.category || 'General',
            author: author,
            publisherDescription: publisherDescription,
            sessionId: sessionId
          };

          // Validate required fields before database insertion
          if (!article.title || article.title === 'Untitled') {
            console.log(`⚠️ Skipping article with invalid title: ${item.link}`);
            continue;
          }
          if (!article.link) {
            console.log(`⚠️ Skipping article with no link: ${article.title}`);
            continue;
          }

          const articleId = await database.addArticle(article);

          newArticles.push({
            id: articleId,
            title: article.title,
            link: article.link
          });
        }
      }

      console.log(`📝 Added ${newArticles.length} new articles from ${source.name}`);
      
      // Update last_checked timestamp for this source
      await database.updateSourceLastChecked(source.id);
      
      return newArticles;
    } catch (error) {
      console.error(`Error checking feed for ${source.name}:`, error);
      throw error;
    }
  }

  async checkFeed(source) {
    try {
      // Check if it's a JSON Feed first
      let feed;
      const isJSON = await this.isJSONFeed(source.url);
      
      if (isJSON) {
        feed = await this.parseJSONFeed(source.url);
      } else {
        feed = await parser.parseURL(source.url);
      }
      
      const newArticles = [];
      
      // Generate session ID for this batch of articles
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      for (const item of feed.items) {
        // Check if article already exists
        const exists = await database.articleExists(item.link);
        if (!exists) {
          // Generate AI-enhanced content
          const enhancedContent = await this.enhanceArticleContent(item);
          
          // Extract publication date from multiple possible fields
          let pubDate = null;
          const dateFields = [
            item.pubDate,
            item.isoDate,
            item.date,
            item.published,
            item['dc:date'],
            item['atom:published']
          ];
          
          // Debug: Log available date fields for first few articles
          if (newArticles.length < 3) {
            console.log(`Debug - Available date fields for "${item.title}":`, {
              pubDate: item.pubDate,
              isoDate: item.isoDate,
              date: item.date,
              published: item.published,
              'dc:date': item['dc:date'],
              'atom:published': item['atom:published']
            });
          }
          
          for (const dateField of dateFields) {
            if (dateField) {
              try {
                pubDate = new Date(dateField);
                if (!isNaN(pubDate.getTime())) {
                  if (newArticles.length < 3) {
                    console.log(`Debug - Using date field: ${dateField} -> ${pubDate.toISOString()}`);
                  }
                  break; // Valid date found
                }
              } catch (e) {
                // Continue to next date field
              }
            }
          }
          
          // If no valid date found, leave as null so UI shows "Date unavailable"
          if (!pubDate || isNaN(pubDate.getTime())) {
            pubDate = null;
          }
          

          // Extract author and publisher description for this method too
          let author = item.creator || item.author || item['dc:creator'] || null;
          if (author && typeof author === 'object' && author.name) {
            author = author.name;
          }

          let publisherDescription = item.description || item.contentSnippet || null;
          if (publisherDescription && publisherDescription.length > 300) {
            publisherDescription = publisherDescription.substring(0, 300);
          }

          // Add to database with session ID
          const articleId = await database.addArticle({
            title: enhancedContent.title || 'Untitled',
            content: enhancedContent.content,
            preview: enhancedContent.preview,
            link: item.link,
            pubDate: pubDate ? pubDate.toISOString() : null,
            sourceId: source.id,
            sourceName: source.name,
            category: source.category,
            author: author,
            publisherDescription: publisherDescription,
            sessionId: sessionId
          });
          
          newArticles.push({
            id: articleId,
            title: enhancedContent.title,
            link: item.link
          });
        }
      }
      
      // Update last_checked timestamp for this source
      await database.updateSourceLastChecked(source.id);
      
      return newArticles;
    } catch (error) {
      console.error(`Error checking feed ${source.name}:`, error);
      throw error;
    }
  }

  // Enhance article content using AI
  async enhanceArticleContent(item) {
    try {
      // Extract and clean content properly
      const { title, content } = this.extractTitleAndContent(item);
      let cleanedContent = this.cleanContent(content);

      // Fallback: fetch full article HTML when RSS content is too short
      if ((!cleanedContent || cleanedContent.length < 240) && item.link) {
        try {
          const full = await this.fetchFullArticleContent(item.link);
          if (full && full.length > cleanedContent.length) {
            cleanedContent = full;
          }
        } catch (e) {
          // Soft-fail: keep existing cleanedContent
          console.warn('Fallback fetch failed:', e.message);
        }
      }
      
      // Use LLM service to generate author's note style summary (concise, factual)
      const llmService = require('./llmService');
      const summary = await llmService.summarizeArticle(title, cleanedContent, 'RSS Feed');
      
      return {
        content: cleanedContent,
        preview: summary, // Author's note style summary
        title: title
      };
    } catch (error) {
      console.error('Error enhancing article content:', error);
      const { title, content } = this.extractTitleAndContent(item);
      const cleanedContent = this.cleanContent(content);
      // Fallback to author's note style
      const llmService = require('./llmService');
      const fallbackSummary = llmService.createAuthorsNoteStyleSummary(title, cleanedContent, 'RSS Feed');
      return {
        content: cleanedContent,
        preview: fallbackSummary,
        title: title
      };
    }
  }

  // Extract proper title and content from RSS item
  extractTitleAndContent(item) {
    let title = item.title || 'Untitled';
    let content = '';

    // Try different content sources in order of preference
    const contentSources = [
      item.contentSnippet,
      item.description,
      item.content,
      item.summary,
      item['content:encoded'], // Some feeds use this
      item['media:description'] // Media feeds
    ];

    // Find the best content source
    for (const source of contentSources) {
      if (source && typeof source === 'string' && source.trim().length > 0) {
        content = source.trim();
        break;
      }
    }

    // Handle cases where title might actually be content
    if (title.length > 200 && content.length < 100) {
      // If title is very long and content is short, they might be swapped
      const temp = title;
      title = content || 'Untitled';
      content = temp;
    }

    // Clean up title if it's too long (likely contains content)
    if (title.length > 150) {
      // Try to extract a proper title from the beginning
      const sentences = title.split(/[.!?]+/);
      if (sentences.length > 1) {
        const firstSentence = sentences[0].trim();
        // Only use first sentence as title if it's reasonable length
        if (firstSentence.length > 10 && firstSentence.length < 100) {
          title = firstSentence;
          // If we extracted title from content, use the rest as content
          if (content.length < 50) {
            content = title;
            title = 'Untitled';
          }
        }
      }
    }

    // Ensure title is not a URL
    if (title.match(/^https?:\/\//)) {
      const temp = title;
      title = content || 'Untitled';
      content = temp;
    }

    // Ensure content is not a URL if we have other content
    if (content.match(/^https?:\/\//) && item.contentSnippet && item.contentSnippet.length > 50) {
      content = item.contentSnippet;
    }

    // If we still don't have meaningful content, use the link as a fallback summary
    if (!content || content.length < 50) {
      content = item.link || '';
    }

    return { title, content };
  }

  // Fetch and extract readable text from an article page
  async fetchFullArticleContent(url) {
    try {
      const resp = await axios.get(url, { 
        timeout: 15000, 
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none'
        },
        maxRedirects: 5,
        validateStatus: (status) => {
          // Allow 200-302 (success and redirects), but treat 403 as error
          if (status === 403) return false;
          return status >= 200 && status < 400;
        }
      });
      
      const $ = cheerio.load(resp.data);

    // Common content selectors across blogs/CMS (including Substack-like)
    const selectors = [
      'article',
      '.post-content',
      '.entry-content',
      '.article-content',
      '.content',
      'main article',
      'section[data-testid="post"]',
      'div[data-article-body=true]',
      'div.post',
      '.body',
    ];

    let best = '';
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el && el.length) {
        // Join paragraph-like nodes
        const text = el
          .find('p, li, h2, h3, blockquote')
          .map((_, n) => $(n).text())
          .get()
          .join('\n\n');
        const cleaned = this.cleanContent(text);
        if (cleaned.length > best.length) best = cleaned;
      }
    }

    // Fallback: all paragraphs
    if (best.length < 200) {
      const all = $('p').map((_, n) => $(n).text()).get().join('\n\n');
      const cleanedAll = this.cleanContent(all);
      if (cleanedAll.length > best.length) best = cleanedAll;
    }

    return best;
    } catch (error) {
      // Re-throw errors - caller will handle 403s gracefully
      throw error;
    }
  }

  // Extract article metadata from a URL
  async extractArticleMetadata(url) {
    try {
      const resp = await axios.get(url, { 
        timeout: 15000, 
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none'
        },
        maxRedirects: 5,
        validateStatus: (status) => {
          // Allow 200-302 (success and redirects), but treat 403 as error
          if (status === 403) return false;
          return status >= 200 && status < 400;
        }
      });
      
      const $ = cheerio.load(resp.data);

      // Extract title - use multiple strategies for maximum compatibility
      let title = null;
      
      // Strategy 1: Check Open Graph and meta tags (most reliable, works across sites)
      const ogTitle = $('meta[property="og:title"]').attr('content') || 
                     $('meta[name="og:title"]').attr('content');
      if (ogTitle && ogTitle.trim().length > 10) {
        title = ogTitle.trim();
      }
      
      // Strategy 2: Check JSON-LD structured data (very reliable)
      if (!title) {
        try {
          const jsonLdScripts = $('script[type="application/ld+json"]');
          jsonLdScripts.each((i, script) => {
            try {
              const data = JSON.parse($(script).html());
              if (data.headline || data.name) {
                const jsonTitle = data.headline || data.name;
                if (jsonTitle && jsonTitle.trim().length > 10 && jsonTitle.length < 200) {
                  title = jsonTitle.trim();
                  return false; // Break
                }
              }
              // Handle arrays
              if (Array.isArray(data)) {
                data.forEach(item => {
                  if (item.headline || item.name) {
                    const jsonTitle = item.headline || item.name;
                    if (jsonTitle && jsonTitle.trim().length > 10 && jsonTitle.length < 200) {
                      title = jsonTitle.trim();
                      return false;
                    }
                  }
                });
              }
            } catch (e) {
              // Invalid JSON, skip
            }
          });
        } catch (e) {
          // JSON-LD parsing failed, continue
        }
      }
      
      // Strategy 3: Look for article-specific h1 within article containers
      if (!title) {
        const articleContainers = $('article, [class*="article"], [class*="post-content"], [class*="entry-content"], main article, .post, .blog-post, [role="article"]');
        if (articleContainers.length > 0) {
          const articleH1 = articleContainers.find('h1').first();
          if (articleH1.length && articleH1.text().trim().length > 10) {
            const h1Text = articleH1.text().trim();
            // Filter out generic titles
            if (!h1Text.toLowerCase().includes('blog') &&
                !h1Text.toLowerCase().includes('all posts') &&
                !h1Text.toLowerCase().includes('latest by topic') &&
                h1Text.length < 200) {
              title = h1Text;
            }
          }
        }
      }
      
      // Strategy 4: Look for main h1 (but filter out generic ones)
      if (!title) {
        const allH1s = $('h1');
        for (let i = 0; i < allH1s.length; i++) {
          const h1Text = $(allH1s[i]).text().trim();
          // Skip generic titles
          if (h1Text.length > 10 && 
              h1Text.length < 200 &&
              !h1Text.toLowerCase().includes('blog') &&
              !h1Text.toLowerCase().includes('all posts') &&
              !h1Text.toLowerCase().includes('latest by topic') &&
              !h1Text.toLowerCase().includes('category') &&
              !h1Text.toLowerCase().includes('tag') &&
              !h1Text.match(/^(home|about|contact|careers|company|solutions|marketplace|latest)$/i)) {
            title = h1Text;
            break;
          }
        }
      }
      
      // Strategy 5: Use page title but clean it up extensively
      if (!title) {
        title = $('title').text() || 'Untitled';
        title = title.replace(/\s+/g, ' ').trim();
        
        // Remove common site name patterns
        // Patterns: "Title | Site", "Title - Site", "Title | Site Name", "Site: Title"
        title = title
          .replace(/\s*[|\-–—]\s*([^|–—]+)$/i, '')  // Remove "| Site Name"
          .replace(/^([^|–—]+)[|\-–—]\s*/i, '')      // Remove "Site | " prefix
          .replace(/^[^:]+:\s*/i, '')                // Remove "Site: " prefix
          .trim();
        
        // If title still contains separators, use the longest part (usually the article title)
        const titleParts = title.split(/[|\-–—]/);
        if (titleParts.length > 1) {
          // Find the longest part (usually the article title)
          title = titleParts.reduce((a, b) => a.trim().length > b.trim().length ? a.trim() : b.trim(), '');
        }
      }
      
      // Final cleanup - remove extra whitespace and validate
      title = title.replace(/\s+/g, ' ').trim();
      
      // Validate title isn't too generic
      const genericPatterns = [
        /^latest by topic/i,
        /^mothership of ai/i,
        /^backbone of ai infrastructure/i,
        /^innovations & ideas from/i,
        /^research by dr/i,
        /^why we should train ai models/i
      ];
      
      // If title matches generic pattern, try to get a better one
      if (genericPatterns.some(pattern => pattern.test(title))) {
        // Try to get title from URL slug as fallback
        try {
          const urlObj = new URL(url);
          const slug = urlObj.pathname.split('/').pop();
          if (slug && slug.length > 10) {
            const urlTitle = decodeURIComponent(slug)
              .replace(/[-_]/g, ' ')
              .replace(/\.[^.]+$/, '') // Remove file extension
              .trim();
            if (urlTitle.length > 10 && urlTitle.length < 200) {
              title = urlTitle;
            }
          }
        } catch (e) {
          // URL parsing failed, keep current title
        }
      }

      // Extract source name from URL domain
      const urlObj = new URL(url);
      let sourceName = urlObj.hostname.replace('www.', '');
      // Capitalize first letter and remove .com/.org etc
      sourceName = sourceName.split('.')[0].charAt(0).toUpperCase() + sourceName.split('.')[0].slice(1);

      // Extract RSS-style description/summary
      let description = '';
      const descriptionSelectors = [
        'meta[name="description"]',
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
        '.article-summary',
        '.post-excerpt',
        '.entry-summary',
        '.excerpt'
      ];

      for (const selector of descriptionSelectors) {
        const descEl = $(selector);
        if (descEl.length) {
          const descValue = descEl.attr('content') || descEl.text();
          if (descValue && descValue.length > description.length) {
            description = descValue.trim();
          }
        }
      }

      // Fallback: extract first paragraph or intro text
      if (!description) {
        const firstParagraph = $('p').first().text().trim();
        if (firstParagraph && firstParagraph.length > 50) {
          description = firstParagraph.substring(0, 300) + (firstParagraph.length > 300 ? '...' : '');
        }
      }

      // Helper to parse date in various formats including "06-Nov-25"
      const parseDate = (dateStr) => {
        if (!dateStr) return null;
        
        // First try standard Date parsing
        try {
          const standardDate = new Date(dateStr);
          if (!isNaN(standardDate.getTime())) {
            const now = new Date();
            const yearDiff = standardDate.getFullYear() - now.getFullYear();
            // Validate date is reasonable (not in distant future/past)
            if (yearDiff >= -10 && yearDiff <= 5) {
              return standardDate.toISOString();
            }
          }
        } catch (e) {
          // Continue to pattern matching
        }
        
        // Try pattern matching for various date formats
        const datePatterns = [
          // Full month name: "November 12, 2025" or "November 12 2025"
          /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
          // Short month name: "Nov 12, 2025" or "Nov 12 2025"
          /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i,
          // DD-MMM-YY format (e.g., "06-Nov-25")
          /\b(\d{1,2})[-/](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/](\d{2,4})\b/i,
          // DD-MM-YY or DD/MM/YYYY
          /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/,
          // YYYY-MM-DD
          /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/
        ];
        
        for (const pattern of datePatterns) {
          const match = dateStr.match(pattern);
          if (match) {
            try {
              let parsed;
              
              // Handle full month name: "November 12, 2025"
              if (match[1] && /^(January|February|March|April|May|June|July|August|September|October|November|December)$/i.test(match[1])) {
                const month = match[1];
                const day = match[2];
                const year = match[3];
                parsed = new Date(`${month} ${day}, ${year}`);
              }
              // Handle short month name: "Nov 12, 2025"
              else if (match[1] && /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(match[1])) {
                const month = match[1];
                const day = match[2];
                const year = match[3];
                parsed = new Date(`${month} ${day}, ${year}`);
              }
              // Handle DD-MMM-YY format
              else if (match[2] && /[A-Za-z]{3}/.test(match[2])) {
                const day = match[1];
                const month = match[2];
                const year = match[3].length === 2 ? `20${match[3]}` : match[3];
                parsed = new Date(`${day}-${month}-${year}`);
              }
              // Handle numeric formats
              else {
                parsed = new Date(match[0]);
              }
              
              if (!isNaN(parsed.getTime())) {
                const now = new Date();
                const yearDiff = parsed.getFullYear() - now.getFullYear();
                if (yearDiff >= -10 && yearDiff <= 5) {
                  return parsed.toISOString();
                }
              }
            } catch (e) {
              // Continue to next pattern
            }
          }
        }
        
        return null;
      };

      // Extract publication date
      let pubDate = null;
      const dateSelectors = [
        'meta[property="article:published_time"]',
        'meta[name="article:published_time"]',
        'meta[property="og:article:published_time"]',
        'meta[property="article:published"]',
        'meta[name="publishdate"]',
        'meta[name="pubdate"]',
        'meta[name="date"]',
        'time[datetime]',
        'time',
        '[datetime]',
        '[data-date]',
        '[data-published]',
        '.published-date',
        '.post-date',
        '.article-date',
        '.date',
        '.publish-date',
        '[class*="date"]',
        '[class*="published"]',
        '[class*="publish"]',
        '[id*="date"]',
        '[id*="published"]'
      ];
      
      // Also check JSON-LD structured data for dates
      try {
        const jsonLdScripts = $('script[type="application/ld+json"]');
        jsonLdScripts.each((i, script) => {
          try {
            const data = JSON.parse($(script).html());
            if (data['@type'] === 'Article' || data['@type'] === 'BlogPosting' || data['@type'] === 'NewsArticle') {
              if (data.datePublished) {
                pubDate = parseDate(data.datePublished);
                if (pubDate) return false; // Break loop
              }
              if (data.dateCreated && !pubDate) {
                pubDate = parseDate(data.dateCreated);
                if (pubDate) return false; // Break loop
              }
            }
            // Handle arrays of structured data
            if (Array.isArray(data)) {
              data.forEach(item => {
                if ((item['@type'] === 'Article' || item['@type'] === 'BlogPosting') && item.datePublished) {
                  pubDate = parseDate(item.datePublished);
                  if (pubDate) return false; // Break loop
                }
              });
            }
          } catch (e) {
            // Invalid JSON, skip
          }
        });
      } catch (e) {
        // JSON-LD parsing failed, continue
      }

      // Try structured selectors first
      for (const selector of dateSelectors) {
        const dateEl = $(selector);
        if (dateEl.length) {
          // Try content attribute first (for meta tags)
          let dateValue = dateEl.attr('content') || dateEl.attr('datetime') || dateEl.attr('date');
          
          // If no attribute, try text content
          if (!dateValue) {
            dateValue = dateEl.text().trim();
          }
          
          if (dateValue) {
            pubDate = parseDate(dateValue);
            if (pubDate) break;
          }
        }
      }
      
      // If still no date, look for date patterns in article content
      // Common patterns: "November 12, 2025", "Nov 12, 2025", "12 November 2025"
      if (!pubDate) {
        const articleContent = $('article, [class*="article"], [class*="post-content"], main').first().text() || $('body').text();
        const datePatterns = [
          // "November 12, 2025" or "Nov 12, 2025"
          /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i,
          // "12 November 2025"
          /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/i,
        ];
        
        for (const pattern of datePatterns) {
          const match = articleContent.match(pattern);
          if (match) {
            try {
              const dateStr = match[0];
              pubDate = parseDate(dateStr);
              if (pubDate) break;
            } catch (e) {
              // Continue
            }
          }
        }
      }
      
      // If no structured date found, search entire page for date patterns
      if (!pubDate) {
        // Try article content area first (more likely to have date)
        const articleContent = $('article, .article, .post, .content, main').first().text();
        if (articleContent) {
          pubDate = parseDate(articleContent);
        }
        
        // If still no date, search entire page
        if (!pubDate) {
          const pageText = $('body').text();
          pubDate = parseDate(pageText);
        }
      }
      
      // Log if date was found or not (for debugging)
      if (pubDate) {
        console.log(`📅 Found date from article page: ${pubDate}`);
      } else {
        console.log(`⚠️ No date found for article: ${url}`);
      }

      // Extract content using the same logic as fetchFullArticleContent
      // But handle 403 gracefully - don't fail if we can't fetch full content
      let content = '';
      try {
        content = await this.fetchFullArticleContent(url);
      } catch (contentError) {
        // If 403, just use empty content - we already have description from meta tags
        if (contentError.response && contentError.response.status === 403) {
          console.log(`⚠️ 403 Forbidden when fetching full content from ${url}, using meta description only`);
          content = description || ''; // Use description as fallback
        } else {
          // For other errors, log but don't fail
          console.warn(`⚠️ Could not fetch full content from ${url}:`, contentError.message);
          content = description || ''; // Use description as fallback
        }
      }

      return {
        title,
        content,
        pubDate,
        sourceName,
        description
      };
    } catch (error) {
      // Handle 403 errors gracefully
      if (error.response && error.response.status === 403) {
        console.log(`⚠️ 403 Forbidden when extracting metadata from ${url} (Cloudflare protection)`);
        return { 
          title: 'Untitled',
          content: '',
          pubDate: null,
          sourceName: '',
          description: ''
        };
      }
      console.error('Error extracting article metadata:', error);
      throw error;
    }
  }

  // Clean and format content for better readability
  cleanContent(content) {
    if (!content) return '';
    
    // Remove HTML tags but preserve structure
    let cleaned = content
      .replace(/<br\s*\/?>/gi, '\n')  // Convert <br> to line breaks
      .replace(/<\/p>/gi, '\n\n')     // Convert </p> to double line breaks
      .replace(/<p[^>]*>/gi, '')      // Remove opening <p> tags
      .replace(/<[^>]*>/g, '')        // Remove all other HTML tags
      .replace(/&nbsp;/g, ' ')        // Convert &nbsp; to spaces
      .replace(/&amp;/g, '&')         // Convert &amp; to &
      .replace(/&lt;/g, '<')          // Convert &lt; to <
      .replace(/&gt;/g, '>')          // Convert &gt; to >
      .replace(/&quot;/g, '"')        // Convert &quot; to "
      .replace(/&#39;/g, "'")         // Convert &#39; to '
      .replace(/\s+/g, ' ')           // Replace multiple spaces with single space
      .replace(/\n\s+/g, '\n')        // Remove spaces after line breaks
      .trim();
    
    // Remove metadata and unwanted patterns
    cleaned = this.removeMetadata(cleaned);
    
    // Add proper line breaks for better readability
    cleaned = cleaned
      .replace(/([.!?])\s+([A-Z])/g, '$1\n\n$2')  // Add breaks after sentences
      .replace(/([.!?])\s+([✨🚀🌎💸📡🔥🎓🎉📍])/g, '$1\n\n$2')  // Add breaks before emoji sections
      .replace(/([a-z])([A-Z])/g, '$1 $2')        // Add spaces between camelCase
      .replace(/\n{3,}/g, '\n\n');                // Limit to max 2 consecutive line breaks
    
    return cleaned;
  }

  // Remove metadata and unwanted content patterns
  removeMetadata(content) {
    if (!content) return '';
    
    let cleaned = content;
    
    // Enhanced metadata patterns - more comprehensive
    const metadataPatterns = [
      // Date patterns
      /Category:\s*[\w\s,]+\s+\w{3}\s+\d{1,2},\s*\d{4}/gi,  // Category:updatesawards Aug 11, 2025
      /Category:\s*[\w\s,]+/gi,                              // Category:updates
      /\w{3}\s+\d{1,2},\s*\d{4}/g,                          // Aug 11, 2025
      /\d{4}-\d{2}-\d{2}/g,                                  // 2025-08-11
      /\d{1,2}\/\d{1,2}\/\d{4}/g,                           // 8/11/2025
      /Posted on\s+[\w\s,]+/gi,                             // Posted on August 11, 2025
      /Published on\s+[\w\s,]+/gi,                          // Published on August 11, 2025
      /Updated on\s+[\w\s,]+/gi,                            // Updated on August 11, 2025
      /By\s+[\w\s]+,\s*\w{3}\s+\d{1,2},\s*\d{4}/gi,        // By Author Name, Aug 11, 2025
      
      // Author and attribution patterns
      /Author:\s*[\w\s]+/gi,                                // Author: John Doe
      /By\s+[\w\s]+$/gi,                                    // By John Doe (end of line)
      /^\w+\s+\w+,\s*\w{3}\s+\d{1,2},\s*\d{4}$/gm,        // Author Name, Aug 11, 2025 (full line)
      
      // Tags and categories
      /Tags?:\s*[\w\s,]+/gi,                                // Tags: blockchain, crypto
      /Filed under:\s*[\w\s,]+/gi,                          // Filed under: News
      
      // Navigation and UI elements
      /Read more\s*→?/gi,                                   // Read more →
      /Continue reading\s*→?/gi,                            // Continue reading →
      /View all articles/gi,                                // View all articles
      /Related Articles/gi,                                 // Related Articles
      /See also/gi,                                         // See also
      /Share this/gi,                                       // Share this
      /Tweet this/gi,                                       // Tweet this
      /Copy link/gi,                                        // Copy link
      /Facebook/gi,                                         // Facebook
      /Email/gi,                                            // Email
      /Notes/gi,                                            // Notes
      /More/gi,                                             // More
      
      // Social media and sharing
      /\d+\s*Share this post/gi,                           // 10 Share this post
      /Share this post\s+\w+'s Substack/gi,                // Share this post Virtuals' Substack
      /Virtuals' Substack\s+Virtuals Monthly Update/gi,    // Duplicate content patterns
      /Copy link\s+Facebook\s+Email\s+Notes\s+More/gi,     // Navigation elements
      
      // Substack specific patterns
      /Virtuals Protocol\s+\w{3}\s+\d{2},\s*\d{4}/gi,      // Virtuals Protocol Feb 05, 2025
      /\d+\s*min read/gi,                                   // 5 min read
      /Listen\s+Share/gi,                                   // Listen Share
      
      // Medium specific patterns
      /\d+\s*min read·\w{3}\s+\d{1,2},\s*\d{4}/gi,         // 2 min read·Jun 19, 2025
      /--Listen\s+Share/gi,                                 // --Listen Share
      
      // Ocean Protocol specific
      /Ocean Protocol Team\s+\d+\s*min read/gi,            // Ocean Protocol Team 2 min read
      /Press enter or click to view image in full size/gi, // Image placeholder text
      
      // Filecoin specific patterns
      /✨\s*Highlights\s*✨/gi,                             // ✨ Highlights ✨
      /🚀\s*[A-Z][^🚀]*🚀/gi,                             // 🚀 Content 🚀 patterns
      /🌎\s*Community Updates\s*🌎/gi,                     // 🌎 Community Updates 🌎
      /🔥\s*[A-Z][^🔥]*🔥/gi,                             // 🔥 Content 🔥 patterns
      /🛠️\s*[A-Z][^🛠️]*🛠️/gi,                         // 🛠️ Content 🛠️ patterns
      /🎉\s*[A-Z][^🎉]*🎉/gi,                             // 🎉 Content 🎉 patterns
      /📡\s*[A-Z][^📡]*📡/gi,                             // 📡 Content 📡 patterns
      /🐶\s*[A-Z][^🐶]*🐶/gi,                             // 🐶 Content 🐶 patterns
    ];
    
    // Apply metadata removal patterns
    metadataPatterns.forEach(pattern => {
      cleaned = cleaned.replace(pattern, '');
    });
    
    // Remove duplicate content patterns
    cleaned = cleaned.replace(/(.{20,}?)\1+/g, '$1');
    
    // Remove lines that are just metadata or navigation
    const lines = cleaned.split('\n');
    const filteredLines = lines.filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return true; // Keep empty lines for spacing
      
      // Remove lines that are likely metadata or navigation
      const isMetadata = /^[A-Z][a-z]+:\s/.test(trimmed) ||  // Category: or Author:
                         /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/.test(trimmed) ||  // Date patterns
                         /^By\s+[\w\s]+,\s*\w{3}\s+\d{1,2},\s*\d{4}$/.test(trimmed) ||  // By Author, Date
                         /^[A-Z][a-z]+\s+\d{1,2},\s*\d{4}$/.test(trimmed) ||  // Month Day, Year
                         (trimmed.length < 20 && /^[A-Z\s]+$/.test(trimmed)) || // Short all-caps lines
                         /^[\w\s]+\s+\d+\s*min read/.test(trimmed) || // Author 2 min read
                         /^[\w\s]+\s+\w{3}\s+\d{2},\s*\d{4}$/.test(trimmed) || // Author Feb 05, 2025
                         trimmed.match(/^(Share|Copy|Facebook|Email|Notes|More|Listen)$/i) || // Navigation words
                         trimmed.match(/^\d+\s*Share this post$/); // Share counts
      
      return !isMetadata;
    });
    
    cleaned = filteredLines.join('\n');
    
    // Clean up extra whitespace
    cleaned = cleaned
      .replace(/\n{3,}/g, '\n\n')  // Max 2 consecutive line breaks
      .replace(/^\s+|\s+$/g, '')   // Trim start and end
      .replace(/[ \t]+/g, ' ')     // Multiple spaces/tabs to single space
      .replace(/\n /g, '\n')       // Remove leading spaces from lines
      .replace(/ \n/g, '\n');      // Remove trailing spaces from lines
    
    return cleaned;
  }

  // Start automatic monitoring
  startMonitoring() {
    if (this.isMonitoring) {
      console.log('Feed monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    console.log('Starting feed monitoring...');
    
    // Check feeds immediately
    this.checkAllFeeds().catch(error => {
      console.error('Error in initial feed check:', error);
    });
    
    // Then check every 30 minutes
    this.monitoringInterval = setInterval(() => {
      if (this.isMonitoring) {
        this.checkAllFeeds().catch(error => {
          console.error('Error in scheduled feed check:', error);
        });
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  // Stop monitoring
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    console.log('Feed monitoring stopped');
  }
}

module.exports = new FeedMonitor();
