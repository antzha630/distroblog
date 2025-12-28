const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const database = require('../database-postgres');
const FeedDiscovery = require('./feedDiscovery');
const WebScraper = require('./webScraper');
const ADKScraper = require('./adkScraper');

const parser = new Parser();

class FeedMonitor {
  constructor() {
    this.isMonitoring = false;
    this.monitoringInterval = null;
    this.feedDiscovery = new FeedDiscovery();
    this.webScraper = new WebScraper();
    // Use ADK scraper for AI-powered extraction (faster and more consistent than Playwright/Cheerio)
    this.adkScraper = new ADKScraper();
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
  // allowManual: if true, allows the check to run even if monitoring is stopped (for manual triggers)
  async checkAllFeeds(allowManual = false) {
    const startTime = Date.now();
    const triggerType = allowManual ? 'MANUAL' : 'SCHEDULED';
    console.log(`\n🚀 [CHECK NOW] Starting ${triggerType} feed check at ${new Date().toISOString()}`);
    
    if (!this.isMonitoring && !allowManual) {
      console.log('⚠️  [CHECK NOW] Feed monitoring is stopped, skipping scheduled check');
      return [];
    }
    
    if (!this.isMonitoring && allowManual) {
      console.log('ℹ️  [CHECK NOW] Feed monitoring is stopped, but allowing manual check');
    }
    
    // Skip if scraping is in progress (re-scrape or other scraping operations)
    if (this.isScrapingInProgress) {
      console.log('⏸️  [CHECK NOW] Feed monitoring paused: scraping operation in progress');
      return [];
    }

    try {
      const sources = await database.getAllSources();
      if (sources.length === 0) {
        console.log('ℹ️  [CHECK NOW] No sources to check');
        return [];
      }

      // Filter out paused sources
      const activeSources = sources.filter(source => !source.is_paused);
      const pausedSources = sources.filter(source => source.is_paused);
      
      if (pausedSources.length > 0) {
        console.log(`⏸️  [CHECK NOW] Skipping ${pausedSources.length} paused sources: ${pausedSources.map(s => s.name).join(', ')}`);
      }

      if (activeSources.length === 0) {
        console.log('ℹ️  [CHECK NOW] No active sources to check');
        return [];
      }

      console.log(`🔍 [CHECK NOW] Checking ${activeSources.length} active sources for new articles...`);
      const results = [];
      
      // Process sources sequentially; for manual checks we skip heavy metadata fetches
      // and for both manual/auto we now avoid artificial delays to improve speed.
      const isManual = allowManual;
      const BATCH_SIZE = 3; // Process articles in batches to control memory
      let totalNewArticlesProcessed = 0;
      
      // Memory monitoring helper - use RSS (Resident Set Size) which includes all memory
      // RSS is total memory used, not just heap (includes Playwright browser processes)
      const getMemoryMB = () => {
        if (process.memoryUsage) {
          const memUsage = process.memoryUsage();
          // Use RSS (Resident Set Size) - total memory including native memory from Playwright
          return Math.round(memUsage.rss / 1024 / 1024);
        }
        return 0;
      };
      
      const getMemoryDetails = () => {
        if (process.memoryUsage) {
          const memUsage = process.memoryUsage();
          return {
            rss: Math.round(memUsage.rss / 1024 / 1024), // Total memory (including Playwright)
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // Heap only
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024) // Native memory (Playwright)
          };
        }
        return null;
      };
      
      const MEMORY_LIMIT_MB = 450; // Stop if we exceed 450MB RSS to stay under 512MB limit
      
      // Skip list for problematic sources that cause memory issues
      // (Currently empty - Hyper Cycle removed as ADK approach uses less memory)
      const SKIP_SOURCES = [
        // 'hypercycle.ai',
        // 'www.hypercycle.ai',
        // 'Hyper Cycle'  // Removed - ADK approach uses less memory
      ];
      
      for (let i = 0; i < activeSources.length; i++) {
        const source = activeSources[i];
        console.log(`\n📊 [CHECK NOW] [${i + 1}/${activeSources.length}] Processing source: ${source.name}`);
        
        // Skip problematic sources
        const shouldSkip = SKIP_SOURCES.some(skipPattern => 
          source.name.toLowerCase().includes(skipPattern.toLowerCase()) ||
          source.url.toLowerCase().includes(skipPattern.toLowerCase())
        );
        
        if (shouldSkip) {
          console.warn(`⚠️  [CHECK NOW] Skipping problematic source "${source.name}" (known to cause memory issues)`);
          results.push({
            source: source.name,
            url: source.url,
            newArticles: 0,
            success: false,
            error: 'Skipped - known problematic source',
            skipped: true
          });
          continue;
        }
        
        // Memory check: Skip scraping sources if memory is too high (but continue with RSS)
        const currentMemMB = getMemoryMB();
        const memDetails = getMemoryDetails();
        
        if (currentMemMB > MEMORY_LIMIT_MB) {
          if (source.monitoring_type === 'SCRAPING') {
            const detailsStr = memDetails ? ` (RSS=${memDetails.rss}MB, heap=${memDetails.heapUsed}MB, external=${memDetails.external}MB)` : '';
            console.warn(`⚠️  [CHECK NOW] Memory usage (${currentMemMB}MB) exceeds limit (${MEMORY_LIMIT_MB}MB)${detailsStr}. Skipping scraping source "${source.name}" to prevent crash.`);
            results.push({
              source: source.name,
              url: source.url,
              newArticles: 0,
              success: false,
              error: 'Skipped due to memory limit',
              skipped: true
            });
            continue; // Skip this scraping source, but continue with others
          }
          // RSS feeds are lightweight, so continue processing them
        }
        
        // Additional check: If memory is getting high (>400MB), add extra delay before scraping
        if (source.monitoring_type === 'SCRAPING' && currentMemMB > 400) {
          console.warn(`⚠️  [CHECK NOW] Memory is high (${currentMemMB}MB), adding extra delay before scraping "${source.name}"...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Extra 2s delay
        }
        
        try {
          const monitoringType = source.monitoring_type || 'RSS';
          let newArticles = [];
          
          // Flow: RSS → ADK → SCRAPING (fallback only if ADK returns 0 articles)
          // Monitoring types:
          // - 'RSS': Use RSS feed directly (url field already contains RSS feed URL from initial setup)
          // - 'ADK': Skip RSS check, go directly to ADK, then scraping fallback if ADK returns 0
          // - 'SCRAPING': Skip RSS discovery (already checked during setup), go directly to ADK, then scraping fallback
          // Note: RSS discovery happens during source setup. If RSS was found, source would be marked as 'RSS' type.
          // For 'Check Now', we don't need to rediscover RSS - just use what was determined during setup.
          let hasRSSFeed = false;
          if (monitoringType === 'RSS') {
            // Source is explicitly marked as RSS - url field already contains the RSS feed URL
            // No need to discover - just use it directly
            hasRSSFeed = true;
            console.log(`📡 [CHECK NOW] [${source.name}] Using RSS feed: ${source.url}`);
          } else if (monitoringType === 'ADK') {
            // ADK monitoring type: skip RSS check, go directly to ADK
            hasRSSFeed = false;
            console.log(`🤖 [CHECK NOW] [${source.name}] ADK monitoring type - using ADK directly`);
          } else {
            // For SCRAPING sources: RSS discovery already happened during setup
            // If RSS was found, source would be 'RSS' type. Since it's 'SCRAPING', no RSS was found.
            // Skip RSS discovery and go straight to ADK (which was working before)
            hasRSSFeed = false;
            console.log(`🤖 [CHECK NOW] [${source.name}] SCRAPING type - RSS already checked during setup, using ADK`);
          }
          
          if (hasRSSFeed) {
            // RSS/JSON Feed: process ALL new articles from the feed
            console.log(`📡 [CHECK NOW] [${source.name}] Checking RSS/JSON feed: ${source.url}`);
            const rssStartTime = Date.now();
            
            // Process recent articles from RSS feed (limit to 50 for speed)
            // Pass allowManual flag to optimize RSS processing for manual checks
            newArticles = await this.checkFeedLimited(source, 50, isManual);
            const rssDuration = Date.now() - rssStartTime;
            console.log(`✅ [CHECK NOW] [${source.name}] RSS check completed in ${rssDuration}ms, found ${newArticles.length} new articles`);
            
            totalNewArticlesProcessed += newArticles.length;
          } else {
            // No RSS feed found (or ADK monitoring type) - try ADK, then scraping fallback if ADK returns 0
            const scrapeStartTime = Date.now();
            let articles = [];
            
            const adkMessage = monitoringType === 'ADK' 
              ? `Using ADK monitoring type from: ${source.url}`
              : `No RSS feed, trying ADK from: ${source.url}`;
            console.log(`🤖 [CHECK NOW] [${source.name}] ${adkMessage}`);
            
            try {
              articles = await this.adkScraper.scrapeArticles(source);
              
              const sourceDomain = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
              
              // Check if ADK returned valid results (not empty, not wrong domain)
              if (articles.length === 0) {
                console.log(`⚠️ [CHECK NOW] [${source.name}] ADK returned 0 articles, falling back to traditional scraper`);
              } else {
                // Verify articles are from correct domain
                const validArticles = articles.filter(article => {
                  try {
                    const articleDomain = new URL(article.link || article.url).hostname.replace(/^www\./, '').toLowerCase();
                    return articleDomain === sourceDomain;
                  } catch (e) {
                    return false;
                  }
                });
                
                if (validArticles.length === 0 && articles.length > 0) {
                  console.log(`⚠️ [CHECK NOW] [${source.name}] ADK returned ${articles.length} articles from wrong domain, falling back to traditional scraper`);
                  articles = []; // Clear invalid articles
                } else if (validArticles.length < articles.length) {
                  console.log(`⚠️ [CHECK NOW] [${source.name}] ADK returned ${articles.length} articles, but only ${validArticles.length} are from correct domain`);
                  articles = validArticles; // Keep only valid ones
                }
              }
              
              const scrapeDuration = Date.now() - scrapeStartTime;
              if (articles.length > 0) {
                console.log(`✅ [CHECK NOW] [${source.name}] ADK extracted ${articles.length} articles in ${scrapeDuration}ms`);
              } else {
                console.log(`❌ [CHECK NOW] [${source.name}] ADK failed (0 valid articles) in ${scrapeDuration}ms`);
              }
            } catch (scrapeError) {
              console.error(`❌ [CHECK NOW] [${source.name}] ADK error: ${scrapeError.message}`);
              articles = [];
            }
            
            // Fallback to traditional scraper ONLY if ADK returned 0 articles
            // webScraper handles Playwright first, then static scraping as fallback (same as original implementation)
            if (articles.length === 0) {
              // Check memory before using Playwright (which is memory-intensive)
              const currentMemMB = getMemoryMB();
              if (currentMemMB > MEMORY_LIMIT_MB) {
                console.warn(`⚠️  [CHECK NOW] [${source.name}] Memory too high (${currentMemMB}MB), skipping Playwright fallback to prevent crash`);
                articles = []; // Skip scraping if memory is too high
              } else {
                console.log(`🔄 [CHECK NOW] [${source.name}] ADK returned 0 articles, falling back to traditional scraper (Playwright/static)...`);
                try {
                  articles = await this.webScraper.scrapeArticles(source);
                const fallbackDuration = Date.now() - scrapeStartTime;
                if (articles.length > 0) {
                  console.log(`✅ [CHECK NOW] [${source.name}] Traditional scraper extracted ${articles.length} articles in ${fallbackDuration}ms`);
                } else {
                  console.log(`❌ [CHECK NOW] [${source.name}] Traditional scraper also returned 0 articles`);
                }
              } catch (fallbackError) {
                console.error(`❌ [CHECK NOW] [${source.name}] Traditional scraper also failed: ${fallbackError.message}`);
                articles = [];
              }
            }
              
              // Clean up browser if traditional scraper was used (Playwright creates browser instances)
              // Playwright browsers need extra time to fully release memory
              try {
                if (this.webScraper && typeof this.webScraper.close === 'function') {
                  await this.webScraper.close();
                }
              } catch (closeError) {
                // Ignore cleanup errors
              }
              
              // CRITICAL: Extra delay after Playwright usage to allow browser process to fully close
              // Playwright browsers can take 2-3 seconds to fully release memory
              // Without this delay, memory accumulates when processing multiple sources
              console.log(`⏳ [CHECK NOW] [${source.name}] Waiting for Playwright browser cleanup (2s delay)...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              // Force garbage collection after Playwright cleanup
              try {
                if (global.gc) {
                  global.gc();
                  console.log(`🧹 [CHECK NOW] [${source.name}] Forced garbage collection after Playwright cleanup`);
                }
              } catch (gcError) {
                // Ignore cleanup errors
              }
            }
            
            // Memory cleanup (for ADK-only sources too)
            try {
              if (global.gc) {
                global.gc();
              }
            } catch (gcError) {
              // Ignore cleanup errors
            }
            
            // Small delay for stability (reduced for ADK-only, longer already added for Playwright)
            const delayMs = articles.length > 0 && articles[0].link ? 500 : 1000;
            await new Promise(resolve => setTimeout(resolve, delayMs));
            
            console.log(`📰 [CHECK NOW] [${source.name}] Checking ${articles.length} articles for new ones...`);
            
            // MEMORY OPTIMIZATION: Check all articles, but filter out existing ones first (no DB queries in loop)
            // Then process new ones in batches to control memory usage
            const newArticlesToProcess = [];
            let checkedCount = 0;
            
            // First pass: identify all new articles (quick check, no heavy processing)
            for (const article of articles) {
              checkedCount++;
              try {
                // Ensure article has link property (some scrapers return 'url' instead)
                const articleLink = article.link || article.url;
                if (!articleLink) {
                  console.warn(`⚠️  [CHECK NOW] [${source.name}] Article missing link/url: ${JSON.stringify({title: article.title, link: article.link, url: article.url})}`);
                  continue;
                }
                const exists = await database.articleExists(articleLink);
                if (exists) {
                  continue; // Skip existing articles
                }
                // Ensure article object has link property for consistency
                if (!article.link && article.url) {
                  article.link = article.url;
                }
                // This is a new article - add to queue
                newArticlesToProcess.push(article);
              } catch (err) {
                console.warn(`⚠️  [CHECK NOW] [${source.name}] Error checking article existence: ${err.message}`);
              }
            }
            
            console.log(`📊 [CHECK NOW] [${source.name}] Found ${newArticlesToProcess.length} new articles out of ${checkedCount} checked`);
            
            if (newArticlesToProcess.length === 0) {
              console.log(`ℹ️  [CHECK NOW] [${source.name}] No new articles found`);
            }
            
            // Second pass: Process new articles in batches with optimized scraping (better titles/dates)
            let newArticlesFound = 0;
            for (let batchIdx = 0; batchIdx < newArticlesToProcess.length; batchIdx += BATCH_SIZE) {
              const batch = newArticlesToProcess.slice(batchIdx, batchIdx + BATCH_SIZE);
              console.log(`🔄 [CHECK NOW] [${source.name}] Processing batch ${Math.floor(batchIdx / BATCH_SIZE) + 1}/${Math.ceil(newArticlesToProcess.length / BATCH_SIZE)} (${batch.length} articles)`);
              
              // Process batch sequentially (not parallel) to control memory
              for (const article of batch) {
                try {
                  newArticlesFound++;
                  totalNewArticlesProcessed++;
                  console.log(`🆕 [CHECK NOW] [${source.name}] NEW article #${newArticlesFound}: "${article.title.substring(0, 50)}..."`);
                  console.log(`📊 [CHECK NOW] Total new articles processed so far: ${totalNewArticlesProcessed}`);
                  
                  // NEW ARTICLE FOUND - fetch full content and metadata
                  // Ensure title is never null or empty (simple check)
                  let originalTitle = (article.title && article.title.trim()) ? article.title.trim() : 'Untitled Article';
                  
                  // Skip if link is invalid
                  if (!article.link || typeof article.link !== 'string') {
                    console.log(`⚠️  [CHECK NOW] [${source.name}] Invalid link, skipping article`);
                    continue;
                  }
                  
                  // Use optimized scraping logic (same as re-scrape) to get better titles/dates
                  // For manual checks, skip metadata fetch to speed up, but do basic title cleaning
                  let improvedTitle = this.cleanTitle(article.title.trim());
                  
                  // Filter out generic titles
                  if (this.isGenericTitle(improvedTitle)) {
                    console.log(`⚠️  [CHECK NOW] [${source.name}] Skipping article with generic title: "${improvedTitle}"`);
                    continue;
                  }
                  
                  // Extract date from scraped article (lightweight, no full page fetch)
                  let improvedDate = article.datePublished ? new Date(article.datePublished) : null;
                  
                  // For manual checks, try lightweight date extraction (static HTTP fetch) if still no date
                  if (isManual && (!improvedDate || isNaN(improvedDate.getTime()))) {
                    try {
                      const staticDate = await this.extractDateStatic(article.link);
                      if (staticDate) {
                        const d = new Date(staticDate);
                        if (!isNaN(d.getTime())) {
                          improvedDate = d;
                          console.log(`📅 [CHECK NOW] [${source.name}] Extracted date via static fetch: ${d.toISOString()}`);
                        }
                      }
                    } catch (e) {
                      console.log(`⚠️  [CHECK NOW] [${source.name}] Static date fetch failed: ${e.message}`);
                    }
                  }
                  
                  if (!isManual) {
                    // Validate URL before attempting metadata fetch
                    // Skip metadata fetching for invalid URLs (Google redirects, generic URLs, etc.)
                    const shouldSkipMetadata = (() => {
                      try {
                        const url = article.link;
                        if (!url || url === 'null' || url.trim() === '') return true;
                        
                        // Skip Google redirect URLs
                        if (url.includes('vertexaisearch.cloud.google.com') || 
                            url.includes('grounding-api-redirect') ||
                            url.includes('google.com/grounding')) {
                          console.log(`⏩ [CHECK NOW] [${source.name}] Skipping metadata fetch for Google redirect URL`);
                          return true;
                        }
                        
                        // Skip URLs that are clearly invalid (check if URL is valid)
                        try {
                          const urlObj = new URL(url);
                          // If pathname is too short or just "/", likely invalid
                          if (urlObj.pathname.length <= 1) {
                            console.log(`⏩ [CHECK NOW] [${source.name}] Skipping metadata fetch for generic/invalid URL path`);
                            return true;
                          }
                        } catch (e) {
                          console.log(`⏩ [CHECK NOW] [${source.name}] Skipping metadata fetch for invalid URL format`);
                          return true;
                        }
                        
                        return false;
                      } catch (e) {
                        return true; // Skip on any error
                      }
                    })();
                    
                    if (shouldSkipMetadata) {
                      console.log(`⏩ [CHECK NOW] [${source.name}] Skipping metadata fetch for invalid URL`);
                    } else {
                      try {
                        console.log(`🔍 [CHECK NOW] [${source.name}] Fetching optimized metadata (title/date) for: ${article.link.substring(0, 60)}...`);
                        const metadataStartTime = Date.now();
                        
                        // Use extractArticleMetadata - same optimized logic as re-scrape
                        const metadata = await this.extractArticleMetadata(article.link);
                        const metadataDuration = Date.now() - metadataStartTime;
                        console.log(`✅ [CHECK NOW] [${source.name}] Optimized metadata fetched in ${metadataDuration}ms`);
                        
                        // Skip post-metadata delay to speed up
                        
                        // Use article page title if available and better (same logic as re-scrape)
                        if (metadata.title && metadata.title.trim().length > 10) {
                          const newTitle = metadata.title.trim();
                          const newTitleLower = newTitle.toLowerCase();
                          const isGeneric = newTitleLower.includes('blog') ||
                                           newTitleLower.includes('all posts') ||
                                           newTitleLower.includes('latest by topic') ||
                                           newTitleLower.includes('mothership') ||
                                           newTitleLower.includes('backbone of ai infrastructure') ||
                                           newTitleLower.includes('page not found') ||
                                           newTitleLower.includes('500') ||
                                           newTitleLower.includes('internal server error') ||
                                           newTitleLower.includes('just a moment') ||
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
                              console.log(`📝 [CHECK NOW] [${source.name}] Using optimized title: "${improvedTitle.substring(0, 60)}..."`);
                          } else {
                              console.log(`⚠️  [CHECK NOW] [${source.name}] Article page title is generic/error, keeping original`);
                          }
                        } else {
                            console.log(`⚠️  [CHECK NOW] [${source.name}] Article page title not found, keeping original`);
                        }
                        
                        // Use article page date if available (same logic as re-scrape)
                        if (metadata.pubDate) {
                          try {
                            const articlePageDate = new Date(metadata.pubDate);
                            if (!isNaN(articlePageDate.getTime())) {
                                improvedDate = articlePageDate;
                            console.log(`📅 [CHECK NOW] [${source.name}] Found optimized date: ${improvedDate.toISOString()}`);
                        }
                      } catch (e) {
                          console.log(`⚠️  [CHECK NOW] [${source.name}] Invalid date format: ${metadata.pubDate}`);
                      }
                        } else {
                            console.log(`⚠️  [CHECK NOW] [${source.name}] No date found on article page`);
                        }
                      } catch (err) {
                        // If fetching fails, use what we have from listing page
                        console.log(`❌ [CHECK NOW] [${source.name}] Could not fetch optimized metadata: ${err.message} (using listing page data)`);
                      }
                    }
                  } else {
                    console.log(`⏩ [CHECK NOW] [${source.name}] Skipping metadata fetch to speed up manual check`);
                  }
                  
                  // Try lightweight description fetch even during manual checks (static HTML only, no Playwright)
                  let articleDescription = article.description || article.contentSnippet || '';
                  if (!articleDescription || articleDescription.length < 50) {
                    try {
                      const staticDesc = await this.extractDescriptionStatic(article.link);
                      if (staticDesc && staticDesc.length > 50) {
                        articleDescription = staticDesc;
                        console.log(`📝 [CHECK NOW] [${source.name}] Extracted description via static fetch: ${articleDescription.substring(0, 60)}...`);
                      }
                    } catch (descError) {
                      // If description fetch fails, continue with what we have (silent fail for speed)
                    }
                  }
                  
                  // Use scraped content from listing page (skip full content fetch to save memory)
                  let articleContent = article.content || articleDescription || '';
                  
                  // Ensure we have at least a preview or description
                  // Don't skip articles with short content if they have a description (from RSS or listing page)
                  const preview = articleDescription || article.contentSnippet || articleContent.substring(0, 200);
                  
                  // Only skip if BOTH title is too short AND (content AND preview are too short)
                  // Allow articles with good titles even if content/preview is missing (they'll be enriched later)
                  if (improvedTitle.length < 10 && articleContent.length < 20 && (!preview || preview.length < 20)) {
                    console.log(`⚠️  [CHECK NOW] [${source.name}] Skipping article with insufficient title/content/preview (title: ${improvedTitle.length} chars, content: ${articleContent.length} chars, preview: ${preview?.length || 0} chars): "${improvedTitle.substring(0, 50)}..."`);
                    continue;
                  }
                  
                  // MEMORY OPTIMIZATION: Skip AI summary generation for "Check Now" to save memory
                  // AI summaries can be generated later when articles are selected/reviewed
                  const enhancedContent = {
                    content: articleContent,
                    preview: preview.length > 200 ? preview.substring(0, 200) + '...' : preview,
                    title: improvedTitle
                  };
                  
                  // Generate concise hook for dashboard (helps users quickly understand if they're interested)
                  // This is done asynchronously after article is added to avoid blocking
                  let articleHook = null;
                  try {
                    const llmService = require('./llmService');
                    const hookContent = articleContent || articleDescription || preview || '';
                    if (hookContent.length > 50) {
                      // Generate hook asynchronously - don't block article addition
                      // We'll update it after the article is added
                      articleHook = await llmService.generateArticleHook(improvedTitle, hookContent, source.name);
                      console.log(`🎣 [CHECK NOW] [${source.name}] Generated hook: "${articleHook.substring(0, 60)}..."`);
                    }
                  } catch (hookError) {
                    // If hook generation fails, continue without it (non-blocking)
                    console.log(`⚠️  [CHECK NOW] [${source.name}] Hook generation failed: ${hookError.message} (continuing without hook)`);
                  }
                  
                  // Format date using improved date
                  let finalPubDate = null;
                  if (improvedDate && !isNaN(improvedDate.getTime())) {
                    finalPubDate = improvedDate.toISOString();
                  }
                  
                  const articleObj = {
                    sourceId: source.id,
                    title: improvedTitle, // Use optimized title from article page
                    link: article.link,
                    content: enhancedContent.content || articleContent || '',
                    preview: enhancedContent.preview || articleDescription || article.description || article.contentSnippet || '',
                    pubDate: finalPubDate, // Use optimized date from article page
                    sourceName: source.name || 'Unknown Source',
                    category: source.category || 'General',
                    status: 'new',
                    publisherDescription: articleDescription || article.description || article.contentSnippet || null,
                    articleHook: articleHook // Concise one-liner hook for dashboard
                  };
                  
                  // Final validation: Skip articles with generic/error titles before adding to database
                  if (this.isGenericTitle(articleObj.title)) {
                    console.log(`⚠️  [CHECK NOW] [${source.name}] Skipping article with generic/error title before database add: "${articleObj.title}"`);
                    continue;
                  }
                  
                  if (articleObj.title && articleObj.title.trim() !== '' && articleObj.link) {
                    try {
                      await database.addArticle(articleObj);
                      newArticles.push({
                        id: articleObj.sourceId,
                        title: articleObj.title,
                        link: articleObj.link,
                        pubDate: articleObj.pubDate
                      });
                      
                      // Log new article found with optimized data
                      console.log(`✨ [CHECK NOW] [${source.name}] NEW ARTICLE ADDED (with optimized title/date): "${articleObj.title.substring(0, 60)}..." | Date: ${articleObj.pubDate || 'NO DATE'}`);
                      
                      // Removed per-article delay to speed up
                    } catch (addErr) {
                      // Handle duplicate key error gracefully (might happen due to race conditions or duplicate links)
                      if (addErr.code === '23505' || addErr.message?.includes('duplicate key')) {
                        console.log(`ℹ️  [CHECK NOW] [${source.name}] Article already exists (duplicate link): ${articleObj.link.substring(0, 60)}...`);
                        continue; // Skip this article, it was already added
                      }
                      throw addErr; // Re-throw if it's a different error
                    }
                  }
                } catch (articleErr) {
                  // Handle duplicate key error gracefully
                  if (articleErr.code === '23505' || articleErr.message?.includes('duplicate key')) {
                    console.log(`ℹ️  [CHECK NOW] [${source.name}] Article already exists: ${article.link?.substring(0, 60) || 'unknown'}...`);
                    continue; // Skip this article
                  }
                  console.error(`❌ [CHECK NOW] [${source.name}] Error processing article:`, articleErr.message);
                  // Continue with next article
                }
              }
              
              // Removed per-batch delay to speed up
            }
            
            // Removed per-source delay to speed up
            
            if (newArticles.length > 0) {
              console.log(`✅ [CHECK NOW] [${source.name}] Added ${newArticles.length} new article(s)`);
            } else {
              console.log(`ℹ️  [CHECK NOW] [${source.name}] No new articles found (checked ${articles.length} articles, all already in database)`);
            }
            
            // Update last_checked timestamp (scraping result is already stored by webScraper)
            try {
            await database.updateSourceLastChecked(source.id);
            } catch (updateError) {
              console.warn(`⚠️  [CHECK NOW] [${source.name}] Could not update last_checked timestamp: ${updateError.message}`);
              // Don't fail the entire process if timestamp update fails
            }
          }
          
          results.push({
            source: source.name,
            url: source.url,
            newArticles: newArticles.length,
            success: true,
            monitoring_type: monitoringType
          });
          
          // MEMORY OPTIMIZATION: Small delay between sources to allow GC
          // Especially important after scraping sources that use Playwright or ADK
          if ((monitoringType === 'SCRAPING' || monitoringType === 'ADK') && i < activeSources.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
          // Log memory usage if available (for monitoring) - use RSS for total memory
          if (process.memoryUsage && i % 3 === 0) {
            const memDetails = getMemoryDetails();
            if (memDetails) {
              console.log(`💾 [CHECK NOW] Memory after source ${i + 1}: RSS=${memDetails.rss}MB (heap=${memDetails.heapUsed}MB, external=${memDetails.external}MB)`);
            }
          }
        } catch (error) {
          console.error(`❌ [CHECK NOW] [${source.name}] Error checking ${source.monitoring_type || 'RSS'} source:`, error.message);
          
          // Ensure browser is closed even if error occurred
          try {
            await this.webScraper.close();
          } catch (closeError) {
            // Ignore close errors during error handling
          }
          
          results.push({
            source: source.name,
            url: source.url,
            newArticles: 0,
            success: false,
            error: error.message
          });
          
          // Continue to next source - don't crash the entire process
          console.log(`⏭️  [CHECK NOW] Continuing with next source despite error...`);
        }
      }
      
      const totalDuration = Date.now() - startTime;
      const successfulSources = results.filter(r => r.success).length;
      const totalNewArticles = results.reduce((sum, r) => sum + r.newArticles, 0);
      
      console.log(`\n✅ [CHECK NOW] Feed check completed in ${totalDuration}ms`);
      console.log(`📊 [CHECK NOW] Summary: ${successfulSources}/${results.length} sources successful, ${totalNewArticles} new articles found`);
      
      // Automatically enrich dates for newly found scraping articles that don't have dates
      if (totalNewArticles > 0 && allowManual) {
        console.log(`\n🔍 [CHECK NOW] Auto-enriching dates for new articles without dates...`);
        try {
          // Use a reasonable limit - try to enrich up to the number of new articles found
          // Increased limit to 50 to cover more articles
          const enrichLimit = Math.min(totalNewArticles, 50);
          const enrichedCount = await this.enrichNewArticlesDates(enrichLimit);
          if (enrichedCount > 0) {
            console.log(`✨ [CHECK NOW] Auto-enriched dates for ${enrichedCount} new articles`);
          } else {
            console.log(`ℹ️  [CHECK NOW] No dates found for new articles (may require full page rendering)`);
          }
        } catch (enrichError) {
          console.warn(`⚠️  [CHECK NOW] Auto-enrichment failed (non-critical): ${enrichError.message}`);
          // Don't fail Check Now if enrichment fails
        }
      }
      
      console.log(`🚀 [CHECK NOW] Finished at ${new Date().toISOString()}\n`);
      
      return results;
    } catch (error) {
      console.error('Error checking all feeds:', error.message || error);
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
  // allowManual: if true, skip expensive content enhancement to speed up
  async checkFeedLimited(source, maxArticles = 5, allowManual = false) {
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
      console.log(`📰 [CHECK NOW] Processing ${limitedItems.length} most recent articles from ${source.name} (feed has ${feed.items.length} total, checking up to ${maxArticles})`);
      
      for (const item of limitedItems) {
        try {
          // Skip if no link
          if (!item.link) {
            continue;
          }
          
        // Check if article already exists
        const exists = await database.articleExists(item.link);
          if (exists) {
            continue; // Skip existing articles
          }
          
          // Generate AI-enhanced content (skip for manual checks to speed up)
          const enhancedContent = allowManual 
            ? { title: item.title || 'Untitled', content: item.content || item.contentSnippet || item.description || '', preview: (item.contentSnippet || item.description || '').substring(0, 200) }
            : await this.enhanceArticleContent(item);
          
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

          // Generate concise hook for dashboard (helps users quickly understand if they're interested)
          let articleHook = null;
          try {
            const llmService = require('./llmService');
            const hookContent = enhancedContent.content || item.content || item.description || item.contentSnippet || '';
            if (hookContent.length > 50) {
              articleHook = await llmService.generateArticleHook(
                enhancedContent.title || item.title || 'Untitled',
                hookContent,
                source.name
              );
            }
          } catch (hookError) {
            // If hook generation fails, continue without it (non-blocking)
            console.log(`⚠️  [CHECK NOW] [${source.name}] Hook generation failed: ${hookError.message} (continuing without hook)`);
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
            articleHook: articleHook, // Concise one-liner hook for dashboard
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

          // Try to add article, handle duplicate key errors gracefully
          try {
          const articleId = await database.addArticle(article);
          newArticles.push({
            id: articleId,
            title: article.title,
            link: article.link
          });
          } catch (addError) {
            // Handle duplicate key error gracefully (might happen due to race conditions)
            if (addError.code === '23505' || addError.message?.includes('duplicate key')) {
              console.log(`ℹ️  Article already exists (race condition): ${item.link}`);
              continue; // Skip this article, it was added by another process
            }
            // Re-throw other errors
            throw addError;
          }
        } catch (itemError) {
          console.error(`❌ Error processing RSS item from ${source.name}:`, itemError.message);
          // Continue with next item instead of crashing
          continue;
        }
      }

      console.log(`📝 Added ${newArticles.length} new articles from ${source.name}`);
      
      // Update last_checked timestamp for this source
      await database.updateSourceLastChecked(source.id);
      
      return newArticles;
    } catch (error) {
      console.error(`Error checking feed for ${source.name}:`, error.message || error);
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

          // Generate concise hook for dashboard (helps users quickly understand if they're interested)
          let articleHook = null;
          try {
            const llmService = require('./llmService');
            const hookContent = enhancedContent.content || item.content || item.description || item.contentSnippet || '';
            if (hookContent.length > 50) {
              articleHook = await llmService.generateArticleHook(
                enhancedContent.title || item.title || 'Untitled',
                hookContent,
                source.name
              );
            }
          } catch (hookError) {
            // If hook generation fails, continue without it (non-blocking)
            console.log(`⚠️  [CHECK NOW] [${source.name}] Hook generation failed: ${hookError.message} (continuing without hook)`);
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
            articleHook: articleHook, // Concise one-liner hook for dashboard
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
      console.error(`Error checking feed ${source.name}:`, error.message || error);
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
      console.error('Error enhancing article content:', error.message || error);
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
  // Tries Playwright first (for JS-rendered sites), then falls back to static scraping
  async fetchFullArticleContent(url) {
    // Try Playwright first for JS-rendered content
    try {
      const { chromium } = require('playwright');
      let browser = null;
      let page = null;
      
      try {
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        page = await browser.newPage();
        
        // Set realistic browser headers
        if (typeof page.setUserAgent === 'function') {
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        }
        if (typeof page.setExtraHTTPHeaders === 'function') {
          await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
          });
        }
        
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 20000 
        });
        
        // Check for Cloudflare challenge
        const isCloudflareChallenge = await page.evaluate(() => {
          return document.body.textContent.includes('Checking your browser') ||
                 document.body.textContent.includes('Just a moment') ||
                 document.title.includes('Just a moment');
        });
        
        if (isCloudflareChallenge) {
          console.log('⚠️  Cloudflare challenge detected, waiting...');
          await page.waitForTimeout(5000);
          try {
            await page.waitForFunction(() => {
              return !document.body.textContent.includes('Checking your browser') &&
                     !document.body.textContent.includes('Just a moment');
            }, { timeout: 15000 });
          } catch (e) {
            console.warn('Cloudflare challenge may not have passed');
          }
        }
        
        // Wait for content to load - longer wait for JS-rendered sites
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(3000); // Additional wait for JS to execute
        
        // Extract content using Playwright
        const content = await page.evaluate(() => {
          // Try common content selectors in order of preference
          const selectors = [
            'article',
            'main article',
            '.post-content',
            '.entry-content',
            '.article-content',
            '[class*="article-content"]',
            '[class*="post-content"]',
            '[class*="entry-content"]',
            '.content',
            'section[data-testid="post"]',
            'div[data-article-body=true]',
            'div.post',
            '.body',
            '[class*="article"]',
            '[class*="post"]',
            '[class*="content"]',
            'main' // Last resort
          ];
          
          let best = '';
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
              // Get text from paragraphs, headings, lists, blockquotes
              const text = Array.from(el.querySelectorAll('p, li, h2, h3, h4, blockquote, div[class*="text"], div[class*="paragraph"]'))
                .map(n => {
                  const txt = n.textContent.trim();
                  // Filter out very short text (likely navigation/buttons)
                  return txt.length > 20 ? txt : '';
                })
                .filter(t => t.length > 0)
                .join('\n\n');
              
              // Also try direct text content if selector found something
              if (text.length < 200) {
                const directText = el.textContent.trim();
                // Remove common non-content elements
                const cleaned = directText
                  .replace(/\s+/g, ' ')
                  .replace(/Subscribe|Follow|Share|Like|Comment/gi, '')
                  .trim();
                if (cleaned.length > text.length && cleaned.length > 200) {
                  return cleaned;
                }
              }
              
              if (text.length > best.length) best = text;
            }
          }
          
          // Fallback: all paragraphs in main content area
          if (best.length < 200) {
            const main = document.querySelector('main, [role="main"], body');
            if (main) {
              const all = Array.from(main.querySelectorAll('p'))
                .map(n => n.textContent.trim())
                .filter(t => t.length > 20) // Filter short paragraphs
                .join('\n\n');
              if (all.length > best.length) best = all;
            }
          }
          
          return best;
        });
        
        await page.close();
        await browser.close();
        
        // Clean and validate content
        if (content) {
          const cleaned = this.cleanContent(content);
          // Only return if we got substantial content (at least 200 chars)
          // This prevents returning placeholder/loading text
          if (cleaned.length > 200) {
            return cleaned;
          }
        }
      } catch (playwrightError) {
        // Playwright failed - fall back to static scraping
        if (browser) {
          try {
            await browser.close();
          } catch (e) {
            // Ignore close errors
          }
        }
        // Continue to static scraping fallback
      }
    } catch (playwrightNotAvailable) {
      // Playwright not available - use static scraping
    }
    
    // Fallback to static scraping (for non-JS sites or if Playwright fails)
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

  // Basic title cleaning for scraped articles (remove common prefixes and suffixes)
  cleanTitle(title) {
    if (!title) return 'Untitled Article';
    
    let cleaned = title.trim();
    
    // Remove common prefixes like "articlePINNED", "article", "PINNED"
    // Handle "articlePINNED" as a single word (case-insensitive)
    if (/^articlePINNED/i.test(cleaned)) {
      cleaned = cleaned.replace(/^articlePINNED\s*/i, '');
    }
    // Remove other variations
    cleaned = cleaned.replace(/^(PINNED|article|Article)\s*/i, '');
    // Remove prefixes that might have different casing variations (with spaces)
    cleaned = cleaned.replace(/^article\s*pinned\s*/i, '');
    cleaned = cleaned.replace(/^pinned\s*article\s*/i, '');
    
    // Remove common suffixes like "2025-12-113 min read", "3 min read", etc.
    cleaned = cleaned.replace(/\s*\d{4}-\d{2}-\d{1,2}\s*\d+\s*min\s*read.*$/i, '');
    cleaned = cleaned.replace(/\s*\d+\s*min\s*read.*$/i, '');
    
    // Remove trailing dates in various formats
    cleaned = cleaned.replace(/\s*\d{4}-\d{2}-\d{2}.*$/i, '');
    
    // Remove extra whitespace and dots
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/\.{3,}/g, '...'); // Normalize ellipsis
    
    return cleaned || 'Untitled Article';
  }

  // Lightweight static description extraction (no Playwright) for manual runs
  async extractDescriptionStatic(url) {
    try {
      const resp = await axios.get(url, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DistroScraper/1.0)',
        },
        maxContentLength: 2 * 1024 * 1024, // 2MB
      });
      const html = resp.data;
      const $ = cheerio.load(html);

      // Try meta tags first
      let description = '';
      const ogDesc = $('meta[property="og:description"]').attr('content') || '';
      const metaDesc = $('meta[name="description"]').attr('content') || '';
      const titleText = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
      
      // Use OG description if it exists and is meaningful (not just the title)
      if (ogDesc && ogDesc.length > 50 && ogDesc.toLowerCase() !== titleText.toLowerCase()) {
        description = ogDesc;
      } else if (metaDesc && metaDesc.length > 50 && metaDesc.toLowerCase() !== titleText.toLowerCase()) {
        description = metaDesc;
      }
      
      // If no good meta description, use first paragraph from article content
      if (!description || description.length < 50) {
        const firstParagraph = $('article p, main p, [class*="article-content"] p, [class*="post-content"] p').first().text().trim();
        if (firstParagraph && firstParagraph.length > 50) {
          description = firstParagraph.substring(0, 300) + (firstParagraph.length > 300 ? '...' : '');
        } else {
          // Last resort: any paragraph
          const anyParagraph = $('p').first().text().trim();
          if (anyParagraph && anyParagraph.length > 50) {
            description = anyParagraph.substring(0, 300) + (anyParagraph.length > 300 ? '...' : '');
          }
        }
      }
      
      return description || null;
    } catch (err) {
      return null;
    }
  }

  // Lightweight static date extraction (no Playwright) for manual runs
  async extractDateStatic(url) {
    const parseDate = (text) => {
      if (!text) return null;
      const patterns = [
        // Full month name: November 12, 2025 or Nov 12, 2025
        /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i,
        // 12 November 2025
        /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/i,
        // YYYY-MM-DD
        /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/,
        // MM/DD/YYYY or DD/MM/YYYY
        /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/,
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          const dt = new Date(match[0]);
          if (!isNaN(dt.getTime())) {
            return dt.toISOString();
          }
        }
      }
      // Fallback: Date.parse
      const dt = new Date(text);
      return isNaN(dt.getTime()) ? null : dt.toISOString();
    };

    try {
      const resp = await axios.get(url, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DistroScraper/1.0)',
        },
        maxContentLength: 2 * 1024 * 1024, // 2MB to avoid huge pages
      });
      const html = resp.data;
      const $ = cheerio.load(html);

      // Try structured selectors first
      const selectors = [
        'meta[property="article:published_time"]',
        'meta[name="article:published_time"]',
        'meta[property="og:article:published_time"]',
        'meta[name="publishdate"]',
        'meta[name="pubdate"]',
        'meta[name="date"]',
        'time[datetime]',
        'time',
        '[datetime]',
        '[data-date]',
        '[data-published]',
        '[class*="date"]',
        '[class*="published"]',
        '[class*="publish"]',
      ];

      for (const sel of selectors) {
        const el = $(sel).first();
        if (el && el.length) {
          const val =
            el.attr('content') ||
            el.attr('datetime') ||
            el.attr('date') ||
            el.attr('data-date') ||
            el.text();
          const parsed = parseDate(val);
          if (parsed) return parsed;
        }
      }

      // Try JSON-LD
      try {
        $('script[type="application/ld+json"]').each((_, script) => {
          if (!script || !script.children || script.children.length === 0) return;
          const jsonText = $(script).html();
          if (!jsonText) return;
          const data = JSON.parse(jsonText);
          const pick = (obj) => {
            if (!obj) return null;
            if (obj.datePublished) return parseDate(obj.datePublished);
            if (obj.dateCreated) return parseDate(obj.dateCreated);
            return null;
          };
          let cand = pick(data);
          if (!cand && Array.isArray(data)) {
            for (const item of data) {
              cand = pick(item);
              if (cand) break;
            }
          }
          if (cand) throw new Error(`DATE_FOUND:${cand}`);
        });
      } catch (e) {
        if (typeof e.message === 'string' && e.message.startsWith('DATE_FOUND:')) {
          return e.message.replace('DATE_FOUND:', '');
        }
        // else ignore JSON parse errors
      }

      // As a last resort, scan body text
      const bodyText = $('body').text().substring(0, 5000); // limit for perf
      const parsed = parseDate(bodyText);
      return parsed;
    } catch (err) {
      // Log softly and return null - only show essential error info
      const errorMsg = err.response?.status 
        ? `HTTP ${err.response.status}` 
        : err.message || 'Unknown error';
      // Only log if it's not a 404 (common for old/deleted articles)
      if (err.response?.status !== 404) {
        console.log(`⚠️  extractDateStatic failed for ${url}: ${errorMsg}`);
      }
      return null;
    }
  }
  
  // Check if title is generic/non-article (should be filtered out)
  isGenericTitle(title) {
    if (!title || title.length < 10) return true;
    
    const lowerTitle = title.toLowerCase();
    const genericPatterns = [
      /^follow us on/i,
      /^posts? related to/i,
      /^latest by topic/i,
      /^read more/i,
      /^view all/i,
      /^see more/i,
      /^click here/i,
      /^subscribe/i,
      /^newsletter/i,
      /^blog$/i,
      /^home$/i,
      /^search$/i,
      /^category/i,
      /^tag:/i,
      /^author:/i,
      /^swarm community call.*recap$/i,
      /^article$/i,
      /^untitled/i,
      // Error titles from invalid URLs
      /^page not found/i,
      /^404/i,
      /^500/i,
      /internal server error/i,
      /^just a moment/i,
      /^cloudflare/i,
      /access denied/i,
      /forbidden/i,
      /could not be found/i,
      /this page could not be found/i,
      /page not found/i,
      /not found/i
    ];
    
    return genericPatterns.some(pattern => pattern.test(lowerTitle));
  }

  // Auto-enrich dates for newly found articles (called automatically after Check Now)
  async enrichNewArticlesDates(maxArticles = 20) {
    const getMemoryMB = () => {
      if (process.memoryUsage) {
        const memUsage = process.memoryUsage();
        return Math.round(memUsage.rss / 1024 / 1024);
      }
      return 0;
    };
    
    const MEMORY_LIMIT_MB = 450;
    const BATCH_SIZE = 2; // Smaller batches for auto-enrichment (less aggressive)
    const ENRICH_LIMIT = Math.min(maxArticles, 50); // Increased limit to 50 articles for better coverage
    
    try {
      // Get recently added articles (last 1 hour) with missing dates from scraping sources
      // This catches articles from the current Check Now run and any recent ones
      const result = await database.pool.query(`
        SELECT a.id, a.title, a.link, a.pub_date, a.source_id, a.source_name, a.created_at,
               s.monitoring_type
        FROM articles a
        LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.pub_date IS NULL
          AND (s.monitoring_type = 'SCRAPING' OR a.source_name IN (
            SELECT name FROM sources WHERE monitoring_type = 'SCRAPING'
          ))
          AND a.created_at >= NOW() - INTERVAL '2 hours'
        ORDER BY a.created_at DESC
        LIMIT $1
      `, [ENRICH_LIMIT]);
      
      const articles = result.rows;
      
      if (articles.length === 0) {
        return 0;
      }
      
      console.log(`📊 [ENRICH] Found ${articles.length} new articles without dates to enrich`);
      
      let enriched = 0;
      
      // Process in small batches
      const totalBatches = Math.ceil(articles.length / BATCH_SIZE);
      for (let i = 0; i < articles.length; i += BATCH_SIZE) {
        const batch = articles.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        console.log(`   📦 [ENRICH] Processing batch ${batchNum}/${totalBatches} (${batch.length} articles)`);
        
        // Check memory before batch
        const memoryBefore = getMemoryMB();
        if (memoryBefore > MEMORY_LIMIT_MB) {
          console.log(`⚠️  [ENRICH] Memory too high (${memoryBefore}MB), stopping auto-enrichment`);
          break;
        }
        
        // Process each article in batch
        for (const article of batch) {
          try {
            console.log(`   🔍 [ENRICH] Processing article ${article.id}: ${article.title?.substring(0, 60)}...`);
            // Use extractArticleMetadata to get date from fully rendered page
            const metadata = await this.extractArticleMetadata(article.link);
            
            if (metadata && metadata.pubDate) {
              await database.updateArticle(article.id, { pub_date: metadata.pubDate });
              enriched++;
              console.log(`   ✅ [ENRICH] Enriched date (${metadata.pubDate}) for: ${article.title?.substring(0, 50)}...`);
            } else {
              console.log(`   ⚠️  [ENRICH] No date found for: ${article.title?.substring(0, 50)}...`);
            }
            
            // Small delay between articles
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Check memory after each article
            const memoryAfter = getMemoryMB();
            if (memoryAfter > MEMORY_LIMIT_MB) {
              console.log(`⚠️  [ENRICH] Memory exceeded limit (${memoryAfter}MB), stopping`);
              return enriched;
            }
          } catch (error) {
            console.warn(`   ⚠️  [ENRICH] Failed to enrich ${article.id}: ${error.message}`);
            // Continue with next article
          }
        }
        
        // Delay between batches
        if (i + BATCH_SIZE < articles.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Force GC if available
          if (global.gc) {
            global.gc();
          }
        }
      }
      
      return enriched;
    } catch (error) {
      console.error(`❌ [ENRICH] Error in auto-enrichment: ${error.message}`);
      return 0; // Return 0 on error, don't throw
    }
  }

  // Extract article metadata from a URL
  // Tries Playwright first (for JS-rendered sites), then falls back to static scraping
  async extractArticleMetadata(url) {
    // Try Playwright first for JS-rendered content
    try {
      const { chromium } = require('playwright');
      let browser = null;
      let page = null;
      
      try {
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        page = await browser.newPage();
        
        // Set realistic browser headers
        if (typeof page.setUserAgent === 'function') {
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        }
        if (typeof page.setExtraHTTPHeaders === 'function') {
          await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
          });
        }
        
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 20000 
        });
        
        // Check for Cloudflare challenge
        const isCloudflareChallenge = await page.evaluate(() => {
          return document.body.textContent.includes('Checking your browser') ||
                 document.body.textContent.includes('Just a moment') ||
                 document.title.includes('Just a moment');
        });
        
        if (isCloudflareChallenge) {
          console.log('⚠️  Cloudflare challenge detected, waiting...');
          await page.waitForTimeout(5000);
          try {
            await page.waitForFunction(() => {
              return !document.body.textContent.includes('Checking your browser') &&
                     !document.body.textContent.includes('Just a moment');
            }, { timeout: 15000 });
          } catch (e) {
            console.warn('Cloudflare challenge may not have passed');
          }
        }
        
        // Wait for content to load
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(3000);
        
        // Extract metadata using Playwright
        const metadata = await page.evaluate(() => {
          // Extract title
          let title = '';
          let titleSource = '';
          // Try Open Graph first
          const ogTitle = document.querySelector('meta[property="og:title"]');
          if (ogTitle) {
            title = ogTitle.getAttribute('content') || '';
            titleSource = 'og:title';
          }
          // Try JSON-LD
          if (!title) {
            const jsonLd = document.querySelector('script[type="application/ld+json"]');
            if (jsonLd) {
              try {
                const data = JSON.parse(jsonLd.textContent);
                if (data.headline) {
                  title = data.headline;
                  titleSource = 'JSON-LD headline';
                } else if (data.name) {
                  title = data.name;
                  titleSource = 'JSON-LD name';
                }
              } catch (e) {
                // Invalid JSON
              }
            }
          }
          // Try article H1
          if (!title) {
            const h1 = document.querySelector('article h1, main h1, [class*="article"] h1');
            if (h1) {
              title = h1.textContent.trim();
              titleSource = 'article h1';
            }
          }
          // Fallback to page title
          if (!title) {
            title = document.title || '';
            titleSource = 'page title';
          }
          
          // Check if this is a 404 or error page - if so, don't use the title
          const isErrorPage = title.toLowerCase().includes('404') ||
                             title.toLowerCase().includes('page not found') ||
                             title.toLowerCase().includes('could not be found') ||
                             title.toLowerCase().includes('not found') ||
                             document.body.textContent.toLowerCase().includes('404') ||
                             document.body.textContent.toLowerCase().includes('page not found');
          
          if (isErrorPage) {
            console.log(`⚠️  [extractArticleMetadata] Detected 404/error page, returning null title`);
            title = null; // Don't use error page titles
          }
          
          // Extract description
          let description = '';
          const ogDesc = document.querySelector('meta[property="og:description"]');
          if (ogDesc) {
            description = ogDesc.getAttribute('content') || '';
          }
          if (!description) {
            const metaDesc = document.querySelector('meta[name="description"]');
            if (metaDesc) {
              description = metaDesc.getAttribute('content') || '';
            }
          }
          
          // If OG description is just the title (too short or same as title), use first paragraph
          if (description && description.length < 50) {
            const firstParagraph = document.querySelector('article p, main p, [class*="article-content"] p, [class*="post-content"] p');
            if (firstParagraph) {
              const paraText = firstParagraph.textContent.trim();
              if (paraText && paraText.length > 50) {
                description = paraText.substring(0, 300);
              }
            }
          }
          
          // Extract date - try multiple strategies
          let pubDate = null;
          
          // Strategy 1: Structured elements
          const timeEl = document.querySelector('time[datetime]');
          if (timeEl) {
            pubDate = timeEl.getAttribute('datetime');
          }
          if (!pubDate) {
            const pubDateMeta = document.querySelector('meta[property="article:published_time"], meta[name="publish-date"], meta[name="date"]');
            if (pubDateMeta) {
              pubDate = pubDateMeta.getAttribute('content');
            }
          }
          
          // Strategy 2: Look in article header/author area for date text
          if (!pubDate) {
            const articleHeader = document.querySelector('article header, [class*="article-header"], [class*="post-header"], [class*="entry-header"]');
            if (articleHeader) {
              const headerText = articleHeader.textContent;
              // Look for date patterns: "Nov 21, 2025", "November 21, 2025", etc.
              const datePatterns = [
                /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i,
                /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
                /\b(\d{1,2})[-/](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/](\d{2,4})\b/i,
                /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/
              ];
              
              for (const pattern of datePatterns) {
                const match = headerText.match(pattern);
                if (match) {
                  try {
                    const dateStr = match[0];
                    const date = new Date(dateStr);
                    if (!isNaN(date.getTime())) {
                      // Validate date is reasonable (not too far in past/future)
                      const now = new Date();
                      const yearDiff = date.getFullYear() - now.getFullYear();
                      if (yearDiff >= -10 && yearDiff <= 2) {
                        pubDate = date.toISOString();
                        break;
                      }
                    }
                  } catch (e) {
                    // Invalid date, continue
                  }
                }
              }
            }
          }
          
          // Strategy 3: Look in article body near the top for date patterns
          if (!pubDate) {
            const articleBody = document.querySelector('article, [class*="article-content"], [class*="post-content"], main');
            if (articleBody) {
              // Get first 500 chars (likely to contain date if present)
              const bodyText = articleBody.textContent.substring(0, 500);
              const datePatterns = [
                /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i,
                /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i
              ];
              
              for (const pattern of datePatterns) {
                const match = bodyText.match(pattern);
                if (match) {
                  try {
                    const dateStr = match[0];
                    const date = new Date(dateStr);
                    if (!isNaN(date.getTime())) {
                      const now = new Date();
                      const yearDiff = date.getFullYear() - now.getFullYear();
                      if (yearDiff >= -10 && yearDiff <= 2) {
                        pubDate = date.toISOString();
                        break;
                      }
                    }
                  } catch (e) {
                    // Invalid date, continue
                  }
                }
              }
            }
          }
          
          return { title: title.trim(), titleSource, description: description.trim(), pubDate };
        });
        
        console.log(`📝 [${url.substring(0, 60)}...] Extracted title: "${metadata.title.substring(0, 60)}..." (source: ${metadata.titleSource})`);
        if (metadata.pubDate) {
          console.log(`📅 [${url.substring(0, 60)}...] Extracted date: ${metadata.pubDate}`);
        } else {
          console.log(`⚠️  [${url.substring(0, 60)}...] No date found`);
        }
        
        await page.close();
        await browser.close();
        
        // MEMORY OPTIMIZATION: Don't fetch full content here - just return metadata
        // Full content fetching creates another browser instance, doubling memory usage
        // For re-scrape operations, we only need title/date, not full content
        return {
          title: metadata.title,
          content: '', // Skip content fetch to save memory
          pubDate: metadata.pubDate,
          sourceName: '',
          description: metadata.description
        };
      } catch (playwrightError) {
        // Playwright failed - fall back to static scraping
        if (browser) {
          try {
            await browser.close();
          } catch (e) {
            // Ignore close errors
          }
        }
        // Continue to static scraping fallback
      }
    } catch (playwrightNotAvailable) {
      // Playwright not available - use static scraping
    }
    
    // Fallback to static scraping (for non-JS sites or if Playwright fails)
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
      // Also use first paragraph if OG description is just the title (too short or same as title)
      const ogDescValue = $('meta[property="og:description"]').attr('content') || '';
      const titleText = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
      
      if (!description || description.length < 50 || (ogDescValue && ogDescValue.toLowerCase() === titleText.toLowerCase())) {
        const firstParagraph = $('article p, main p, [class*="article-content"] p, [class*="post-content"] p').first().text().trim();
        if (firstParagraph && firstParagraph.length > 50) {
          description = firstParagraph.substring(0, 300) + (firstParagraph.length > 300 ? '...' : '');
        } else {
          // Try any paragraph as last resort
          const anyParagraph = $('p').first().text().trim();
          if (anyParagraph && anyParagraph.length > 50) {
            description = anyParagraph.substring(0, 300) + (anyParagraph.length > 300 ? '...' : '');
          }
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
      console.error('Error extracting article metadata:', error.message || error);
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
      console.error('Error in initial feed check:', error.message || error);
    });
    
    // Then check every 30 minutes
    this.monitoringInterval = setInterval(() => {
      if (this.isMonitoring) {
        this.checkAllFeeds().catch(error => {
          console.error('Error in scheduled feed check:', error.message || error);
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
