const { chromium } = require('playwright');
const axios = require('axios');
const cheerio = require('cheerio');
const FeedDiscovery = require('./feedDiscovery');

class WebScraper {
  constructor() {
    this.feedDiscovery = new FeedDiscovery();
    this.browser = null;
    this.pageCache = new Map(); // Store page fingerprints for change detection
  }

  /**
   * Scrape articles from a website (fallback when RSS/JSON Feed not found)
   * Returns articles in RSS-like format for compatibility
   */
  async scrapeArticles(source) {
    try {
      console.log(`🌐 Scraping articles from: ${source.url}`);
      
      // Try static scraping first (faster, no browser needed)
      let articles = await this.scrapeStatic(source.url);
      
      // If no articles found, try with Playwright (for JS-rendered sites)
      if (articles.length === 0) {
        console.log(`📱 No articles found with static scraping, trying Playwright...`);
        articles = await this.scrapeWithPlaywright(source.url);
      }
      
      // Convert to RSS-like format
      const normalizedArticles = articles.map(article => ({
        title: article.title || 'Untitled',
        link: article.url || article.link || '',
        content: article.content || article.description || '',
        contentSnippet: article.description || article.preview || '',
        description: article.description || article.preview || '',
        pubDate: article.datePublished ? new Date(article.datePublished).toISOString() : null,
        isoDate: article.datePublished ? new Date(article.datePublished).toISOString() : null,
        sourceName: source.name || 'Unknown Source',
        category: source.category || 'General'
      }));
      
      // Sort by date (newest first), limit to most recent
      normalizedArticles.sort((a, b) => {
        if (a.pubDate && b.pubDate) {
          return new Date(b.pubDate) - new Date(a.pubDate);
        }
        return 0;
      });
      
      return normalizedArticles;
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
    try {
      // Launch browser (reuse if possible)
      if (!this.browser) {
        this.browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
      }
      
      const page = await this.browser.newPage();
      
      // Set user agent
      await page.setUserAgent('Mozilla/5.0 (compatible; RSS Feed Discovery Bot)');
      
      // Navigate and wait for content to load
      await page.goto(url, { 
        waitUntil: 'networkidle',
        timeout: 30000 
      });
      
      // Wait a bit for any lazy-loaded content
      await page.waitForTimeout(2000);
      
      // Extract articles using multiple strategies
      const articles = await page.evaluate(() => {
        const results = [];
        
        // Strategy 1: Look for article elements
        const articleElements = document.querySelectorAll('article, [class*="article"], [class*="post"], [class*="blog-post"]');
        articleElements.forEach(el => {
          const link = el.querySelector('a');
          const title = el.querySelector('h1, h2, h3, h4, [class*="title"], [class*="headline"]');
          const date = el.querySelector('time, [class*="date"], [datetime]');
          
          if (link && title) {
            results.push({
              url: link.href,
              title: title.textContent.trim(),
              description: el.querySelector('[class*="excerpt"], [class*="summary"], p')?.textContent.trim() || '',
              datePublished: date?.getAttribute('datetime') || date?.textContent.trim() || null
            });
          }
        });
        
        // Strategy 2: Look for headings with nearby links
        const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
        headings.forEach(heading => {
          const text = heading.textContent.trim();
          // Skip if it's a section heading (short) or navigation
          if (text.length < 30 || text.length > 200) return;
          
          // Look for link in parent or sibling
          let link = null;
          const parent = heading.parentElement;
          const headingLink = parent.querySelector('a');
          if (headingLink) {
            link = headingLink.href;
          } else {
            // Check siblings
            let next = heading.nextElementSibling;
            for (let i = 0; i < 3 && next; i++) {
              const siblingLink = next.querySelector('a');
              if (siblingLink) {
                link = siblingLink.href;
                break;
              }
              next = next.nextElementSibling;
            }
          }
          
          if (link && link.includes('blog') || link.includes('post') || link.includes('article')) {
            // Check if we already have this URL
            if (!results.some(r => r.url === link)) {
              results.push({
                url: link,
                title: text,
                description: '',
                datePublished: null
              });
            }
          }
        });
        
        // Strategy 3: Look for links in blog containers
        const blogContainers = document.querySelectorAll('[class*="blog"], [id*="blog"], [class*="post-list"]');
        blogContainers.forEach(container => {
          const links = container.querySelectorAll('a[href*="/blog/"], a[href*="/post/"], a[href*="/article/"]');
          links.forEach(link => {
            const href = link.href;
            const title = link.textContent.trim() || link.querySelector('h1, h2, h3, h4')?.textContent.trim();
            
            if (title && title.length > 10 && !results.some(r => r.url === href)) {
              results.push({
                url: href,
                title: title,
                description: '',
                datePublished: null
              });
            }
          });
        });
        
        return results;
      });
      
      await page.close();
      
      // Deduplicate by URL
      const seen = new Set();
      const unique = articles.filter(a => {
        if (!a.url || seen.has(a.url)) return false;
        seen.add(a.url);
        return true;
      });
      
      console.log(`✅ Playwright found ${unique.length} articles`);
      return unique;
      
    } catch (error) {
      console.error('Error in Playwright scraping:', error.message);
      return [];
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

