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
      // Try Gemini 2.0 first (has Google Search built-in), fallback to 1.5 if not available
      let llm;
      let modelName = 'gemini-2.0-flash-exp'; // Use Gemini 2.0 for Google Search support
      
      try {
        llm = new adk.Gemini({
          model: modelName,
          apiKey: apiKey
        });
        console.log(`✅ [ADK] Using model: ${modelName}`);
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
        instruction: `Use the Google Search tool to find the 5 most recent blog posts or articles from the given website URL. 

For each article found, extract:
- title: The article headline/title
- url: Full URL to the article  
- description: Brief description or excerpt (if available)
- datePublished: Publication date in ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ), or null if not found

Return the results as a JSON array with this exact structure:
[
  {
    "title": "Article Title",
    "url": "https://full-url-to-article.com/article-slug",
    "description": "Article description or excerpt",
    "datePublished": "2025-12-17T10:00:00Z"
  }
]

Focus on articles from the specified domain only. Ignore navigation links, footer links, and non-article content.`,
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

      // Create a session for this request
      const session = await this.runner.sessionService.createSession({
        appName: 'distroblog',
        userId: 'system',
        state: {}
      });

      // Ask the agent to find articles from the website using Google Search
      // Be explicit about using Google Search to ensure it's invoked
      const searchQuery = `I need you to use Google Search to find the 5 most recent blog posts or articles from ${source.url}. 

IMPORTANT: You must use Google Search to look up recent articles from this website. Do not rely on your training data - perform a live search.

After searching, return the results as a JSON array with this exact format:
[
  {
    "title": "Article Title",
    "url": "https://full-url-to-article.com/article-slug",
    "description": "Article description or excerpt",
    "datePublished": "2025-12-17T10:00:00Z" or null
  }
]

Only include articles from ${source.url} domain. Return only valid JSON, no other text.`;
      
      let articles = [];
      let lastEvent = null;
      let fullResponse = '';

      // Run the agent
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
        lastEvent = event;
        
        // Extract articles from agent response
        if (event.content && event.content.parts) {
          for (const part of event.content.parts) {
            // Log function calls to see if Google Search is being used
            if (part.functionCall) {
              console.log(`🔧 [ADK] Agent called function: ${part.functionCall.name}`);
              if (part.functionCall.args) {
                console.log(`   Args: ${JSON.stringify(part.functionCall.args).substring(0, 200)}...`);
              }
            }
            if (part.functionResponse) {
              console.log(`📥 [ADK] Agent received function response: ${part.functionResponse.name}`);
            }
            if (part.text) {
              fullResponse += part.text + '\n';
              
              // Try to parse JSON from the response
              try {
                // Extract JSON from markdown code blocks if present
                let text = part.text.trim();
                if (text.includes('```json')) {
                  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                } else if (text.includes('```')) {
                  text = text.replace(/```\n?/g, '').trim();
                }
                
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
              }
            }
          }
        }
      }

      // Always log the response for debugging
      if (fullResponse) {
        console.log(`📝 [ADK] Full agent response (first 1000 chars):\n${fullResponse.substring(0, 1000)}${fullResponse.length > 1000 ? '...' : ''}`);
      } else {
        console.log(`⚠️ [ADK] No response text received from agent`);
      }

      // If no articles found in structured format, try to extract from full response
      if (articles.length === 0 && fullResponse) {
        
        try {
          // Look for JSON anywhere in the full response
          const jsonMatch = fullResponse.match(/\[[\s\S]*?\]/);
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
      const sourceDomain = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
      const articlesBeforeFilter = articles.length;
      const filteredArticles = articles.filter(article => {
        try {
          const articleUrl = article.url || article.link;
          if (!articleUrl) return false;
          const articleDomain = new URL(articleUrl).hostname.replace(/^www\./, '').toLowerCase();
          return articleDomain === sourceDomain;
        } catch (e) {
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

      // Return lightweight articles (limit to 5 most recent)
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
      
      return lightweightArticles;
    } catch (error) {
      console.error(`❌ [ADK] Error finding articles from ${source.url}:`, error.message);
      // If ADK fails, return empty array (fallback to traditional scraper will happen in feedMonitor)
      return [];
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
