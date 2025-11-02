const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

class WebScraper {
  constructor() {
    // Store page fingerprints for change detection
    this.pageFingerprints = new Map(); // sourceId -> {hash, lastChecked}
    this.fingerprintTimeout = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Monitor a website for new blog posts/press releases
   * Uses change detection and pattern-based extraction
   */
  async monitorWebsite(source) {
    try {
      console.log(`🌐 Monitoring website for new posts: ${source.url}`);
      
      // Try to find blog/posts section
      const blogUrl = await this.findBlogSection(source.url);
      const targetUrl = blogUrl || source.url;
      
      // Fetch page
      const response = await axios.get(targetUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RSS Feed Discovery Bot)'
        }
      });

      if (!response || response.status !== 200) {
        return [];
      }

      const html = response.data;
      const $ = cheerio.load(html);

      // Extract articles using multiple strategies
      const articles = await this.extractArticles($, targetUrl, source);

      // Use change detection - check if page structure changed
      const fingerprint = this.createPageFingerprint(html, articles);
      const cached = this.pageFingerprints.get(source.id);
      
      // If we've seen this page before, only return new articles
      if (cached && cached.hash === fingerprint.hash) {
        console.log(`📋 Page unchanged for ${source.name}, checking for new articles...`);
        // Compare articles to find new ones
        return this.findNewArticles(articles, cached.lastArticles);
      }

      // Update fingerprint cache
      this.pageFingerprints.set(source.id, {
        hash: fingerprint.hash,
        lastChecked: Date.now(),
        lastArticles: articles
      });

      return articles;
    } catch (error) {
      console.error(`❌ Error monitoring website ${source.url}:`, error.message);
      return [];
    }
  }

  /**
   * Find blog/posts section of website
   */
  async findBlogSection(baseUrl) {
    try {
      const commonBlogPaths = [
        '/blog',
        '/posts',
        '/articles',
        '/news',
        '/press',
        '/press-releases',
        '/updates',
        '/announcements'
      ];

      for (const path of commonBlogPaths) {
        try {
          const testUrl = baseUrl.replace(/\/$/, '') + path;
          const response = await axios.head(testUrl, { timeout: 5000 });
          if (response.status === 200) {
            return testUrl;
          }
        } catch (e) {
          // Continue to next path
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract articles from HTML using multiple strategies
   */
  async extractArticles($, baseUrl, source) {
    const articles = [];

    // Strategy 1: Look for structured data (JSON-LD)
    const jsonLd = $('script[type="application/ld+json"]');
    jsonLd.each((i, elem) => {
      try {
        const data = JSON.parse($(elem).html());
        if (data['@type'] === 'BlogPosting' || data['@type'] === 'Article') {
          articles.push({
            title: data.headline || data.name || '',
            link: data.url || data.mainEntityOfPage?.['@id'] || '',
            preview: data.description || '',
            pub_date: data.datePublished || data.dateCreated || null,
            source_name: source.name,
            category: source.category
          });
        }
      } catch (e) {
        // Invalid JSON, skip
      }
    });

    // Strategy 2: Look for article/blog post patterns in HTML
    const articleSelectors = [
      'article',
      '[class*="article"]',
      '[class*="post"]',
      '[class*="blog"]',
      '[id*="article"]',
      '[id*="post"]',
      '.entry',
      '.blog-post',
      '.news-item'
    ];

    for (const selector of articleSelectors) {
      $(selector).each((i, elem) => {
        const $elem = $(elem);
        const title = $elem.find('h1, h2, h3, [class*="title"], [class*="headline"]').first().text().trim();
        const link = $elem.find('a').first().attr('href');
        const preview = $elem.find('[class*="excerpt"], [class*="summary"], [class*="preview"], p').first().text().trim();
        
        if (title && link) {
          const fullLink = link.startsWith('http') ? link : new URL(link, baseUrl).href;
          
          // Try to extract date
          const dateText = $elem.find('[class*="date"], time, [datetime]').first().attr('datetime') || 
                          $elem.find('[class*="date"], time').first().text();
          let pubDate = null;
          if (dateText) {
            try {
              pubDate = new Date(dateText);
              if (isNaN(pubDate.getTime())) pubDate = null;
            } catch (e) {
              pubDate = null;
            }
          }

          articles.push({
            title,
            link: fullLink,
            preview: preview.substring(0, 500),
            pub_date: pubDate,
            source_name: source.name,
            category: source.category
          });
        }
      });
    }

    // Strategy 3: Look for list items with links (common blog pattern)
    if (articles.length === 0) {
      $('ul li, ol li').each((i, elem) => {
        const $elem = $(elem);
        const link = $elem.find('a').first();
        const href = link.attr('href');
        const title = link.text().trim() || $elem.text().trim();

        if (title && href && href.length > 0 && !href.startsWith('#')) {
          const fullLink = href.startsWith('http') ? href : new URL(href, baseUrl).href;
          articles.push({
            title,
            link: fullLink,
            preview: '',
            pub_date: null,
            source_name: source.name,
            category: source.category
          });
        }
      });
    }

    // Deduplicate by link
    const uniqueArticles = [];
    const seenLinks = new Set();
    for (const article of articles) {
      if (article.link && !seenLinks.has(article.link)) {
        seenLinks.add(article.link);
        uniqueArticles.push(article);
      }
    }

    // Sort by date (newest first), or by order found if no date
    uniqueArticles.sort((a, b) => {
      if (a.pub_date && b.pub_date) {
        return new Date(b.pub_date) - new Date(a.pub_date);
      }
      return 0;
    });

    return uniqueArticles.slice(0, 20); // Return max 20 most recent
  }

  /**
   * Create a fingerprint of the page for change detection
   */
  createPageFingerprint(html, articles) {
    // Create hash of page structure and article titles
    const articleTitles = articles.map(a => a.title).join('|');
    const hash = crypto
      .createHash('md5')
      .update(html.substring(0, 10000) + articleTitles)
      .digest('hex');
    
    return { hash, timestamp: Date.now() };
  }

  /**
   * Find new articles by comparing with cached ones
   */
  findNewArticles(currentArticles, lastArticles = []) {
    if (!lastArticles || lastArticles.length === 0) {
      return currentArticles;
    }

    const lastLinks = new Set(lastArticles.map(a => a.link));
    return currentArticles.filter(article => !lastLinks.has(article.link));
  }

  /**
   * Clean up old fingerprints
   */
  cleanupOldFingerprints() {
    const now = Date.now();
    for (const [sourceId, data] of this.pageFingerprints.entries()) {
      if (now - data.lastChecked > this.fingerprintTimeout) {
        this.pageFingerprints.delete(sourceId);
      }
    }
  }
}

module.exports = WebScraper;

