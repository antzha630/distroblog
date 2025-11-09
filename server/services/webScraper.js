// Playwright is optional - only needed for JS-rendered sites
// Static scraping works for most sites, so we make Playwright optional
const FeedDiscovery = require('./feedDiscovery');

class WebScraper {
  constructor() {
    this.feedDiscovery = new FeedDiscovery();
    this.browser = null;
    this.pageCache = new Map(); // Store page fingerprints for change detection
  }

  /**
   * Check if a URL is from the same domain as the source
   */
  isSameDomain(url, sourceUrl) {
    try {
      const urlObj = new URL(url);
      const sourceObj = new URL(sourceUrl);
      
      // Normalize domains (remove www. and compare)
      const urlDomain = urlObj.hostname.replace(/^www\./, '').toLowerCase();
      const sourceDomain = sourceObj.hostname.replace(/^www\./, '').toLowerCase();
      
      return urlDomain === sourceDomain;
    } catch (e) {
      return false;
    }
  }

  /**
   * Scrape articles from a website (fallback when RSS/JSON Feed not found)
   * Returns articles in RSS-like format for compatibility
   * Strategy: Try Playwright first (more reliable, handles JS), then static scraping as fallback (faster)
   */
  async scrapeArticles(source) {
    try {
      console.log(`🌐 Scraping articles from: ${source.url}`);
      
      // Try Playwright first (more reliable, handles JS-rendered sites)
      let articles = [];
      try {
        console.log(`📱 Trying Playwright first for reliable JS-rendered content extraction...`);
        articles = await this.scrapeWithPlaywright(source.url);
        if (articles.length > 0) {
          console.log(`✅ Playwright found ${articles.length} articles`);
        }
      } catch (playwrightError) {
        // Playwright failed - log error and fall back to static scraping
        if (playwrightError.message && playwrightError.message.includes('Executable doesn\'t exist')) {
          console.log(`⚠️ Playwright browsers not installed, falling back to static scraping...`);
        } else if (playwrightError.message && playwrightError.message.includes('Cannot find module')) {
          console.log(`⚠️ Playwright not installed, falling back to static scraping...`);
        } else {
          console.log(`⚠️ Playwright scraping failed: ${playwrightError.message}, falling back to static scraping...`);
        }
      }
      
      // If Playwright found nothing or failed, try static scraping as fallback
      if (articles.length === 0) {
        console.log(`📄 Trying static scraping as fallback...`);
        articles = await this.scrapeStatic(source.url);
        if (articles.length > 0) {
          console.log(`✅ Static scraping found ${articles.length} articles`);
        }
      }
      
      // Filter articles to only include those from the same domain as the source
      const sourceDomain = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
      const articlesBeforeFilter = articles.length;
      articles = articles.filter(article => {
        try {
          const articleUrl = article.url || article.link;
          if (!articleUrl) return false;
          return this.isSameDomain(articleUrl, source.url);
        } catch (e) {
          return false;
        }
      });
      
      const articlesFiltered = articlesBeforeFilter - articles.length;
      
      if (articles.length === 0) {
        if (articlesBeforeFilter > 0) {
          console.log(`⚠️ No articles found from ${sourceDomain} domain. ${articlesBeforeFilter} articles from other domains were filtered out.`);
        } else {
          console.log(`⚠️ No articles found from ${sourceDomain} domain.`);
        }
      } else {
        console.log(`✅ Found ${articles.length} articles from ${sourceDomain} domain${articlesFiltered > 0 ? ` (${articlesFiltered} external articles filtered out)` : ''}`);
      }
      
      // Store scraping result for health tracking
      if (source.id) {
        try {
          // Use the same database instance as the rest of the app
          const database = require('../database-postgres');
          await database.updateScrapingResult(source.id, {
            articlesFound: articlesBeforeFilter,
            articlesAfterFilter: articles.length,
            articlesFiltered: articlesFiltered,
            success: articles.length > 0,
            timestamp: new Date().toISOString(),
            domain: sourceDomain
          });
        } catch (err) {
          // Don't fail scraping if result storage fails
          console.warn('Could not store scraping result:', err.message);
        }
      }
      
      // Enhance articles with full content and better date extraction (reuse existing logic from feedMonitor)
      const feedMonitor = require('./feedMonitor');
      const enhancedArticles = [];
      
      for (const article of articles) {
        try {
          let articleUrl = article.url || article.link;
          
          // Fix URL resolution - handle relative URLs and malformed URLs
          if (articleUrl && !articleUrl.startsWith('http')) {
            // Relative URL - resolve against base URL
            if (articleUrl.startsWith('/')) {
              const baseUrlObj = new URL(source.url);
              articleUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${articleUrl}`;
            } else {
              // Relative path - resolve against source URL
              const baseUrlObj = new URL(source.url);
              const basePath = baseUrlObj.pathname.replace(/\/[^\/]*$/, '/');
              articleUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${basePath}${articleUrl}`;
            }
          }
          
          // Fix double /post/ issue: if base has /post and link has /posts/, fix it
          if (articleUrl.includes('/post/posts/')) {
            articleUrl = articleUrl.replace('/post/posts/', '/posts/');
          }
          // If base is /post but link should be /posts/, fix it
          if (source.url.includes('/post') && !source.url.includes('/posts') && 
              articleUrl.includes('/post/') && articleUrl.match(/\/post\/posts\/[^\/]+/)) {
            articleUrl = articleUrl.replace(/\/post\//, '/posts/');
          }
          
              // Fetch full content for each article (reuse existing method)
              // NOTE: For initial scraping, we skip full content fetch to avoid timeouts
              // Full content will be fetched later when articles are processed individually
              let fullContent = null;
              
              // Only fetch full content for the first few articles to avoid timeouts
              // When adding a new source, we only process 3 articles anyway
              if (enhancedArticles.length < 5) {
                try {
                  fullContent = await feedMonitor.fetchFullArticleContent(articleUrl);
                } catch (err) {
                  // Handle 403 (Cloudflare) gracefully - just use scraped content
                  if (err.response && err.response.status === 403) {
                    console.log(`⚠️ 403 Forbidden for ${articleUrl} (Cloudflare protection), using scraped content`);
                  }
                  // If 404, try alternative URL patterns
                  else if (err.response && err.response.status === 404) {
                    console.log(`⚠️ 404 for ${articleUrl}, trying alternative URLs...`);
                    
                    // Try alternative URL patterns (only if same domain)
                    const urlVariations = [
                      articleUrl.replace('/posts/', '/post/'),
                      articleUrl.replace('/post/', '/posts/'),
                      articleUrl.replace('/posts/', '/blog/'),
                      articleUrl.replace('/post/', '/blog/'),
                    ].filter(url => this.isSameDomain(url, source.url));
                    
                    for (const altUrl of urlVariations) {
                      try {
                        fullContent = await feedMonitor.fetchFullArticleContent(altUrl);
                        if (fullContent && fullContent.length > 100) {
                          articleUrl = altUrl; // Use the working URL
                          break;
                        }
                      } catch (e) {
                        // Continue to next variation
                      }
                    }
                  }
                  
                  // If still no content, use what we have from scraping
                  if (!fullContent) {
                    // Don't log if it's a 403 - we already logged that
                    if (!err.response || err.response.status !== 403) {
                      console.log(`⚠️ Could not fetch full content for ${articleUrl}, using scraped content`);
                    }
                  }
                }
              } else {
                // For articles beyond the first 5, skip full content fetch to save time
                // Full content will be fetched later when needed
                fullContent = null;
              }
          
          // Extract publication date from article page (more comprehensive than list page)
          let pubDate = article.datePublished ? new Date(article.datePublished) : null;
          
          // If no date from list page, try extracting from article page (skip if 403)
          if ((!pubDate || isNaN(pubDate.getTime())) && fullContent) {
            try {
              const metadata = await feedMonitor.extractArticleMetadata(articleUrl);
              if (metadata.pubDate) {
                pubDate = new Date(metadata.pubDate);
              }
            } catch (err) {
              // If extraction fails (especially 403), keep existing date or null
            }
          }
          
          // Validate and format date
          let finalPubDate = null;
          let finalIsoDate = null;
          if (pubDate && !isNaN(pubDate.getTime())) {
            finalPubDate = pubDate.toISOString();
            finalIsoDate = pubDate.toISOString();
          }
          
          // Convert to RSS-like format
          // Store full content for AI summaries (use scraped content if fetch failed)
          const articleContent = fullContent || article.content || article.description || '';
          
          // Generate author's note style summary immediately for scraped articles
          const llmService = require('./llmService');
          let authorNote = article.description || article.preview || '';
          
          // If we have content but no good description, generate author's note style summary
          if (articleContent && articleContent.length > 100 && (!authorNote || authorNote.length < 50)) {
            try {
              authorNote = llmService.createAuthorsNoteStyleSummary(
                article.title || 'Untitled',
                articleContent,
                source.name || 'Unknown Source'
              );
            } catch (err) {
              // If generation fails, use what we have
              console.warn('Could not generate author\'s note style summary:', err.message);
            }
          }
          
          enhancedArticles.push({
            title: article.title || 'Untitled',
            link: articleUrl,
            content: articleContent, // Full content for AI summaries
            contentSnippet: authorNote, // Author's note style summary
            description: authorNote, // Author's note style summary (shown on dashboard)
            pubDate: finalPubDate,
            isoDate: finalIsoDate,
            sourceName: source.name || 'Unknown Source',
            category: source.category || 'General'
          });
        } catch (err) {
          // If fetching full content fails, use what we have
          const articleUrl = article.url || article.link;
          let pubDate = article.datePublished ? new Date(article.datePublished) : null;
          let finalPubDate = null;
          let finalIsoDate = null;
          if (pubDate && !isNaN(pubDate.getTime())) {
            finalPubDate = pubDate.toISOString();
            finalIsoDate = pubDate.toISOString();
          }
          
          enhancedArticles.push({
            title: article.title || 'Untitled',
            link: articleUrl,
            content: article.content || article.description || '',
            contentSnippet: article.description || article.preview || '',
            description: article.description || article.preview || '',
            pubDate: finalPubDate,
            isoDate: finalIsoDate,
            sourceName: source.name || 'Unknown Source',
            category: source.category || 'General'
          });
        }
      }
      
      // Sort by date (newest first)
      enhancedArticles.sort((a, b) => {
        // Articles with dates come first
        if (a.pubDate && !b.pubDate) return -1;
        if (!a.pubDate && b.pubDate) return 1;
        
        // If both have dates, sort by date (newest first)
        if (a.pubDate && b.pubDate) {
          try {
            const dateA = new Date(a.pubDate);
            const dateB = new Date(b.pubDate);
            if (!isNaN(dateA.getTime()) && !isNaN(dateB.getTime())) {
              return dateB - dateA; // Newest first
            }
          } catch (e) {
            // Invalid date, keep original order
          }
        }
        return 0;
      });
      
      // Limit to most recent 20 articles to avoid processing too many
      // When adding a new source, only 3 will be used anyway
      const limitedArticles = enhancedArticles.slice(0, 20);
      
      console.log(`✅ Scraping completed: ${limitedArticles.length} articles (from ${enhancedArticles.length} total, showing most recent)`);
      return limitedArticles;
    } catch (error) {
      console.error(`❌ Error scraping ${source.url}:`, error.message);
      return [];
    }
  }

  /**
   * Static HTML scraping (no browser needed)
   */
  async scrapeStatic(url) {
    try {
      // Try structured data first
      const structured = await this.feedDiscovery.extractStructuredData(url);
      
      // Try blog section extraction
      const blogArticles = await this.feedDiscovery.extractArticlesFromBlogSection(url);
      
      // Merge and deduplicate
      const merged = [...structured, ...blogArticles];
      const seen = new Set();
      return merged.filter(a => {
        if (!a.url || seen.has(a.url)) return false;
        seen.add(a.url);
        return true;
      });
    } catch (error) {
      console.error('Error in static scraping:', error.message);
      return [];
    }
  }

  /**
   * Playwright-based scraping for JS-rendered sites
   */
  async scrapeWithPlaywright(url) {
    let browser = null;
    let page = null;
    try {
      // Try to require Playwright (might not be installed)
      const { chromium } = require('playwright');
      
      // Launch browser (reuse if possible)
      if (!this.browser) {
        try {
          this.browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
          });
          if (!this.browser) {
            throw new Error('Browser launch returned null');
          }
        } catch (launchError) {
          // Browser launch failed - likely missing system dependencies
          if (launchError.message.includes('Executable doesn\'t exist') || 
              launchError.message.includes('browserType.launch')) {
            throw new Error('Playwright browsers not installed. Run "npx playwright install chromium" during build.');
          }
          throw launchError;
        }
      }
      
      // Create new page
      try {
        page = await this.browser.newPage();
        if (!page) {
          throw new Error('Browser.newPage() returned null or undefined');
        }
        
        // Verify page object has expected methods
        if (typeof page.goto !== 'function') {
          throw new Error('Page object does not have goto method - Playwright may not be installed correctly');
        }
      } catch (pageError) {
        throw new Error(`Failed to create Playwright page: ${pageError.message}`);
      }
      
      // Set user agent (optional - some Playwright versions handle this differently)
      try {
        if (typeof page.setUserAgent === 'function') {
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        } else if (typeof page.setExtraHTTPHeaders === 'function') {
          // Alternative: set user agent via headers
          await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          });
        }
      } catch (uaError) {
        // If setUserAgent fails, continue anyway - not critical
        console.log('⚠️ Could not set user agent, continuing without it...');
      }
      
      // Navigate and wait for content to load (important for JS-rendered sites like Next.js)
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', // Start with domcontentloaded, then wait for network
        timeout: 30000 
      });
      
      // Wait for network to be idle (all AJAX/fetch requests complete)
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch (e) {
        // Network idle timeout is OK - continue anyway
        console.log('⚠️ Network did not become idle, continuing...');
      }
      
      // Wait for any lazy-loaded content (especially important for Next.js)
      await page.waitForTimeout(3000); // Initial wait for JS to execute
      
      // For Next.js apps, wait for content to appear (not just spinner)
      // Try multiple strategies to detect when content is loaded
      try {
        // Strategy 1: Wait for loading spinner to disappear
        await page.waitForFunction(() => {
          const spinner = document.querySelector('.animate-spin, [class*="spinner"], [class*="loading"]');
          return !spinner || spinner.offsetParent === null; // Spinner is hidden or doesn't exist
        }, { timeout: 10000 }).catch(() => {
          // Spinner might not exist or already gone
        });
        
        // Strategy 2: Wait for content containers to appear
        await page.waitForSelector('a[href*="/blog/"], article, [class*="post"], [class*="blog"], [class*="card"], [class*="grid"]', { 
          timeout: 10000 
        }).catch(() => {
          // If no specific selector found, continue anyway
        });
        
        // Strategy 3: Wait for links that look like blog posts
        await page.waitForFunction(() => {
          const links = Array.from(document.querySelectorAll('a[href]'));
          return links.some(link => {
            const href = link.href;
            return href.includes('/blog/') || href.includes('/post/') || href.includes('/article/');
          });
        }, { timeout: 10000 }).catch(() => {
          // No blog links found yet, continue anyway
        });
        
        // Additional wait for any API calls to complete
        await page.waitForTimeout(2000);
      } catch (e) {
        // Continue even if waiting fails
        console.log('⚠️ Content loading detection completed, proceeding with extraction...');
      }
      
      // Get source domain for filtering
      const sourceUrlObj = new URL(url);
      const sourceDomain = sourceUrlObj.hostname.replace(/^www\./, '').toLowerCase();
      
      // Extract articles using multiple strategies (optimized for Next.js and modern React apps)
      const articles = await page.evaluate((sourceDomain) => {
        const results = [];
        
        // Helper to check if URL is from same domain
        const isSameDomain = (urlString) => {
          try {
            const urlObj = new URL(urlString);
            const urlDomain = urlObj.hostname.replace(/^www\./, '').toLowerCase();
            return urlDomain === sourceDomain;
          } catch (e) {
            return false;
          }
        };
        
        // Helper to extract date from text (handles formats like "06-Nov-25", "November 6, 2025", etc.)
        const extractDate = (text) => {
          if (!text) return null;
          // Try to parse common date formats
          const datePatterns = [
            /(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/, // DD-MM-YY or DD/MM/YYYY
            /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
            /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/ // YYYY-MM-DD
          ];
          for (const pattern of datePatterns) {
            const match = text.match(pattern);
            if (match) {
              try {
                const date = new Date(match[0]);
                if (!isNaN(date.getTime())) return date.toISOString();
              } catch (e) {
                // Continue to next pattern
              }
            }
          }
          return null;
        };
        
        // Strategy 1: Look for article cards (common in Next.js/blog layouts)
        // Look for elements that contain both a link and text that looks like a title
        const allLinks = document.querySelectorAll('a[href]');
        allLinks.forEach(link => {
          const href = link.href;
          if (!href || !isSameDomain(href)) return;
          
          // Focus on blog post URLs (most reliable indicator)
          // Look for URLs like /blog/slug, /post/slug, /article/slug
          const isBlogPostUrl = href.match(/\/(blog|post|article)\/[^\/\?#]+/i);
          if (!isBlogPostUrl) {
            // Skip if it's not a blog post URL and doesn't look like one
            if (!href.includes('/blog/') && !href.includes('/post/') && !href.includes('/article/')) {
              return;
            }
          }
          
          // Skip navigation, footer, and obvious non-article links
          if (href.includes('#') || 
              href === window.location.href || 
              href.endsWith('/blog') || 
              href.endsWith('/blog/')) {
            return;
          }
          
          // Look for title in the link or its parent container
          let title = link.textContent.trim();
          let dateText = null;
          let description = '';
          
          // Check parent container for title and date
          let container = link.closest('div, article, section, li, [class*="card"], [class*="post"]');
          if (container) {
            // Look for title in container (headings, or text with title-like characteristics)
            const titleElement = container.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="headline"], [class*="name"]');
            if (titleElement) {
              title = titleElement.textContent.trim();
            }
            
            // Look for date in container
            const dateElement = container.querySelector('time, [class*="date"], [datetime], [class*="time"]');
            if (dateElement) {
              dateText = dateElement.getAttribute('datetime') || dateElement.textContent.trim();
            } else {
              // Try to find date in text content (look for patterns like "06-Nov-25")
              const containerText = container.textContent || '';
              dateText = extractDate(containerText) || null;
            }
            
            // Extract description
            description = (container.querySelector('[class*="excerpt"], [class*="summary"], [class*="description"], p')?.textContent.trim() || '').substring(0, 300);
            
            // If no title found, try to extract from link's accessible text or aria-label
            if (!title || title.length < 10) {
              title = link.getAttribute('aria-label') || link.title || link.textContent.trim();
            }
          }
          
          // Filter: Must have a meaningful title
          if (title && title.length > 10) {
            // Skip if it's clearly not an article (navigation, buttons, etc.)
            const lowerTitle = title.toLowerCase();
            if (lowerTitle.includes('read more') || 
                lowerTitle.includes('learn more') ||
                lowerTitle === 'blog' ||
                lowerTitle === 'about' ||
                title.length < 15) {
              return;
            }
            
            // For blog post URLs, be more lenient with title length
            const minTitleLength = isBlogPostUrl ? 10 : 20;
            if (title.length < minTitleLength) {
              return;
            }
            
            // Check if we already have this URL
            if (!results.some(r => r.url === href)) {
              results.push({
                url: href,
                title: title,
                description: description,
                datePublished: dateText
              });
            }
          }
        });
        
        // Strategy 2: Look for structured data (JSON-LD) in the page
        const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
        jsonLdScripts.forEach(script => {
          try {
            const data = JSON.parse(script.textContent);
            if (data['@type'] === 'Blog' || data['@type'] === 'BlogPosting' || 
                (Array.isArray(data) && data.some(item => item['@type'] === 'BlogPosting'))) {
              const items = Array.isArray(data) ? data : [data];
              items.forEach(item => {
                if (item['@type'] === 'BlogPosting' && item.url && isSameDomain(item.url)) {
                  if (!results.some(r => r.url === item.url)) {
                    results.push({
                      url: item.url,
                      title: item.headline || item.name || '',
                      description: item.description || '',
                      datePublished: item.datePublished || item.dateCreated || null
                    });
                  }
                }
              });
            }
          } catch (e) {
            // Invalid JSON, skip
          }
        });
        
        // Strategy 3: Look for article elements with proper structure
        const articleElements = document.querySelectorAll('article, [class*="article"], [class*="post"], [class*="blog-post"], [class*="card"]');
        articleElements.forEach(el => {
          const link = el.querySelector('a[href]');
          if (!link || !isSameDomain(link.href)) return;
          
          const title = el.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="headline"]')?.textContent.trim() ||
                       link.textContent.trim();
          const date = el.querySelector('time, [class*="date"], [datetime]');
          
          if (title && title.length > 10 && 
              (link.href.includes('/blog/') || link.href.includes('/post/') || link.href.includes('/article/'))) {
            const dateText = date?.getAttribute('datetime') || date?.textContent.trim() || 
                            extractDate(el.textContent);
            
            if (!results.some(r => r.url === link.href)) {
              results.push({
                url: link.href,
                title: title,
                description: el.querySelector('[class*="excerpt"], [class*="summary"], p')?.textContent.trim() || '',
                datePublished: dateText
              });
            }
          }
        });
        
        // Strategy 4: Look for grid/list items that contain blog posts
        // Common patterns: grid containers with cards
        const gridContainers = document.querySelectorAll('[class*="grid"], [class*="list"], [class*="posts"], [class*="articles"]');
        gridContainers.forEach(container => {
          const items = container.querySelectorAll('div, li, article, section');
          items.forEach(item => {
            const link = item.querySelector('a[href]');
            if (!link || !isSameDomain(link.href)) return;
            
            // Check if this looks like a blog post item
            const hasTitle = item.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"]');
            const hasDate = item.textContent.match(/\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/) || 
                          item.querySelector('time, [class*="date"]');
            
            if (hasTitle && (link.href.includes('/blog/') || link.href.includes('/post/') || hasDate)) {
              const title = hasTitle.textContent.trim() || link.textContent.trim();
              if (title && title.length > 10 && !results.some(r => r.url === link.href)) {
                results.push({
                  url: link.href,
                  title: title,
                  description: item.querySelector('[class*="excerpt"], [class*="summary"], p')?.textContent.trim() || '',
                  datePublished: extractDate(item.textContent)
                });
              }
            }
          });
        });
        
        return results;
      }, sourceDomain);
      
      await page.close();
      
      // Deduplicate by URL
      const seen = new Set();
      const unique = articles.filter(a => {
        if (!a.url || seen.has(a.url)) return false;
        seen.add(a.url);
        return true;
      });
      
      // Sort by date (newest first) - articles with dates come first
      unique.sort((a, b) => {
        // Articles with dates come first
        if (a.datePublished && !b.datePublished) return -1;
        if (!a.datePublished && b.datePublished) return 1;
        
        // If both have dates, sort by date
        if (a.datePublished && b.datePublished) {
          try {
            const dateA = new Date(a.datePublished);
            const dateB = new Date(b.datePublished);
            if (!isNaN(dateA.getTime()) && !isNaN(dateB.getTime())) {
              return dateB - dateA; // Newest first
            }
          } catch (e) {
            // Invalid date, keep original order
          }
        }
        
        return 0;
      });
      
      // Limit to most recent 20 articles (enough for initial fetch, but not too many)
      // The workflow will further limit to 3 when adding a new source
      const limited = unique.slice(0, 20);
      
      console.log(`✅ Playwright found ${limited.length} articles (from ${unique.length} total, showing most recent)`);
      return limited;
      
    } catch (error) {
      // Clean up page if it was created
      if (page) {
        try {
          await page.close();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      // Re-throw the error so caller can handle it appropriately
      throw error;
    }
  }

  /**
   * Clean up browser instance
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = WebScraper;

