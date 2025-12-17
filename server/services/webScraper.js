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
      
      // OPTIMIZATION: Two-phase approach for memory efficiency
      // Phase 1: Lightweight scraping - get 5 articles from listing page (just URLs/titles)
      // Phase 2: Check which exist in DB, then only fetch full content for NEW articles
      // This way we have a buffer (5) but only process what's actually new (typically 0-2)
      // This is much more memory-efficient than processing all articles fully before checking
      
      // Return lightweight articles (just from listing page)
      // Full processing will happen in feedMonitor after checking which are new
      const lightweightArticles = articles.slice(0, 5).map(article => {
        // Fix URL resolution for relative URLs
          let articleUrl = article.url || article.link;
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
          
        return {
            title: article.title || 'Untitled',
            link: articleUrl,
          url: articleUrl,
          description: article.description || '',
            content: article.content || article.description || '',
          datePublished: article.datePublished || null,
            sourceName: source.name || 'Unknown Source',
            category: source.category || 'General'
        };
      });
      
            console.log(`✅ [${source.url}] Scraping completed: ${lightweightArticles.length} articles found (lightweight, will check for new ones before full processing)`);
            if (lightweightArticles.length > 0) {
              lightweightArticles.forEach((article, i) => {
                console.log(`   ${i + 1}. "${article.title.substring(0, 50)}..." (date: ${article.datePublished || 'none'})`);
              });
            }
            return lightweightArticles;
    } catch (error) {
      console.error(`❌ Error scraping ${source.url}:`, error.message);
      return [];
    }
  }

  /**
   * Static HTML scraping (no browser needed)
   */
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
      
      // Set realistic browser headers to avoid Cloudflare/bot detection
      try {
        if (typeof page.setExtraHTTPHeaders === 'function') {
          await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
          });
        }
      } catch (headerError) {
        // Header setting failed - continue anyway
      }
      
      // Navigate and wait for content to load (important for JS-rendered sites like Next.js)
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', // Start with domcontentloaded, then wait for network
        timeout: 30000 
      });
      
      // Check if we hit a Cloudflare challenge
      const isCloudflareChallenge = await page.evaluate(() => {
        return document.body.textContent.includes('Checking your browser') ||
               document.body.textContent.includes('Just a moment') ||
               document.title.includes('Just a moment') ||
               document.querySelector('#challenge-form') !== null ||
               document.querySelector('.cf-browser-verification') !== null;
      });
      
      if (isCloudflareChallenge) {
        console.log(`⚠️  [${url}] Cloudflare challenge detected, waiting longer...`);
        // Wait longer for Cloudflare to pass
        await page.waitForTimeout(5000);
        // Wait for challenge to complete (look for actual content)
        try {
          await page.waitForFunction(() => {
            return !document.body.textContent.includes('Checking your browser') &&
                   !document.body.textContent.includes('Just a moment') &&
                   (document.querySelector('h1, article, main, a[href*="/blog/"]') !== null);
          }, { timeout: 15000 });
          console.log(`✅ [${url}] Cloudflare challenge passed, content loaded`);
        } catch (e) {
          console.warn(`⚠️  [${url}] Cloudflare challenge may not have passed, continuing anyway...`);
        }
      }
      
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
          // EXCLUDE category/tag pages: /blog/category, /blog/tag, /blog/quick-reads, etc.
          const isBlogPostUrl = href.match(/\/(blog|post|article|articles|news|updates|story|stories)\/[^\/\?#]+/i) &&
                                !href.match(/\/(blog|post|article|articles)\/(quick-reads|artificial-intelligence|blockchain|cybersecurity|company-updates|io-intelligence|ai-infrastructure-compute|ai-startup-corner|developer-resources|search|tag|category|archive|author|c\/)/i);
          
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
                                     pathname === '/contact-us' ||
                                     pathname === '/partners' ||
                                     pathname === '/research' ||
                                     pathname === '/about' ||
                                     pathname === '/careers' ||
                                     pathname === '/company' ||
                                     pathname === '/solutions' ||
                                     pathname === '/marketplace' ||
                                     pathname === '/search' ||
                                     pathname.startsWith('/contact/') ||
                                     pathname.startsWith('/contact-us/') ||
                                     pathname.startsWith('/partners/') ||
                                     pathname.startsWith('/research/') ||
                                     pathname.startsWith('/press') ||
                                     pathname.startsWith('/privacy') ||
                                     pathname.startsWith('/terms') ||
                                     pathname.startsWith('/cookie') ||
                                     pathname.startsWith('/brand') ||
                                     pathname.startsWith('/litepaper') ||
                                     pathname.startsWith('/faq') ||
                                     pathname.startsWith('/products') ||
                                     pathname.startsWith('/docs') ||
                                     pathname.startsWith('/c/') || // Category pages (e.g., /c/tutorials)
                                     pathname.match(/^\/[a-z]{2}$/i) || // Language codes (e.g., /en, /zh)
                                     pathname.match(/^\/tag[s]?\/|\/category\/|\/archive\/|\/author\//i)) && // Tag/category/archive/author pages
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
            // Prioritize headings that are direct children or in article-like structures
            // Get all headings in the container, prioritizing h2/h3 (common for article cards)
            const containerHeadings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            
            // Sort headings by priority: h2/h3 first (common in cards), then h1, then others
            const headingPriority = { 'H2': 1, 'H3': 2, 'H1': 3, 'H4': 4, 'H5': 5, 'H6': 6 };
            containerHeadings.sort((a, b) => {
              const priorityA = headingPriority[a.tagName] || 99;
              const priorityB = headingPriority[b.tagName] || 99;
              return priorityA - priorityB;
            });
            
            // Filter out headings that are page-level (usually h1 at the top of the page)
            // Prefer headings that are NOT the first h1 on the page or are within the card structure
            for (const heading of containerHeadings) {
              // Skip if this heading is NOT actually inside our container
              if (!container.contains(heading)) continue;
              
              // Skip if this is likely a page-level heading (first h1, or in header/nav)
              const headingParent = heading.closest('header, nav, [class*="header"], [class*="nav"]');
              if (headingParent && !container.contains(headingParent)) continue;
              
              // Skip if heading is inside the link itself (might be redundant)
              if (link.contains(heading) && heading !== link) {
                // Only skip if there are other headings available
                if (containerHeadings.length > 1) continue;
              }
              
              let headingText = heading.textContent.trim();
              
              // Clean up common prefixes/suffixes
              headingText = headingText
                .replace(/^(articlePINNED|PINNED|article|Article)\s*/i, '')
                .replace(/\s*\d{4}-\d{2}-\d{1,2}\s*\d+\s*min\s*read.*$/i, '')
                .replace(/\s*\d+\s*min\s*read.*$/i, '')
                .trim();
              
              // Skip if it's too short, generic, or looks like a section header
              const headingLower = headingText.toLowerCase();
              const isGenericHeading = headingLower.length < 25 && (
                headingLower.match(/^(blockchain|web3|cybersecurity|company updates?|io intelligence|ai infrastructure|ai startup|developer resources)/i) ||
                headingLower === 'blockchain web3' ||
                headingLower === 'cybersecurity' ||
                headingLower.includes('swarm community call') && headingLower.includes('recap')
              );
              
              if (headingText.length > 15 && 
                  headingText.length < 200 &&
                  !isGenericHeading &&
                  !headingLower.includes('blog') &&
                  !headingLower.includes('all posts') &&
                  !headingLower.includes('quarterly updates') &&
                  !headingLower.includes('case studies') &&
                  !headingLower.includes('read more') &&
                  !headingLower.match(/^follow us/i) &&
                  !headingLower.match(/^posts? related/i)) {
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
            // First, look for date elements (prioritize semantic HTML)
            const dateSelectors = [
              'time[datetime]',           // Semantic HTML5 time element with datetime
              'time',                      // Any time element
              '[datetime]',                // Any element with datetime attribute
              '[data-date]',               // Data attribute for dates
              '[class*="date"]',           // Elements with "date" in class
              '[class*="time"]',           // Elements with "time" in class
              '[class*="published"]',      // Elements with "published" in class
              '[class*="pub-date"]',       // Elements with "pub-date" in class
              '[class*="publish"]',        // Elements with "publish" in class
              '[class*="meta"] time',      // Time elements within meta sections
              '[class*="meta"] [class*="date"]', // Date elements within meta sections
              '[class*="author"] + [class*="date"]', // Date after author info
              '[class*="byline"] [class*="date"]',   // Date in byline
              'header [class*="date"]',    // Date in header section
              'header time'                // Time in header section
            ];
            
            for (const selector of dateSelectors) {
              try {
                const dateEl = container.querySelector(selector);
                if (dateEl) {
                  // Try attributes first (most reliable)
                  dateText = dateEl.getAttribute('datetime') || 
                            dateEl.getAttribute('date') ||
                            dateEl.getAttribute('data-date') ||
                            dateEl.getAttribute('content') ||
                            dateEl.getAttribute('data-published') ||
                            null;
                  
                  // If no attribute, try text content
                  if (!dateText) {
                    const text = dateEl.textContent.trim();
                    // Only use text if it looks like a date (has numbers and month/date indicators)
                    if (text && (/\d/.test(text) && (/\d{4}/.test(text) || /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)/i.test(text)))) {
                      dateText = text;
                    }
                  }
                  
                  if (dateText) break;
                }
              } catch (e) {
                // Invalid selector, continue
              }
            }
            
            // If no date element found, look for date patterns in text
            if (!dateText) {
              // Get all text from container (but exclude link text to avoid false matches)
              const containerClone = container.cloneNode(true);
              // Remove the link and other interactive elements to avoid noise
              containerClone.querySelectorAll('a, button, nav, header, footer').forEach(el => el.remove());
              const containerText = containerClone.textContent || container.textContent || '';
              
              // Look for date patterns in the text (prioritize common blog formats)
              // Try to find dates near the beginning of the text (more likely to be publication date)
              const textSamples = [
                containerText.substring(0, 200),  // First 200 chars (most likely location)
                containerText.substring(0, 500),  // First 500 chars
                containerText                      // Full text as fallback
              ];
              
              for (const sample of textSamples) {
                dateText = extractDate(sample);
                if (dateText) break;
              }
            }
            
            // Extract description - try multiple strategies
            const descSelectors = [
              '[class*="excerpt"]',           // Common excerpt class
              '[class*="summary"]',            // Summary class
              '[class*="description"]',        // Description class
              '[class*="preview"]',            // Preview class
              '[class*="intro"]',              // Introduction class
              '[class*="lead"]',               // Lead paragraph class
              '[class*="snippet"]',            // Snippet class
              'p:not([class*="meta"]):not([class*="date"])', // Paragraphs (but not meta/date)
              '[class*="content"] p',          // Paragraphs in content sections
              'p'                              // Any paragraph as fallback
            ];
            
            for (const selector of descSelectors) {
              try {
                const descEl = container.querySelector(selector);
                if (descEl && container.contains(descEl) && descEl !== link) {
                  let descText = descEl.textContent.trim();
                  
                  // Skip if it's too short or looks like metadata
                  if (descText.length > 20 && 
                      descText.length < 500 &&
                      !descText.match(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/) && // Not a date
                      !descText.match(/^(by|author|published|date):/i) && // Not metadata
                      !descText.toLowerCase().includes('read more') &&
                      !descText.toLowerCase().includes('learn more')) {
                    description = descText.substring(0, 300);
                    break;
                  }
                }
              } catch (e) {
                // Invalid selector, continue
              }
            }
            
            // If still no description, try getting first substantial paragraph
            if (!description || description.length < 20) {
              const paragraphs = container.querySelectorAll('p');
              for (const p of paragraphs) {
                if (container.contains(p) && p !== link && !link.contains(p)) {
                  const text = p.textContent.trim();
                  if (text.length > 50 && text.length < 500) {
                    description = text.substring(0, 300);
                    break;
                  }
                }
              }
            }
          } else {
            // Fallback: use link text if container not found
            title = link.textContent.trim();
          }
          
          // Filter out generic/site-wide titles BEFORE using them
          if (title) {
            const titleLower = title.toLowerCase().trim();
            // Check for very short generic titles (likely category/navigation items)
            const isVeryShortGeneric = title.length < 25 && (
              titleLower.match(/^(blockchain|web3|cybersecurity|company updates?|io intelligence|ai infrastructure compute|ai startup corner|developer resources|swarm community call)/i) ||
              titleLower === 'blockchain web3' ||
              titleLower === 'cybersecurity' ||
              titleLower === 'company updates' ||
              titleLower === 'io intelligence' ||
              titleLower === 'ai infrastructure compute' ||
              titleLower === 'ai startup corner' ||
              titleLower === 'developer resources'
            );
            
            const isGeneric = isVeryShortGeneric ||
                             titleLower.includes('latest by topic') ||
                             titleLower.includes('mothership of ai compute') ||
                             titleLower.includes('backbone of ai infrastructure') ||
                             titleLower.includes('research by dr. yu sun') ||
                             titleLower.includes('innovations & ideas from') ||
                             titleLower.includes('why we should train ai models') ||
                             titleLower.match(/^(home|about|contact|careers|company|solutions|marketplace|blog|all posts)$/i) ||
                             (titleLower.includes('exabits:') && titleLower.includes('mothership')) ||
                             (titleLower.includes('giza') && titleLower.includes('innovations')) ||
                             // Check for duplicate generic titles (like "Swarm Community Call, 30 October – Recap" appearing multiple times)
                             (titleLower.includes('swarm community call') && titleLower.includes('recap'));
            
            if (isGeneric) {
              // Try to extract a better title from the URL slug
              try {
                const urlObj = new URL(href, window.location.href);
                const slug = urlObj.pathname.split('/').pop();
                if (slug && slug.length > 10) {
                  const urlTitle = decodeURIComponent(slug)
                    .replace(/[-_]/g, ' ')
                    .replace(/\.[^.]+$/, '')
                    .trim();
                  if (urlTitle.length > 10 && urlTitle.length < 200) {
                    title = urlTitle;
                  } else {
                    title = null; // Skip this article if we can't get a good title
                  }
                } else {
                  title = null; // Skip if no good title
                }
              } catch (e) {
                title = null; // Skip if URL parsing fails
              }
            }
          }
          
            // CRITICAL: Filter out non-article URLs FIRST (before title check)
            const urlPath = new URL(href).pathname.toLowerCase();
            const isNonArticleUrl = urlPath === '/search' ||
                                   urlPath === '/partners' ||
                                   urlPath === '/contact' ||
                                   urlPath === '/contact-us' ||
                                   urlPath === '/research' ||
                                   urlPath.startsWith('/partners/') ||
                                   urlPath.startsWith('/contact/') ||
                                   urlPath.startsWith('/contact-us/') ||
                                   urlPath.startsWith('/research/') ||
                                   urlPath.startsWith('/c/') ||
                                   urlPath.match(/^\/[a-z]{2}$/i) || // Language codes
                                   urlPath.match(/^\/tag[s]?\/|\/category\/|\/archive\/|\/author\//i) ||
                                   urlPath.includes('/search?') ||
                                   urlPath.includes('/category/') ||
                                   urlPath.includes('/tag/') ||
                                   // Filter PDFs and other file types
                                   href.match(/\.(pdf|doc|docx|xls|xlsx|zip|tar|gz)$/i) ||
                                   // Filter external documentation sites
                                   (href.includes('docs.') && !href.includes('/blog')) ||
                                   // Filter category pages: /blog/quick-reads, /blog/artificial-intelligence, etc.
                                   urlPath.match(/\/(blog|post|article|articles)\/(quick-reads|artificial-intelligence|blockchain|cybersecurity|company-updates|io-intelligence|ai-infrastructure-compute|ai-startup-corner|developer-resources)(\/|$)/i);
            
            if (isNonArticleUrl) {
              debug.push(`Filtered non-article URL: ${href} (path: ${urlPath})`);
              return; // Skip non-article pages entirely
          }
          
          // Filter: Must have a meaningful title
          if (title && title.length > 10) {
            // Skip if it's clearly not an article (navigation, buttons, etc.)
            const lowerTitle = title.toLowerCase().trim();
            const isGenericNav = lowerTitle.includes('read more') || 
                lowerTitle.includes('learn more') ||
                lowerTitle === 'blog' ||
                lowerTitle === 'about' ||
                lowerTitle === 'articles' ||
                lowerTitle === 'posts' ||
                lowerTitle === 'partners' ||
                lowerTitle === 'contact' ||
                lowerTitle === 'contact us' ||
                lowerTitle === 'whitepaper' ||
                lowerTitle.includes('read the documentation') ||
                lowerTitle.includes('all posts') ||
                lowerTitle.includes('view all') ||
                // Reject very short generic titles
                (title.length < 25 && (
                  lowerTitle === 'blockchain web3' ||
                  lowerTitle === 'cybersecurity' ||
                  lowerTitle === 'company updates' ||
                  lowerTitle === 'io intelligence' ||
                  lowerTitle === 'ai infrastructure compute' ||
                  lowerTitle === 'ai startup corner' ||
                  lowerTitle === 'developer resources' ||
                  (lowerTitle.includes('swarm community call') && lowerTitle.includes('recap'))
                )) ||
                // Reject generic page titles (too long, likely homepage/category)
                (title.length > 100 && (
                  lowerTitle.includes('mothership of ai') ||
                  lowerTitle.includes('backbone of ai infrastructure') ||
                  lowerTitle.includes('unlock unparalleled gpu compute')
                )) ||
                // Reject duplicate generic titles (same title = likely category page)
                (lowerTitle.includes('swarm community call') && lowerTitle.includes('recap'));
            
            if (isGenericNav) {
              debug.push(`Filtered generic title: "${title}" (URL: ${href})`);
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
            
            // Check if we already have this URL OR this exact title (duplicate titles = likely category pages)
            const isDuplicate = results.some(r => 
              r.url === href || 
              (r.title && r.title.toLowerCase().trim() === lowerTitle)
            );
            
            if (!isDuplicate) {
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
      
      // Limit to most recent 5 articles (benchmark for new article detection)
      // This allows real-time updates while saving memory and processing time
      const limited = unique.slice(0, 5);
      
      if (limited.length === 0) {
        console.log(`⚠️ [${url}] Playwright found 0 articles. This might be because:`);
        console.log(`   - Content is loaded via JavaScript that needs more time`);
        console.log(`   - URL structure doesn't match expected patterns (/articles/slug)`);
        console.log(`   - Page structure is different than expected`);
        console.log(`   - Site might be blocking scrapers (Cloudflare?)`);
        console.log(`   - Articles might be loaded via API calls after page load`);
      } else {
        console.log(`✅ [${url}] Playwright found ${limited.length} articles (from ${unique.length} total, showing most recent)`);
        limited.forEach((article, i) => {
          console.log(`   ${i + 1}. "${article.title.substring(0, 50)}..." (date: ${article.datePublished || 'none'})`);
        });
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
   * Clean up browser instance and all pages
   */
  async close() {
    if (this.browser) {
      try {
        // Close all pages first (important for memory cleanup)
        const pages = this.browser.pages ? await this.browser.pages() : [];
        for (const page of pages) {
          try {
            await page.close();
          } catch (e) {
            // Ignore page close errors
          }
        }
        
        // Then close browser
        await this.browser.close();
        this.browser = null;
      } catch (error) {
        // If close fails, at least null out the reference
        this.browser = null;
        throw error;
      }
    }
  }
}

module.exports = WebScraper;

