const axios = require('axios');
const cheerio = require('cheerio');

class FeedDiscovery {
  constructor() {
    // Comprehensive list of common RSS feed paths
    this.commonFeedPaths = [
      '/feed',
      '/feed.xml',
      '/feed.json',
      '/rss',
      '/rss.xml',
      '/atom.xml',
      '/feeds/all.xml',
      '/feeds/posts/default',
      '/index.xml',
      '/feed.rss',
      '/rss2.xml',
      '/feed/',
      '/feeds/',
      '/blog/feed',
      '/blog/feed.json',
      '/blog/rss',
      '/news/feed',
      '/news/feed.json',
      '/news/rss',
      '/posts/feed',
      '/posts/feed.json',
      '/posts/rss',
      '/articles/feed',
      '/articles/feed.json',
      '/articles/rss',
      '/updates/feed',
      '/updates/feed.json',
      '/updates/rss',
      '/content/feed',
      '/content/rss',
      '/latest/feed',
      '/latest/rss',
      '/feed.rdf',
      '/feed.atom',
      '/sitemap.xml',
      '/feed/index.xml',
      '/rss/index.xml',
      '/atom/index.xml'
    ];
    
    // Cache to avoid re-detecting the same URLs
    this.detectionCache = new Map();
    this.cacheTimeout = 30 * 60 * 1000; // 30 minutes
    
    // Rate limiting tracking
    this.requestDelays = new Map(); // Track delays per domain
  }

