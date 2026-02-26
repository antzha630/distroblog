# Check Now: Log Analysis, What’s Working, and ADK vs Playwright

## 1. What the logs show (this run)

- **Vana:** ADK returned 0 → Playwright fallback ran (one-time allowance), found 5 articles, **4 new** added. Playwright is working for Vana.
- **Virtuals Protocol:** RSS, 19 new articles, no issues.
- **Summary:** 37/39 sources successful, **175 new articles**, ~786s total. No OpenAI/429 errors (hooks are content-only now).
- **Consecutive Playwright: 2/2** – We’re at the limit; the next source that needs Playwright after an ADK 0 would be skipped (except for the single “one-time” allowance we use for one source like Vana).

## 2. Issues / inconsistencies

| Issue | What’s going on |
|-------|------------------|
| **2/39 “not successful”** | Two sources didn’t return new articles or errored (we’d need full logs to see which; often ADK 0 + Playwright skipped due to cooldown). |
| **Vana: 0 with_dates in by_source** | DB shows Vana with 0 dates. The 4 new articles from this run *did* get dates in the log (e.g. 2025-09-22). If they’re still null in DB, the insert path for Playwright-sourced articles may not be persisting `pub_date` in all code paths – worth a quick check. |
| **Only 6 articles “last 7 days”** | Filter uses `pub_date`; 126 articles have no `pub_date`, so they’re excluded. More dates (from RSS or better extraction) = more “last 7 days” hits. |
| **Lumerin noise** | SCRAPING + Medium: lots of off-topic posts (different authors on same publication). Not a bug, but quality/filtering might help later. |
| **“FeaturedArticles…” date** | First Vana item has date like `BYVana Team|December 15, 2025`. That’s author\|date; our parser may not normalize it to ISO, so it might not end up in `pub_date`. |

## 3. What’s actually “hitting” vs not

- **RSS:** Hitting well. Fast, has dates, no browser, no ADK. Virtuals, GAIB, Numerai, Render, etc. are solid.
- **Playwright (traditional scraper):** Hitting when we use it. Vana got 4 new articles this run via Playwright. We throttle it (memory cooldown, consecutive limit) so we don’t use it for every SCRAPING source every time.
- **ADK:** Often returning **0** for SCRAPING sources (e.g. Vana). When it does, we depend on Playwright fallback; if we’re in cooldown, we skip and get no articles for that source.

So: **RSS and Playwright are what’s giving you hits. ADK is often not.**

## 4. “Google” vs ADK vs Playwright (clarification)

- **ADK is the “Google” path.**  
  ADK uses **Google Search** (Gemini + ADK’s Google Search tool). So when we say “ADK,” we mean: ask a Gemini agent to use Google Search to find articles from a domain. No direct scraping, no Playwright.
- **Playwright** is our own headless browser: we load the site and parse the DOM (e.g. blog listing).
- **Static/Cheerio** is HTTP fetch + HTML parse, no browser, no Google.

So the real choice is:

- **Option A – ADK (Google Search agent)**  
  - Pros: No browser, works for some sites without touching HTML, uses Google’s index.  
  - Cons: Often returns 0 for blog listing pages (e.g. vana.org/post), rate limits (e.g. 10 RPM), and when it fails we *still* need Playwright to get hits. So we pay ADK cost and then often rely on Playwright anyway.

- **Option B – Playwright (our browser)**  
  - Pros: When we run it, it gets articles (e.g. Vana 5 articles). Direct control, no search API limits.  
  - Cons: Memory-heavy; we intentionally limit how often we use it (cooldown, consecutive cap) to avoid OOM, so we can’t “Playwright everything” on a big run.

- **Option C – Static/Cheerio only**  
  - Pros: Light, fast, no browser, no Google.  
  - Cons: Fails on JS-rendered listing pages (many modern blogs), so we’d miss a lot of sources.

## 5. Recommendation for “more hits, more robust, dates working”

Your CEO’s priority: **more scoops (hits), more sources, robustness, dates** – not luxury UX like hooks.

- **RSS first everywhere possible**  
  When we can discover/store an RSS feed, use it. No ADK, no Playwright, best dates and reliability. Keep improving RSS discovery (e.g. feedDiscovery, sitemaps → feed hints) so more sources become RSS.

- **For SCRAPING sources: prefer Playwright-first (or static-first, then Playwright), not ADK-first**  
  Right now we do ADK → if 0 → Playwright. That means we often burn ADK (and rate limit) and then depend on Playwright anyway. For “more hits” and “more robust”:
  - **Option 1 (recommended):** For sources that have a known blog URL (e.g. vana.org/post), **skip ADK and call Playwright (or static then Playwright) directly.** That gives you the same or better hits without ADK’s 0s and limits. We’d need to relax or re-tune memory limits (or run fewer sources per process / more batching) so we can run Playwright on more sources without OOM.
  - **Option 2:** Keep ADK as an optional path only for specific sources where it’s been shown to work; for the rest, go straight to Playwright (or static → Playwright).
  - **Option 3:** Stay ADK-first but invest in making ADK actually return articles for more sites (prompts, tool use, parsing). That’s higher effort and still leaves you with rate limits and fallback dependency.

- **Dates**  
  - Ensure every path that adds articles (RSS, Playwright, static) **persists `pub_date`** when we have it (including Playwright-extracted and weird formats like “BYVana Team|December 15, 2025” → normalize to ISO where possible).  
  - Keep auto-enrichment for missing dates, but treat it as best-effort; the main gain is from capturing dates at fetch time.

- **Summary**  
  **What’s hitting:** RSS and Playwright. **What’s not:** ADK often 0. So for more hits and robustness: **RSS where we can; for the rest, Playwright-first (or static then Playwright) and only use ADK where it’s proven to add value.** That aligns with “load up more sources and get more scoops” without depending on the current ADK behavior.
