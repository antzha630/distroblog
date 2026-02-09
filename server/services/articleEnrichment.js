/**
 * Article Enrichment Service
 * 
 * Background service that enriches articles with missing dates and descriptions
 * by fetching the article page and extracting metadata.
 * 
 * This runs periodically to fill in missing data that wasn't captured during
 * the initial scraping process (e.g., when dates are only visible on article pages,
 * not listing pages).
 */

const axios = require('axios');
const cheerio = require('cheerio');
const database = require('../database-postgres');

class ArticleEnrichmentService {
  constructor() {
    this.isRunning = false;
    this.enrichmentInterval = null;
    this.lastRunTime = null;
    this.stats = {
      articlesProcessed: 0,
      datesEnriched: 0,
      descriptionsEnriched: 0,
      errors: 0
    };
  }

  /**
   * Parse date from various formats
   */
  parseDate(text) {
    if (!text) return null;
    
    const patterns = [
      // Full month name: November 12, 2025 or Nov 12, 2025
      /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i,
      // 12 November 2025
      /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/i,
      // YYYY-MM-DD or YYYY/MM/DD
      /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/,
      // MM/DD/YYYY or DD/MM/YYYY
      /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/,
      // DD-MMM-YY format (e.g., "06-Nov-25", "03-Nov-25")
      /\b(\d{1,2})[-/](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/](\d{2,4})\b/i,
      // ISO 8601 with time: 2025-12-15T10:00:00Z
      /\b(\d{4})[-/](\d{2})[-/](\d{2})T\d{2}:\d{2}:\d{2}/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          let dateStr = match[0];
          
          // Handle DD-MMM-YY format
          if (match[2] && /[A-Za-z]{3}/.test(match[2])) {
            const day = match[1];
            const month = match[2];
            const year = match[3].length === 2 ? `20${match[3]}` : match[3];
            dateStr = `${day}-${month}-${year}`;
          }
          
          const dt = new Date(dateStr);
          if (!isNaN(dt.getTime())) {
            const now = new Date();
            const yearDiff = dt.getFullYear() - now.getFullYear();
            if (yearDiff >= -10 && yearDiff <= 5) {
              return dt.toISOString();
            }
          }
        } catch (e) {
          // Continue to next pattern
        }
      }
    }
    
    // Fallback: Try Date.parse
    try {
      const dt = new Date(text);
      if (!isNaN(dt.getTime())) {
        const now = new Date();
        const yearDiff = dt.getFullYear() - now.getFullYear();
        if (yearDiff >= -10 && yearDiff <= 5) {
          return dt.toISOString();
        }
      }
    } catch (e) {
      // Ignore
    }
    
    return null;
  }

  /**
   * Extract date from article page
   */
  async extractDateFromPage(url) {
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DistroEnrichment/1.0)',
        },
        maxContentLength: 2 * 1024 * 1024,
      });

      const html = response.data;
      const $ = cheerio.load(html);

      // Try structured selectors first (most reliable)
      const dateSelectors = [
        'meta[property="article:published_time"]',
        'meta[name="article:published_time"]',
        'meta[property="og:article:published_time"]',
        'meta[property="article:published"]',
        'meta[name="publishdate"]',
        'meta[name="pubdate"]',
        'meta[name="date"]',
        'meta[name="DC.date"]',
        'meta[property="published_time"]',
        'time[datetime]',
        'time[pubdate]',
        'time',
        '[datetime]',
        '[data-date]',
        '[data-published]',
        '[class*="date"]',
        '[class*="published"]',
        '[class*="publish"]',
        '[class*="pub-date"]',
        '[class*="post-date"]',
      ];

      for (const selector of dateSelectors) {
        const el = $(selector).first();
        if (el && el.length) {
          const val = el.attr('content') ||
                      el.attr('datetime') ||
                      el.attr('date') ||
                      el.attr('data-date') ||
                      el.attr('data-published') ||
                      el.text();
          if (val) {
            const parsed = this.parseDate(val);
            if (parsed) {
              return parsed;
            }
          }
        }
      }

      // Try JSON-LD
      try {
        $('script[type="application/ld+json"]').each((_, script) => {
          const jsonText = $(script).html();
          if (!jsonText) return;
          try {
            const data = JSON.parse(jsonText);
            const pick = (obj) => {
              if (!obj) return null;
              return this.parseDate(obj.datePublished || obj.dateCreated || obj.dateModified);
            };
            let cand = pick(data);
            if (!cand && Array.isArray(data)) {
              for (const item of data) {
                cand = pick(item);
                if (cand) break;
              }
            }
            if (cand) {
              throw new Error(`DATE_FOUND:${cand}`);
            }
          } catch (e) {
            if (e.message?.startsWith('DATE_FOUND:')) throw e;
          }
        });
      } catch (e) {
        if (e.message?.startsWith('DATE_FOUND:')) {
          return e.message.replace('DATE_FOUND:', '');
        }
      }

      // Try article header area
      const articleSelectors = ['article header', '[class*="article-header"]', '[class*="post-header"]', 'main header'];
      for (const selector of articleSelectors) {
        const header = $(selector).first();
        if (header && header.length) {
          const parsed = this.parseDate(header.text());
          if (parsed) return parsed;
        }
      }

      // Scan first 3000 chars of body text
      const bodyText = $('article, [role="article"], main').first().text() || $('body').text();
      return this.parseDate(bodyText.substring(0, 3000));

    } catch (error) {
      if (error.response?.status !== 404) {
        console.log(`⚠️ [ENRICH] Date extraction failed for ${url.substring(0, 60)}...: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Extract description from article page
   */
  async extractDescriptionFromPage(url) {
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DistroEnrichment/1.0)',
        },
        maxContentLength: 2 * 1024 * 1024,
      });

      const html = response.data;
      const $ = cheerio.load(html);

      // Try meta description first (most reliable)
      const metaSelectors = [
        'meta[name="description"]',
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
        'meta[property="article:description"]',
      ];

      for (const selector of metaSelectors) {
        const el = $(selector).first();
        if (el && el.length) {
          const content = el.attr('content');
          if (content && content.length > 50) {
            return content.substring(0, 500);
          }
        }
      }

      // Try JSON-LD description
      try {
        $('script[type="application/ld+json"]').each((_, script) => {
          const jsonText = $(script).html();
          if (!jsonText) return;
          try {
            const data = JSON.parse(jsonText);
            const getDesc = (obj) => obj?.description || obj?.articleBody?.substring(0, 500);
            let desc = getDesc(data);
            if (!desc && Array.isArray(data)) {
              for (const item of data) {
                desc = getDesc(item);
                if (desc) break;
              }
            }
            if (desc && desc.length > 50) {
              throw new Error(`DESC_FOUND:${desc.substring(0, 500)}`);
            }
          } catch (e) {
            if (e.message?.startsWith('DESC_FOUND:')) throw e;
          }
        });
      } catch (e) {
        if (e.message?.startsWith('DESC_FOUND:')) {
          return e.message.replace('DESC_FOUND:', '');
        }
      }

      // Try first paragraph in article content
      const articleContent = $('article, [role="article"], main, [class*="article-content"], [class*="post-content"]').first();
      if (articleContent.length) {
        const firstParagraph = articleContent.find('p').first().text();
        if (firstParagraph && firstParagraph.length > 50) {
          return firstParagraph.substring(0, 500);
        }
      }

      return null;

    } catch (error) {
      if (error.response?.status !== 404) {
        console.log(`⚠️ [ENRICH] Description extraction failed for ${url.substring(0, 60)}...: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Enrich a single article with missing data
   */
  async enrichArticle(article) {
    let enrichedDate = null;
    let enrichedDescription = null;

    // Extract date if missing
    if (!article.pub_date) {
      enrichedDate = await this.extractDateFromPage(article.link);
      if (enrichedDate) {
        this.stats.datesEnriched++;
        console.log(`📅 [ENRICH] Found date for "${article.title.substring(0, 40)}...": ${enrichedDate}`);
      }
    }

    // Extract description if missing
    if (article.needs_description || 
        (!article.content || article.content.length < 50) && 
        (!article.preview || article.preview.length < 50)) {
      enrichedDescription = await this.extractDescriptionFromPage(article.link);
      if (enrichedDescription) {
        this.stats.descriptionsEnriched++;
        console.log(`📝 [ENRICH] Found description for "${article.title.substring(0, 40)}...": ${enrichedDescription.substring(0, 60)}...`);
      }
    }

    // Update database if we found anything
    if (enrichedDate || enrichedDescription) {
      try {
        await database.enrichArticle(article.id, {
          pubDate: enrichedDate,
          content: enrichedDescription,
          preview: enrichedDescription ? enrichedDescription.substring(0, 200) : null,
          publisherDescription: enrichedDescription
        });
        return true;
      } catch (dbError) {
        console.error(`❌ [ENRICH] Database update failed for article ${article.id}: ${dbError.message}`);
        this.stats.errors++;
        return false;
      }
    }

    return false;
  }

  /**
   * Run enrichment for a batch of articles
   */
  async runEnrichmentBatch(limit = 20) {
    if (this.isRunning) {
      console.log('⏸️ [ENRICH] Enrichment already running, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    console.log(`\n🔄 [ENRICH] Starting article enrichment batch (limit: ${limit})...`);

    try {
      const articles = await database.getArticlesNeedingEnrichment(limit);
      
      if (articles.length === 0) {
        console.log('✅ [ENRICH] No articles need enrichment');
        return { processed: 0, enriched: 0 };
      }

      console.log(`📊 [ENRICH] Found ${articles.length} articles needing enrichment`);

      let enrichedCount = 0;

      // Process articles sequentially with small delay to avoid rate limiting
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        this.stats.articlesProcessed++;

        try {
          const wasEnriched = await this.enrichArticle(article);
          if (wasEnriched) enrichedCount++;
        } catch (error) {
          console.error(`❌ [ENRICH] Error processing article ${article.id}: ${error.message}`);
          this.stats.errors++;
        }

        // Small delay between articles to avoid rate limiting
        if (i < articles.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const duration = Date.now() - startTime;
      console.log(`✅ [ENRICH] Batch complete: ${enrichedCount}/${articles.length} articles enriched in ${duration}ms`);
      console.log(`📊 [ENRICH] Stats: dates=${this.stats.datesEnriched}, descriptions=${this.stats.descriptionsEnriched}, errors=${this.stats.errors}`);

      this.lastRunTime = new Date();
      return { processed: articles.length, enriched: enrichedCount };

    } catch (error) {
      console.error('❌ [ENRICH] Enrichment batch failed:', error.message);
      this.stats.errors++;
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start periodic enrichment
   */
  startPeriodicEnrichment(intervalMinutes = 30) {
    if (this.enrichmentInterval) {
      console.log('⚠️ [ENRICH] Periodic enrichment already running');
      return;
    }

    console.log(`🚀 [ENRICH] Starting periodic enrichment every ${intervalMinutes} minutes`);
    
    // Run immediately
    this.runEnrichmentBatch(20).catch(err => {
      console.error('❌ [ENRICH] Initial enrichment failed:', err.message);
    });

    // Then run periodically
    this.enrichmentInterval = setInterval(() => {
      this.runEnrichmentBatch(20).catch(err => {
        console.error('❌ [ENRICH] Periodic enrichment failed:', err.message);
      });
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Stop periodic enrichment
   */
  stopPeriodicEnrichment() {
    if (this.enrichmentInterval) {
      clearInterval(this.enrichmentInterval);
      this.enrichmentInterval = null;
      console.log('🛑 [ENRICH] Stopped periodic enrichment');
    }
  }

  /**
   * Get current stats
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime
    };
  }

  /**
   * Reset stats
   */
  resetStats() {
    this.stats = {
      articlesProcessed: 0,
      datesEnriched: 0,
      descriptionsEnriched: 0,
      errors: 0
    };
  }

  /**
   * Get current memory usage in MB
   */
  getMemoryMB() {
    if (process.memoryUsage) {
      return Math.round(process.memoryUsage().rss / 1024 / 1024);
    }
    return 0;
  }

  /**
   * Memory-safe Playwright enrichment for a single article
   * Only runs if memory is below threshold
   */
  async enrichWithPlaywright(article) {
    const MEMORY_LIMIT = 280; // Leave plenty of buffer for Render's 512MB limit
    const currentMem = this.getMemoryMB();
    
    if (currentMem > MEMORY_LIMIT) {
      console.log(`⚠️  [ENRICH-PW] Memory too high (${currentMem}MB > ${MEMORY_LIMIT}MB), skipping Playwright`);
      return { success: false, reason: 'memory_limit' };
    }

    let browser = null;
    let page = null;
    let enrichedDate = null;
    let enrichedDescription = null;

    try {
      const { chromium } = require('playwright');

      console.log(`🔄 [ENRICH-PW] Starting Playwright enrichment for: ${article.title.substring(0, 50)}...`);
      console.log(`📊 [ENRICH-PW] Memory before: ${currentMem}MB`);

      // Launch with minimal memory footprint
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process',
          '--no-zygote',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-translate',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--js-flags=--max-old-space-size=128'
        ]
      });

      page = await browser.newPage();
      page.setDefaultTimeout(20000);
      page.setDefaultNavigationTimeout(20000);

      // Block unnecessary resources to save memory
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      await page.goto(article.link, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for JS to render content
      await page.waitForTimeout(3000);

      // Extract date and description from rendered page
      const result = await page.evaluate(() => {
        const parseDate = (text) => {
          if (!text) return null;
          
          // Normalize text - insert spaces before month names that follow letters/words
          // This handles cases like "PublishedFebruary" or "onFebruary" 
          let normalizedText = text.replace(/(Published|on|Updated)\s*(?=(January|February|March|April|May|June|July|August|September|October|November|December))/gi, '$1 ');
          
          // Handle relative dates like "1 day ago", "3 days ago"
          const relativeMatch = normalizedText.match(/(\d+)\s*(day|days|hour|hours|week|weeks)\s*ago/i);
          if (relativeMatch) {
            const amount = parseInt(relativeMatch[1]);
            const unit = relativeMatch[2].toLowerCase();
            const now = new Date();
            if (unit.startsWith('day')) {
              now.setDate(now.getDate() - amount);
            } else if (unit.startsWith('hour')) {
              now.setHours(now.getHours() - amount);
            } else if (unit.startsWith('week')) {
              now.setDate(now.getDate() - (amount * 7));
            }
            return now.toISOString();
          }
          
          const patterns = [
            // Standard month formats - with flexible spacing
            /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2}),?\s*(\d{4})/i,
            /(\d{1,2})\s*(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{4})/i,
            // ISO formats
            /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/,
            /(\d{1,2})[-/](\d{1,2})[-/](\d{4})/,
            /(\d{4})[-/](\d{2})[-/](\d{2})T\d{2}:\d{2}:\d{2}/,
          ];
          for (const pattern of patterns) {
            const match = normalizedText.match(pattern);
            if (match) {
              try {
                let dateStr = match[0];
                const dt = new Date(dateStr);
                if (!isNaN(dt.getTime())) {
                  const now = new Date();
                  const yearDiff = dt.getFullYear() - now.getFullYear();
                  if (yearDiff >= -10 && yearDiff <= 5) {
                    return dt.toISOString();
                  }
                }
              } catch (e) {}
            }
          }
          return null;
        };

        let foundDate = null;
        let foundDescription = null;

        // === DATE EXTRACTION ===
        
        // Try meta tags first
        const dateMetaSelectors = [
          'meta[property="article:published_time"]',
          'meta[name="article:published_time"]',
          'meta[property="og:article:published_time"]',
          'meta[name="publishdate"]',
          'meta[name="pubdate"]',
          'meta[name="date"]',
        ];
        for (const sel of dateMetaSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            const content = el.getAttribute('content');
            if (content) {
              const parsed = parseDate(content);
              if (parsed) {
                foundDate = parsed;
                break;
              }
            }
          }
        }

        // Try time elements
        if (!foundDate) {
          const timeEl = document.querySelector('time[datetime]');
          if (timeEl) {
            const dt = timeEl.getAttribute('datetime');
            if (dt) foundDate = parseDate(dt);
          }
        }

        // Try JSON-LD
        if (!foundDate) {
          const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const script of jsonLdScripts) {
            try {
              const data = JSON.parse(script.textContent);
              const checkObj = (obj) => {
                if (obj?.datePublished) return parseDate(obj.datePublished);
                if (obj?.dateCreated) return parseDate(obj.dateCreated);
                return null;
              };
              let found = checkObj(data);
              if (!found && Array.isArray(data)) {
                for (const item of data) {
                  found = checkObj(item);
                  if (found) break;
                }
              }
              if (found) {
                foundDate = found;
                break;
              }
            } catch (e) {}
          }
        }

        // Try visible text with "Published" prefix or date patterns
        if (!foundDate) {
          const datePatternSelectors = [
            '[class*="published"]',
            '[class*="date"]',
            '[class*="time"]',
            '[class*="meta"]',
            'article header',
            '.post-meta',
            '.article-meta',
          ];
          for (const sel of datePatternSelectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const text = el.textContent?.trim();
              if (text && text.length < 200) {
                const parsed = parseDate(text);
                if (parsed) {
                  foundDate = parsed;
                  break;
                }
              }
            }
            if (foundDate) break;
          }
        }

        // Last resort: scan body text for date patterns
        // Scan more text since dates can appear after navigation/header content
        if (!foundDate) {
          const bodyText = document.body?.textContent || '';
          // Scan up to 15000 chars to find dates that appear after nav content
          foundDate = parseDate(bodyText.substring(0, 15000));
          
          // If still not found, try searching specifically for "Published" context
          if (!foundDate) {
            const pubIndex = bodyText.indexOf('Published');
            if (pubIndex > -1) {
              const context = bodyText.substring(pubIndex, pubIndex + 100);
              foundDate = parseDate(context);
            }
          }
        }

        // === DESCRIPTION EXTRACTION ===
        
        // Try meta description
        const descMetaSelectors = [
          'meta[name="description"]',
          'meta[property="og:description"]',
          'meta[name="twitter:description"]',
        ];
        for (const sel of descMetaSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            const content = el.getAttribute('content');
            if (content && content.length > 50) {
              foundDescription = content.substring(0, 500);
              break;
            }
          }
        }

        // Try JSON-LD description
        if (!foundDescription) {
          const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const script of jsonLdScripts) {
            try {
              const data = JSON.parse(script.textContent);
              const getDesc = (obj) => obj?.description || obj?.articleBody?.substring(0, 500);
              let desc = getDesc(data);
              if (!desc && Array.isArray(data)) {
                for (const item of data) {
                  desc = getDesc(item);
                  if (desc) break;
                }
              }
              if (desc && desc.length > 50) {
                foundDescription = desc.substring(0, 500);
                break;
              }
            } catch (e) {}
          }
        }

        // Try first meaningful paragraph (skip cookie consent, etc.)
        if (!foundDescription) {
          const articleEl = document.querySelector('article, [role="article"], main, [class*="article-content"], [class*="post-content"]');
          if (articleEl) {
            const paragraphs = articleEl.querySelectorAll('p');
            for (const p of paragraphs) {
              const text = p.textContent?.trim();
              // Skip short text, cookie consent, navigation text
              if (text && text.length > 50 && 
                  !text.toLowerCase().includes('cookie') &&
                  !text.toLowerCase().includes('privacy policy') &&
                  !text.toLowerCase().includes('consent') &&
                  !text.toLowerCase().includes('sign up') &&
                  !text.toLowerCase().includes('subscribe')) {
                foundDescription = text.substring(0, 500);
                break;
              }
            }
          }
        }

        return { date: foundDate, description: foundDescription };
      });

      enrichedDate = result.date;
      enrichedDescription = result.description;

      // Clean up Playwright resources
      await page.close();
      page = null;
      await browser.close();
      browser = null;

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const memAfter = this.getMemoryMB();
      console.log(`📊 [ENRICH-PW] Memory after cleanup: ${memAfter}MB`);

      // Update database if we found anything
      if (enrichedDate || enrichedDescription) {
        const needsDate = !article.pub_date;
        const needsDesc = !article.content || article.content.length < 50;

        // Only update if we found what was needed
        const updateDate = needsDate && enrichedDate ? enrichedDate : null;
        const updateDesc = needsDesc && enrichedDescription ? enrichedDescription : null;

        if (updateDate || updateDesc) {
          await database.enrichArticle(article.id, {
            pubDate: updateDate,
            content: updateDesc,
            preview: updateDesc ? updateDesc.substring(0, 200) : null,
            publisherDescription: updateDesc
          });

          if (updateDate) {
            this.stats.datesEnriched++;
            console.log(`📅 [ENRICH-PW] Found date: ${updateDate}`);
          }
          if (updateDesc) {
            this.stats.descriptionsEnriched++;
            console.log(`📝 [ENRICH-PW] Found description: ${updateDesc.substring(0, 60)}...`);
          }

          return { success: true, date: updateDate, description: updateDesc };
        }
      }

      console.log(`⚠️  [ENRICH-PW] No new data found for article`);
      return { success: false, reason: 'no_data_found' };

    } catch (error) {
      console.error(`❌ [ENRICH-PW] Error: ${error.message}`);
      this.stats.errors++;
      return { success: false, reason: error.message };
    } finally {
      // Ensure cleanup happens even on error
      try {
        if (page) await page.close();
        if (browser) await browser.close();
      } catch (e) {
        // Ignore cleanup errors
      }
      // Force garbage collection
      if (global.gc) {
        global.gc();
      }
    }
  }

  /**
   * Run Playwright enrichment on articles that static enrichment couldn't handle
   * Processes one article at a time with memory checks between each
   */
  async runPlaywrightEnrichmentBatch(limit = 5) {
    if (this.isRunning) {
      console.log('⏸️ [ENRICH-PW] Enrichment already running, skipping...');
      return { processed: 0, enriched: 0 };
    }

    this.isRunning = true;
    const startTime = Date.now();
    console.log(`\n🔄 [ENRICH-PW] Starting Playwright enrichment batch (limit: ${limit})...`);
    console.log(`📊 [ENRICH-PW] Initial memory: ${this.getMemoryMB()}MB`);

    try {
      const articles = await database.getArticlesNeedingEnrichment(limit);

      if (articles.length === 0) {
        console.log('✅ [ENRICH-PW] No articles need enrichment');
        return { processed: 0, enriched: 0 };
      }

      console.log(`📊 [ENRICH-PW] Found ${articles.length} articles to process`);

      let enrichedCount = 0;
      let processedCount = 0;

      for (const article of articles) {
        // Check memory before each article
        const currentMem = this.getMemoryMB();
        if (currentMem > 350) {
          console.log(`⚠️  [ENRICH-PW] Memory too high (${currentMem}MB), stopping batch early`);
          break;
        }

        this.stats.articlesProcessed++;
        processedCount++;

        const result = await this.enrichWithPlaywright(article);
        if (result.success) {
          enrichedCount++;
        }

        // Wait between articles to let memory settle
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const duration = Date.now() - startTime;
      console.log(`✅ [ENRICH-PW] Batch complete: ${enrichedCount}/${processedCount} articles enriched in ${duration}ms`);
      console.log(`📊 [ENRICH-PW] Final memory: ${this.getMemoryMB()}MB`);

      this.lastRunTime = new Date();
      return { processed: processedCount, enriched: enrichedCount };

    } catch (error) {
      console.error('❌ [ENRICH-PW] Batch failed:', error.message);
      this.stats.errors++;
      throw error;
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = new ArticleEnrichmentService();
