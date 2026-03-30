 // ADK (Agent Development Kit) implementation using Google Search
const axios = require('axios');
const config = require('../config');
const articleEnrichment = require('./articleEnrichment');

/**
 * Medium hosts multiple publications on the same domain; domain match alone is not enough.
 * Returns a path prefix like /lumerin-blog or /@handle, or null if we should not apply this rule.
 */
function mediumPublicationPathPrefix(sourceUrl) {
  let u;
  try {
    u = new URL(sourceUrl);
  } catch {
    return null;
  }
  const h = u.hostname.replace(/^www\./, '').toLowerCase();
  if (h !== 'medium.com' && !h.endsWith('.medium.com')) return null;
  let p = u.pathname.replace(/\/$/, '');
  if (p.endsWith('/feed')) p = p.slice(0, -5);
  if (!p || p === '/') return null;
  return p;
}

function tokenizeForSimilarity(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function overlapScore(a, b) {
  const ta = tokenizeForSimilarity(a);
  const tb = tokenizeForSimilarity(b);
  if (!ta.length || !tb.length) return 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const w of setA) {
    if (setB.has(w)) inter++;
  }
  return inter / Math.max(setA.size, setB.size);
}

function extractHtmlTitle(html) {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || !m[1]) return null;
  return m[1].replace(/\s+/g, ' ').trim();
}

