// ADK (Agent Development Kit) implementation using Tavily Search API
// Required env: GOOGLE_GENAI_API_KEY or GEMINI_API_KEY
// Optional env: TAVILY_API_KEY (for web search)
// Optional env: ADK_MODEL | SCOOPSTREAM_ADK_MODEL (try this Gemini id first), ADK_VERBOSE
const axios = require('axios');
const config = require('../config');
const articleEnrichment = require('./articleEnrichment');

// Tavily Search API endpoint (replaces Google Custom Search which is closed to new customers)
const TAVILY_API_URL = 'https://api.tavily.com/search';

/**
 * Call Tavily Search API to get real search results.
 * Tavily is designed for AI agents and provides clean, relevant results.
 */
async function tavilySearch(query, apiKey, numResults = 10) {
  if (!apiKey) {
    console.warn('[TAVILY] Missing API key, cannot perform search');
    return [];
  }
  
  // Clean up Google-specific search operators that Tavily doesn't support
  let cleanQuery = query
    .replace(/\bafter:\d{4}-\d{2}-\d{2}\b/gi, '')  // Remove after:YYYY-MM-DD
    .replace(/\binurl:\w+/gi, '')                   // Remove inurl:xxx
    .replace(/\s+/g, ' ')                           // Collapse multiple spaces
    .trim();
  
  // If query is just "site:domain.com" with nothing else, add a generic term
  if (/^site:\S+\s*$/.test(cleanQuery)) {
    cleanQuery += ' blog OR news OR article';
  }
  
  // Date filtering strategy:
  // - Tavily API doesn't allow time_range + start_date together (400 error)
  // - start_date is precise but often too strict (Tavily's index can lag)
  // - time_range='month' is unreliable according to user testing (Reddit)
  // - Best approach: no Tavily filtering, let Gemini + post-processing handle it
  //
  // Use TAVILY_DATE_MODE to configure:
  //   'none' (default): no Tavily-side date filtering (recommended)
  //   'time_range': use time_range=month (may reduce results)
  //   'start_date': use start_date parameter (strictest, may return 0)
  const dateMode = (process.env.TAVILY_DATE_MODE || 'none').toLowerCase();
  
  const body = {
    api_key: apiKey,
    query: cleanQuery,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
    max_results: Math.min(numResults, 10),
  };
  
  if (dateMode === 'time_range') {
    body.time_range = 'month';
  } else if (dateMode === 'start_date') {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    body.start_date = startDate.toISOString().split('T')[0];
  }
  // 'none' mode: no date filtering at Tavily level

  try {
    const response = await axios.post(TAVILY_API_URL, body, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    const results = response.data.results || [];
    console.log(`[TAVILY] Search "${cleanQuery.substring(0, 50)}..." returned ${results.length} results`);
    
    return results.map(item => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
      displayLink: item.url ? new URL(item.url).hostname : '',
    }));
  } catch (error) {
    if (error.response) {
      const errData = error.response.data;
      const errMsg = typeof errData === 'string' ? errData : (errData?.message || errData?.detail || JSON.stringify(errData));
      console.error(`[TAVILY] API error ${error.response.status}: ${errMsg}`);
    } else {
      console.error(`[TAVILY] Request error: ${error.message}`);
    }
    return [];
  }
}

