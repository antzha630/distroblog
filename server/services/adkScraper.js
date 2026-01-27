 // ADK (Agent Development Kit) implementation using Google Search
const axios = require('axios');
// This uses an agent with Google Search tool instead of scraping HTML
// Based on: https://google.github.io/adk-docs/

/**
 * ADK-based article finder using Google Search agent
 * Instead of scraping HTML, uses an AI agent with Google Search to find articles
 * 
 * Benefits:
 * - No scraping needed (uses Google Search)
 * - Works with JS-rendered sites automatically
 * - More reliable (no HTML parsing)
 * - Lower memory usage (no Playwright browsers)
 */
class ADKScraper {
  constructor() {
    this.agent = null;
    this.runner = null;
    this.initialized = false;
    this.modelName = null;
    // Rate limiting: gemini-2.0-flash-exp has 10 RPM limit
    // We'll throttle to max 1 request per 7 seconds (8.5 RPM) to stay safe
    this.lastRequestTime = 0;
    this.minRequestInterval = 7000; // 7 seconds between requests (8.5 RPM, safely under 10 RPM limit)
  }

  async initialize() {
    if (this.initialized) return;
    
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.warn('⚠️ Google API key not found. ADK scraping will be disabled. Set GOOGLE_API_KEY or GEMINI_API_KEY in .env');
      return;
    }