function normalizePageTitle(rawTitle, sourceDomain) {
  if (!rawTitle) return rawTitle;
  let t = rawTitle.trim();
  const domainToken = (sourceDomain || '').replace(/^www\./, '').split('.')[0];
  // Remove common site suffixes while keeping the main article headline.
  t = t.replace(/\s*\|\s*[^|]+$/, '').trim();
  if (domainToken) {
    const re = new RegExp(`\\s*[-|]\\s*${domainToken}\\s*$`, 'i');
    t = t.replace(re, '').trim();
  }
  return t;
}
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
    // Keep the Gemini model instance so we can reuse it elsewhere (e.g. /api/adk/test)
    // without relying on ADK's env-var credential resolver.
    this.llm = null;
    // Rate limiting: gemini-2.0-flash-exp has 10 RPM limit
    // We'll throttle to max 1 request per 7 seconds (8.5 RPM) to stay safe
    this.lastRequestTime = 0;
    this.minRequestInterval = 7000; // 7 seconds between requests (8.5 RPM, safely under 10 RPM limit)
  }

  async initialize() {
    if (this.initialized) return;
    
    const apiKey =
      process.env.GOOGLE_GENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY;
    
    if (!apiKey) {
      console.warn(
        '⚠️ ADK API key not found. ADK scraping will be disabled. Set GOOGLE_GENAI_API_KEY or GEMINI_API_KEY in .env'
      );
      return;
    }

    try {
      // Dynamic import since ADK is ES module and we're in CommonJS
      const adk = await import('@google/adk');
      
      // Pick the first available model that supports Google Search
      // Updated January 2026: gemini-2.0-flash-exp was deprecated, using GA models
      const candidateModels = [
        'gemini-2.5-flash',             // Prefer stronger quality first
        'gemini-2.0-flash',             // Stable fallback
        'gemini-2.5-flash-lite',        // Lightweight version
        'gemini-1.5-flash-latest',      // common alias
        'gemini-1.5-flash',             // fallback
        'gemini-1.5-flash-001',         // legacy fallback
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
          this.llm = llm; // Store for reuse by other routes
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
      // ADK/Gemini prompt best practices (see ai.google.dev/gemini-api/docs/prompting-strategies, google.github.io/adk-docs/agents/llm-agents):
      // - Be clear and specific; avoid long lists of "don't" (positive patterns beat anti-patterns).
      // - Use few-shot examples for format and behavior; keep instructions focused.
      this.agent = new adk.LlmAgent({
        name: 'article_finder',
        // Pass Gemini instance so credentials are available in environments where
        // ADK doesn't pick up the right API key env var names automatically.
        model: llm,
        description: 'Agent that finds recent blog posts and articles from websites using Google Search.',
        instruction: `You are a research assistant. Your job is to find recent blog posts on a specific website using the Google Search tool.

Non-negotiable rules:
1) You MUST use the Google Search tool at least once before your final answer. Do not answer from memory alone.
2) Your final reply MUST be a single JSON array only — no markdown fences, no headings, no apologies, no "I could not find" paragraphs. If there are zero matches, output exactly: []
3) Each item must pair title and url from the same search result (never mix title from one result with url from another).
4) URLs must be direct https links on the requested site (or its subdomains when that site uses them); never use Google redirect or vertexaisearch URLs.
5) On medium.com, only list articles whose URL path is under the same publication as the user’s source (e.g. medium.com/lumerin-blog/... not medium.com/illumination/...).

Fields per object: title (string), url (string), description (string, short), datePublished (YYYY-MM-DD or null if unknown).

Example (your entire final message must look like this, nothing else):
[{"title":"Example Post","url":"https://example.com/blog/post-slug","description":"One or two sentences.","datePublished":"2026-03-20"}]`,
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
   * Build source-specific memory from previously stored successful articles.
   * This acts like lightweight long-term memory: URL shape, recent examples, and
   * date behavior for each source to steer the agent toward canonical outputs.
   */
  async buildSourceMemoryHint(source, maxExamples = 5) {
    if (!source || !source.id) return '';
    try {
      const database = require('../database-postgres');
      const prev = await database.getArticlesBySourceId(source.id, maxExamples);
      if (!Array.isArray(prev) || prev.length === 0) return '';

      const examples = prev
        .map((a) => {
          const link = (a.link || '').trim();
          if (!link) return null;
          const d = a.pub_date ? String(a.pub_date).slice(0, 10) : 'unknown';
          return `- ${link} (date: ${d})`;
        })
        .filter(Boolean)
        .slice(0, maxExamples);

      if (examples.length === 0) return '';

      // Extract stable path prefixes from past links (e.g. /blog/, /post/, /news/)
      const pathCounts = new Map();
      for (const a of prev) {
        try {
          const u = new URL(a.link);
          const p = u.pathname || '/';
          const seg = p.split('/').filter(Boolean);
          const prefix = seg.length >= 1 ? `/${seg[0]}/` : '/';
          pathCounts.set(prefix, (pathCounts.get(prefix) || 0) + 1);
        } catch {
          // ignore malformed historical links
        }
      }
      const topPrefixes = Array.from(pathCounts.entries())
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([p]) => p);
      const prefixHint = topPrefixes.length ? topPrefixes.join(', ') : 'unknown';

      return `\nMemory from previous successful articles for this source:
Likely URL path prefixes: ${prefixHint}
Examples of canonical article URLs:
${examples.join('\n')}
Prefer URL structures similar to these examples when selecting results.\n`;
    } catch (e) {
      console.log(`⚠️ [ADK][V2][diag] source-memory unavailable for ${source.name}: ${e.message}`);
      return '';
    }
  }

  /**
   * Find articles from a website URL using ADK agent with Google Search
   * Returns articles in RSS-like format for compatibility
   */
  async scrapeArticles(source) {
    // MEMORY FIX: Track session outside try block so we can clean it up in catch
    let session = null;
    const scrapeStartedAt = Date.now();

    try {
      console.log(`🤖 [ADK] Finding articles from: ${source.url} using Google Search agent`);

      // Initialize if not already done
      if (!this.initialized) {
        await this.initialize();
      }

      if (!this.agent || !this.runner) {
      throw new Error('ADK agent not initialized. Check ADK API key environment variable (GOOGLE_GENAI_API_KEY / GEMINI_API_KEY).');
      }

      // V2 gets an extra self-recovery attempt because ADK can occasionally return
      // malformed/empty outputs even when grounding is available.
      const maxAttempts = config.mode === 'v2' ? 3 : 1;
      const maxItems = config.mode === 'v2' ? 8 : 3;
      const v2ObsStart = Date.now();

      const domain = new URL(source.url).hostname;
      const baseDomain = domain.replace(/^www\./, ''); // Remove www. for matching

      // Calculate concrete date cutoff:
      // - V1: keep tighter 7-day window
      // - V2: widen so Google Search has more opportunity to return results
      const daysBack = config.mode === 'v2' ? 30 : 7;
      const today = new Date();
      const cutoffDate = new Date(today);
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      const cutoffDateStr = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD format
      const todayStr = today.toISOString().split('T')[0];

      console.log(
        `📅 [ADK] Date filter: articles after ${cutoffDateStr} (today is ${todayStr}, daysBack=${daysBack})`
      );

      const mediumPub = mediumPublicationPathPrefix(source.url);
      const mediumHint = mediumPub
        ? `\nMedium publication: only include article URLs whose path starts with "${mediumPub}/" (same publication as ${source.url}). Do not include other Medium authors or publications.\n`
        : '';
      const sourcePath = (() => {
        try {
          const p = new URL(source.url).pathname || '/';
          return p.replace(/\/$/, '') || '/';
        } catch {
          return '/';
        }
      })();
      const sourcePathHint = sourcePath && sourcePath !== '/'
        ? `\nPath scope hint: prioritize results under "${sourcePath}/" on ${baseDomain}.`
        : '';
      const sourceMemoryHint = config.mode === 'v2'
        ? await this.buildSourceMemoryHint(source, 5)
        : '';

      const primarySearchQuery = `Task: find up to ${maxItems} blog or news articles on ${baseDomain} published within the last ${daysBack} days (after ${cutoffDateStr}). Today is ${todayStr}.
Source URL for scope: ${source.url}
${mediumHint}
${sourceMemoryHint}
Step 1 — Use Google Search now with queries such as:
site:${baseDomain} blog
site:${baseDomain} news OR post OR article
site:${baseDomain}${sourcePath === '/' ? '/blog' : sourcePath} 
(adjust if the site uses a subdomain like blog.${baseDomain}.)

Step 2 — From search snippets and result URLs, build the JSON array.

Output rules — reply with JSON only:
- Array of objects: title, url, description, datePublished (YYYY-MM-DD or null).
- url must be a normal https URL on ${baseDomain} (or obvious subdomain of that brand). No vertexaisearch / Google redirect URLs.
- If nothing qualifies, reply with exactly: []
${sourcePathHint}

Do not write explanations or apologies.`;

      const retrySearchQuery = `Retry: previous answer was empty or not valid JSON.

Use Google Search again with different queries, e.g.:
site:${baseDomain} "blog"
site:${baseDomain} after:${cutoffDateStr}
site:${baseDomain} inurl:blog after:${cutoffDateStr}
site:${baseDomain} inurl:news after:${cutoffDateStr}
site:${baseDomain}${sourcePath === '/' ? '/blog' : sourcePath}
Today is ${todayStr}.
Source URL for scope: ${source.url}
${mediumHint}
${sourcePathHint}
${sourceMemoryHint}
Return ONLY valid JSON: an array of up to ${maxItems} objects {title, url, description, datePublished}. No markdown, no prose.
You MUST call Google Search before final output.
If still nothing: []`;
      const strictRetryQuery = `Final retry. Use Google Search now.

Run at least two searches:
1) site:${baseDomain} after:${cutoffDateStr}
2) site:${baseDomain} inurl:blog OR inurl:news OR inurl:post after:${cutoffDateStr}

Source URL for scope: ${source.url}
${mediumHint}
${sourcePathHint}
${sourceMemoryHint}
Return only a valid JSON array with up to ${maxItems} objects: {title,url,description,datePublished}.
No prose. No markdown fences. If nothing qualifies, output exactly: []`;

      let lightweightArticles = [];
      let lastRawCount = 0;
      let lastValidCount = 0;
      let lastToolCalls = 0;
      let lastToolResponses = 0;
      let lastGroundingEvents = 0;

      for (let qi = 0; qi < maxAttempts; qi++) {
        const searchQuery = qi === 0
          ? primarySearchQuery
          : qi === 1
            ? retrySearchQuery
            : strictRetryQuery;
        if (qi > 0) {
          console.log(`🔁 [ADK] Alternate prompt attempt ${qi + 1}/${maxAttempts} for ${source.name}`);
        }

        // Rate limiting: Ensure we don't exceed 10 RPM limit
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
          const waitTime = this.minRequestInterval - timeSinceLastRequest;
          console.log(`⏳ [ADK] Rate limiting: waiting ${waitTime}ms to stay under 10 RPM limit...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.lastRequestTime = Date.now();

        const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        session = await this.runner.sessionService.createSession({
          appName: 'distroblog',
          userId: 'system',
          id: sessionId,
          state: {}
        });

      let articles = [];
      let lastEvent = null;
      let fullResponse = '';
      let toolCallCount = 0;
      let toolResponseCount = 0;
      let groundingEventCount = 0;
      let groundingChunkCount = 0;
      let groundingFallbackArticles = [];

      // Run the agent and collect all events
      let eventCount = 0;
      let attemptError = null;
      try {
        for await (const event of this.runner.runAsync({
          userId: session.userId,
          sessionId: session.id,
          newMessage: {
            role: 'user',
            parts: [{ text: searchQuery }]
          },
          runConfig: {
            // Search + tool result + final JSON may need several turns; cap to control cost
            maxLlmCalls: 8
          }
        })) {
          eventCount++;
          lastEvent = event;
          
          // Log the entire event for debugging
          console.log(`📦 [ADK] Event #${eventCount} - author: ${event.author}, has content: ${!!event.content}, partial: ${event.partial || false}`);
          if (event.content) {
            console.log(`📦 [ADK] Content role: ${event.content.role}, has parts: ${!!event.content.parts}, parts count: ${event.content.parts ? event.content.parts.length : 0}`);
          }
          if (event.groundingMetadata && Object.keys(event.groundingMetadata).length > 0) {
            groundingEventCount++;
            const chunks = Array.isArray(event.groundingMetadata.groundingChunks)
              ? event.groundingMetadata.groundingChunks.length
              : 0;
            groundingChunkCount += chunks;
            if (chunks > 0) {
              const extracted = event.groundingMetadata.groundingChunks
                .map((chunk) => {
                  const web = chunk && chunk.web ? chunk.web : null;
                  const uri = web && typeof web.uri === 'string' ? web.uri : null;
                  const title = web && typeof web.title === 'string' ? web.title : null;
                  return uri
                    ? {
                        title: title || 'Grounded result',
                        url: uri,
                        description: 'Recovered from ADK grounding metadata.',
                        datePublished: null
                      }
                    : null;
                })
                .filter(Boolean);
              if (extracted.length > 0) {
                groundingFallbackArticles.push(...extracted);
              }
            }
          }
          
          // Check for errors in the event
          if (event.errorCode || event.errorMessage) {
            console.error(`❌ [ADK] API Error - Code: ${event.errorCode}, Message: ${event.errorMessage}`);
            if (event.errorCode === '429') {
              console.error(
                `⚠️ [ADK] Rate limit/quota exceeded.${config.mode === 'v2' ? ' (V2: no Playwright fallback — empty result).' : ' Will fallback to traditional scraper.'}`
              );
              throw new Error(`Rate limit exceeded (429): ${event.errorMessage}`);
            } else if (event.errorCode === '400' && event.errorMessage && event.errorMessage.includes('Search as tool is not enabled')) {
              console.error(
                `⚠️ [ADK] Model does not support Google Search tool.${config.mode === 'v2' ? ' (V2: no Playwright fallback — empty result).' : ' Will fallback to traditional scraper.'}`
              );
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
                toolCallCount++;
                console.log(`🔧 [ADK] Agent called function: ${part.functionCall.name}`);
                if (part.functionCall.args) {
                  console.log(`   Args: ${JSON.stringify(part.functionCall.args).substring(0, 200)}...`);
                }
              }
              if (part.functionResponse) {
                toolResponseCount++;
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
      } catch (runErr) {
        attemptError = runErr;
        console.warn(
          `⚠️ [ADK][V2][diag] Attempt ${qi + 1}/${maxAttempts} run error: ${(runErr.message || 'unknown').substring(0, 180)}`
        );
      }

      // Always log the response for debugging
      console.log(`📊 [ADK] Total events received: ${eventCount}`);
      if (lastEvent) {
        console.log(`📊 [ADK] Last event author: ${lastEvent.author}, partial: ${lastEvent.partial || false}`);
        console.log(`📊 [ADK] Last event content: ${JSON.stringify(lastEvent.content || {}).substring(0, 500)}`);
      }
      
      if (fullResponse) {
        console.log(`📝 [ADK] Full agent response (first 1000 chars):\n${fullResponse.substring(0, 1000)}${fullResponse.length > 1000 ? '...' : ''}`);
        if (
          config.mode === 'v2' &&
          /unable to find|could not find|I'm sorry|I cannot|no recent blog/i.test(fullResponse) &&
          !/\[[\s\S]*"title"[\s\S]*\]/.test(fullResponse)
        ) {
          console.log(
            `⚠️ [ADK][V2][diag] Prose/refusal-style reply with no JSON objects — likely skipped tool use or ignored JSON-only instruction.`
          );
        }
      } else {
        console.log(`⚠️ [ADK] No response text received from agent`);
        console.log(`⚠️ [ADK] Last event structure: ${JSON.stringify(lastEvent || {}).substring(0, 1000)}`);
      }
      if (config.mode === 'v2' && toolCallCount === 0 && toolResponseCount === 0 && groundingEventCount === 0) {
        console.log(
          '⚠️ [ADK][V2][diag] No tool/grounding evidence in events (toolCalls=0, toolResponses=0, groundingEvents=0).'
        );
      }
      // If model output is unusable but grounding metadata has links, use them as a fallback.
      // This keeps V2 productive when ADK returns prose/empty JSON despite grounding.
      if (articles.length === 0 && groundingFallbackArticles.length > 0) {
        const dedup = new Map();
        for (const a of groundingFallbackArticles) {
          if (a.url && !dedup.has(a.url)) dedup.set(a.url, a);
        }
        articles = Array.from(dedup.values()).slice(0, maxItems);
        console.log(
          `🛟 [ADK][V2][diag] Recovered ${articles.length} candidate article(s) from grounding metadata fallback`
        );
      }
      if (attemptError) {
        // Cleanup current attempt session before moving to next retry.
        try {
          if (this.runner && this.runner.sessionService && this.runner.sessionService.deleteSession) {
            await this.runner.sessionService.deleteSession({
              appName: 'distroblog',
              userId: session.userId,
              sessionId: session.id
            });
            console.log(`🧹 [ADK] Cleaned up session ${session.id} after attempt error`);
          }
        } catch (cleanupErr) {
          console.warn(`⚠️ [ADK] Could not clean up session after attempt error: ${cleanupErr.message}`);
        }
        session = null;
        if (qi < maxAttempts - 1) {
          continue;
        }
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
      
      // Helper to resolve redirects and get canonical URL.
      // We use this before domain filtering so grounding redirect links can be
      // converted into real article URLs instead of being discarded too early.
      const resolveCanonicalUrl = async (url) => {
        try {
          const response = await axios.get(url, {
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400,
            maxContentLength: 10000,
            maxBodyLength: 10000,
          });

          let finalUrl = url;
          if (response.request?.res?.responseUrl) {
            finalUrl = response.request.res.responseUrl;
          } else if (response.request?.responseURL) {
            finalUrl = response.request.responseURL;
          } else if (response.headers?.location) {
            const location = response.headers.location;
            finalUrl = location.startsWith('http') ? location : new URL(location, url).toString();
          } else if (response.config?.url && response.config.url !== url && response.config.url.startsWith('http')) {
            finalUrl = response.config.url;
          }

          if (finalUrl && finalUrl !== url && finalUrl.startsWith('http')) {
            return finalUrl;
          }
          return url;
        } catch (e) {
          return url;
        }
      };

      // Filter articles to only include those from the same domain
      // Also filter out generic URLs (homepage, base blog URL without article path)
      // AND filter out Google redirect URLs and invalid URLs
      const sourceDomain = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
      const sourceUrlObj = new URL(source.url);
      const basePath = sourceUrlObj.pathname.endsWith('/') ? sourceUrlObj.pathname.slice(0, -1) : sourceUrlObj.pathname;

      // Normalize URLs and resolve known grounding redirect links before filtering.
      let resolvedGroundingRedirects = 0;
      articles = await Promise.all(
        articles.map(async (article) => {
          let articleUrl = article.url || article.link;
          if (!articleUrl || typeof articleUrl !== 'string') return article;

          if (!articleUrl.startsWith('http')) {
            try {
              if (articleUrl.startsWith('/')) {
                articleUrl = `${sourceUrlObj.protocol}//${sourceUrlObj.host}${articleUrl}`;
              } else {
                const p = sourceUrlObj.pathname.replace(/\/[^\/]*$/, '/');
                articleUrl = `${sourceUrlObj.protocol}//${sourceUrlObj.host}${p}${articleUrl}`;
              }
            } catch (e) {
              return article;
            }
          }

          const isGroundingRedirect =
            articleUrl.includes('vertexaisearch.cloud.google.com') ||
            articleUrl.includes('grounding-api-redirect') ||
            articleUrl.includes('google.com/grounding');

          if (isGroundingRedirect) {
            const canonicalUrl = await resolveCanonicalUrl(articleUrl);
            if (canonicalUrl !== articleUrl) {
              resolvedGroundingRedirects++;
              return { ...article, url: canonicalUrl, link: canonicalUrl };
            }
          }
          return { ...article, url: articleUrl, link: articleUrl };
        })
      );
      if (resolvedGroundingRedirects > 0) {
        console.log(`🔗 [ADK] Resolved ${resolvedGroundingRedirects} grounding redirect URL(s) before filtering`);
      }
      
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
          wrongPublication: 0,
          genericUrl: 0,
          shortPath: 0,
          invalidUrl: 0,
          outsideDateRange: 0
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
          // Filter out literal placeholder paths (e.g. /post/placeholder)
          if (articleUrl.toLowerCase().includes('/placeholder')) {
            accuracyMetrics.filteredOut.genericUrl++;
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out placeholder URL: ${articleUrl}`);
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

          // Medium: same domain is not enough — require same publication path (fixes random Medium posts)
          const mediumPrefix = mediumPublicationPathPrefix(source.url);
          if (mediumPrefix) {
            const ap = articleUrlObj.pathname.replace(/\/$/, '') || '/';
            const ok =
              ap === mediumPrefix ||
              ap.startsWith(mediumPrefix + '/');
            if (!ok) {
              accuracyMetrics.filteredOut.wrongPublication++;
              console.log(
                `⚠️ [ADK] [ACCURACY] Filtering out wrong Medium publication (need path prefix ${mediumPrefix}): ${articleUrl.substring(0, 100)}...`
              );
              return false;
            }
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
                                   '/faq', '/help', '/support', '/docs', '/documentation',
                                   '/eco-system', '/build', '/developers'];
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
          // Filter out section/landing paths that are not single-article pages
          if (normalizedPath.includes('/eco-system') || normalizedPath.includes('/build/') ||
              normalizedPath.endsWith('/developers') || normalizedPath.includes('/blog/events')) {
            accuracyMetrics.filteredOut.genericUrl++;
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out non-article path (${normalizedPath}): ${articleUrl}`);
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

      // Date-range filter runs AFTER the quality pass so we can use HTML metadata (JSON-LD, og:, etc.)
      // instead of trusting ADK-only dates alone.
      const articlesAfterUrlFilter = filteredArticles;

      // Final quality pass: verify URLs, repair title mismatches, and extract publish dates from HTML
      // (same response body as verification — no extra HTTP round trip).
      const validatedArticles = [];
      for (const article of articlesAfterUrlFilter) {
        const articleUrl = article.url || article.link;
        if (!articleUrl || typeof articleUrl !== 'string') continue;
        try {
          const resp = await axios.get(articleUrl, {
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; ScoopstreamBot/1.0)'
            }
          });

          // Hard-drop dead links.
          if (resp.status === 404) {
            console.log(`⚠️ [ADK][QUALITY] Dropping 404 article URL: ${articleUrl}`);
            continue;
          }

          // 403 is common for Medium anti-bot; keep if URL pattern is valid.
          if (resp.status >= 400 && resp.status !== 403 && resp.status !== 429) {
            console.log(`⚠️ [ADK][QUALITY] Dropping non-OK article URL (${resp.status}): ${articleUrl}`);
            continue;
          }

          let finalUrl = articleUrl;
          if (resp.request?.res?.responseUrl) {
            finalUrl = resp.request.res.responseUrl;
          } else if (resp.request?.responseURL) {
            finalUrl = resp.request.responseURL;
          }

          const next = { ...article, url: finalUrl, link: finalUrl };
          const htmlTitle = normalizePageTitle(
            extractHtmlTitle(typeof resp.data === 'string' ? resp.data : ''),
            sourceDomain
          );
          if (htmlTitle && next.title) {
            const score = overlapScore(next.title, htmlTitle);
            if (score < 0.22) {
              console.log(
                `⚠️ [ADK][QUALITY] Title mismatch (score=${score.toFixed(2)}), replacing model title with page title.`
              );
              next.title = htmlTitle;
            }
          } else if (htmlTitle && !next.title) {
            next.title = htmlTitle;
          }

          const rawHtml = typeof resp.data === 'string' ? resp.data : '';
          if (rawHtml) {
            const iso = articleEnrichment.extractDateFromHtml(rawHtml);
            if (iso) {
              const d = new Date(iso);
              if (!isNaN(d.getTime())) {
                const ymd = d.toISOString().slice(0, 10);
                const prev = next.datePublished;
                next.datePublished = ymd;
                if (prev && String(prev).slice(0, 10) !== ymd) {
                  console.log(`📅 [ADK][DATE] HTML metadata: ${ymd} (ADK had "${prev}")`);
                } else if (!prev) {
                  console.log(`📅 [ADK][DATE] Filled missing date from page metadata: ${ymd}`);
                }
              }
            }
          }

          validatedArticles.push(next);
        } catch (e) {
          // Keep article only for transient network issues on valid-looking URLs.
          // If we cannot verify due to timeout, we prefer recall over silent loss.
          if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
            console.log(`⚠️ [ADK][QUALITY] URL verify timeout, keeping candidate: ${articleUrl}`);
            validatedArticles.push(article);
          } else {
            console.log(`⚠️ [ADK][QUALITY] URL verify error, dropping: ${articleUrl} (${e.message})`);
          }
        }
      }
      if (validatedArticles.length > 0) {
        const dropped = articlesAfterUrlFilter.length - validatedArticles.length;
        if (dropped > 0) {
          console.log(`🧪 [ADK][QUALITY] Dropped ${dropped} low-quality/invalid article candidate(s)`);
        }
      }

      const baseForDateFilter =
        validatedArticles.length > 0 ? validatedArticles : articlesAfterUrlFilter;
      const articlesBeforeDateFilter = baseForDateFilter.length;

      const dateFilteredArticles = baseForDateFilter.filter((article) => {
        if (!article.datePublished) {
          console.log(
            `⚠️ [ADK] [DATE] Article has no date after HTML enrichment, keeping: "${article.title?.substring(0, 50) || 'unknown'}"`
          );
          return true;
        }
        try {
          const articleDate = new Date(article.datePublished);
          if (isNaN(articleDate.getTime())) {
            console.log(
              `⚠️ [ADK] [DATE] Invalid date format "${article.datePublished}", keeping article: "${article.title?.substring(0, 50) || 'unknown'}"`
            );
            return true;
          }
          if (articleDate < cutoffDate) {
            console.log(
              `⚠️ [ADK] [DATE] Filtering out old article (${article.datePublished} < ${cutoffDateStr}): "${article.title?.substring(0, 50) || 'unknown'}"`
            );
            accuracyMetrics.filteredOut.outsideDateRange = (accuracyMetrics.filteredOut.outsideDateRange || 0) + 1;
            return false;
          }
          return true;
        } catch (e) {
          console.log(`⚠️ [ADK] [DATE] Error parsing date "${article.datePublished}": ${e.message}`);
          return true;
        }
      });

      const articlesFilteredByDate = articlesBeforeDateFilter - dateFilteredArticles.length;
      if (articlesFilteredByDate > 0) {
        console.log(
          `📅 [ADK] [DATE] Filtered out ${articlesFilteredByDate} articles outside date range (before ${cutoffDateStr})`
        );
      }

      const articlesFiltered = articlesBeforeFilter - dateFilteredArticles.length;

      dateFilteredArticles.sort((a, b) => {
        const dateA = a.datePublished ? new Date(a.datePublished).getTime() : 0;
        const dateB = b.datePublished ? new Date(b.datePublished).getTime() : 0;
        if (dateA && dateB) return dateB - dateA;
        if (dateA && !dateB) return -1;
        if (!dateA && dateB) return 1;
        return 0;
      });

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
      console.log(`     - Wrong Medium publication / path: ${accuracyMetrics.filteredOut.wrongPublication}`);
      console.log(`     - Generic/homepage URLs: ${accuracyMetrics.filteredOut.genericUrl}`);
      console.log(`     - Short path (< 11 chars): ${accuracyMetrics.filteredOut.shortPath}`);
      console.log(`     - Invalid URL format: ${accuracyMetrics.filteredOut.invalidUrl}`);
      console.log(`     - Outside date range (>${daysBack} days old): ${accuracyMetrics.filteredOut.outsideDateRange}`);
      const accuracyRate = accuracyMetrics.totalReturned > 0
        ? ((accuracyMetrics.validArticles / accuracyMetrics.totalReturned) * 100).toFixed(1)
        : 0;
      console.log(`   Accuracy rate: ${accuracyRate}% (${accuracyMetrics.validArticles}/${accuracyMetrics.totalReturned} valid)\n`);

      if (config.mode === 'v2') {
        const fo = accuracyMetrics.filteredOut;
        console.log(
          `🔬 [ADK][V2][diag] attempt=${qi + 1}/${maxAttempts} rawJson=${articlesBeforeFilter} afterUrlFilters=${filteredArticles.length} afterQuality=${validatedArticles.length} afterDateFilter=${dateFilteredArticles.length} responseChars=${fullResponse.length} events=${eventCount} ` +
            `filteredWrongDomain=${fo.wrongDomain} wrongPublication=${fo.wrongPublication || 0} googleRedirect=${fo.googleRedirect} outsideDate=${fo.outsideDateRange || 0} shortPath=${fo.shortPath} genericUrl=${fo.genericUrl} ` +
            `toolCalls=${toolCallCount} toolResponses=${toolResponseCount} groundingEvents=${groundingEventCount} groundingChunks=${groundingChunkCount}`
        );
      }

      if (dateFilteredArticles.length === 0) {
        if (articlesBeforeFilter > 0) {
          console.log(
            `⚠️ [ADK] No articles found from ${sourceDomain} domain. ${articlesBeforeFilter} articles from other domains were filtered out.`
          );
        } else {
          console.log(`⚠️ [ADK] No articles found from ${sourceDomain} domain.`);
        }
      } else {
        console.log(
          `✅ [ADK] Found ${dateFilteredArticles.length} articles from ${sourceDomain} domain${articlesFiltered > 0 ? ` (${articlesFiltered} external articles filtered out)` : ''}`
        );
      }

      if (source.id) {
        try {
          const database = require('../database-postgres');
          await Promise.race([
            database.updateScrapingResult(source.id, {
              articlesFound: articlesBeforeFilter,
              articlesAfterFilter: dateFilteredArticles.length,
              articlesFiltered: articlesFiltered,
              success: dateFilteredArticles.length > 0,
              timestamp: new Date().toISOString(),
              domain: sourceDomain,
              method: 'ADK_AGENT'
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Database query timeout')), 5000))
          ]);
        } catch (err) {
          if (err.code !== 'ETIMEDOUT' && err.code !== 'ECONNRESET' && !err.message.includes('timeout')) {
            console.warn(`⚠️  [ADK] Could not store scraping result for ${source.name}:`, err.message);
          }
        }
      }

      // Return lightweight articles (limit to 3 most recent articles)
      // This ensures we get the most recent articles from each source
      // Resolve redirects to get canonical URLs (ADK may return long slugs that redirect to shorter ones)
      const finalCandidates = dateFilteredArticles.slice(0, maxItems);
      const lightweightArticlesPromises = finalCandidates.map(async (article) => {
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
        lightweightArticles = await Promise.all(lightweightArticlesPromises);

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

        lastRawCount = accuracyMetrics.totalReturned;
        lastValidCount = accuracyMetrics.validArticles;
        lastToolCalls = toolCallCount;
        lastToolResponses = toolResponseCount;
        lastGroundingEvents = groundingEventCount;

      // MEMORY FIX: Delete the session after use to prevent memory accumulation
      // InMemoryRunner stores all sessions in memory, causing OOM crashes over time
      try {
        if (session && this.runner && this.runner.sessionService && this.runner.sessionService.deleteSession) {
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

        if (lightweightArticles.length > 0) {
          break;
        }
      } // end for qi (retry attempts)

      if (config.mode === 'v2') {
        const ms = Date.now() - v2ObsStart;
        console.log(
          `📈 [ADK][V2] observability source=${source.name} domain=${new URL(source.url).hostname} ms=${ms} attempts=${maxAttempts} final=${lightweightArticles.length} rawReturned=${lastRawCount} validAfterDomainRules=${lastValidCount} toolCalls=${lastToolCalls} toolResponses=${lastToolResponses} groundingEvents=${lastGroundingEvents}`
        );
      }

      // If no valid articles found: V2 returns [] (ADK-only, no implicit fallback); V1 throws for scraper fallback
      if (lightweightArticles.length === 0) {
        if (config.mode === 'v2') {
          return [];
        }
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
      
      // Check if it's a rate limit error
      if ((error.message && error.message.includes('429')) || (error.message && error.message.includes('quota'))) {
        console.error(`❌ [ADK] Rate limit/quota exceeded for ${source.url}: ${error.message}`);
        if (config.mode !== 'v2') {
          console.log(`🔄 [ADK] Will fallback to traditional scraper for ${source.name}`);
        }
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

      // V2: ADK-only — return [] so feedMonitor does not treat as "success" but also does not imply Playwright fallback
      if (config.mode === 'v2') {
        const ms = Date.now() - scrapeStartedAt;
        console.warn(`⚠️ [ADK][V2] Returning empty result after error for ${source.name} (no scraper fallback)`);
        console.log(
          `📈 [ADK][V2] observability source=${source.name} domain=${source.url ? new URL(source.url).hostname : '?'} ms=${ms} attempts=error final=0 rawReturned=0 validAfterDomainRules=0 error=${(error.message || 'unknown').substring(0, 120)}`
        );
        return [];
      }

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
      this.llm = null;
      console.log('🧹 [ADK] Resources cleaned up');
    } catch (error) {
      console.warn(`⚠️ [ADK] Error during cleanup: ${error.message}`);
      // Reset state anyway
      this.runner = null;
      this.agent = null;
      this.llm = null;
      this.initialized = false;
    }
  }
}

module.exports = ADKScraper;
