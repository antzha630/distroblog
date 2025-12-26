const axios = require('axios');
const cheerio = require('cheerio');
// Using Google Generative AI SDK (which ADK uses under the hood)
// This provides AI-powered article extraction as a replacement for Playwright/Cheerio
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * AI-powered article scraper using Google Gemini
 * Uses Playwright to get fully rendered HTML (handles JS-rendered sites),
 * then uses Gemini AI to intelligently extract article metadata
 * 
 * Benefits over traditional scraping:
 * - Better at handling different HTML structures
 * - More consistent extraction across sites
 * - Still handles JavaScript-rendered sites (via Playwright)
 * - Lower memory usage than Playwright-based parsing (no DOM manipulation)
 */
class ADKScraper {
  constructor() {
    this.genAI = null;
    this.initializeGemini();
  }

  initializeGemini() {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.warn('Google API key not found. ADK scraping will be disabled. Set GOOGLE_API_KEY or GEMINI_API_KEY in .env');
      return;
    }

    try {
      this.genAI = new GoogleGenerativeAI(apiKey);
      console.log('Google Gemini client initialized successfully for ADK scraping');
    } catch (error) {
      console.error('Error initializing Google Gemini client:', error.message);
    }
  }

  /**
   * Extract articles from a website URL using Gemini AI
   * Returns articles in RSS-like format for compatibility
   */
  async scrapeArticles(source) {
    try {
      console.log(`🤖 [ADK] Extracting articles from: ${source.url}`);

      if (!this.genAI) {
        throw new Error('Google Gemini API key not configured');
      }

      // First, fetch the HTML content of the page
      const htmlContent = await this.fetchHTML(source.url);
      
      // Use Gemini to extract article metadata
      const extractedArticles = await this.extractArticlesWithGemini(source.url, htmlContent, source);
      
      // Filter articles to only include those from the same domain
      const sourceDomain = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
      const articlesBeforeFilter = extractedArticles.length;
      const articles = extractedArticles.filter(article => {
        try {
          const articleUrl = article.url || article.link;
          if (!articleUrl) return false;
          const articleDomain = new URL(articleUrl).hostname.replace(/^www\./, '').toLowerCase();
          return articleDomain === sourceDomain;
        } catch (e) {
          return false;
        }
      });

      const articlesFiltered = articlesBeforeFilter - articles.length;
      
      if (articles.length === 0) {
        if (articlesBeforeFilter > 0) {
          console.log(`⚠️ [ADK] No articles found from ${sourceDomain} domain. ${articlesBeforeFilter} articles from other domains were filtered out.`);
        } else {
          console.log(`⚠️ [ADK] No articles found from ${sourceDomain} domain.`);
        }
      } else {
        console.log(`✅ [ADK] Found ${articles.length} articles from ${sourceDomain} domain${articlesFiltered > 0 ? ` (${articlesFiltered} external articles filtered out)` : ''}`);
      }

      // Store scraping result for health tracking
      if (source.id) {
        try {
          const database = require('../database-postgres');
          await database.updateScrapingResult(source.id, {
            articlesFound: articlesBeforeFilter,
            articlesAfterFilter: articles.length,
            articlesFiltered: articlesFiltered,
            success: articles.length > 0,
            timestamp: new Date().toISOString(),
            domain: sourceDomain,
            method: 'ADK'
          });
        } catch (err) {
          console.warn('Could not store scraping result:', err.message);
        }
      }

      // Return lightweight articles (limit to 5 most recent)
      const lightweightArticles = articles.slice(0, 5).map(article => {
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

      console.log(`✅ [ADK] [${source.url}] Extraction completed: ${lightweightArticles.length} articles found`);
      if (lightweightArticles.length > 0) {
        lightweightArticles.forEach((article, i) => {
          console.log(`   ${i + 1}. "${article.title.substring(0, 50)}..." (date: ${article.datePublished || 'none'})`);
        });
      }
      
      return lightweightArticles;
    } catch (error) {
      console.error(`❌ [ADK] Error extracting articles from ${source.url}:`, error.message);
      return [];
    }
  }

  /**
   * Fetch HTML content from a URL
   * Uses Playwright to handle JavaScript-rendered sites, then extracts with Gemini
   */
  async fetchHTML(url) {
    // Try Playwright first for JS-rendered sites
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
        
        // Set user agent via context or extra headers (more reliable than setUserAgent)
        try {
          if (typeof page.setUserAgent === 'function') {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
          } else if (typeof page.setExtraHTTPHeaders === 'function') {
            await page.setExtraHTTPHeaders({
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });
          }
        } catch (uaError) {
          // If user agent setting fails, continue anyway - not critical
          console.log('⚠️ [ADK] Could not set user agent, continuing...');
        }
        
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000 
        });
        
        // Wait for network to be idle (JS-rendered content loads)
        try {
          await page.waitForLoadState('networkidle', { timeout: 10000 });
        } catch (e) {
          // Continue even if network doesn't become idle
        }
        
        // Wait a bit for any lazy-loaded content
        await page.waitForTimeout(2000);
        
        // Get fully rendered HTML
        const html = await page.content();
        
        // Clean up
        await page.close();
        await browser.close();
        
        return html;
      } catch (playwrightError) {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        throw playwrightError;
      }
    } catch (playwrightError) {
      // Fallback to axios if Playwright fails or isn't available
      console.log(`⚠️ [ADK] Playwright not available, falling back to axios: ${playwrightError.message}`);
      try {
        const response = await axios.get(url, {
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        return response.data;
      } catch (axiosError) {
        console.error(`Error fetching HTML from ${url}:`, axiosError.message);
        throw axiosError;
      }
    }
  }

  /**
   * Extract article metadata using Gemini AI
   */
  async extractArticlesWithGemini(url, htmlContent, source) {
    try {
      // Clean HTML content - remove scripts, styles, etc. to reduce token usage
      const $ = cheerio.load(htmlContent);
      $('script, style, nav, footer, header, aside').remove();
      const cleanedHTML = $.text().substring(0, 50000); // Limit to 50k chars to stay within token limits

      const prompt = `Extract article/blog post metadata from this website. 
The source URL is: ${url}
The source name is: ${source.name || 'Unknown'}

From the HTML content below, extract up to 5 most recent articles/blog posts. For each article, provide:
- title: The article headline/title
- url: Full URL to the article (resolve relative URLs to absolute)
- description: Brief description or excerpt
- datePublished: Publication date in ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ), or null if not found

Return the data as a JSON array of objects with this exact structure:
[
  {
    "title": "Article Title",
    "url": "https://full-url-to-article.com/article-slug",
    "description": "Article description or excerpt",
    "datePublished": "2025-12-17T10:00:00Z" // or null
  }
]

Focus on articles from this domain only. Ignore navigation links, footer links, and non-article content.
If the page is an article listing page, extract articles from the list. If it's a single article page, extract just that article.

HTML Content:
${cleanedHTML}

Return ONLY valid JSON, no markdown, no explanation:`;

      // Try gemini-1.5-flash first, fallback to gemini-pro if model not available
      let result;
      try {
        const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        result = await model.generateContent(prompt);
      } catch (modelError) {
        // If gemini-1.5-flash fails (404 or not available), try gemini-pro
        if (modelError.message && (modelError.message.includes('404') || modelError.message.includes('not found'))) {
          console.log(`⚠️ [ADK] gemini-1.5-flash not available, trying gemini-pro: ${modelError.message}`);
          const fallbackModel = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
          result = await fallbackModel.generateContent(prompt);
        } else {
          throw modelError; // Re-throw if it's a different error
        }
      }
      const response = await result.response;
      const text = response.text();

      // Parse JSON from response
      // Sometimes Gemini wraps JSON in markdown code blocks
      let jsonText = text.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```\n?/g, '').trim();
      }

      const articles = JSON.parse(jsonText);
      
      // Validate and normalize articles
      return articles.map(article => ({
        title: article.title || 'Untitled',
        url: this.resolveURL(article.url || '', url),
        link: this.resolveURL(article.url || '', url),
        description: article.description || '',
        content: article.description || '',
        datePublished: article.datePublished || null
      })).filter(article => article.url && article.title !== 'Untitled');

    } catch (error) {
      console.error('Error extracting articles with Gemini:', error.message);
      // Fallback: try basic HTML parsing if Gemini fails
      return this.fallbackExtraction(htmlContent, url);
    }
  }

  /**
   * Resolve relative URLs to absolute URLs
   */
  resolveURL(url, baseURL) {
    if (!url) return null;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    try {
      return new URL(url, baseURL).href;
    } catch (e) {
      return url;
    }
  }

  /**
   * Fallback extraction using basic HTML parsing if Gemini fails
   */
  fallbackExtraction(htmlContent, baseURL) {
    try {
      const $ = cheerio.load(htmlContent);
      const articles = [];
      
      // Look for common article patterns
      $('article, [class*="article"], [class*="post"], [class*="blog"]').each((i, elem) => {
        if (i >= 5) return false; // Limit to 5
        
        const $elem = $(elem);
        const link = $elem.find('a[href]').first().attr('href');
        const title = $elem.find('h1, h2, h3, [class*="title"], [class*="headline"]').first().text().trim();
        const description = $elem.find('[class*="excerpt"], [class*="summary"], p').first().text().trim();
        
        if (link && title) {
          articles.push({
            title,
            url: this.resolveURL(link, baseURL),
            link: this.resolveURL(link, baseURL),
            description,
            content: description,
            datePublished: null
          });
        }
      });

      return articles;
    } catch (error) {
      console.error('Fallback extraction failed:', error.message);
      return [];
    }
  }

  /**
   * Clean up resources (no-op for ADK, but kept for compatibility)
   */
  async close() {
    // No browser instances to close with ADK
    return Promise.resolve();
  }
}

module.exports = ADKScraper;