/** ADK_VERBOSE=1 — full per-event / per-filter logs. Default: concise [ADK] start/done + preview (no extra env). */
function isAdkVerbose() {
  const v = (process.env.ADK_VERBOSE || process.env.SCOOPSTREAM_ADK_VERBOSE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function escLogOneLine(s, max = 320) {
  if (s == null || typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** When errorMessage is missing (e.g. STOP), log something inspectable. */
function summarizeAdkErrorEvent(event) {
  try {
    const parts = event.content && event.content.parts;
    const partSummary = Array.isArray(parts)
      ? parts.map((p) => ({
          textChars: p.text ? p.text.length : 0,
          fnCall: p.functionCall && p.functionCall.name,
          fnRes: p.functionResponse && p.functionResponse.name,
        }))
      : [];
    return JSON.stringify({
      author: event.author,
      partial: event.partial,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      finishReason: event.finishReason,
      partSummary,
      grounding: event.groundingMetadata ? Object.keys(event.groundingMetadata) : [],
    });
  } catch {
    return '(unserializable event)';
  }
}

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

const QUALITY_UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; ScoopstreamBot/1.0)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** After a 404, try slash variant and www / non-www (some CDNs differ). */
function urlVariantsAfter404(original) {
  const list = [];
  try {
    const parsed = new URL(original);
    const path = parsed.pathname;
    if (path.length > 1) {
      if (path.endsWith('/')) {
        const np = path.replace(/\/$/, '') || '/';
        list.push(new URL(np + parsed.search, parsed.origin).href);
      } else {
        list.push(new URL(path + '/' + parsed.search, parsed.origin).href);
      }
    }
    const h = parsed.hostname;
    if (!h.startsWith('www.')) {
      list.push(new URL(parsed.pathname + parsed.search + parsed.hash, `${parsed.protocol}//www.${h}`).href);
    } else {
      list.push(new URL(parsed.pathname + parsed.search + parsed.hash, `${parsed.protocol}//${h.slice(4)}`).href);
    }
  } catch {
    return [];
  }
  return [...new Set(list)].filter((x) => x !== original);
}

/**
 * GET for quality pass; on 404 only, retry alternate URL forms once each.
 * @returns {{ resp: import('axios').AxiosResponse, finalUrl: string, used404Fallback: boolean }}
 */
/** NEAR blog long slugs often 404; canonical posts use shorter paths (e.g. /blog/legion-city-nodes). */
function nearOrgBlogSlugRepairVariants(original) {
  const list = [];
  try {
    const parsed = new URL(original);
    const h = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (h !== 'near.org') return [];
    const m = parsed.pathname.match(/^\/blog\/([^/]+)/i);
    if (!m) return [];
    let slug = m[1].replace(/\/$/, '');
    if (slug.startsWith('near-')) {
      slug = slug.slice(5);
      list.push(new URL(`/blog/${slug}`, 'https://www.near.org').href);
    }
    const parts = slug.split('-').filter(Boolean);
    if (parts.length > 3) {
      list.push(new URL(`/blog/${parts.slice(0, 3).join('-')}`, 'https://www.near.org').href);
    }
    if (parts.length > 4) {
      list.push(new URL(`/blog/${parts.slice(0, 4).join('-')}`, 'https://www.near.org').href);
    }
  } catch {
    return [];
  }
  return [...new Set(list)].filter((x) => x !== original);
}

async function fetchArticleForQuality(initialUrl) {
  const req = {
    timeout: 10000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500,
    headers: QUALITY_UA_HEADERS,
  };
  let resp = await axios.get(initialUrl, req);
  let finalUrl = initialUrl;
  let used404Fallback = false;
  if (resp.status === 404) {
    const alts = [
      ...urlVariantsAfter404(initialUrl),
      ...nearOrgBlogSlugRepairVariants(initialUrl),
    ];
    const seen = new Set([initialUrl]);
    for (const alt of alts) {
      if (seen.has(alt)) continue;
      seen.add(alt);
      const r2 = await axios.get(alt, req);
      if (r2.status !== 404 && r2.status < 500) {
        resp = r2;
        finalUrl = alt;
        used404Fallback = true;
        break;
      }
    }
  }
  return { resp, finalUrl, used404Fallback };
}

/** NEAR blog: prefer www host (routing differs from apex). */
function canonicalizeKnownBlogUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (h === 'near.org' && u.pathname.startsWith('/blog')) {
      return `https://www.near.org${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    return url;
  }
  return url;
}

function hostnameKey(host) {
  return String(host || '')
    .replace(/^www\./i, '')
    .toLowerCase();
}

/** Decode a small subset of entities in href/content attributes (canonical URLs). */
function decodeMinimalHtmlEntities(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/**
 * Prefer <link rel="canonical">, then og:url (first ~200KB only — enough for <head>).
 * @returns {string|null}
 */
function extractCanonicalUrlFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const headish = html.length > 200000 ? html.slice(0, 200000) : html;
  let m = headish.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  if (!m) {
    m = headish.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i);
  }
  if (m && m[1]) {
    const raw = decodeMinimalHtmlEntities(m[1].trim());
    return raw || null;
  }
  m = headish.match(/property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
  if (!m) {
    m = headish.match(/content=["']([^"']+)["'][^>]*property=["']og:url["']/i);
  }
  if (m && m[1]) {
    const raw = decodeMinimalHtmlEntities(m[1].trim());
    return raw || null;
  }
  return null;
}

function firstPathSegment(pathname) {
  const parts = String(pathname || '')
    .split('/')
    .filter(Boolean);
  return parts[0] || null;
}

/** Reject homepages and obvious non-article hubs as canonical targets. */
function isProbablyArticlePath(pathname) {
  const p = String(pathname || '').replace(/\/$/, '') || '/';
  if (p === '/') return false;
  const parts = p.split('/').filter(Boolean);
  if (parts.length >= 2) return true;
  if (parts.length === 1 && parts[0].startsWith('@')) return false;
  return false;
}

/**
 * After redirects, prefer HTML-declared canonical / og:url when same-site and safe.
 * @param {string} fetchUrl - original request URL
 * @param {string} redirectFinalUrl - URL after HTTP redirects (from axios)
 * @param {string} html - response body
 * @param {string} [sourceBaseUrl] - source homepage / feed URL (Medium publication guard)
 * @returns {string}
 */
function pickPreferredArticleUrl(fetchUrl, redirectFinalUrl, html, sourceBaseUrl) {
  let base = redirectFinalUrl || fetchUrl;
  try {
    const baseU = new URL(base);
    const fromHtml = extractCanonicalUrlFromHtml(html);
    if (!fromHtml) return base;

    let candU = new URL(fromHtml, base);
    if (candU.protocol !== 'http:' && candU.protocol !== 'https:') return base;
    if (candU.protocol === 'http:') {
      candU = new URL(candU.href.replace(/^http:/i, 'https:'));
    }

    if (hostnameKey(candU.hostname) !== hostnameKey(baseU.hostname)) return base;

    if (!isProbablyArticlePath(candU.pathname)) return base;

    const h = hostnameKey(candU.hostname);
    if (h === 'medium.com' || h.endsWith('.medium.com')) {
      const srcPrefix = sourceBaseUrl ? mediumPublicationPathPrefix(sourceBaseUrl) : null;
      if (srcPrefix) {
        const norm = srcPrefix.replace(/\/$/, '');
        const cp = candU.pathname.replace(/\/$/, '');
        if (!cp.startsWith(norm)) return base;
      } else {
        const bSeg = firstPathSegment(baseU.pathname);
        const cSeg = firstPathSegment(candU.pathname);
        if (bSeg && cSeg && bSeg !== cSeg) return base;
      }
    }

    return normalizeHrefPathDoubles(candU.href);
  } catch {
    return base;
  }
}

/** Some CMS emit https://host//path in canonical; normalize for stable storage. */
function normalizeHrefPathDoubles(href) {
  try {
    const u = new URL(href);
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
    return u.href;
  } catch {
    return href;
  }
}

/** Axios redirect / final response URL (same logic as quality pass). */
function getAxiosFinalUrl(response, requestUrl) {
  let finalUrl = requestUrl;
  if (response.request?.res?.responseUrl) {
    finalUrl = response.request.res.responseUrl;
  } else if (response.request?.responseURL) {
    finalUrl = response.request.responseURL;
  } else if (response.headers?.location) {
    const location = response.headers.location;
    finalUrl = location.startsWith('http') ? location : new URL(location, requestUrl).toString();
  } else if (
    response.config?.url &&
    response.config.url !== requestUrl &&
    String(response.config.url).startsWith('http')
  ) {
    finalUrl = response.config.url;
  }
  return finalUrl;
}

/** Extra user-prompt lines for domains with known apex/www or slug quirks (v2 discovery). */
function domainSpecificSiteHint(baseDomain) {
  const d = (baseDomain || '').replace(/^www\./, '').toLowerCase();
  if (d === 'near.org') {
    return `\nNEAR Foundation blog: Use https://www.near.org/blog/... URLs exactly as shown in Google Search snippets. Do not invent long slug paths; apex near.org and www.near.org may resolve different paths — prefer www for blog posts when the snippet shows www.\n`;
  }
  return '';
}

/**
 * Phase 4: Domain-specific blocklist for known bad URL patterns.
 * Returns { blocked: boolean, reason?: string } for a given URL.
 * Use this to reject URLs that Google Search returns but are clearly wrong
 * (e.g., Cambrian national news site, Merit NATO pages).
 */
function domainBlocklist(articleUrl, sourceName) {
  if (!articleUrl) return { blocked: false };
  try {
    const u = new URL(articleUrl);
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    const p = u.pathname.toLowerCase();

    // Cambrian: block cambrian.org national/local news pages (wrong site)
    if (sourceName && sourceName.toLowerCase().includes('cambrian')) {
      if (h === 'cambrian.org' && (p.includes('/news/national') || p.includes('/news/local'))) {
        return { blocked: true, reason: 'cambrian_news_wrong_site' };
      }
    }

    // Merit: block NATO/DIANA pages (wrong entity)
    if (sourceName && sourceName.toLowerCase().includes('merit')) {
      if (p.includes('/diana') || p.includes('/nato') || p.includes('defence')) {
        return { blocked: true, reason: 'merit_nato_wrong_entity' };
      }
    }

    // Generic: block obvious non-blog paths on any domain
    if (p.includes('/careers') || p.includes('/jobs/') || p.includes('/login') || p.includes('/signup')) {
      return { blocked: true, reason: 'generic_non_article' };
    }

    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}
// This uses an agent with web_search tool (Tavily Search API) instead of scraping HTML
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
    
    // Gemini/ADK API key (for the LLM)
    this.apiKey =
      process.env.GOOGLE_GENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY;
    
    // Tavily API key for web search (replaces Google CSE which is closed to new customers)
    this.tavilyApiKey = process.env.TAVILY_API_KEY;
    
    if (!this.apiKey) {
      console.warn(
        '⚠️ ADK API key not found. ADK scraping will be disabled. Set GOOGLE_GENAI_API_KEY or GEMINI_API_KEY in .env'
      );
      return;
    }
    
    if (!this.tavilyApiKey) {
      console.warn(
        '⚠️ Tavily API key not found. Set TAVILY_API_KEY in .env for web search results.'
      );
      console.warn('   Without TAVILY_API_KEY, ADK will use grounding only (less accurate).');
    } else {
      console.log(`✅ [ADK] Tavily Search configured (key: ${this.tavilyApiKey.substring(0, 8)}...)`);
    }

    try {
      // Dynamic import since ADK is ES module and we're in CommonJS
      const adk = await import('@google/adk');
      
      // Pick the first available model
      const defaultCandidates = [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-2.5-flash-lite',
        'gemini-1.5-flash-latest',
        'gemini-1.5-flash',
        'gemini-1.5-flash-001',
      ];
      const envModel = (process.env.ADK_MODEL || process.env.SCOOPSTREAM_ADK_MODEL || '').trim();
      const candidateModels = envModel
        ? [envModel, ...defaultCandidates.filter((m) => m !== envModel)]
        : defaultCandidates;
      if (envModel) {
        console.log(`[ADK] ADK_MODEL=${JSON.stringify(envModel)} — trying this model first (then defaults if unavailable)`);
      }

      let llm = null;
      let modelName = null;

      for (const candidate of candidateModels) {
        try {
          llm = new adk.Gemini({
            model: candidate,
            apiKey: this.apiKey
          });
          modelName = candidate;
          this.llm = llm;
          console.log(`✅ [ADK] Using model: ${candidate}`);
          break;
        } catch (e) {
          console.warn(`⚠️ [ADK] Model ${candidate} unavailable: ${e.message}`);
          llm = null;
        }
      }

      if (!llm || !modelName) {
        throw new Error('No Gemini model available for ADK');
      }
      this.modelName = modelName;

      // Create a custom FunctionTool that calls Tavily Search API
      // Tavily is designed for AI agents and provides clean, relevant results
      const self = this;
      const webSearchTool = new adk.FunctionTool({
        name: 'web_search',
        description: 'Search the web using Tavily Search API. Returns real search results with titles, URLs, and snippets. You MUST call this tool before answering. Use site:domain.com in the query to limit to a specific site.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query. Use site:domain.com to limit to a specific site.'
            }
          },
          required: ['query']
        },
        execute: async ({ query }) => {
          console.log(`[ADK] Tool EXECUTE: web_search("${query.substring(0, 80)}${query.length > 80 ? '...' : ''}")`);
          try {
            const results = await tavilySearch(query, self.tavilyApiKey, 10);
            console.log(`[ADK] Tool returned ${results.length} results from Tavily`);
            if (results.length === 0) {
              return { results: [], message: 'No results found for this query. Try a different search.' };
            }
            return {
              results: results.map(r => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet
              }))
            };
          } catch (err) {
            console.error(`[ADK] Tool ERROR: ${err.message}`);
            return { error: err.message, results: [] };
          }
        }
      });

      // Create LlmAgent with our custom search tool
      this.agent = new adk.LlmAgent({
        name: 'article_finder',
        model: llm,
        description: 'Agent that finds recent blog posts and articles from websites using web search.',
        tools: [webSearchTool]
      });

      // Create in-memory runner to execute the agent
      this.runner = new adk.InMemoryRunner({
        agent: this.agent,
        appName: 'distroblog'
      });

      if (!this.agent) {
        throw new Error('Failed to create ADK agent');
      }
      
      try {
        const canonicalModel = this.agent.canonicalModel;
        if (canonicalModel) {
        console.log(`✅ [ADK] Agent canonical model: ${canonicalModel.model || 'unknown'}`);
        }
      } catch (modelError) {
        console.error('⚠️ [ADK] Warning: Could not verify canonical model:', modelError.message);
      }

      this.initialized = true;
      const searchMode = this.tavilyApiKey ? 'web_search tool (Tavily API)' : 'Grounding only (fallback)';
      console.log(`✅ ADK agent initialized successfully with ${searchMode}`);
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
   * Returns Article[] or, with { inspect: true }, { articles, inspection } for local debugging.
   */
  async scrapeArticles(source, options = {}) {
    // MEMORY FIX: Track session outside try block so we can clean it up in catch
    let session = null;
    const scrapeStartedAt = Date.now();
    const verbose = isAdkVerbose();
    const concise = !verbose;
    const inspect = options && options.inspect === true;
    const inspection = inspect
      ? { source: { name: source.name, url: source.url }, model: null, attempts: [] }
      : null;

    try {
      if (verbose) {
      console.log(`🤖 [ADK] Finding articles from: ${source.url} using Google Search agent`);
      }
      if (verbose) {
        console.log('📣 [ADK] ADK_VERBOSE=1 — detailed per-event and per-filter logging enabled');
      }

      // Initialize if not already done
      if (!this.initialized) {
        await this.initialize();
      }

      if (inspection) {
        inspection.model = this.modelName || null;
      }

      if (!this.agent || !this.runner) {
      throw new Error('ADK agent not initialized. Check ADK API key environment variable (GOOGLE_GENAI_API_KEY / GEMINI_API_KEY).');
      }

      // V2 smart retry: start with up to 3 attempts but short-circuit if toolCalls=0
      // suggests a systemic issue (quota, model config) rather than transient bad luck.
      const MAX_ATTEMPTS_CAP = config.mode === 'v2' ? 3 : 1;
      let maxAttempts = MAX_ATTEMPTS_CAP;
      const maxItems = config.mode === 'v2' ? 8 : 3;
      let consecutiveNoToolUse = 0; // Track attempts where model didn't use search
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

      if (verbose) {
        console.log(
          `📅 [ADK] Date filter: articles after ${cutoffDateStr} (today is ${todayStr}, daysBack=${daysBack})`
        );
      }
      if (concise) {
        console.log(
          `[ADK] start source=${JSON.stringify(source.name)} url=${source.url} cutoff=${cutoffDateStr} daysBack=${daysBack} model=${this.modelName || '?'}`
        );
      }

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

      // Build a more specific site: query for Medium publications
      // e.g. site:medium.com/lumerin-blog instead of site:medium.com
      const siteQuery = mediumPub
        ? `site:${baseDomain}${mediumPub}`
        : `site:${baseDomain}`;

      // Medium-specific hint (keep it short)
      const mediumHintShort = mediumPub
        ? `Only include URLs from the ${mediumPub}/ path.`
        : '';

      // Path hint for non-Medium sites
      const pathHintShort = !mediumPub && sourcePath && sourcePath !== '/'
        ? `Prioritize URLs under ${sourcePath}/.`
        : '';

      // Balanced prompt: Role + Task + Key Constraints + Format
      // Research shows 150-300 words is optimal; focus on what Gemini CAN verify (URL patterns, titles)
      // Post-processing handles what it CAN'T (HTTP checks, HTML date extraction)
      const primarySearchQuery = `You are a news aggregator. Find recent articles from ${baseDomain}.

1. Call web_search: ${siteQuery}
2. From the results, select up to 5 actual article pages

Filter out:
- URLs from other domains (must be ${baseDomain})
- Non-article pages: homepage, /about, /contact, /login, /pricing, category listings
- Generic titles like "Blog" or "Home"
${mediumHintShort}${pathHintShort}

Return JSON array only (no markdown):
[{"title": "Article Title", "url": "https://...", "description": "Brief summary", "datePublished": "YYYY-MM-DD or null"}]

If no articles found: []`;

      const retrySearchQuery = `Search ${baseDomain} for articles.

Call web_search: ${siteQuery}

Return up to 5 article pages as JSON (not category pages, not /about or /login).
${mediumHintShort}

[{"title": "...", "url": "...", "description": "...", "datePublished": "YYYY-MM-DD or null"}]

If nothing: []`;

      const strictRetryQuery = retrySearchQuery;

      let lightweightArticles = [];
      let lastRawCount = 0;
      let lastValidCount = 0;
      let lastToolCalls = 0;
      let lastToolResponses = 0;
      let lastGroundingEvents = 0;
      let conciseLastAttempt = null;

      for (let qi = 0; qi < maxAttempts; qi++) {
        const searchQuery = qi === 0
          ? primarySearchQuery
          : qi === 1
            ? retrySearchQuery
            : strictRetryQuery;
        if (qi > 0) {
          if (concise) {
            console.log(`[ADK] retry ${qi + 1}/${maxAttempts} ${JSON.stringify(source.name)}`);
          } else {
            console.log(`🔁 [ADK] Alternate prompt attempt ${qi + 1}/${maxAttempts} for ${source.name}`);
          }
      }

      // Rate limiting: Ensure we don't exceed 10 RPM limit
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        const waitTime = this.minRequestInterval - timeSinceLastRequest;
          if (concise) {
            console.log(`[ADK] wait ${waitTime}ms rpm`);
          } else {
        console.log(`⏳ [ADK] Rate limiting: waiting ${waitTime}ms to stay under 10 RPM limit...`);
          }
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
        
          if (verbose) {
        console.log(`📦 [ADK] Event #${eventCount} - author: ${event.author}, has content: ${!!event.content}, partial: ${event.partial || false}`);
        if (event.content) {
          console.log(`📦 [ADK] Content role: ${event.content.role}, has parts: ${!!event.content.parts}, parts count: ${event.content.parts ? event.content.parts.length : 0}`);
            }
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
            const msg = event.errorMessage != null && event.errorMessage !== ''
              ? event.errorMessage
              : '(no message)';
            console.error(`❌ [ADK] API Error - Code: ${event.errorCode}, Message: ${msg}`);
            if (!event.errorMessage && event.errorCode) {
              console.error(`❌ [ADK] API Error detail: ${escLogOneLine(summarizeAdkErrorEvent(event), 900)}`);
            }
          if (event.errorCode === '429') {
              console.error(
                `⚠️ [ADK] Rate limit/quota exceeded.${config.mode === 'v2' ? ' (V2: no Playwright fallback — empty result).' : ' Will fallback to traditional scraper.'}`
              );
            throw new Error(`Rate limit exceeded (429): ${event.errorMessage}`);
          } else if (event.errorCode === '400' && event.errorMessage && event.errorMessage.includes('Search as tool is not enabled')) {
              console.error(
                `⚠️ [ADK] Model does not support web_search tool.${config.mode === 'v2' ? ' (V2: no Playwright fallback — empty result).' : ' Will fallback to traditional scraper.'}`
              );
            throw new Error(`Model does not support Google Search: ${event.errorMessage}`);
          }
        }
        
        // Check if this is a final response
        const adk = await import('@google/adk');
        const isFinal = adk.isFinalResponse ? adk.isFinalResponse(event) : (!event.partial && event.content);
          if (verbose) {
        console.log(`📦 [ADK] Is final response: ${isFinal}`);
          }
        
        // Extract articles from agent response
        if (event.content && event.content.parts) {
            if (verbose) {
          console.log(`📦 [ADK] Event has ${event.content.parts.length} parts`);
            }
          for (let i = 0; i < event.content.parts.length; i++) {
            const part = event.content.parts[i];
              if (verbose) {
            console.log(`📦 [ADK] Part ${i}: has text=${!!part.text}, has functionCall=${!!part.functionCall}, has functionResponse=${!!part.functionResponse}`);
              }
            
            // Log function calls to see if Google Search is being used
            if (part.functionCall) {
                toolCallCount++;
                if (verbose) {
              console.log(`🔧 [ADK] Agent called function: ${part.functionCall.name}`);
              if (part.functionCall.args) {
                console.log(`   Args: ${JSON.stringify(part.functionCall.args).substring(0, 200)}...`);
                  }
              }
            }
            if (part.functionResponse) {
                toolResponseCount++;
                if (verbose) {
              console.log(`📥 [ADK] Agent received function response: ${part.functionResponse.name}`);
              if (part.functionResponse.response) {
                console.log(`   Response preview: ${JSON.stringify(part.functionResponse.response).substring(0, 300)}...`);
                  }
              }
            }
            if (part.text) {
              fullResponse += part.text + '\n';
                if (verbose) {
              console.log(`📝 [ADK] Received text (${part.text.length} chars): ${part.text.substring(0, 200)}...`);
                }
              
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
                      if (verbose) {
                    console.log(`✅ [ADK] Found ${articles.length} articles in JSON response`);
                      }
                    break;
                  }
                }
              } catch (e) {
                // Not JSON, continue
                  if (verbose && e.message.includes('JSON')) {
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

      // If model output is unusable but grounding metadata has links, use them as a fallback.
      // This keeps V2 productive when ADK returns prose/empty JSON despite grounding.
      if (articles.length === 0 && groundingFallbackArticles.length > 0) {
        const dedup = new Map();
        for (const a of groundingFallbackArticles) {
          if (a.url && !dedup.has(a.url)) dedup.set(a.url, a);
        }
        articles = Array.from(dedup.values()).slice(0, maxItems);
        if (verbose) {
          console.log(
            `🛟 [ADK][V2][diag] Recovered ${articles.length} candidate article(s) from grounding metadata fallback`
          );
        }
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
            if (verbose) {
              console.log(`🧹 [ADK] Cleaned up session ${session.id} after attempt error`);
            }
          }
        } catch (cleanupErr) {
          console.warn(`⚠️ [ADK] Could not clean up session after attempt error: ${cleanupErr.message}`);
        }
        session = null;
        if (qi < maxAttempts - 1) {
          if (!verbose) {
            console.log(
              `[ADK] run_error attempt=${qi + 1}/${maxAttempts} ${(attemptError.message || 'unknown').substring(0, 160)}`
            );
          }
          continue;
        }
      }

      // If no articles found in structured format, try to extract from full response
      if (articles.length === 0 && fullResponse) {
        // Check if response is just empty markdown code blocks (e.g., just "```")
        const trimmedResponse = fullResponse.trim();
        if (trimmedResponse === '```' || trimmedResponse === '```json' || trimmedResponse.length < 10) {
          if (verbose) {
          console.log(`⚠️ [ADK] [ISSUE] Response is empty or minimal (${trimmedResponse.length} chars). Agent may not have completed the request.`);
            console.log(`⚠️ [ADK] [ISSUE] This could indicate: 1) Agent didn't use web_search tool, 2) Search returned no results, 3) Agent response was truncated`);
          }
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
                if (verbose) {
                console.log(`✅ [ADK] Found ${articles.length} articles in full response JSON`);
                }
              } else if (verbose) {
                console.log(`⚠️ [ADK] [ISSUE] Found JSON array but it's empty. Agent may not have found any articles.`);
              }
            } else if (verbose) {
              console.log(`⚠️ [ADK] [ISSUE] No JSON array found in response. Response might be text-only or agent didn't follow format.`);
              console.log(`⚠️ [ADK] [ISSUE] Full response preview: ${fullResponse.substring(0, 500)}...`);
            }
          } catch (e) {
            if (verbose) {
            console.log(`⚠️ [ADK] [ISSUE] Could not parse JSON from agent response: ${e.message}`);
            console.log(`⚠️ [ADK] [ISSUE] Response preview: ${fullResponse.substring(0, 500)}...`);
            }
          }
        }
      } else if (articles.length > 0) {
        if (verbose) {
        console.log(`✅ [ADK] Successfully extracted ${articles.length} articles from agent response`);
        }
      } else if (articles.length === 0 && !fullResponse) {
        if (verbose) {
        console.log(`⚠️ [ADK] [ISSUE] No articles found and no response text. Agent may have failed silently or not executed.`);
        }
      }

      if (verbose) {
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
            maxContentLength: 120000,
            maxBodyLength: 120000,
            headers: QUALITY_UA_HEADERS,
          });

          const afterRedirect = getAxiosFinalUrl(response, url);
          const htmlStr = typeof response.data === 'string' ? response.data : '';
          const best = pickPreferredArticleUrl(url, afterRedirect, htmlStr, source.url);

          if (best && best.startsWith('http') && best !== url) {
            return best;
          }
          if (afterRedirect && afterRedirect.startsWith('http') && afterRedirect !== url) {
            return afterRedirect;
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
      if (resolvedGroundingRedirects > 0 && verbose) {
        console.log(`🔗 [ADK] Resolved ${resolvedGroundingRedirects} grounding redirect URL(s) before filtering`);
      }
      
      // First, filter out articles with null/empty titles
      articles = articles.filter(article => {
        const title = article.title;
        if (!title || title === null || title === 'null' || title.trim() === '') {
          if (verbose) {
          console.log(`⚠️ [ADK] Filtering out article with null/empty title: ${article.url || article.link || 'unknown'}`);
          }
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
          outsideDateRange: 0,
          blocklist: 0,
          titleUrlMismatch: 0
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
            if (verbose) {
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out article with missing URL (title: ${article.title || 'unknown'})`);
            }
            return false;
          }
          
          // Filter out Google redirect URLs (grounding API redirects)
          if (articleUrl.includes('vertexaisearch.cloud.google.com') || 
              articleUrl.includes('grounding-api-redirect') ||
              articleUrl.includes('google.com/grounding')) {
            accuracyMetrics.filteredOut.googleRedirect++;
            if (verbose) {
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out Google redirect URL: ${articleUrl.substring(0, 80)}...`);
            }
            return false;
          }
          
          // Filter out null URLs or placeholder URLs
          if (articleUrl === 'null' || articleUrl === null || articleUrl.trim() === '') {
            accuracyMetrics.filteredOut.nullUrl++;
            if (verbose) {
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out null/empty URL (title: ${article.title || 'unknown'})`);
            }
            return false;
          }
          // Filter out literal placeholder paths (e.g. /post/placeholder)
          if (articleUrl.toLowerCase().includes('/placeholder')) {
            accuracyMetrics.filteredOut.genericUrl++;
            if (verbose) {
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out placeholder URL: ${articleUrl}`);
            }
            return false;
          }
          
          const articleUrlObj = new URL(articleUrl);
          const articleDomain = articleUrlObj.hostname.replace(/^www\./, '').toLowerCase();
          
          // Must match domain
          if (articleDomain !== sourceDomain) {
            accuracyMetrics.filteredOut.wrongDomain++;
            if (verbose) {
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out wrong domain: ${articleDomain} (expected: ${sourceDomain}) - Title: "${article.title?.substring(0, 50) || 'unknown'}" - URL: ${articleUrl.substring(0, 80)}...`);
            }
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
                `[ADK] medium_wrong_pub drop=${articleUrl.substring(0, 100)} need=${mediumPrefix} source=${source.name}`
              );
              return false;
            }
          }

          // Phase 4: Domain-specific blocklist (Cambrian news, Merit NATO, etc.)
          const blockCheck = domainBlocklist(articleUrl, source.name);
          if (blockCheck.blocked) {
            accuracyMetrics.filteredOut.blocklist = (accuracyMetrics.filteredOut.blocklist || 0) + 1;
            console.log(
              `[ADK] blocklist_drop reason=${blockCheck.reason} url=${articleUrl.substring(0, 100)} source=${source.name}`
            );
            return false;
          }
          
          // Filter out generic URLs (homepage, base blog URL without specific article path)
          const articlePath = articleUrlObj.pathname;
          // If URL is just the base blog URL or homepage, skip it
          if (articlePath === '/' || articlePath === basePath || articlePath === basePath + '/') {
            accuracyMetrics.filteredOut.genericUrl++;
            if (verbose) {
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out generic URL (homepage/base): ${articleUrl}`);
            }
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
            if (verbose) {
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out non-article page (${normalizedPath}): ${articleUrl}`);
            }
            return false;
          }
          // Filter out section/landing paths that are not single-article pages
          if (normalizedPath.includes('/eco-system') || normalizedPath.includes('/build/') ||
              normalizedPath.endsWith('/developers') || normalizedPath.includes('/blog/events')) {
            accuracyMetrics.filteredOut.genericUrl++;
            if (verbose) {
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out non-article path (${normalizedPath}): ${articleUrl}`);
            }
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
            if (verbose) {
            console.log(`⚠️ [ADK] [ACCURACY] Filtering out URL with insufficient path length (${pathAfterDomain.length} chars, need at least 11): ${articleUrl}`);
            }
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
          if (verbose) {
          console.log(`⚠️ [ADK] [ACCURACY] Filtering out invalid URL: ${article.url || article.link || 'unknown'} - ${e.message}`);
          }
          return false;
        }
      });

      // SIMPLIFIED MODE: Skip all post-processing, just return what Gemini gives us
      // Set ADK_SKIP_POST_PROCESSING=true to enable (for testing)
      const skipPostProcessing = process.env.ADK_SKIP_POST_PROCESSING === 'true';
      
      // Declare these outside so they're available regardless of skipPostProcessing
      let validatedArticles = [];
      let articlesAfterUrlFilter = filteredArticles;
      let dateFilteredArticles = [];
      
      if (skipPostProcessing) {
        console.log(`[ADK] SKIP_POST_PROCESSING=true — returning raw results without filtering`);
        // Just pass through what we got
        validatedArticles = filteredArticles;
        dateFilteredArticles = filteredArticles;
        lightweightArticles = filteredArticles.map(a => ({
          title: a.title || 'Untitled',
          link: a.url || a.link,
          url: a.url || a.link,
          description: a.description || a.snippet || '',
          content: a.description || a.snippet || '',
          datePublished: a.datePublished || null,
          sourceName: source.name,
          category: source.category || 'General',
        }));
      } else {
      // Date-range filter runs AFTER the quality pass so we can use HTML metadata (JSON-LD, og:, etc.)
      // instead of trusting ADK-only dates alone.
      articlesAfterUrlFilter = filteredArticles;

      // Final quality pass: verify URLs, repair title mismatches, and extract publish dates from HTML
      // (same response body as verification — no extra HTTP round trip).
      for (const article of articlesAfterUrlFilter) {
        const articleUrl = article.url || article.link;
        if (!articleUrl || typeof articleUrl !== 'string') continue;
        try {
          let resolvedForFetch = canonicalizeKnownBlogUrl(articleUrl);
          let { resp, finalUrl: fetchedAfter404Retry, used404Fallback } = await fetchArticleForQuality(resolvedForFetch);
          if (used404Fallback && resp.status !== 404 && concise) {
            console.log(
              `[ADK] quality_url_retry ok ${resolvedForFetch.substring(0, 90)}${resolvedForFetch.length > 90 ? '…' : ''} → ${fetchedAfter404Retry.substring(0, 90)}${fetchedAfter404Retry.length > 90 ? '…' : ''}`
            );
          }

          // Hard-drop dead links.
          if (resp.status === 404) {
            if (concise) {
              console.log(`[ADK] quality_404 ${articleUrl.substring(0, 120)}${articleUrl.length > 120 ? '…' : ''}`);
            } else {
              console.log(`⚠️ [ADK][QUALITY] Dropping 404 article URL: ${articleUrl}`);
            }
            continue;
          }

          // 403 is common for Medium anti-bot; keep if URL pattern is valid.
          if (resp.status >= 400 && resp.status !== 403 && resp.status !== 429) {
            if (concise) {
              console.log(`[ADK] quality_http${resp.status} ${articleUrl.substring(0, 100)}…`);
            } else {
              console.log(`⚠️ [ADK][QUALITY] Dropping non-OK article URL (${resp.status}): ${articleUrl}`);
            }
            continue;
          }

          let finalUrl = getAxiosFinalUrl(resp, fetchedAfter404Retry);
          const rawHtml = typeof resp.data === 'string' ? resp.data : '';
          const beforeCanonical = finalUrl;
          finalUrl = pickPreferredArticleUrl(resolvedForFetch, finalUrl, rawHtml, source.url);
          if (verbose && finalUrl !== beforeCanonical) {
            console.log(
              `🔗 [ADK][QUALITY] HTML canonical: ${escLogOneLine(beforeCanonical, 140)} → ${escLogOneLine(finalUrl, 140)}`
            );
          }

          const next = { ...article, url: finalUrl, link: finalUrl };
          const htmlTitle = normalizePageTitle(extractHtmlTitle(rawHtml), sourceDomain);
          if (htmlTitle && next.title) {
            const score = overlapScore(next.title, htmlTitle);
            // Title-URL agreement gate (relaxed for real Custom Search results)
            // - score < 0.05: extreme mismatch → DROP (completely wrong page)
            // - score < 0.20: mild mismatch → replace title with HTML title (trust URL)
            // Previously was 0.10/0.22 but that was too strict for real search results
            if (score < 0.05) {
              console.log(
                `[ADK] title_url_drop score=${score.toFixed(2)} model="${(next.title || '').substring(0, 50)}" page="${(htmlTitle || '').substring(0, 50)}" url=${finalUrl.substring(0, 80)}`
              );
              continue; // DROP this article
            }
            if (score < 0.20) {
              if (verbose) {
                console.log(
                  `⚠️ [ADK][QUALITY] Title mismatch (score=${score.toFixed(2)}), replacing model title with page title.`
                );
              }
              next.title = htmlTitle;
            }
          } else if (htmlTitle && !next.title) {
            next.title = htmlTitle;
          }

          if (rawHtml) {
            const iso = articleEnrichment.extractDateFromHtml(rawHtml);
            if (iso) {
              const d = new Date(iso);
              if (!isNaN(d.getTime())) {
                const ymd = d.toISOString().slice(0, 10);
                const prev = next.datePublished;
                next.datePublished = ymd;
                if (verbose) {
                  if (prev && String(prev).slice(0, 10) !== ymd) {
                    console.log(`📅 [ADK][DATE] HTML metadata: ${ymd} (ADK had "${prev}")`);
                  } else if (!prev) {
                    console.log(`📅 [ADK][DATE] Filled missing date from page metadata: ${ymd}`);
                  }
                }
              }
            }
          }

          validatedArticles.push(next);
        } catch (e) {
          // Keep article only for transient network issues on valid-looking URLs.
          // If we cannot verify due to timeout, we prefer recall over silent loss.
          if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
            if (verbose) {
              console.log(`⚠️ [ADK][QUALITY] URL verify timeout, keeping candidate: ${articleUrl}`);
            }
            validatedArticles.push(article);
          } else {
            if (verbose) {
              console.log(`⚠️ [ADK][QUALITY] URL verify error, dropping: ${articleUrl} (${e.message})`);
            }
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

      dateFilteredArticles = baseForDateFilter.filter((article) => {
        if (!article.datePublished) {
          if (verbose) {
            console.log(
              `⚠️ [ADK] [DATE] Article has no date after HTML enrichment, keeping: "${article.title?.substring(0, 50) || 'unknown'}"`
            );
          }
          return true;
        }
        try {
          const articleDate = new Date(article.datePublished);
          if (isNaN(articleDate.getTime())) {
            if (verbose) {
              console.log(
                `⚠️ [ADK] [DATE] Invalid date format "${article.datePublished}", keeping article: "${article.title?.substring(0, 50) || 'unknown'}"`
              );
            }
            return true;
          }
          // Add 7-day grace period to cutoff (dates can be slightly inaccurate)
          const gracePeriodMs = 7 * 24 * 60 * 60 * 1000;
          const relaxedCutoff = new Date(cutoffDate.getTime() - gracePeriodMs);
          if (articleDate < relaxedCutoff) {
            if (verbose) {
              console.log(
                `⚠️ [ADK] [DATE] Filtering out old article (${article.datePublished} < ${cutoffDateStr}): "${article.title?.substring(0, 50) || 'unknown'}"`
              );
            }
            accuracyMetrics.filteredOut.outsideDateRange = (accuracyMetrics.filteredOut.outsideDateRange || 0) + 1;
            return false;
          }
          return true;
        } catch (e) {
          if (verbose) {
          console.log(`⚠️ [ADK] [DATE] Error parsing date "${article.datePublished}": ${e.message}`);
          }
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

      const accuracyRate = accuracyMetrics.totalReturned > 0
        ? ((accuracyMetrics.validArticles / accuracyMetrics.totalReturned) * 100).toFixed(1)
        : 0;
      if (verbose) {
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
      console.log(`   Accuracy rate: ${accuracyRate}% (${accuracyMetrics.validArticles}/${accuracyMetrics.totalReturned} valid)\n`);
      } else if (config.mode !== 'v2' && verbose) {
        const fo = accuracyMetrics.filteredOut;
        console.log(
          `📊 [ADK] ${source.name}: raw=${accuracyMetrics.totalReturned} domain_ok=${accuracyMetrics.validArticles} rate=${accuracyRate}% | dropped: wrongDomain=${fo.wrongDomain} pub=${fo.wrongPublication || 0} google=${fo.googleRedirect} generic=${fo.genericUrl} short=${fo.shortPath} invalid=${fo.invalidUrl} oldDate=${fo.outsideDateRange || 0}`
        );
      }

      if (config.mode === 'v2' && verbose) {
        const fo = accuracyMetrics.filteredOut;
        console.log(
          `🔬 [ADK][V2][diag] attempt=${qi + 1}/${maxAttempts} rawJson=${articlesBeforeFilter} afterUrlFilters=${filteredArticles.length} afterQuality=${validatedArticles.length} afterDateFilter=${dateFilteredArticles.length} responseChars=${fullResponse.length} events=${eventCount} ` +
            `filteredWrongDomain=${fo.wrongDomain} wrongPublication=${fo.wrongPublication || 0} googleRedirect=${fo.googleRedirect} outsideDate=${fo.outsideDateRange || 0} shortPath=${fo.shortPath} genericUrl=${fo.genericUrl} ` +
            `toolCalls=${toolCallCount} toolResponses=${toolResponseCount} groundingEvents=${groundingEventCount} groundingChunks=${groundingChunkCount}`
        );
      }

      if (verbose) {
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
        if (canonicalUrl !== articleUrl && verbose) {
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
      } // END of else block for post-processing (when skipPostProcessing is false)

      const dateCoverage = lightweightArticles.length > 0
        ? ((lightweightArticles.filter(a => a.datePublished).length / lightweightArticles.length) * 100).toFixed(1)
        : 0;

      if (verbose) {
      console.log(`✅ [ADK] [${source.url}] Agent found ${lightweightArticles.length} articles`);
      }
      if (lightweightArticles.length > 0 && verbose) {
        lightweightArticles.forEach((article, i) => {
          console.log(`   ${i + 1}. "${article.title.substring(0, 50)}..." (date: ${article.datePublished || 'none'})`);
        });
      }
      
      if (verbose) {
      console.log(`📊 [ADK] [SUMMARY] ${source.name}: ${lightweightArticles.length} valid articles, ${dateCoverage}% have dates`);
      }

        lastRawCount = accuracyMetrics.totalReturned;
        lastValidCount = accuracyMetrics.validArticles;
        lastToolCalls = toolCallCount;
        lastToolResponses = toolResponseCount;
        lastGroundingEvents = groundingEventCount;

      // Phase 0/3: Track tool usage for smart retry decisions
      // Only explicit tool calls count for skip-retry (logs often show tools=0/0 ground=1 — grounding alone is not search)
      const attemptUsedSearch = toolCallCount > 0 || toolResponseCount > 0;
      if (!attemptUsedSearch) {
        consecutiveNoToolUse++;
      } else {
        consecutiveNoToolUse = 0;
      }

      conciseLastAttempt = {
        attempt: qi + 1,
        fullResponse,
        eventCount,
        toolCallCount,
        toolResponseCount,
        groundingEventCount,
        groundingChunkCount,
        rawParsed: articlesBeforeFilter,
        afterDomain: filteredArticles.length,
        afterQuality: validatedArticles.length,
        afterDate: dateFilteredArticles.length,
        finalOut: lightweightArticles.length,
        dateCoverage,
        usedSearch: attemptUsedSearch,
      };

      if (inspection) {
        inspection.attempts.push({
          attempt: qi + 1,
          prompt: searchQuery,
          fullResponse,
          eventCount,
          toolCallCount,
          toolResponseCount,
          groundingEventCount,
          groundingChunkCount,
          articlesBeforeFilter,
          afterDomain: filteredArticles.length,
          afterQuality: validatedArticles.length,
          afterDateFilter: dateFilteredArticles.length,
          finalOut: lightweightArticles.length,
          filteredOut: { ...accuracyMetrics.filteredOut },
        });
      }
      
      // MEMORY FIX: Delete the session after use to prevent memory accumulation
      // InMemoryRunner stores all sessions in memory, causing OOM crashes over time
      try {
        if (session && this.runner && this.runner.sessionService && this.runner.sessionService.deleteSession) {
          await this.runner.sessionService.deleteSession({
            appName: 'distroblog',
            userId: session.userId,
            sessionId: session.id
          });
          if (verbose) {
          console.log(`🧹 [ADK] Cleaned up session ${session.id}`);
          }
        }
      } catch (cleanupErr) {
        // Don't fail if cleanup fails, just log it
        console.warn(`⚠️ [ADK] Could not clean up session: ${cleanupErr.message}`);
      }
      
        if (lightweightArticles.length > 0) {
          break;
        }

        // Phase 3: Smart retry skip — if 2 consecutive attempts had no tool use,
        // retrying is likely pointless (quota/config issue, not bad luck).
        if (config.mode === 'v2' && consecutiveNoToolUse >= 2) {
          console.log(
            `[ADK] skip_retry reason=consecutive_no_tool_use count=${consecutiveNoToolUse} source=${JSON.stringify(source.name)} — likely systemic (quota/model config), not transient`
          );
          break;
        }

        if (config.mode === 'v2' && qi < maxAttempts - 1) {
          const base = 1500;
          const cap = 12000;
          const exp = Math.min(base * 2 ** qi + Math.floor(Math.random() * 1000), cap);
          if (concise) {
            console.log(`[ADK] backoff ${exp}ms before attempt ${qi + 2}/${maxAttempts}`);
          } else {
            console.log(`⏳ [ADK] Backing off ${exp}ms before attempt ${qi + 2}/${maxAttempts}`);
          }
          await new Promise((r) => setTimeout(r, exp));
        }
      } // end for qi (retry attempts)

      if (config.mode === 'v2' && verbose) {
        const ms = Date.now() - v2ObsStart;
        console.log(
          `📈 [ADK][V2] observability source=${source.name} domain=${new URL(source.url).hostname} ms=${ms} attempts=${maxAttempts} final=${lightweightArticles.length} rawReturned=${lastRawCount} validAfterDomainRules=${lastValidCount} toolCalls=${lastToolCalls} toolResponses=${lastToolResponses} groundingEvents=${lastGroundingEvents}`
        );
      }

      if (verbose && config.mode === 'v2' && conciseLastAttempt) {
        const s = conciseLastAttempt;
        const outcomeTag = lightweightArticles.length > 0 ? 'ok' : 'empty';
        console.log(
          `[ADK] outcome=${outcomeTag} attempts_used=${s.attempt} final_out=${lightweightArticles.length} raw_json=${s.rawParsed} response_chars=${(s.fullResponse || '').length}`
        );
      }

      if (concise && conciseLastAttempt) {
        const s = conciseLastAttempt;
        const preview = escLogOneLine(s.fullResponse, 400);
        console.log(
          `[ADK] done source=${JSON.stringify(source.name)} domain=${new URL(source.url).hostname} ` +
            `ms=${Date.now() - scrapeStartedAt} lastAttempt=${s.attempt}/${maxAttempts} ` +
            `final=${lightweightArticles.length} raw=${s.rawParsed} domainOk=${s.afterDomain} httpOk=${s.afterQuality} dateOk=${s.afterDate} out=${s.finalOut} ` +
            `dates=${s.dateCoverage}% tools=${lastToolCalls}/${lastToolResponses} ground=${lastGroundingEvents} ` +
            `ev=${s.eventCount} chars=${(s.fullResponse || '').length} preview=${JSON.stringify(preview)}`
        );
        const outcomeTag = lightweightArticles.length > 0 ? 'ok' : 'empty';
        console.log(
          `[ADK] outcome=${outcomeTag} attempts_used=${s.attempt} final_out=${s.finalOut} raw_json=${s.rawParsed} response_chars=${(s.fullResponse || '').length}`
        );
      }

      if (inspect) {
        inspection.finalArticles = lightweightArticles;
        inspection.msTotal = Date.now() - scrapeStartedAt;
        inspection.conciseSnapshot = conciseLastAttempt;
      }

      // If no valid articles found: V2 returns [] (ADK-only, no implicit fallback); V1 throws for scraper fallback
      if (lightweightArticles.length === 0) {
        if (config.mode === 'v2') {
          if (inspect) {
            return { articles: [], inspection };
          }
          return [];
        }
        if (inspect) {
          return { articles: [], inspection };
        }
        throw new Error(`ADK agent found 0 valid articles from ${source.url} (may need fallback to traditional scraper)`);
      }
      
      if (inspect) {
        return { articles: lightweightArticles, inspection };
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
        if (verbose) {
          console.log(
            `📈 [ADK][V2] observability source=${source.name} domain=${source.url ? new URL(source.url).hostname : '?'} ms=${ms} attempts=error final=0 rawReturned=0 validAfterDomainRules=0 error=${(error.message || 'unknown').substring(0, 120)}`
          );
        } else {
          console.log(
            `[ADK] error source=${JSON.stringify(source.name)} ms=${ms} ${(error.message || 'unknown').substring(0, 200)}`
          );
        }
        if (inspect) {
          return {
            articles: [],
            inspection: {
              ...(inspection || { source: { name: source.name, url: source.url } }),
              error: error.message,
              msTotal: ms,
            },
          };
        }
        return [];
      }

      if (inspect) {
        return {
          articles: [],
          inspection: {
            ...(inspection || { source: { name: source.name, url: source.url } }),
            error: error.message,
          },
        };
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
module.exports.extractCanonicalUrlFromHtml = extractCanonicalUrlFromHtml;
module.exports.pickPreferredArticleUrl = pickPreferredArticleUrl;
module.exports.getAxiosFinalUrl = getAxiosFinalUrl;
/** For scripts/eval-url-canonical-effectiveness.js — mirrors ADK quality pass HTTP behavior. */
module.exports.fetchArticleForQuality = fetchArticleForQuality;
module.exports.canonicalizeKnownBlogUrl = canonicalizeKnownBlogUrl;
