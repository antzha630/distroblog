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
      
      // Create Gemini LLM with API key
      // NOTE: gemini-2.5-flash-image does NOT support Google Search tool, so we skip it
      // Use gemini-2.0-flash-exp (supports Google Search) as primary, fallback to 1.5
      let llm;
      let modelName = 'gemini-2.0-flash-exp'; // Primary model (supports Google Search)
      
      try {
        llm = new adk.Gemini({
          model: modelName,
          apiKey: apiKey
        });
        console.log(`✅ [ADK] Using model: ${modelName} (supports Google Search)`);
      } catch (e) {
        // Fallback to Gemini 1.5 if 2.0 not available
        console.log(`⚠️ [ADK] Gemini 2.0 not available (${e.message}), trying 1.5...`);
        modelName = 'gemini-1.5-flash-latest';
        llm = new adk.Gemini({
          model: modelName,
          apiKey: apiKey
        });
        console.log(`✅ [ADK] Using fallback model: ${modelName}`);
      }

      // Create LlmAgent with Google Search tool
      // The agent will use Google Search to find articles from websites
      // Based on Python ADK pattern: tools=[google_search] with simple instruction
      this.agent = new adk.LlmAgent({
        name: 'article_finder',
        model: llm, // Pass the LLM object directly (not model name string)
        description: 'Agent to find recent blog posts and articles from a website URL using Google Search.',
        instruction: `You are an assistant to a professional journalist who is looking for the latest blog posts and articles from specific projects and companies on the news beat. Your job is to help find the most recent content from these sources so the journalist can stay up-to-date with the latest news and updates.

When given a website URL, use Google Search to find the 3 MOST RECENT blog posts or articles from that specific website. Focus on finding actual article content - not homepages, about pages, or navigation pages.

CRITICAL REQUIREMENTS:
1. RECENCY: Get the most recent articles from the source, regardless of publication date. Some blogs publish infrequently (monthly or less), so older articles are fine as long as they're the most recent from that source.
2. Use Google Search to perform a live search - do not rely on training data
3. CANONICAL URLs: Extract the CANONICAL/SHORT article URLs (not long slugs). Many sites use short URLs like "/incentive-dynamic-engine" instead of long slugs like "/io-net-launches-the-first-adaptive-economic-engine-for-decentralized-compute". Prefer shorter, cleaner URLs when available in search results.
4. Extract FULL article URLs (not just the blog homepage). Each article must have a unique URL path like "/article-slug" or "/blog/post-title"
5. Only include articles from the exact domain specified
6. Ignore generic pages like homepages, "About" pages, or navigation pages
7. DATE ACCURACY: Extract publication dates from search results - dates are CRITICAL. Look for dates in search snippets, article previews, or metadata. Search results often show dates like "2 days ago", "Dec 11, 2025", etc. - convert these to ISO 8601 format (YYYY-MM-DD). Try hard to find dates.

For each article found, provide:
- title: The complete article headline/title (not generic titles like "Blog" or "Home")
- url: The CANONICAL/SHORT URL to the specific article page (prefer shorter URLs over long slugs when both are available)
- description: Brief description or excerpt (if available)
- datePublished: Publication date in ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ). Extract from search results when available. Prioritize articles with dates. Use null only if absolutely no date information exists.

Return ONLY a valid JSON array with this exact structure, sorted by date (most recent first):
[
  {
    "title": "Complete Article Title",
    "url": "https://domain.com/blog/canonical-article-slug",
    "description": "Article description or excerpt",
    "datePublished": "2025-12-17T10:00:00Z" or null
  }
]

Do not include explanatory text. Return only the JSON array.`,
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
      const session = await this.runner.sessionService.createSession({
        appName: 'distroblog',
        userId: 'system',
        state: {}
      });

      // Ask the agent to find articles from the website using Google Search
      // Improved prompt to get specific article URLs and most recent articles
      const domain = new URL(source.url).hostname;
      const baseDomain = domain.replace(/^www\./, ''); // Remove www. for matching
      const searchQuery = `You are an assistant to a professional journalist who is looking for the latest blog posts from projects on the news beat. Please search the following URL to find the latest blog posts: ${source.url}

Use Google Search to find the 3 MOST RECENT blog posts or articles from ${source.url}. Focus on finding actual article content that would be useful for a journalist covering this beat.

CRITICAL REQUIREMENTS - READ CAREFULLY:
1. RECENCY PRIORITY: Return exactly 3 MOST RECENT articles from ${baseDomain}, sorted by publication date (newest first). It's okay if articles are from months ago - just get the 3 most recent ones available from this source. Some blogs publish infrequently (monthly or less), so older articles are acceptable as long as they're the most recent from this source.

2. DOMAIN MATCHING: ONLY return articles from ${baseDomain} domain. Check every URL - it MUST contain "${baseDomain}" in the hostname. Reject any URLs from other domains (like tim.blog, medium.com, etc.). If search results show articles from other domains, ignore them completely.

3. CANONICAL URLs: Prefer SHORT/CANONICAL URLs over long slugs. Many sites use short URLs like "/incentive-dynamic-engine" instead of long slugs like "/io-net-launches-the-first-adaptive-economic-engine-for-decentralized-compute". When search results show both, prefer the shorter canonical URL. The URL path should be meaningful but concise.

4. Extract ACTUAL article URLs from search results - NOT Google redirect URLs. NEVER use URLs containing:
   - "vertexaisearch.cloud.google.com"
   - "grounding-api-redirect"
   - "google.com/grounding"
   - Any other Google redirect service
   Extract the FINAL destination URL from search results, not the redirect link.

5. Each article URL must be a DIRECT link to the article page on ${baseDomain}. Examples:
   - ✅ GOOD: https://${baseDomain}/blog/article-slug
   - ✅ GOOD: https://${baseDomain}/article-title
   - ✅ GOOD: https://${baseDomain}/blog/2025/12/article-name
   - ❌ BAD: https://${baseDomain}/blog (homepage)
   - ❌ BAD: https://${baseDomain}/ (homepage)
   - ❌ BAD: https://${baseDomain}/about (not an article - this is an About page)
   - ❌ BAD: https://${baseDomain}/contact (not an article - this is a Contact page)
   - ❌ BAD: https://${baseDomain}/privacy (not an article - this is a Privacy page)
   NEVER return URLs to non-article pages like /about, /contact, /privacy, /terms, /team, /careers, etc. Only return URLs to actual blog posts or articles.

6. DO NOT return generic blog homepage URLs like "${source.url}" or "${source.url}/" - only return URLs with specific article paths. The URL must have a meaningful path segment after the domain (at least 10 characters in the path).

7. DATE ACCURACY: Extract publication dates from search results. Dates are CRITICAL - try hard to find dates in:
   - Search result snippets (e.g., "2 days ago", "Dec 11, 2025")
   - Article previews in search results
   - Metadata shown in search results
   Convert relative dates like "2 days ago" to absolute dates. Format: YYYY-MM-DD (e.g., "2025-12-15"). Only use null if absolutely no date information is available in the search results.

8. TITLE REQUIREMENT: Every article MUST have a non-null, non-empty, meaningful title. Do NOT return:
   - null or empty titles
   - Generic titles like "Blog", "Home", "Article", "Untitled"
   - Titles that are just the domain name
   Extract the actual article headline from search results.

9. URL PATH VALIDATION: Each article must have a unique URL path beyond the base blog URL. The path (after the domain) must be at least 11 characters long (including the leading "/"). This ensures we have a specific article, not a generic page.

EXAMPLES OF WHAT TO RETURN:
✅ GOOD: {"title": "How to Build AI Agents in 2025", "url": "https://${baseDomain}/blog/how-to-build-ai-agents", "datePublished": "2025-12-15", "description": "A guide to building AI agents..."}
✅ GOOD: {"title": "New Feature Launch: Agent Marketplace", "url": "https://${baseDomain}/blog/new-feature-launch", "datePublished": "2025-12-10", "description": "We're excited to announce..."}
✅ GOOD: {"title": "Q4 2025 Product Updates", "url": "https://${baseDomain}/updates/q4-2025", "datePublished": "2025-11-20", "description": "Here's what's new..."}

EXAMPLES OF WHAT NOT TO RETURN:
❌ BAD: {"title": "Blog", "url": "https://${baseDomain}/blog", ...} - This is the homepage, not an article
❌ BAD: {"title": null, "url": "https://${baseDomain}/article", ...} - Missing title
❌ BAD: {"title": "Article", "url": "https://vertexaisearch.cloud.google.com/...", ...} - Google redirect URL
❌ BAD: {"title": "Article", "url": "https://other-domain.com/article", ...} - Wrong domain
❌ BAD: {"title": "Home", "url": "https://${baseDomain}/", ...} - Homepage, not an article
❌ BAD: {"title": "About Us", "url": "https://${baseDomain}/about", ...} - Not an article page (this is an About page)
❌ BAD: {"title": "Contact", "url": "https://${baseDomain}/contact", ...} - Not an article page
❌ BAD: {"title": "Privacy Policy", "url": "https://${baseDomain}/privacy", ...} - Not an article page

VERIFY BEFORE RETURNING:
- Every URL must contain "${baseDomain}" in the hostname (exact match, case-insensitive)
- Every URL must have a specific article path (not just /blog or /)
- Every title must be non-null, non-empty, and meaningful (not generic)
- Prefer shorter canonical URLs over long slugs when both are available
- No redirect URLs from Google or any other service
- Articles are sorted by date (newest first) - this is the most recent from this source
- Each URL path must be at least 11 characters long (including leading "/")

Return a JSON array with articles sorted by date (most recent first):
- title: Complete article title (REQUIRED - must be non-null, non-empty, not generic, not "Blog" or "Home")
- url: CANONICAL/SHORT URL to the specific article page on ${baseDomain} (prefer shorter URLs over long slugs, must include article path, NOT a redirect URL, MUST be from ${baseDomain} domain)
- description: Article excerpt if available
- datePublished: Publication date (YYYY-MM-DD format) - EXTRACT from search results when available. Prioritize articles with dates. Use null only if no date information exists.

ONLY include articles from ${baseDomain}. DO NOT include redirect URLs, generic URLs, articles with null/empty titles, or articles from other domains. Return only valid JSON array, no other text.`;
      
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

      // Store scraping result for health tracking
      if (source.id) {
        try {
          const database = require('../database-postgres');
          await database.updateScrapingResult(source.id, {
            articlesFound: articlesBeforeFilter,
            articlesAfterFilter: filteredArticles.length,
            articlesFiltered: articlesFiltered,
            success: filteredArticles.length > 0,
            timestamp: new Date().toISOString(),
            domain: sourceDomain,
            method: 'ADK_AGENT'
          });
        } catch (err) {
          console.warn('Could not store scraping result:', err.message);
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
      
      // If no valid articles found, throw error to trigger fallback to traditional scraper
      if (lightweightArticles.length === 0) {
        throw new Error(`ADK agent found 0 valid articles from ${source.url} (may need fallback to traditional scraper)`);
      }
      
      return lightweightArticles;
    } catch (error) {
      // Check if it's a rate limit error - log it but still throw to trigger fallback
      if (error.message && error.message.includes('429') || error.message.includes('quota')) {
        console.error(`❌ [ADK] Rate limit/quota exceeded for ${source.url}: ${error.message}`);
        console.log(`🔄 [ADK] Will fallback to traditional scraper for ${source.name}`);
      } else {
        console.error(`❌ [ADK] Error finding articles from ${source.url}:`, error.message);
      }
      // Throw error to trigger fallback to traditional scraper in feedMonitor
      throw error;
    }
  }

  /**
   * Clean up resources (no-op for ADK, but kept for compatibility)
   */
  async close() {
    // ADK doesn't need cleanup like browsers
    return Promise.resolve();
  }
}

module.exports = ADKScraper;