  async discoverFeedUrl(websiteUrl) {
    try {
      console.log(`🔍 Discovering RSS feed for: ${websiteUrl}`);
      
      // Clean up the URL
      const baseUrl = this.normalizeUrl(websiteUrl);
      
      // Check cache first
      const cacheKey = baseUrl;
      const cached = this.detectionCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
        console.log(`📋 Using cached result for: ${baseUrl}`);
        return cached.result;
      }
      
      // Optimize detection order based on URL patterns
      const detectionMethods = this.getOptimizedDetectionMethods(baseUrl);
      
      for (const method of detectionMethods) {
        try {
          const feeds = await method.func(baseUrl);
          if (feeds && feeds.length > 0) {
            console.log(`✅ Found ${feeds.length} ${method.name} feed(s):`, feeds);
            const result = feeds[0];
            this.detectionCache.set(cacheKey, { result, timestamp: Date.now() });
            return result;
          }
        } catch (error) {
          console.log(`⚠️ ${method.name} detection failed:`, error.message);
          // Continue to next method
        }
      }
      
      console.log(`❌ No RSS feed found for: ${websiteUrl}`);
      // Cache negative result too
      this.detectionCache.set(cacheKey, { result: null, timestamp: Date.now() });
      return null;
      
    } catch (error) {
      console.error(`❌ Error discovering feed for ${websiteUrl}:`, error.message);
      return null;
    }
  }

  // Optimize detection methods based on URL patterns
  getOptimizedDetectionMethods(baseUrl) {
    const methods = [];
    
    // Always try HTML parsing first (most reliable)
    methods.push({ name: 'HTML', func: this.parseHtmlForFeeds.bind(this) });
    
    // Try parent-page strategies early (cheap and high-signal)
    methods.push({ name: 'Parent meta', func: this.checkParentPagesMeta.bind(this) });
    methods.push({ name: 'Parent suffixes', func: this.checkParentCommonSuffixes.bind(this) });
    
    // Check for platform-specific patterns first
    if (baseUrl.includes('substack.com')) {
      methods.push({ name: 'Substack', func: this.checkSubstackFeeds.bind(this) });
    } else if (baseUrl.includes('medium.com')) {
      methods.push({ name: 'Medium', func: this.checkMediumFeeds.bind(this) });
    } else if (baseUrl.includes('youtube.com') || baseUrl.includes('reddit.com') || baseUrl.includes('github.com')) {
      methods.push({ name: 'Platform-specific', func: this.checkPlatformSpecificFeeds.bind(this) });
    }
    
    // Check for WordPress patterns
    if (baseUrl.includes('wordpress.com') || baseUrl.includes('wp-content') || baseUrl.includes('wp-json')) {
      methods.push({ name: 'WordPress', func: this.checkWordPressFeeds.bind(this) });
    }
    
    // Always try common paths (but after platform-specific)
    methods.push({ name: 'Common paths', func: this.checkCommonFeedPaths.bind(this) });
    
    // Sitemap discovery (run after common paths to avoid heavy requests when not needed)
    methods.push({ name: 'Sitemap', func: this.checkSitemapForFeeds.bind(this) });
    
    // Add remaining platform checks if not already added
    if (!baseUrl.includes('substack.com')) {
      methods.push({ name: 'Substack', func: this.checkSubstackFeeds.bind(this) });
    }
    if (!baseUrl.includes('medium.com')) {
      methods.push({ name: 'Medium', func: this.checkMediumFeeds.bind(this) });
    }
    if (!baseUrl.includes('youtube.com') && !baseUrl.includes('reddit.com') && !baseUrl.includes('github.com')) {
      methods.push({ name: 'Platform-specific', func: this.checkPlatformSpecificFeeds.bind(this) });
    }
    if (!baseUrl.includes('wordpress.com') && !baseUrl.includes('wp-content') && !baseUrl.includes('wp-json')) {
      methods.push({ name: 'WordPress', func: this.checkWordPressFeeds.bind(this) });
    }
    
    return methods;
  }

  // Generate parent paths by walking up the URL path hierarchy
  buildParentPaths(baseUrl) {
    try {
      const u = new URL(baseUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      const parents = ['/' + parts.slice(0, 1).join('/')];
      for (let i = 1; i < parts.length; i++) {
        parents.push('/' + parts.slice(0, i + 1).join('/'));
      }
      // Ensure root is included
      parents.unshift('/');
      // Deduplicate and keep shallowest first
      return [...new Set(parents)];
    } catch (_) {
      return ['/'];
    }
  }

  // Check parent pages for <link rel="alternate" ...> style feed hints
  async checkParentPagesMeta(baseUrl) {
    try {
      const u = new URL(baseUrl);
      const parents = this.buildParentPaths(baseUrl);
      const working = [];
      for (const p of parents) {
        const pageUrl = `${u.origin}${p}`.replace(/\/$/, '');
        const found = await this.parseHtmlForFeeds(pageUrl);
        if (found && found.length) {
          working.push(...found);
          break; // stop after first success
        }
      }
      return working;
    } catch (_) {
      return [];
    }
  }

  // Probe common feed paths on each parent path and common blog sections
  async checkParentCommonSuffixes(baseUrl) {
    try {
      const u = new URL(baseUrl);
      const parents = this.buildParentPaths(baseUrl);
      const sectionHints = ['', '/blog', '/news', '/posts', '/articles', '/updates'];
      for (const parent of parents) {
        for (const section of sectionHints) {
          const prefix = `${u.origin}${section || parent}`.replace(/\/$/, '');
          const found = await this.checkCommonFeedPaths(prefix);
          if (found && found.length) return found;
        }
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  // Parse sitemap.xml for likely feed URLs or relevant sections to probe
  async checkSitemapForFeeds(baseUrl) {
    try {
      const u = new URL(baseUrl);
      const sitemapUrl = `${u.origin}/sitemap.xml`;
      const res = await this.makeRequestWithRetry(sitemapUrl, { timeout: 8000 });
      if (!res || res.status !== 200 || typeof res.data !== 'string') return [];
      const xml = res.data;
      const urls = [];
      // Extract URLs from a simple regex (cheap and sufficient here)
      const locRegex = /<loc>([^<]+)<\/loc>/gi;
      let m;
      while ((m = locRegex.exec(xml)) !== null) {
        const href = m[1];
        // Only same-origin URLs
        try {
          const v = new URL(href);
          if (v.origin !== u.origin) continue;
          urls.push(href);
        } catch (_) {}
      }

      // First pass: direct feed-looking URLs
      const candidateFeeds = urls.filter(h => /(rss|atom|feed)\.(xml|rss|atom)|\/(rss|atom|feed)(\/|$)/i.test(h));
      for (const cand of candidateFeeds) {
        try {
          const r = await this.makeRequestWithRetry(cand);
          if (r && r.status === 200 && this.isValidFeed(r.data)) {
            return [cand];
          }
        } catch (_) {}
      }

      // Second pass: likely sections to probe with common paths
      const sectionUrls = urls.filter(h => /\/(blog|news|posts|articles|updates)(\/|$)/i.test(h));
      for (const s of sectionUrls.slice(0, 20)) { // cap to avoid heavy scans
        try {
          const found = await this.checkCommonFeedPaths(s.replace(/\/$/, ''));
          if (found && found.length) return found;
        } catch (_) {}
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  normalizeUrl(url) {
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    // Remove trailing slash
    return url.replace(/\/$/, '');
  }

  async checkCommonFeedPaths(baseUrl) {
    const workingFeeds = [];
    
    // Prioritize most common paths first
    const prioritizedPaths = [
      '/feed',           // Most common (RSS)
      '/feed.json',      // Modern JSON Feed
      '/rss',            // Very common
      '/feed.xml',       // Common
      '/rss.xml',        // Common
      '/atom.xml',       // Common
      '/feeds/all.xml',  // Common
      ...this.commonFeedPaths.filter(p => !['/feed', '/feed.json', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/feeds/all.xml'].includes(p))
    ];
    
    for (const path of prioritizedPaths) {
      try {
        const feedUrl = baseUrl + path;
        const response = await this.makeRequestWithRetry(feedUrl);
        
        if (response && response.status === 200 && this.isValidFeed(response.data)) {
          workingFeeds.push(feedUrl);
          console.log(`✅ Found working feed at: ${feedUrl}`);
          // Stop after finding first working feed to avoid rate limiting
          break;
        }
      } catch (error) {
        // Continue to next path
      }
    }
    
    return workingFeeds;
  }

  async parseHtmlForFeeds(baseUrl) {
    try {
      const response = await this.makeRequestWithRetry(baseUrl, { timeout: 10000 });
      if (!response) return [];
      
      const $ = cheerio.load(response.data);
      const feeds = [];
      
      // Look for RSS/Atom/JSON Feed links with comprehensive selectors
      const feedSelectors = [
        'link[type="application/rss+xml"]',
        'link[type="application/atom+xml"]',
        'link[type="application/json"]',
        'link[type="application/feed+json"]',
        'link[type="application/xml"]',
        'link[rel="alternate"][type*="xml"]',
        'link[rel="alternate"][type*="json"]',
        'link[rel="alternate"][type*="rss"]',
        'link[rel="alternate"][type*="atom"]',
        'link[rel="alternate"][type*="feed"]',
        'link[rel="feed"]',
        'link[rel="syndication"]'
      ];
      
      feedSelectors.forEach(selector => {
        $(selector).each((i, elem) => {
          const href = $(elem).attr('href');
          const title = $(elem).attr('title');
          const type = $(elem).attr('type');
          
          if (href) {
            const feedUrl = this.resolveUrl(baseUrl, href);
            feeds.push({
              url: feedUrl,
              title: title || 'RSS Feed',
              type: type || 'unknown'
            });
          }
        });
      });
      
      // Also look for any links that might be feeds (heuristic approach)
      $('a[href*="feed"], a[href*="rss"], a[href*="atom"], a[href*="feed.json"]').each((i, elem) => {
        const href = $(elem).attr('href');
        const text = $(elem).text().toLowerCase();
        
        if (href && (text.includes('rss') || text.includes('feed') || text.includes('syndication') || text.includes('json'))) {
          const feedUrl = this.resolveUrl(baseUrl, href);
          feeds.push({
            url: feedUrl,
            title: $(elem).text() || 'Feed',
            type: 'heuristic'
          });
        }
      });
      
      // Check if any of these feeds actually work
      const workingFeeds = [];
      for (const feed of feeds) {
        try {
          const feedResponse = await this.makeRequestWithRetry(feed.url);
          if (feedResponse && feedResponse.status === 200 && this.isValidFeed(feedResponse.data)) {
            workingFeeds.push(feed.url);
            break; // Stop after finding first working feed
          }
        } catch (error) {
          // Continue to next feed
        }
      }
      
      return workingFeeds;
    } catch (error) {
      return [];
    }
  }

  async checkWordPressFeeds(baseUrl) {
    const wpPaths = [
      '/feed/',
      '/rdf/',
      '/rss/',
      '/atom/',
      '/feed/rss/',
      '/feed/rss2/',
      '/feed/atom/',
      '/wp-feed.php',
      '/?feed=rss',
      '/?feed=rss2',
      '/?feed=atom',
      '/category/uncategorized/feed/',
      '/tag/feed/'
    ];
    
    const workingFeeds = [];
    
    for (const path of wpPaths) {
      try {
        const feedUrl = baseUrl + path;
        const response = await this.makeRequestWithRetry(feedUrl);
        
        if (response && response.status === 200 && this.isValidFeed(response.data)) {
          workingFeeds.push(feedUrl);
          break; // Stop after finding first working feed
        }
      } catch (error) {
        // Continue to next path
      }
    }
    
    return workingFeeds;
  }

  async checkSubstackFeeds(baseUrl) {
    try {
      // Check if it's a Substack URL
      if (baseUrl.includes('substack.com')) {
        const substackFeed = baseUrl + '/feed';
        const response = await this.makeRequestWithRetry(substackFeed);
        
        if (response && response.status === 200 && this.isValidFeed(response.data)) {
          return [substackFeed];
        }
      }
      
      return [];
    } catch (error) {
      return [];
    }
  }

  async checkMediumFeeds(baseUrl) {
    try {
      // Check if it's a Medium URL
      if (baseUrl.includes('medium.com')) {
        const mediumFeed = baseUrl + '/feed';
        const response = await this.makeRequestWithRetry(mediumFeed);
        
        if (response && response.status === 200 && this.isValidFeed(response.data)) {
          return [mediumFeed];
        }
      }
      
      return [];
    } catch (error) {
      return [];
    }
  }

  async checkPlatformSpecificFeeds(baseUrl) {
    const workingFeeds = [];
    
    try {
      // YouTube Channel feeds
      if (baseUrl.includes('youtube.com/channel/') || baseUrl.includes('youtube.com/c/') || baseUrl.includes('youtube.com/user/')) {
        const channelId = this.extractYouTubeChannelId(baseUrl);
        if (channelId) {
          const youtubeFeed = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
          const response = await this.makeRequestWithRetry(youtubeFeed);
          if (response && response.status === 200 && this.isValidFeed(response.data)) {
            workingFeeds.push(youtubeFeed);
          }
        }
      }
      
      // Reddit feeds
      if (baseUrl.includes('reddit.com/r/')) {
        const subredditMatch = baseUrl.match(/reddit\.com\/r\/([^\/]+)/);
        if (subredditMatch) {
          const subreddit = subredditMatch[1];
          const redditFeed = `https://www.reddit.com/r/${subreddit}.rss`;
          const response = await this.makeRequestWithRetry(redditFeed);
          if (response && response.status === 200 && this.isValidFeed(response.data)) {
            workingFeeds.push(redditFeed);
          }
        }
      }
      
      // GitHub feeds
      if (baseUrl.includes('github.com/')) {
        const githubFeed = baseUrl + '.atom';
        const response = await this.makeRequestWithRetry(githubFeed);
        if (response && response.status === 200 && this.isValidFeed(response.data)) {
          workingFeeds.push(githubFeed);
        }
      }
      
      // Blogger feeds
      if (baseUrl.includes('blogspot.com') || baseUrl.includes('blogger.com')) {
        const bloggerFeed = baseUrl + '/feeds/posts/default';
        const response = await this.makeRequestWithRetry(bloggerFeed);
        if (response && response.status === 200 && this.isValidFeed(response.data)) {
          workingFeeds.push(bloggerFeed);
        }
      }
      
      // Tumblr feeds
      if (baseUrl.includes('tumblr.com')) {
        const tumblrFeed = baseUrl + '/rss';
        const response = await this.makeRequestWithRetry(tumblrFeed);
        if (response && response.status === 200 && this.isValidFeed(response.data)) {
          workingFeeds.push(tumblrFeed);
        }
      }
      
      // Mastodon feeds
      if (baseUrl.includes('mastodon.') || baseUrl.includes('mstdn.') || baseUrl.includes('mastodon.social')) {
        const mastodonFeed = baseUrl + '.rss';
        const response = await this.makeRequestWithRetry(mastodonFeed);
        if (response && response.status === 200 && this.isValidFeed(response.data)) {
          workingFeeds.push(mastodonFeed);
        }
      }
      
    } catch (error) {
      // Continue even if one platform check fails
    }
    
    return workingFeeds;
  }

  extractYouTubeChannelId(url) {
    try {
      // Extract channel ID from various YouTube URL formats
      const patterns = [
        /youtube\.com\/channel\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/c\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/user\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/@([a-zA-Z0-9_-]+)/
      ];
      
      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
          return match[1];
        }
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  resolveUrl(baseUrl, href) {
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return href;
    }
    
    if (href.startsWith('//')) {
      return 'https:' + href;
    }
    
    if (href.startsWith('/')) {
      return baseUrl + href;
    }
    
    return baseUrl + '/' + href;
  }

  isValidFeed(content) {
    if (!content) return false;
    if (typeof content !== 'string') return false;

    // Only sniff the first chunk for speed and to reduce false positives
    const snippet = content.slice(0, 4096).toLowerCase();

    // Quickly reject obvious HTML documents
    if (snippet.includes('<html') || snippet.includes('<!doctype html')) {
      return false;
    }

    // RSS/Atom/XML signatures near the top
    const xmlSignatures = ['<rss', '<feed', '<rdf:rdf', '<channel', '<?xml'];
    if (xmlSignatures.some(sig => snippet.includes(sig))) {
      return true;
    }

    // JSON Feed minimal validation
    try {
      const json = JSON.parse(snippet);
      if (json && typeof json === 'object' && json.version && (json.items || json.item)) {
        return true;
      }
    } catch (_) {
      // not JSON
    }

    return false;
  }

  async testFeed(feedUrl) {
    try {
      // Quick HEAD to verify the content-type when available
      try {
        const head = await axios.head(feedUrl, {
          timeout: 5000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS Feed Discovery Bot)' }
        });
        const ct = (head.headers['content-type'] || '').toLowerCase();
        // Accept xml/atom/rss or json (for JSONFeed). If clearly html, reject early.
        if (ct && ct.includes('html')) {
          return { success: false, status: head.status, error: 'HTML content-type' };
        }
      } catch (_) {
        // HEAD not supported; continue with GET
      }

      // GET with small timeout and rely on content sniffing
      const response = await this.makeRequestWithRetry(feedUrl, { timeout: 10000 });
      const contentType = (response.headers['content-type'] || '').toLowerCase();

      // Reject obvious HTML content-types
      if (contentType.includes('text/html')) {
        return { success: false, status: response.status, error: 'HTML page, not a feed' };
      }

      // Validate body content
      if (response && response.status === 200 && this.isValidFeed(response.data)) {
        return {
          success: true,
          status: response.status,
          contentType,
          size: typeof response.data === 'string' ? response.data.length : 0
        };
      }

      return { success: false, status: response?.status || 'unknown', error: 'Invalid feed content' };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        status: error.response?.status || 'unknown'
      };
    }
  }

  // New method: Make HTTP requests with retry logic and rate limiting
  async makeRequestWithRetry(url, options = {}) {
    const domain = new URL(url).hostname;
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second base delay
    
    // Check if we need to delay for this domain
    const lastRequest = this.requestDelays.get(domain);
    if (lastRequest && (Date.now() - lastRequest) < 2000) {
      // Wait at least 2 seconds between requests to same domain
      await new Promise(resolve => setTimeout(resolve, 2000 - (Date.now() - lastRequest)));
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get(url, {
          timeout: options.timeout || 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; RSS Feed Discovery Bot)',
            ...options.headers
          }
        });
        
        // Update last request time
        this.requestDelays.set(domain, Date.now());
        return response;
        
      } catch (error) {
        const status = error.response?.status;
        
        // Handle rate limiting (429) with exponential backoff
        if (status === 429) {
          const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
          console.log(`⏳ Rate limited (429), waiting ${delay}ms before retry ${attempt}/${maxRetries} for ${domain}`);
          
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        
        // Handle other errors
        if (status >= 500 && attempt < maxRetries) {
          // Server errors - retry with delay
          const delay = baseDelay * attempt;
          console.log(`⏳ Server error (${status}), waiting ${delay}ms before retry ${attempt}/${maxRetries} for ${domain}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Don't retry for client errors (4xx except 429)
        if (status >= 400 && status < 500 && status !== 429) {
          throw error;
        }
        
        // Last attempt or other errors
        if (attempt === maxRetries) {
          throw error;
        }
      }
    }
  }

  // Extract structured data (JSON-LD) from a webpage
  async extractStructuredData(baseUrl) {
    try {
      const response = await this.makeRequestWithRetry(baseUrl, { timeout: 10000 });
      if (!response) return [];
      
      const $ = cheerio.load(response.data);
      const articles = [];
      
      // Look for JSON-LD structured data
      $('script[type="application/ld+json"]').each((i, elem) => {
        try {
          const data = JSON.parse($(elem).html());
          
          // Handle BlogPosting
          if (data['@type'] === 'BlogPosting' || data['@type'] === 'Article') {
            articles.push({
              url: data.url || data.mainEntityOfPage?.['@id'] || data['@id'] || '',
              title: data.headline || data.name || '',
              description: data.description || '',
              datePublished: data.datePublished || data.dateCreated || null
            });
          }
          
          // Handle Blog with blogPosts
          if (data['@type'] === 'Blog' && data.blogPost) {
            const blogPosts = Array.isArray(data.blogPost) ? data.blogPost : [data.blogPost];
            blogPosts.forEach(post => {
              if (post['@type'] === 'BlogPosting' || post['@type'] === 'Article') {
                articles.push({
                  url: post.url || post.mainEntityOfPage?.['@id'] || post['@id'] || '',
                  title: post.headline || post.name || '',
                  description: post.description || '',
                  datePublished: post.datePublished || post.dateCreated || null
                });
              }
            });
          }
          
          // Handle ItemList with BlogPosting items
          if (data['@type'] === 'ItemList' && data.itemListElement) {
            data.itemListElement.forEach(item => {
              const element = item.item || item;
              if (element['@type'] === 'BlogPosting' || element['@type'] === 'Article') {
                articles.push({
                  url: element.url || element.mainEntityOfPage?.['@id'] || element['@id'] || '',
                  title: element.headline || element.name || '',
                  description: element.description || '',
                  datePublished: element.datePublished || element.dateCreated || null
                });
              }
            });
          }
        } catch (e) {
          // Invalid JSON, skip
        }
      });
      
      // Return unique articles by URL
      const uniqueArticles = [];
      const seenUrls = new Set();
      for (const article of articles) {
        if (article.url && !seenUrls.has(article.url)) {
          seenUrls.add(article.url);
          uniqueArticles.push(article);
        }
      }
      
      return uniqueArticles;
    } catch (error) {
      return [];
    }
  }

  // Extract articles from blog section HTML (fallback for sites without feeds)
  async extractArticlesFromBlogSection(baseUrl) {
    try {
      // Try to find blog section
      const blogPaths = ['/blog', '/posts', '/articles', '/news', '/press', '/press-releases'];
      let blogUrl = baseUrl;
      
      for (const path of blogPaths) {
        try {
          const testUrl = baseUrl.replace(/\/$/, '') + path;
          const response = await this.makeRequestWithRetry(testUrl, { timeout: 5000 });
          if (response && response.status === 200) {
            blogUrl = testUrl;
            break;
          }
        } catch (e) {
          // Continue to next path
        }
      }
      
      // Fetch blog page
      const response = await this.makeRequestWithRetry(blogUrl, { timeout: 10000 });
      if (!response) return [];
      
      const $ = cheerio.load(response.data);
      const articles = [];
      
      // Extract structured data first (most reliable)
      const structuredArticles = await this.extractStructuredData(blogUrl);
      articles.push(...structuredArticles);
      
      // Strategy 1: Look for all links that might be articles (posts, blog, etc.)
      const articleLinks = [];
      $('a[href*="/post"], a[href*="/blog"], a[href*="/article"], a[href*="/posts"]').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && !href.match(/^#|^javascript:|mailto:|tel:/) && href.match(/\/post/)) {
          // Fix URL resolution - handle base URL with /post properly
          let fullLink;
          if (href.startsWith('http')) {
            fullLink = href;
          } else if (href.startsWith('/')) {
            // Absolute path - resolve against domain
            const baseUrlObj = new URL(blogUrl);
            fullLink = `${baseUrlObj.protocol}//${baseUrlObj.host}${href}`;
          } else {
            // Relative path - resolve against blogUrl
            fullLink = this.resolveUrl(blogUrl, href);
          }
          
          // Fix double /post/ issue: if base has /post and link has /posts/, remove duplicate
          // Also handle /post/... links that should be /posts/...
          if (fullLink.includes('/post/posts/')) {
            fullLink = fullLink.replace('/post/posts/', '/posts/');
          }
          // If link is like /posts/... but base is /post, fix it
          if (blogUrl.includes('/post') && !blogUrl.includes('/posts') && fullLink.includes('/post/') && !fullLink.includes('/post/posts/')) {
            // Check if link should be /posts/ instead
            if (fullLink.match(/\/post\/posts\/[^\/]+/)) {
              fullLink = fullLink.replace(/\/post\//, '/posts/');
            }
          }
          if (!articleLinks.some(a => a.url === fullLink)) {
            const $link = $(elem);
            const $container = $link.closest('article, [class*="post"], [class*="article"], [class*="card"], div, section');
            
            // Try multiple strategies to find the title - prioritize titles in the container
            let title = null;
            
            // Strategy 1: Look for heading in the container (most specific)
            const headings = $container.find('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="headline"]');
            if (headings.length > 0) {
              // Find the heading that's closest to this link or in the same container
              headings.each((idx, heading) => {
                const $heading = $(heading);
                // Check if heading is in the same container as the link
                if ($heading.closest($container).length > 0 || $container.find($heading).length > 0) {
                  const headingText = $heading.text().trim();
                  if (headingText && headingText.length > 10 && !title) {
                    title = headingText;
                    return false; // Break
                  }
                }
              });
            }
            
            // Strategy 2: Use link text if it's meaningful
            if (!title || title.length < 10) {
              const linkText = $link.text().trim();
              if (linkText && linkText.length > 10 && !linkText.toLowerCase().includes('read more') && !linkText.toLowerCase().includes('view')) {
                title = linkText;
              }
            }
            
            // Strategy 3: Look for title in parent elements
            if (!title || title.length < 10) {
              let $parent = $link.parent();
              for (let i = 0; i < 3 && $parent.length; i++) {
                const parentTitle = $parent.find('h1, h2, h3, h4, [class*="title"]').first().text().trim();
                if (parentTitle && parentTitle.length > 10) {
                  title = parentTitle;
                  break;
                }
                $parent = $parent.parent();
              }
            }
            
            if (title && title.length > 10 && !title.toLowerCase().includes('featured') && !title.toLowerCase().includes('other posts')) {
              // Try to find date near the link with multiple strategies
              let dateText = $container.find('time[datetime]').first().attr('datetime') ||
                           $container.find('[datetime]').first().attr('datetime') ||
                           $container.find('[class*="date"]').first().text().trim() ||
                           $container.find('time').first().text().trim();
              
              // Generic date extraction from text content (works for any blog format)
              if (!dateText || dateText.length < 10) {
                const containerText = $container.text();
                
                // Try multiple date patterns (generic, not Vana-specific)
                // Pattern 1: Full month name "SEPTEMBER 22, 2025" or "May 22, 2025"
                let dateMatch = containerText.match(/(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d+,\s+\d{4}/i);
                
                // Pattern 2: "BY X | MONTH DAY, YEAR" format (common on many blogs)
                if (!dateMatch) {
                  dateMatch = containerText.match(/(?:BY|by|By)\s+[^|]+\s+\|\s+(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(\d+),\s+(\d{4})/i);
                  if (dateMatch && dateMatch.length >= 4) {
                    dateText = dateMatch[1] + ' ' + dateMatch[2] + ', ' + dateMatch[3];
                  }
                }
                
                // Pattern 3: Short month "Sep 22, 2025" or "May 22, 2025"
                if (!dateMatch) {
                  dateMatch = containerText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d+,\s+\d{4}/i);
                }
                
                // Pattern 4: ISO format "2025-09-22" or "2025/09/22"
                if (!dateMatch) {
                  dateMatch = containerText.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
                }
                
                // Pattern 5: DD/MM/YYYY or MM/DD/YYYY
                if (!dateMatch) {
                  dateMatch = containerText.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
                }
                
                if (dateMatch && !dateText) {
                  dateText = dateMatch[0];
                }
              }
              
              // Generic date parsing (handles multiple formats)
              let pubDate = null;
              if (dateText) {
                try {
                  // Clean up the date text (remove "BY X |" prefix, etc.)
                  let cleanDate = dateText.trim()
                    .replace(/BY\s+[^|]+\s+\|\s+/i, '')
                    .replace(/Published\s+on\s+/i, '')
                    .replace(/Posted\s+on\s+/i, '')
                    .replace(/Date:\s*/i, '')
                    .trim();
                  
                  // Try parsing directly (handles most standard formats)
                  pubDate = new Date(cleanDate);
                  
                  // If that fails, try manual parsing for month names
                  if (isNaN(pubDate.getTime())) {
                    const monthMap = {
                      'JANUARY': '01', 'FEBRUARY': '02', 'MARCH': '03', 'APRIL': '04',
                      'MAY': '05', 'JUNE': '06', 'JULY': '07', 'AUGUST': '08',
                      'SEPTEMBER': '09', 'OCTOBER': '10', 'NOVEMBER': '11', 'DECEMBER': '12',
                      'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
                      'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
                      'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
                    };
                    
                    const dateParts = cleanDate.match(/(\w+)\s+(\d+),\s+(\d{4})/i);
                    if (dateParts && dateParts.length >= 4) {
                      const monthName = dateParts[1].toUpperCase();
                      const month = monthMap[monthName] || monthMap[monthName.substring(0, 3)];
                      if (month) {
                        const day = dateParts[2].padStart(2, '0');
                        const year = dateParts[3];
                        pubDate = new Date(`${year}-${month}-${day}`);
                      }
                    }
                  }
                  
                  // Validate the date
                  if (isNaN(pubDate.getTime()) || pubDate.getFullYear() < 2000 || pubDate.getFullYear() > 2100) {
                    pubDate = null;
                  }
                } catch (e) {
                  pubDate = null;
                }
              }
              
              articleLinks.push({
                url: fullLink,
                title: title,
                description: $container.find('[class*="excerpt"], [class*="summary"], p').first().text().trim().substring(0, 300) || '',
                datePublished: pubDate
              });
            }
          }
        }
      });
      articles.push(...articleLinks);
      
      // Strategy 2: Fallback - HTML pattern matching for article/blog post elements
      const articleSelectors = [
        'article',
        '[class*="article"]',
        '[class*="post"]',
        '[class*="blog-post"]',
        '[class*="card"]',
        '[id*="article"]',
        '[id*="post"]',
        '.entry',
        '.news-item'
      ];
      
      for (const selector of articleSelectors) {
        $(selector).each((i, elem) => {
          const $elem = $(elem);
          const link = $elem.find('a').first().attr('href');
          const title = $elem.find('h1, h2, h3, h4, [class*="title"], [class*="headline"]').first().text().trim();
          
          if (title && link && title.length > 10 && !title.toLowerCase().includes('featured')) {
            const fullLink = link.startsWith('http') ? link : this.resolveUrl(blogUrl, link);
            
            // Try to extract date with multiple formats
            let dateText = $elem.find('time[datetime]').first().attr('datetime') || 
                          $elem.find('[class*="date"]').first().text().trim() ||
                          $elem.find('time').first().text().trim();
            
            // Also check for date in text like "SEPTEMBER 22, 2025"
            if (!dateText) {
              const text = $elem.text();
              const dateMatch = text.match(/(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d+,\s+\d{4}/i);
              if (dateMatch) {
                dateText = dateMatch[0];
              }
            }
            
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
              url: fullLink,
              title: title,
              description: $elem.find('[class*="excerpt"], [class*="summary"], p').first().text().trim().substring(0, 300),
              datePublished: pubDate
            });
          }
        });
      }
      
      // Deduplicate by URL
      const uniqueArticles = [];
      const seenUrls = new Set();
      for (const article of articles) {
        if (article.url && !seenUrls.has(article.url)) {
          seenUrls.add(article.url);
          uniqueArticles.push(article);
        }
      }
      
      // Sort by date (newest first)
      uniqueArticles.sort((a, b) => {
        if (a.datePublished && b.datePublished) {
          return new Date(b.datePublished) - new Date(a.datePublished);
        }
        return 0;
      });
      
      return uniqueArticles.slice(0, 20); // Return max 20 most recent
    } catch (error) {
      return [];
    }
  }
}

module.exports = FeedDiscovery;