    try {
      // Dynamic import since ADK is ES module and we're in CommonJS
      const adk = await import('@google/adk');
      
      // Pick the first available model that supports Google Search
      const candidateModels = [
        'gemini-2.0-flash-exp',         // preferred
        'gemini-2.0-flash-live-001',    // live variant (from reference)
        'gemini-1.5-flash-latest',      // common alias
        'gemini-1.5-flash',             // fallback
        'gemini-1.5-flash-001',         // legacy fallback
        'gemini-2.5-pro-preview-06-05'  // pro preview (used in reference)
      ];

      let llm = null;
      let modelName = null;

      for (const candidate of candidateModels) {
        try {
          llm = new adk.Gemini({
            model: candidate,
            apiKey: apiKey
          });
          modelName = candidate;
          console.log(`✅ [ADK] Using model: ${candidate} (Google Search tool compatible)`);
          break;
        } catch (e) {
          console.warn(`⚠️ [ADK] Model ${candidate} unavailable: ${e.message}`);
          llm = null;
        }
      }

      if (!llm || !modelName) {
        throw new Error('No Gemini model available for ADK with Google Search');
      }
      this.modelName = modelName;

      // Create LlmAgent with Google Search tool
      // The agent will use Google Search to find articles from websites
      // Based on Python ADK pattern: tools=[google_search] with simple instruction
      this.agent = new adk.LlmAgent({
        name: 'article_finder',
        model: llm, // Pass the LLM object directly (not model name string)
        description: 'Agent to find recent blog posts and articles from a website URL using Google Search.',
        instruction: `You help a journalist by returning exactly 3 of the most recent blog posts or articles from a given site. Use the Google Search tool and return only a JSON array with objects: title, url, description, datePublished.

Rules (must follow all):
- Hostname must match the target domain; reject other domains.
- URL must point to an article page with a meaningful path (length >= 11 chars); reject home/about/contact/privacy/terms/team/careers/docs/login/signup/dashboard/app or other generic pages.
- No Google redirect URLs (vertexaisearch / grounding / google.com/grounding).
- Prefer canonical/short article URLs over long slugs when both appear.
- Title must be non-null, non-empty, and not generic (not "Blog" or "Home").
- datePublished: use ISO (YYYY-MM-DD or with time) when visible in search; null if truly unavailable.
- Sort newest first.
Return only the JSON array, nothing else.`,
        tools: [adk.GOOGLE_SEARCH] // Use Google Search tool (equivalent to Python's google_search)
      });

      // Create in-memory runner to execute the agent
      this.runner = new adk.InMemoryRunner({
        agent: this.agent,
        appName: 'distroblog'
      });

      // Verify the agent was created correctly
      if (!this.agent) {
        throw new Error('Failed to create ADK agent');
      }
      
      // Verify the canonical model is available
      try {
        const canonicalModel = this.agent.canonicalModel;
        if (!canonicalModel) {
          throw new Error('Agent created but canonical model is not available');
        }
        console.log(`✅ [ADK] Agent canonical model: ${canonicalModel.model || 'unknown'}`);
      } catch (modelError) {
        console.error('⚠️ [ADK] Warning: Could not verify canonical model:', modelError.message);
        // Continue anyway - might work at runtime
      }

      this.initialized = true;
      console.log('✅ ADK agent initialized successfully with Google Search tool');
    } catch (error) {
      console.error('❌ Error initializing ADK agent:', error.message);
      if (error.message.includes('Cannot find module')) {
        console.error('   Make sure @google/adk is installed: npm install @google/adk');
      }
      throw error;
    }
  }

  /**
   * Find articles from a website URL using ADK agent with Google Search
   * Returns articles in RSS-like format for compatibility
   */
  async scrapeArticles(source) {
    // MEMORY FIX: Track session outside try block so we can clean it up in catch
    let session = null;
    
    try {
      console.log(`🤖 [ADK] Finding articles from: ${source.url} using Google Search agent`);

      // Initialize if not already done
      if (!this.initialized) {
        await this.initialize();
      }

      if (!this.agent || !this.runner) {
      throw new Error('ADK agent not initialized. Check GOOGLE_API_KEY environment variable.');
      }

      // Rate limiting: Ensure we don't exceed 10 RPM limit
      // Wait if necessary to maintain at least 7 seconds between requests
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        const waitTime = this.minRequestInterval - timeSinceLastRequest;
        console.log(`⏳ [ADK] Rate limiting: waiting ${waitTime}ms to stay under 10 RPM limit...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      this.lastRequestTime = Date.now();

      // Create a session for this request
      // MEMORY FIX: Use a unique session ID that we can clean up after use
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      session = await this.runner.sessionService.createSession({
        appName: 'distroblog',
        userId: 'system',
        id: sessionId,
        state: {}
      });

      // Ask the agent to find articles from the website using Google Search
      // Improved prompt to get specific article URLs and most recent articles
      const domain = new URL(source.url).hostname;
      const baseDomain = domain.replace(/^www\./, ''); // Remove www. for matching
      const searchQuery = `Find exactly 3 of the most recent blog posts/articles from ${source.url}.

Rules (apply strictly):
- Domain must be ${baseDomain} (hostname contains ${baseDomain}); ignore other domains.
- URL must be a direct article with a meaningful path (length >= 11 chars); do not return ${source.url}, ${source.url}/, /about, /contact, /privacy, /terms, /team, /careers, /docs, /login, /signup, /dashboard, /app, or any generic page.
- No Google redirect URLs (vertexaisearch / grounding / google.com/grounding); use the final article URL.
- Prefer canonical/short article URLs when both short and long appear.
- Title must be non-null, non-empty, and not generic (not "Blog" or "Home").
- datePublished in ISO (YYYY-MM-DD or with time) when visible in search results; null only if no date is visible.
- Sort newest first.

Return only a JSON array of 3 objects with: title, url, description, datePublished. No extra text.`;
      
      let articles = [];
      let lastEvent = null;
      let fullResponse = '';

      // Run the agent and collect all events
      let eventCount = 0;
      for await (const event of this.runner.runAsync({
        userId: session.userId,
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [{ text: searchQuery }]
        },
        runConfig: {
          maxLlmCalls: 5 // Limit to prevent infinite loops
        }
      })) {
        eventCount++;
        lastEvent = event;
        
        // Log the entire event for debugging
        console.log(`📦 [ADK] Event #${eventCount} - author: ${event.author}, has content: ${!!event.content}, partial: ${event.partial || false}`);
        if (event.content) {
          console.log(`📦 [ADK] Content role: ${event.content.role}, has parts: ${!!event.content.parts}, parts count: ${event.content.parts ? event.content.parts.length : 0}`);
        }
        
        // Check for errors in the event
        if (event.errorCode || event.errorMessage) {
          console.error(`❌ [ADK] API Error - Code: ${event.errorCode}, Message: ${event.errorMessage}`);
          if (event.errorCode === '429') {
            console.error(`⚠️ [ADK] Rate limit/quota exceeded. Will fallback to traditional scraper.`);
            // Throw error to trigger fallback
            throw new Error(`Rate limit exceeded (429): ${event.errorMessage}`);
          } else if (event.errorCode === '400' && event.errorMessage && event.errorMessage.includes('Search as tool is not enabled')) {
            console.error(`⚠️ [ADK] Model does not support Google Search tool. Will fallback to traditional scraper.`);
            // Throw error to trigger fallback
            throw new Error(`Model does not support Google Search: ${event.errorMessage}`);
          }
        }
        
        // Check if this is a final response
        const adk = await import('@google/adk');
        const isFinal = adk.isFinalResponse ? adk.isFinalResponse(event) : (!event.partial && event.content);
        console.log(`📦 [ADK] Is final response: ${isFinal}`);
        
        // Extract articles from agent response
        if (event.content && event.content.parts) {
          console.log(`📦 [ADK] Event has ${event.content.parts.length} parts`);
          for (let i = 0; i < event.content.parts.length; i++) {
            const part = event.content.parts[i];
            console.log(`📦 [ADK] Part ${i}: has text=${!!part.text}, has functionCall=${!!part.functionCall}, has functionResponse=${!!part.functionResponse}`);
            
            // Log function calls to see if Google Search is being used
            if (part.functionCall) {
              console.log(`🔧 [ADK] Agent called function: ${part.functionCall.name}`);
              if (part.functionCall.args) {
                console.log(`   Args: ${JSON.stringify(part.functionCall.args).substring(0, 200)}...`);
              }
            }
            if (part.functionResponse) {
              console.log(`📥 [ADK] Agent received function response: ${part.functionResponse.name}`);
              if (part.functionResponse.response) {
                console.log(`   Response preview: ${JSON.stringify(part.functionResponse.response).substring(0, 300)}...`);
              }
            }
            if (part.text) {
              fullResponse += part.text + '\n';
              console.log(`📝 [ADK] Received text (${part.text.length} chars): ${part.text.substring(0, 200)}...`);
              
              // Try to parse JSON from the response
              try {
                // Extract JSON from markdown code blocks if present
                let text = part.text.trim();
                if (text.includes('```json')) {
                  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                } else if (text.includes('```')) {
                  text = text.replace(/```\n?/g, '').trim();
                }
                
                // Clean up control characters that can break JSON parsing
                text = text.replace(/[\x00-\x1F\x7F]/g, '');
                
                // Try to find JSON array in the text
                const jsonMatch = text.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                  const parsed = JSON.parse(jsonMatch[0]);
                  if (Array.isArray(parsed) && parsed.length > 0) {
                    articles = parsed;
                    console.log(`✅ [ADK] Found ${articles.length} articles in JSON response`);
                    break;
                  }
                }
              } catch (e) {
                // Not JSON, continue
                if (e.message.includes('JSON')) {
                  console.log(`⚠️ [ADK] JSON parse error in part ${i}: ${e.message}`);
                }
              }
            }
          }
        }
      }

      // Always log the response for debugging
      console.log(`📊 [ADK] Total events received: ${eventCount}`);
      if (lastEvent) {
        console.log(`📊 [ADK] Last event author: ${lastEvent.author}, partial: ${lastEvent.partial || false}`);
        console.log(`📊 [ADK] Last event content: ${JSON.stringify(lastEvent.content || {}).substring(0, 500)}`);
      }
      
      if (fullResponse) {
        console.log(`📝 [ADK] Full agent response (first 1000 chars):\n${fullResponse.substring(0, 1000)}${fullResponse.length > 1000 ? '...' : ''}`);
      } else {
        console.log(`⚠️ [ADK] No response text received from agent`);
        console.log(`⚠️ [ADK] Last event structure: ${JSON.stringify(lastEvent || {}).substring(0, 1000)}`);
      }

      // If no articles found in structured format, try to extract from full response
      if (articles.length === 0 && fullResponse) {
        // Check if response is just empty markdown code blocks (e.g., just "```")
        const trimmedResponse = fullResponse.trim();
        if (trimmedResponse === '```' || trimmedResponse === '```json' || trimmedResponse.length < 10) {
          console.log(`⚠️ [ADK] [ISSUE] Response is empty or minimal (${trimmedResponse.length} chars). Agent may not have completed the request.`);
          console.log(`⚠️ [ADK] [ISSUE] This could indicate: 1) Agent didn't use Google Search tool, 2) Search returned no results, 3) Agent response was truncated`);
        } else {
          try {
            // Clean up control characters that can break JSON parsing
            let cleanedResponse = fullResponse.replace(/[\x00-\x1F\x7F]/g, '');
            
            // Look for JSON anywhere in the full response
            const jsonMatch = cleanedResponse.match(/\[[\s\S]*?\]/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (Array.isArray(parsed) && parsed.length > 0) {
                articles = parsed;
                console.log(`✅ [ADK] Found ${articles.length} articles in full response JSON`);
              } else {
                console.log(`⚠️ [ADK] [ISSUE] Found JSON array but it's empty. Agent may not have found any articles.`);
              }
            } else {
              console.log(`⚠️ [ADK] [ISSUE] No JSON array found in response. Response might be text-only or agent didn't follow format.`);
              console.log(`⚠️ [ADK] [ISSUE] Full response preview: ${fullResponse.substring(0, 500)}...`);
            }
          } catch (e) {
            console.log(`⚠️ [ADK] [ISSUE] Could not parse JSON from agent response: ${e.message}`);
            console.log(`⚠️ [ADK] [ISSUE] Response preview: ${fullResponse.substring(0, 500)}...`);
          }
        }
      } else if (articles.length > 0) {
        console.log(`✅ [ADK] Successfully extracted ${articles.length} articles from agent response`);
      } else if (articles.length === 0 && !fullResponse) {
        console.log(`⚠️ [ADK] [ISSUE] No articles found and no response text. Agent may have failed silently or not executed.`);
      }
      
      // Filter articles to only include those from the same domain
      // Also filter out generic URLs (homepage, base blog URL without article path)
      // AND filter out Google redirect URLs and invalid URLs
      const sourceDomain = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
      const sourceUrlObj = new URL(source.url);
      const basePath = sourceUrlObj.pathname.endsWith('/') ? sourceUrlObj.pathname.slice(0, -1) : sourceUrlObj.pathname;
      
      // First, filter out articles with null/empty titles
      articles = articles.filter(article => {
        const title = article.title;
        if (!title || title === null || title === 'null' || title.trim() === '') {
          console.log(`⚠️ [ADK] Filtering out article with null/empty title: ${article.url || article.link || 'unknown'}`);
          return false;
        }
        return true;
      });
      
      // Track ADK accuracy metrics
      const accuracyMetrics = {
        totalReturned: articles.length,
        filteredOut: {
          missingUrl: 0,
          nullTitle: 0,
          googleRedirect: 0,
          nullUrl: 0,
          wrongDomain: 0,
          genericUrl: 0,
          shortPath: 0,
          invalidUrl: 0
        },
        validArticles: 0,
        articlesWithDates: 0,
        articlesWithoutDates: 0
      };

      const articlesBeforeFilter = articles.length;
      const filteredArticles = articles.filter(article => {
        try {
          const articleUrl = article.url || article.link;
          if (!articleUrl) {
            accuracyMetrics.filteredOut.missingUrl++;
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out article with missing URL (title: ${article.title || 'unknown'})`);
            return false;
          }
          
          // Filter out Google redirect URLs (grounding API redirects)
          if (articleUrl.includes('vertexaisearch.cloud.google.com') || 
              articleUrl.includes('grounding-api-redirect') ||
              articleUrl.includes('google.com/grounding')) {
            accuracyMetrics.filteredOut.googleRedirect++;
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out Google redirect URL: ${articleUrl.substring(0, 80)}...`);
            return false;
          }
          
          // Filter out null URLs or placeholder URLs
          if (articleUrl === 'null' || articleUrl === null || articleUrl.trim() === '') {
            accuracyMetrics.filteredOut.nullUrl++;
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out null/empty URL (title: ${article.title || 'unknown'})`);
            return false;
          }
          
          const articleUrlObj = new URL(articleUrl);
          const articleDomain = articleUrlObj.hostname.replace(/^www\./, '').toLowerCase();
          
          // Must match domain
          if (articleDomain !== sourceDomain) {
            accuracyMetrics.filteredOut.wrongDomain++;
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out wrong domain: ${articleDomain} (expected: ${sourceDomain}) - Title: "${article.title?.substring(0, 50) || 'unknown'}" - URL: ${articleUrl.substring(0, 80)}...`);
            return false;
          }
          
          // Filter out generic URLs (homepage, base blog URL without specific article path)
          const articlePath = articleUrlObj.pathname;
          // If URL is just the base blog URL or homepage, skip it
          if (articlePath === '/' || articlePath === basePath || articlePath === basePath + '/') {
            accuracyMetrics.filteredOut.genericUrl++;
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out generic URL (homepage/base): ${articleUrl}`);
            return false;
          }
          
          // Filter out common non-article pages (about, contact, privacy, terms, etc.)
          const nonArticlePaths = ['/about', '/contact', '/privacy', '/terms', '/terms-of-service', 
                                   '/privacy-policy', '/legal', '/careers', '/jobs', '/team', 
                                   '/faq', '/help', '/support', '/docs', '/documentation'];
          const normalizedPath = articlePath.toLowerCase().replace(/\/$/, ''); // Remove trailing slash
          if (nonArticlePaths.includes(normalizedPath) || 
              normalizedPath.startsWith('/about/') ||
              normalizedPath.startsWith('/contact/') ||
              normalizedPath.startsWith('/privacy') ||
              normalizedPath.startsWith('/terms')) {
            accuracyMetrics.filteredOut.genericUrl++;
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out non-article page (${normalizedPath}): ${articleUrl}`);
            return false;
          }
          
          // Must have at least 10 characters in the path after the domain (as per prompt requirement)
          // Calculate path length after removing the base path
          const pathAfterBase = articlePath.startsWith(basePath) 
            ? articlePath.substring(basePath.length) 
            : articlePath;
          const pathAfterDomain = articlePath; // Full pathname after domain
          
          // Check: path after domain should be at least 10 characters (excluding leading slash)
          // This ensures we have a meaningful article path like "/blog/article-name" or "/article-slug"
          if (pathAfterDomain.length < 11) { // At least "/" + 10 chars = 11 total
            accuracyMetrics.filteredOut.shortPath++;
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out URL with insufficient path length (${pathAfterDomain.length} chars, need at least 11): ${articleUrl}`);
            return false;
          }
          
          // Article passed all filters
          accuracyMetrics.validArticles++;
          if (article.datePublished) {
            accuracyMetrics.articlesWithDates++;
          } else {
            accuracyMetrics.articlesWithoutDates++;
          }
          return true;
        } catch (e) {
          // Invalid URL format
          accuracyMetrics.filteredOut.invalidUrl++;
          console.log(`⚠️ [ADK] [ACCURACY] Filtering out invalid URL: ${article.url || article.link || 'unknown'} - ${e.message}`);
          return false;
        }
      });

      const articlesFiltered = articlesBeforeFilter - filteredArticles.length;
      
      // Log comprehensive ADK accuracy report
      console.log(`\n📊 [ADK] [ACCURACY REPORT] for ${source.name} (${sourceDomain}):`);
      console.log(`   Total articles returned by ADK: ${accuracyMetrics.totalReturned}`);
      console.log(`   Valid articles after filtering: ${accuracyMetrics.validArticles}`);
      console.log(`   Articles with dates: ${accuracyMetrics.articlesWithDates}`);
      console.log(`   Articles without dates: ${accuracyMetrics.articlesWithoutDates}`);
      console.log(`   Filtered out:`);
      console.log(`     - Missing URL: ${accuracyMetrics.filteredOut.missingUrl}`);
      console.log(`     - Null/empty URL: ${accuracyMetrics.filteredOut.nullUrl}`);
      console.log(`     - Google redirect URLs: ${accuracyMetrics.filteredOut.googleRedirect}`);
      console.log(`     - Wrong domain: ${accuracyMetrics.filteredOut.wrongDomain}`);
      console.log(`     - Generic/homepage URLs: ${accuracyMetrics.filteredOut.genericUrl}`);
      console.log(`     - Short path (< 11 chars): ${accuracyMetrics.filteredOut.shortPath}`);
      console.log(`     - Invalid URL format: ${accuracyMetrics.filteredOut.invalidUrl}`);
      const accuracyRate = accuracyMetrics.totalReturned > 0 
        ? ((accuracyMetrics.validArticles / accuracyMetrics.totalReturned) * 100).toFixed(1)
        : 0;
      console.log(`   Accuracy rate: ${accuracyRate}% (${accuracyMetrics.validArticles}/${accuracyMetrics.totalReturned} valid)\n`);
      
      if (filteredArticles.length === 0) {
        if (articlesBeforeFilter > 0) {
          console.log(`⚠️ [ADK] No articles found from ${sourceDomain} domain. ${articlesBeforeFilter} articles from other domains were filtered out.`);
        } else {
          console.log(`⚠️ [ADK] No articles found from ${sourceDomain} domain.`);
        }
      } else {
        console.log(`✅ [ADK] Found ${filteredArticles.length} articles from ${sourceDomain} domain${articlesFiltered > 0 ? ` (${articlesFiltered} external articles filtered out)` : ''}`);
      }

      // Store scraping result for health tracking (non-blocking)
      // This is optional - don't let database errors stop scraping
      if (source.id) {
        try {
          const database = require('../database-postgres');
          // Use a timeout to prevent hanging if database is having issues
          await Promise.race([
            database.updateScrapingResult(source.id, {
              articlesFound: articlesBeforeFilter,
              articlesAfterFilter: filteredArticles.length,
              articlesFiltered: articlesFiltered,
              success: filteredArticles.length > 0,
              timestamp: new Date().toISOString(),
              domain: sourceDomain,
              method: 'ADK_AGENT'
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Database query timeout')), 5000)
            )
          ]);
        } catch (err) {
          // Silently ignore database errors - scraping was successful, that's what matters
          // Only log if it's not a timeout/connection error (those are expected with poolers)
          if (err.code !== 'ETIMEDOUT' && err.code !== 'ECONNRESET' && !err.message.includes('timeout')) {
            console.warn(`⚠️  [ADK] Could not store scraping result for ${source.name}:`, err.message);
          }
        }
      }

      // Sort articles by date (most recent first) before limiting
      // Articles with dates come first, sorted by date (newest first)
      filteredArticles.sort((a, b) => {
        const dateA = a.datePublished ? new Date(a.datePublished).getTime() : 0;
        const dateB = b.datePublished ? new Date(b.datePublished).getTime() : 0;
        if (dateA && dateB) return dateB - dateA; // Newest first
        if (dateA && !dateB) return -1; // Articles with dates first
        if (!dateA && dateB) return 1;
        return 0; // Both have no date, keep original order
      });

      // Helper to resolve redirects and get canonical URL
      // ADK returns URLs from Google Search which may differ from canonical URLs
      // This follows redirects to get the final URL
      const resolveCanonicalUrl = async (url) => {
        try {
          // Use GET request with redirect following
          // Track the redirect chain to get the final canonical URL
          const response = await axios.get(url, {
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400,
            // Limit response size - we only need headers for redirect detection
            maxContentLength: 10000, // 10KB should be enough
            maxBodyLength: 10000,
          });
          
          // Get final URL after redirects - try multiple methods (axios version differences)
          let finalUrl = url;
          
          // Method 1: response.request.res.responseUrl (most common in Node.js axios)
          if (response.request?.res?.responseUrl) {
            finalUrl = response.request.res.responseUrl;
          }
          // Method 2: response.request.responseURL (alternative property)
          else if (response.request?.responseURL) {
            finalUrl = response.request.responseURL;
          }
          // Method 3: Check if response has a Location header (shouldn't happen if redirects followed)
          else if (response.headers?.location) {
            const location = response.headers.location;
            finalUrl = location.startsWith('http') ? location : new URL(location, url).toString();
          }
          // Method 4: Check response URL from config (might be updated after redirects)
          else if (response.config?.url && response.config.url !== url && response.config.url.startsWith('http')) {
            finalUrl = response.config.url;
          }
          
          // Only return different URL if we actually got a redirect and it's valid
          if (finalUrl && finalUrl !== url && finalUrl.startsWith('http')) {
            console.log(`🔗 [ADK] Redirect resolved: ${url.substring(url.lastIndexOf('/') + 1).substring(0, 40)}... -> ${finalUrl.substring(finalUrl.lastIndexOf('/') + 1)}`);
            return finalUrl;
          }
          return url;
        } catch (e) {
          // If redirect resolution fails (404, timeout, etc.), return original URL
          // The original URL might still work even if GET request fails
          // Silently fail - this is expected for some URLs
          return url;
        }
      };

      // Return lightweight articles (limit to 3 most recent articles)
      // This ensures we get the most recent articles from each source
      // Resolve redirects to get canonical URLs (ADK may return long slugs that redirect to shorter ones)
      const lightweightArticlesPromises = filteredArticles.slice(0, 3).map(async (article) => {
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

        // Resolve redirects to get canonical URL (e.g., long slug -> short canonical URL)
        const canonicalUrl = await resolveCanonicalUrl(articleUrl);
        if (canonicalUrl !== articleUrl) {
          console.log(`🔗 [ADK] Resolved redirect: ${articleUrl.substring(articleUrl.lastIndexOf('/') + 1).substring(0, 50)}... -> ${canonicalUrl.substring(canonicalUrl.lastIndexOf('/') + 1)}`);
        }

        return {
          title: article.title || 'Untitled',
          link: canonicalUrl,
          url: canonicalUrl,
          description: article.description || '',
          content: article.description || '',
          datePublished: article.datePublished || null,
          sourceName: source.name || 'Unknown Source',
          category: source.category || 'General'
        };
      });

      // Wait for all redirect resolutions
      const lightweightArticles = await Promise.all(lightweightArticlesPromises);

      console.log(`✅ [ADK] [${source.url}] Agent found ${lightweightArticles.length} articles`);
      if (lightweightArticles.length > 0) {
        lightweightArticles.forEach((article, i) => {
          console.log(`   ${i + 1}. "${article.title.substring(0, 50)}..." (date: ${article.datePublished || 'none'})`);
        });
      }
      
      // Log final ADK summary
      const dateCoverage = lightweightArticles.length > 0
        ? ((lightweightArticles.filter(a => a.datePublished).length / lightweightArticles.length) * 100).toFixed(1)
        : 0;
      console.log(`📊 [ADK] [SUMMARY] ${source.name}: ${lightweightArticles.length} valid articles, ${dateCoverage}% have dates`);
      
      // MEMORY FIX: Delete the session after use to prevent memory accumulation
      // InMemoryRunner stores all sessions in memory, causing OOM crashes over time
      try {
        if (this.runner && this.runner.sessionService && this.runner.sessionService.deleteSession) {
          await this.runner.sessionService.deleteSession({
            appName: 'distroblog',
            userId: session.userId,
            sessionId: session.id
          });
          console.log(`🧹 [ADK] Cleaned up session ${session.id}`);
        }
      } catch (cleanupErr) {
        // Don't fail if cleanup fails, just log it
        console.warn(`⚠️ [ADK] Could not clean up session: ${cleanupErr.message}`);
      }
      
      // If no valid articles found, throw error to trigger fallback to traditional scraper
      if (lightweightArticles.length === 0) {
        throw new Error(`ADK agent found 0 valid articles from ${source.url} (may need fallback to traditional scraper)`);
      }
      
      return lightweightArticles;
    } catch (error) {
      // MEMORY FIX: Clean up session even on error
      if (session && this.runner && this.runner.sessionService && this.runner.sessionService.deleteSession) {
        try {
          await this.runner.sessionService.deleteSession({
            appName: 'distroblog',
            userId: session.userId,
            sessionId: session.id
          });
          console.log(`🧹 [ADK] Cleaned up session ${session.id} after error`);
        } catch (cleanupErr) {
          console.warn(`⚠️ [ADK] Could not clean up session after error: ${cleanupErr.message}`);
        }
      }
      
      // Check if it's a rate limit error - log it but still throw to trigger fallback
      if ((error.message && error.message.includes('429')) || (error.message && error.message.includes('quota'))) {
        console.error(`❌ [ADK] Rate limit/quota exceeded for ${source.url}: ${error.message}`);
        console.log(`🔄 [ADK] Will fallback to traditional scraper for ${source.name}`);
      } else {
        console.error(`❌ [ADK] Error finding articles from ${source.url}:`, error.message);
      }

      // If model became unavailable mid-run, allow re-init next time
      if (error.message && error.message.toLowerCase().includes('model') && error.message.toLowerCase().includes('not found')) {
        console.warn('⚠️ [ADK] Clearing initialization state so next run can retry model selection');
        this.initialized = false;
        this.agent = null;
        this.runner = null;
        this.modelName = null;
      }

      // Throw error to trigger fallback to traditional scraper in feedMonitor
      throw error;
    }
  }

  /**
   * Clean up resources - reset ADK state to free memory
   */
  async close() {
    try {
      // Reset the runner and agent to free memory
      // This forces re-initialization on next use, which is safer than keeping stale state
      if (this.runner) {
        // Try to clean up any remaining sessions
        try {
          if (this.runner.sessionService && this.runner.sessionService.listSessions) {
            const sessions = await this.runner.sessionService.listSessions({
              appName: 'distroblog',
              userId: 'system'
            });
            if (sessions && sessions.length > 0) {
              console.log(`🧹 [ADK] Cleaning up ${sessions.length} remaining sessions...`);
              for (const sess of sessions) {
                try {
                  await this.runner.sessionService.deleteSession({
                    appName: 'distroblog',
                    userId: sess.userId || 'system',
                    sessionId: sess.id
                  });
                } catch (e) {
                  // Ignore individual session cleanup errors
                }
              }
            }
          }
        } catch (listErr) {
          // Ignore session listing errors
        }
        
        this.runner = null;
      }
      
      this.agent = null;
      this.initialized = false;
      console.log('🧹 [ADK] Resources cleaned up');
    } catch (error) {
      console.warn(`⚠️ [ADK] Error during cleanup: ${error.message}`);
      // Reset state anyway
      this.runner = null;
      this.agent = null;
      this.initialized = false;
    }
  }
}

module.exports = ADKScraper;
