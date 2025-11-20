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
      // IMPORTANT: Limit processing to avoid timeouts - only process first 10 articles in detail
      // The workflow will further limit to 3 when adding a new source
      const feedMonitor = require('./feedMonitor');
      const enhancedArticles = [];
      const maxArticlesToProcess = 10; // Only process first 10 articles in detail
      
      for (let i = 0; i < Math.min(articles.length, maxArticlesToProcess); i++) {
        const article = articles[i];
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
          
          // Only fetch full content for the first 3 articles to avoid timeouts
          // When adding a new source, we only process 3 articles anyway
          // This saves time and prevents timeouts when scraping sites with many articles
          if (i < 3) {
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
            // For articles beyond the first 3, skip full content fetch to save time
            // Full content will be fetched later when needed (e.g., when generating AI summaries)
            fullContent = null;
          }
          
          // Extract publication date from article page (more comprehensive than list page)
          let pubDate = article.datePublished ? new Date(article.datePublished) : null;
          
          // Try to extract metadata from article page for first 10 articles (to avoid memory issues)
          // This is critical because the listing page titles/dates might be wrong
          if (i < 10) {
            try {
              console.log(`🔍 Fetching article page for better title/date: ${articleUrl.substring(0, 60)}...`);
              const metadata = await feedMonitor.extractArticleMetadata(articleUrl);
              
              // ALWAYS use article page title if available (it's more reliable)
              if (metadata.title && metadata.title.trim().length > 10) {
                const newTitle = metadata.title.trim();
                // Filter out generic/site-wide titles
                const isGeneric = newTitle.toLowerCase().includes('blog') ||
                                 newTitle.toLowerCase().includes('all posts') ||
                                 newTitle.toLowerCase().includes('latest by topic') ||
                                 newTitle.toLowerCase().includes('mothership') ||
                                 newTitle.toLowerCase().includes('backbone of ai infrastructure') ||
                                 newTitle.toLowerCase().match(/^(home|about|contact|careers|company|solutions|marketplace)$/i);
                
                // Always prefer article page title if it's not generic
                if (!isGeneric) {
                  article.title = newTitle;
                  console.log(`📝 Updated title from article page: "${article.title}"`);
                } else if (newTitle.length > article.title.length && !article.title.toLowerCase().includes('latest by topic')) {
                  // Use if it's longer and current title is also generic
                  article.title = newTitle;
                  console.log(`📝 Using longer title from article page: "${article.title}"`);
                }
              }
              
              // ALWAYS use article page date if available (it's more reliable)
              if (metadata.pubDate) {
                try {
                  const articlePageDate = new Date(metadata.pubDate);
                  if (!isNaN(articlePageDate.getTime())) {
                    pubDate = articlePageDate;
                    console.log(`📅 Found date from article page: ${pubDate.toISOString()}`);
                  }
                } catch (e) {
                  // Invalid date, skip
                }
              }
            } catch (err) {
              // If extraction fails (especially 403), log but continue
              console.log(`⚠️ Could not fetch article page metadata: ${err.message}`);
              // This is OK - we'll use what we scraped from the listing page
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
          
          // Generate author's note style summary only for first 3 articles (to save time and API calls)
          // Other articles will use the description from scraping
          const llmService = require('./llmService');
          let authorNote = article.description || article.preview || '';
          
          // Only generate AI summary for first 3 articles to avoid timeouts and API costs
          if (i < 3 && articleContent && articleContent.length > 100 && (!authorNote || authorNote.length < 50)) {
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
      
      // Add remaining articles (beyond maxArticlesToProcess) without full processing
      // These are already sorted by date, so we just add them with minimal processing
      for (let i = maxArticlesToProcess; i < articles.length && enhancedArticles.length < 20; i++) {
        const article = articles[i];
        try {
          let articleUrl = article.url || article.link;
          
          // Fix URL resolution
          if (articleUrl && !articleUrl.startsWith('http')) {
            if (articleUrl.startsWith('/')) {
              const baseUrlObj = new URL(source.url);
              articleUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${articleUrl}`;
            } else {
              const baseUrlObj = new URL(source.url);
              const basePath = baseUrlObj.pathname.replace(/\/[^\/]*$/, '/');
              articleUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${basePath}${articleUrl}`;
            }
          }
          
          // Parse date if available
          let pubDate = article.datePublished ? new Date(article.datePublished) : null;
          let finalPubDate = null;
          if (pubDate && !isNaN(pubDate.getTime())) {
            finalPubDate = pubDate.toISOString();
          }
          
          enhancedArticles.push({
            title: article.title || 'Untitled',
            link: articleUrl,
            content: article.description || '', // Minimal content - will be fetched later if needed
            contentSnippet: article.description || '',
            description: article.description || '',
            pubDate: finalPubDate,
            isoDate: finalPubDate,
            sourceName: source.name || 'Unknown Source',
            category: source.category || 'General'
          });
        } catch (err) {
          // Skip articles that fail to process
        }
      }
      
      // Limit to most recent 20 articles total
      const limitedArticles = enhancedArticles.slice(0, 20);
      
      console.log(`✅ Scraping completed: ${limitedArticles.length} articles processed (from ${articles.length} found, showing most recent)`);
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
        await page.waitForSelector('a[href*="/blog/"], a[href*="/articles/"], a[href*="/post/"], article, [class*="post"], [class*="blog"], [class*="card"], [class*="grid"]', { 
          timeout: 10000 
        }).catch(() => {
          // If no specific selector found, continue anyway
        });
        
        // Strategy 3: Wait for links that look like blog posts
        await page.waitForFunction(() => {
          const links = Array.from(document.querySelectorAll('a[href]'));
          return links.some(link => {
            const href = link.href;
            return href.includes('/blog/') || 
                   href.includes('/post/') || 
                   href.includes('/article/') ||
                   href.includes('/articles/') ||
                   href.includes('/news/') ||
                   href.includes('/updates/');
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
        const debug = []; // Debug info
        
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
        
        // Check if we're on an articles listing page
        const currentUrl = window.location.href;
        const isArticlesListingPage = currentUrl.includes('/articles') || 
                                      currentUrl.includes('/blog') ||
                                      currentUrl.includes('/posts') ||
                                      currentUrl.includes('/news');
        
        // Helper to extract date from text (handles formats like "06-Nov-25", "November 6, 2025", etc.)
        const extractDate = (text) => {
          if (!text) return null;
          
          // Try to parse common date formats
          const datePatterns = [
            // DD-MMM-YY format (e.g., "06-Nov-25", "03-Nov-25")
            /\b(\d{1,2})[-/](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/](\d{2,4})\b/i,
            // DD-MM-YY or DD/MM/YYYY
            /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/,
            // Full month name (e.g., "November 6, 2025")
            /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
            // YYYY-MM-DD
            /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/
          ];
          
          for (const pattern of datePatterns) {
            const match = text.match(pattern);
            if (match) {
              try {
                let dateStr = match[0];
                
                // Handle DD-MMM-YY format specifically (e.g., "06-Nov-25")
                if (match[2] && /[A-Za-z]{3}/.test(match[2])) {
                  // Convert "06-Nov-25" to a parseable format
                  const day = match[1];
                  const month = match[2];
                  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
                  dateStr = `${day}-${month}-${year}`;
                }
                
                const date = new Date(dateStr);
                if (!isNaN(date.getTime())) {
                  // Validate the date is reasonable (not in the distant future/past)
                  const now = new Date();
                  const yearDiff = date.getFullYear() - now.getFullYear();
                  if (yearDiff >= -10 && yearDiff <= 5) {
                    return date.toISOString();
                  }
                }
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
        debug.push(`Found ${allLinks.length} total links on page`);
        
        let linksChecked = 0;
        let linksSameDomain = 0;
        let linksWithPattern = 0;
        
        allLinks.forEach(link => {
          const href = link.href;
          if (!href || !isSameDomain(href)) return;
          linksSameDomain++;
          
          // Focus on blog post URLs (most reliable indicator)
          // Look for URLs like /blog/slug, /post/slug, /article/slug, /articles/slug
          // Also handle plural forms and variations
          const isBlogPostUrl = href.match(/\/(blog|post|article|articles|news|updates|story|stories)\/[^\/\?#]+/i);
          
          // If we're on an articles listing page, be more lenient - accept any link that:
          // 1. Matches article URL patterns, OR
          // 2. Has a substantial title and looks like an article
          if (!isBlogPostUrl) {
            // Check for plural forms and other common patterns
            const hasArticlePattern = href.includes('/blog/') || 
                                     href.includes('/post/') || 
                                     href.includes('/article/') || 
                                     href.includes('/articles/') ||
                                     href.includes('/news/') ||
                                     href.includes('/updates/') ||
                                     href.includes('/story/') ||
                                     href.includes('/stories/');
            
            // If we're on an articles listing page, be more lenient
            // Accept links that don't match patterns IF they look like articles
            if (!hasArticlePattern && !isArticlesListingPage) {
              return; // Skip if not on listing page and doesn't match pattern
            }
            
            // If on listing page but no pattern match, we'll check later if it looks like an article
            if (!hasArticlePattern && isArticlesListingPage) {
              // Will check later if title/container looks like an article
            }
          }
          
          if (isBlogPostUrl || isArticlesListingPage) {
            linksWithPattern++;
          }
          
          // Skip navigation, footer, and obvious non-article links
          // But allow articles listing pages if they have individual article slugs
          if (href.includes('#') || 
              href === window.location.href) {
            return;
          }
          
          // Skip listing pages (like /blog, /articles) but only if they don't have a slug
          // If the URL has a slug after /articles or /blog, it's an individual article
          const isListingPage = (href.endsWith('/blog') || 
                                 href.endsWith('/blog/') ||
                                 href.endsWith('/articles') ||
                                 href.endsWith('/articles/') ||
                                 href.endsWith('/posts') ||
                                 href.endsWith('/posts/'));
          if (isListingPage) {
            return;
          }
          
          // Skip non-article pages (homepage, contact, about, etc.)
          // Only skip if URL matches pattern AND doesn't have article path
          try {
            const urlObj = new URL(href, window.location.href);
            const pathname = urlObj.pathname.toLowerCase();
            
            // Check if it's a non-article page (but allow if it has /blog/, /post/, etc. in path)
            const isNonArticlePath = (pathname === '/' || 
                                     pathname === '/contact' ||
                                     pathname === '/about' ||
                                     pathname === '/careers' ||
                                     pathname === '/company' ||
                                     pathname === '/solutions' ||
                                     pathname === '/marketplace' ||
                                     pathname.startsWith('/press') ||
                                     pathname.startsWith('/privacy') ||
                                     pathname.startsWith('/terms') ||
                                     pathname.startsWith('/cookie') ||
                                     pathname.startsWith('/brand') ||
                                     pathname.startsWith('/litepaper') ||
                                     pathname.startsWith('/faq') ||
                                     pathname.startsWith('/products')) &&
                                    !pathname.match(/\/(blog|post|article|articles|news)\//i);
            
            if (isNonArticlePath) {
              return;
            }
          } catch (e) {
            // Invalid URL, skip
            return;
          }
          
          // Look for title in the link or its parent container
          // IMPORTANT: Get title from the specific card/article container, not from page-level elements
          let title = null;
          let dateText = null;
          let description = '';
          
          // Find the specific card/article container for this link
          // Walk up the DOM to find the closest card/article container
          let container = link.closest('div, article, section, li');
          let maxDepth = 5; // Limit depth to avoid going too far up
          let depth = 0;
          
          // Find the actual card container (not the whole page)
          while (container && depth < maxDepth) {
            // Check if this container looks like an article card
            const hasMultipleLinks = container.querySelectorAll('a[href]').length;
            const containerClasses = container.className || '';
            const containerId = container.id || '';
            
            // If this container has only 1-2 links and looks like a card, it's likely the article card
            if (hasMultipleLinks <= 2 && 
                (containerClasses.includes('card') || 
                 containerClasses.includes('post') || 
                 containerClasses.includes('article') ||
                 container.tagName === 'ARTICLE')) {
              break; // Found the article card container
            }
            
            container = container.parentElement;
            depth++;
          }
          
          if (container) {
            // CRITICAL: Extract title ONLY from within this specific container
            // Do NOT use page-level headings - they will be the same for all articles
            
            // Strategy 1: Look for headings WITHIN the container (not page-level)
            // Get all headings in the container, but prioritize ones that are NOT in the link
            const containerHeadings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            
            // Filter out headings that are page-level (usually h1 at the top of the page)
            // Prefer headings that are NOT the first h1 on the page or are within the card structure
            for (const heading of containerHeadings) {
              // Skip if this heading is NOT actually inside our container
              if (!container.contains(heading)) continue;
              
              // Skip if this is likely a page-level heading (first h1, or in header/nav)
              const headingParent = heading.closest('header, nav, [class*="header"], [class*="nav"]');
              if (headingParent && !container.contains(headingParent)) continue;
              
              const headingText = heading.textContent.trim();
              
              // Skip if it's too short, generic, or looks like a section header
              if (headingText.length > 15 && 
                  headingText.length < 200 &&
                  !headingText.toLowerCase().includes('blog') &&
                  !headingText.toLowerCase().includes('all posts') &&
                  !headingText.toLowerCase().includes('quarterly updates') &&
                  !headingText.toLowerCase().includes('case studies') &&
                  !headingText.toLowerCase().includes('read more')) {
                title = headingText;
                break; // Use the first valid heading we find in this container
              }
            }
            
            // Strategy 2: Look for title in class-based elements WITHIN container
            if (!title || title.length < 10) {
              const titleEls = container.querySelectorAll('[class*="title"]:not([class*="page"]):not([class*="site"]), [class*="headline"], [class*="name"]');
              for (const titleEl of titleEls) {
                // Make sure it's actually in our container
                if (!container.contains(titleEl)) continue;
                
                const titleText = titleEl.textContent.trim();
                if (titleText.length > 15 && titleText.length < 200) {
                  title = titleText;
                  break;
                }
              }
            }
            
            // Strategy 3: Look for title in the link itself (but only if it's substantial)
            if (!title || title.length < 10) {
              const linkTitle = link.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="headline"]');
              if (linkTitle) {
                title = linkTitle.textContent.trim();
              } else if (link.textContent.trim().length > 15) {
                const linkText = link.textContent.trim();
                if (!linkText.toLowerCase().includes('read more') && 
                    !linkText.toLowerCase().includes('learn more') &&
                    !linkText.toLowerCase().includes('blog')) {
                  title = linkText;
                }
              }
            }
            
            // Strategy 4: Look for title in data attributes or aria-label
            if (!title || title.length < 10) {
              title = link.getAttribute('aria-label') || 
                     link.getAttribute('title') ||
                     container.getAttribute('aria-label') ||
                     null;
            }
            
            // Look for date in container - check multiple patterns
            // First, look for date elements
            const dateSelectors = [
              'time[datetime]',
              'time',
              '[datetime]',
              '[class*="date"]',
              '[class*="time"]',
              '[class*="published"]',
              '[class*="pub-date"]'
            ];
            
            for (const selector of dateSelectors) {
              const dateEl = container.querySelector(selector);
              if (dateEl) {
                dateText = dateEl.getAttribute('datetime') || 
                          dateEl.getAttribute('date') ||
                          dateEl.getAttribute('data-date') ||
                          dateEl.textContent.trim();
                if (dateText) break;
              }
            }
            
            // If no date element found, look for date patterns in text
            if (!dateText) {
              // Get all text from container (but exclude link text to avoid false matches)
              const containerClone = container.cloneNode(true);
              // Remove the link to avoid duplicate text
              containerClone.querySelectorAll('a').forEach(a => a.remove());
              const containerText = containerClone.textContent || container.textContent || '';
              
              // Look for date patterns in the text
              dateText = extractDate(containerText);
            }
            
            // Extract description
            description = (container.querySelector('[class*="excerpt"], [class*="summary"], [class*="description"], p')?.textContent.trim() || '').substring(0, 300);
          } else {
            // Fallback: use link text if container not found
            title = link.textContent.trim();
          }
          
          // Filter: Must have a meaningful title
          if (title && title.length > 10) {
            // Skip if it's clearly not an article (navigation, buttons, etc.)
            const lowerTitle = title.toLowerCase();
            if (lowerTitle.includes('read more') || 
                lowerTitle.includes('learn more') ||
                lowerTitle === 'blog' ||
                lowerTitle === 'about' ||
                lowerTitle === 'articles' ||
                lowerTitle === 'posts' ||
                lowerTitle.includes('all posts') ||
                lowerTitle.includes('view all')) {
              return;
            }
            
            // For blog post URLs, be more lenient with title length
            // Also be lenient if we're on an articles listing page (URL contains /articles)
            const isArticlesPage = window.location.href.includes('/articles');
            const minTitleLength = (isBlogPostUrl || isArticlesPage) ? 10 : 20;
            if (title.length < minTitleLength) {
              return;
            }
            
            // Additional validation: if not a known article URL pattern, require either:
            // 1. Date is present, OR
            // 2. Title is substantial (longer than 30 chars), OR
            // 3. Description is present
            // BUT: if we're on an articles listing page, be more lenient
            if (!isBlogPostUrl && !isArticlesPage) {
              const hasSubstantialContent = title.length > 30 || description.length > 50 || dateText;
              if (!hasSubstantialContent) {
                // Skip links that don't look like articles
                return;
              }
            }
            
            // On articles listing pages, accept links even if URL pattern doesn't match
            // as long as they have a good title and aren't navigation
            if (isArticlesListingPage && !isBlogPostUrl) {
              // Already validated title length above, so accept it
            }
            
            // Check if we already have this URL
            if (!results.some(r => r.url === href)) {
              // Parse dateText to ISO string if it's a string
              let datePublished = null;
              if (dateText) {
                if (typeof dateText === 'string') {
                  datePublished = extractDate(dateText);
                } else {
                  try {
                    datePublished = new Date(dateText).toISOString();
                  } catch (e) {
                    datePublished = extractDate(dateText.toString());
                  }
                }
              }
              
              results.push({
                url: href,
                link: href,
                title: title,
                description: description || '',
                content: description || '',
                datePublished: datePublished
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
          const hasDate = date || extractDate(el.textContent);
          
          // Check if this looks like an article (has title and is from article-like URLs or has date)
          const isArticleUrl = link.href.includes('/blog/') || 
                              link.href.includes('/post/') || 
                              link.href.includes('/article/') ||
                              link.href.includes('/articles/') ||
                              link.href.includes('/news/') ||
                              link.href.includes('/updates/');
          
          if (title && title.length > 10 && (isArticleUrl || hasDate)) {
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
            
            // Check if this looks like an article (has title and is from article-like URLs or has date)
            const isArticleUrl = link.href.includes('/blog/') || 
                                link.href.includes('/post/') || 
                                link.href.includes('/article/') ||
                                link.href.includes('/articles/') ||
                                link.href.includes('/news/') ||
                                link.href.includes('/updates/');
            
            if (hasTitle && (isArticleUrl || hasDate)) {
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
        
        // Log debug info
        console.log('🔍 Scraper debug:', {
          totalLinks: allLinks.length,
          sameDomainLinks: linksSameDomain,
          linksWithPattern: linksWithPattern,
          articlesFound: results.length,
          currentUrl: currentUrl,
          isArticlesListingPage: isArticlesListingPage
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
      
      if (limited.length === 0) {
        console.log(`⚠️ Playwright found 0 articles. This might be because:`);
        console.log(`   - Content is loaded via JavaScript that needs more time`);
        console.log(`   - URL structure doesn't match expected patterns (/articles/slug)`);
        console.log(`   - Page structure is different than expected`);
        console.log(`   - Site might be blocking scrapers`);
        console.log(`   - Articles might be loaded via API calls after page load`);
        console.log(`💡 Check the browser console logs above for debug info about links found`);
      } else {
        console.log(`✅ Playwright found ${limited.length} articles (from ${unique.length} total, showing most recent)`);
      }
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

