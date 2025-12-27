// ADK (Agent Development Kit) implementation using Google Search
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
      // Try Gemini 2.5 Flash Image first (higher quota), then 2.0, then 1.5
      let llm;
      let modelName = 'gemini-2.5-flash-image'; // Try 2.5 first (higher quota limits)
      
      try {
        llm = new adk.Gemini({
          model: modelName,
          apiKey: apiKey
        });
        console.log(`✅ [ADK] Using model: ${modelName}`);
      } catch (e) {
        // Fallback to Gemini 2.0 if 2.5 not available
        console.log(`⚠️ [ADK] Gemini 2.5 not available (${e.message}), trying 2.0...`);
        modelName = 'gemini-2.0-flash-exp';
        try {
          llm = new adk.Gemini({
            model: modelName,
            apiKey: apiKey
          });
          console.log(`✅ [ADK] Using model: ${modelName}`);
        } catch (e2) {
          // Fallback to Gemini 1.5 if 2.0 not available
          console.log(`⚠️ [ADK] Gemini 2.0 not available (${e2.message}), trying 1.5...`);
          modelName = 'gemini-1.5-flash-latest';
          llm = new adk.Gemini({
            model: modelName,
            apiKey: apiKey
          });
          console.log(`✅ [ADK] Using fallback model: ${modelName}`);
        }
      }

      // Create LlmAgent with Google Search tool
      // The agent will use Google Search to find articles from websites
      // Based on Python ADK pattern: tools=[google_search] with simple instruction
      this.agent = new adk.LlmAgent({
        name: 'article_finder',
        model: llm, // Pass the LLM object directly (not model name string)
        description: 'Agent to find recent blog posts and articles from a website URL using Google Search.',
        instruction: `You are an article finder agent. Use Google Search to find the 5 most recent blog posts or articles from a given website URL.

CRITICAL REQUIREMENTS:
1. Use Google Search to perform a live search - do not rely on training data
2. Extract FULL article URLs (not just the blog homepage). Each article must have a unique URL path like "/article-slug" or "/blog/post-title"
3. Only include articles from the exact domain specified
4. Ignore generic pages like homepages, "About" pages, or navigation pages
5. Extract publication dates when available

For each article found, provide:
- title: The complete article headline/title (not generic titles like "Blog" or "Home")
- url: The FULL URL to the specific article page (must include the article path, not just the domain)
- description: Brief description or excerpt (if available)
- datePublished: Publication date in ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ), or null if not found

Return ONLY a valid JSON array with this exact structure:
[
  {
    "title": "Complete Article Title",
    "url": "https://domain.com/blog/specific-article-slug",
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
      if (error.stack) {
        console.error('Stack:', error.stack);
      }
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
      const searchQuery = `Use Google Search to find the 5 MOST RECENT blog posts or articles from ${source.url}.

CRITICAL REQUIREMENTS - READ CAREFULLY:
1. DOMAIN MATCHING: ONLY return articles from ${baseDomain} domain. Check every URL - it MUST contain "${baseDomain}" in the hostname. Reject any URLs from other domains (like tim.blog, medium.com, etc.)
2. Extract ACTUAL article URLs from search results - NOT Google redirect URLs (avoid any URLs containing "vertexaisearch.cloud.google.com" or "grounding-api-redirect")
3. Each article URL must be a DIRECT link to the article page on ${baseDomain} (e.g., https://${baseDomain}/blog/article-slug or https://${baseDomain}/article-title)
4. DO NOT return generic blog homepage URLs like "${source.url}" or "${source.url}/" - only return URLs with specific article paths (must have /blog/article-name or /article-name format)
5. Prioritize the most recently published articles. Sort results by publication date (newest first)
6. Each article must have a unique URL path beyond the base blog URL (at least 10 characters in the path after the domain)

VERIFY BEFORE RETURNING:
- Every URL must contain "${baseDomain}" in the hostname
- Every URL must have a specific article path (not just /blog or /)
- No redirect URLs from Google

Return a JSON array with articles sorted by date (most recent first):
- title: Complete article title (not generic, not "Blog" or "Home")
- url: DIRECT URL to the specific article page on ${baseDomain} (must include article path, NOT a redirect URL, MUST be from ${baseDomain} domain)
- description: Article excerpt if available
- datePublished: Publication date (YYYY-MM-DD format) or null

ONLY include articles from ${baseDomain}. DO NOT include redirect URLs, generic URLs, or articles from other domains. Return only valid JSON array, no other text.`;
      
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
            console.error(`⚠️ [ADK] Rate limit/quota exceeded. Error suggests using gemini-2.5-flash-image model.`);
            // Throw error to trigger fallback
            throw new Error(`Rate limit exceeded (429): ${event.errorMessage}`);
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
              console.log(`⚠️ [ADK] Found JSON array but it's empty`);
            }
          } else {
            console.log(`⚠️ [ADK] No JSON array found in response. Response might be text-only.`);
          }
        } catch (e) {
          console.log(`⚠️ [ADK] Could not parse JSON from agent response: ${e.message}`);
        }
      } else if (articles.length > 0) {
        console.log(`✅ [ADK] Successfully extracted ${articles.length} articles from agent response`);
      }
      
      // Filter articles to only include those from the same domain
      // Also filter out generic URLs (homepage, base blog URL without article path)
      // AND filter out Google redirect URLs and invalid URLs
      const sourceDomain = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
      const sourceUrlObj = new URL(source.url);
      const basePath = sourceUrlObj.pathname.endsWith('/') ? sourceUrlObj.pathname.slice(0, -1) : sourceUrlObj.pathname;
      
      const articlesBeforeFilter = articles.length;
      const filteredArticles = articles.filter(article => {
        try {
          const articleUrl = article.url || article.link;
          if (!articleUrl) return false;
          
          // Filter out Google redirect URLs (grounding API redirects)
          if (articleUrl.includes('vertexaisearch.cloud.google.com') || 
              articleUrl.includes('grounding-api-redirect') ||
              articleUrl.includes('google.com/grounding')) {
            console.log(`⚠️ [ADK] Filtering out Google redirect URL: ${articleUrl.substring(0, 80)}...`);
            return false;
          }
          
          // Filter out null URLs or placeholder URLs
          if (articleUrl === 'null' || articleUrl === null || articleUrl.trim() === '') {
            return false;
          }
          
          const articleUrlObj = new URL(articleUrl);
          const articleDomain = articleUrlObj.hostname.replace(/^www\./, '').toLowerCase();
          
          // Must match domain
          if (articleDomain !== sourceDomain) {
            return false;
          }
          
          // Filter out generic URLs (homepage, base blog URL without specific article path)
          const articlePath = articleUrlObj.pathname;
          // If URL is just the base blog URL or homepage, skip it
          if (articlePath === '/' || articlePath === basePath || articlePath === basePath + '/') {
            console.log(`⚠️ [ADK] Filtering out generic URL (homepage/base): ${articleUrl}`);
            return false;
          }
          
          // Must have some path beyond the base (indicates a specific article)
          // Allow at least 3 characters beyond base path (e.g., "/a" is too short, "/article" is good)
          if (articlePath.length <= basePath.length + 3) {
            console.log(`⚠️ [ADK] Filtering out URL with insufficient path: ${articleUrl}`);
            return false;
          }
          
          return true;
        } catch (e) {
          // Invalid URL format
          console.log(`⚠️ [ADK] Filtering out invalid URL: ${article.url || article.link} - ${e.message}`);
          return false;
        }
      });

      const articlesFiltered = articlesBeforeFilter - filteredArticles.length;
      
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

      // Return lightweight articles (limit to 5 most recent articles)
      // This ensures we get the most recent articles from each source
      const lightweightArticles = filteredArticles.slice(0, 5).map(article => {
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
          content: article.description || '',
          datePublished: article.datePublished || null,
          sourceName: source.name || 'Unknown Source',
          category: source.category || 'General'
        };
      });

      console.log(`✅ [ADK] [${source.url}] Agent found ${lightweightArticles.length} articles`);
      if (lightweightArticles.length > 0) {
        lightweightArticles.forEach((article, i) => {
          console.log(`   ${i + 1}. "${article.title.substring(0, 50)}..." (date: ${article.datePublished || 'none'})`);
        });
      }
      
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
