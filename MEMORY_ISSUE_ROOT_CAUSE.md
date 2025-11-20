# Memory Issue Root Cause Analysis

## Key Finding
The **old single-button workflow** (commit 9254b85) works fine without memory issues, but the **new multi-step workflow** causes memory crashes. This confirms the memory issue was introduced by the workflow changes.

## What Changed

### Old Version (Working - commit 9254b85)
**Single `/api/sources` endpoint does everything:**
1. Validates RSS feed
2. If no feed found → **Test scrape** (line 175): `webScraper.scrapeArticles({ url, name, category })` - **WITHOUT source.id**
3. If test succeeds → Add source to database
4. Then **Actual scrape** (line 208): `webScraper.scrapeArticles({ id: sourceId, url, name, category })` - **WITH source.id**
5. Add articles to database

**Key characteristics:**
- ✅ Everything happens in **ONE request**
- ✅ Browser instance created once, used twice sequentially
- ✅ Request completes, browser can be cleaned up
- ✅ No memory accumulation between steps

### New Version (Broken - multi-step workflow)
**Split into two endpoints:**

1. **`/api/sources/check-feed`** (step 1):
   - Checks for RSS feed
   - Does NOT scrape
   - Returns `{ hasFeed: true/false }`

2. **`/api/sources/setup-scraping`** (step 2):
   - Adds source to database FIRST
   - Then scrapes: `webScraper.scrapeArticles({ id: sourceId, url, name, category })`
   - If scraping fails, removes source from database

**Key characteristics:**
- ❌ Split into **TWO separate HTTP requests**
- ❌ Browser instance might be created/kept alive between requests
- ❌ Memory state persists between the two API calls
- ❌ Potential for browser instance to accumulate memory

## Why This Causes Memory Issues

### Hypothesis 1: Browser Instance Persistence
- In the old version, browser is created → used → request ends → can be garbage collected
- In the new version, browser might be created during `check-feed` (even though it shouldn't be), then kept alive until `setup-scraping` runs
- The time gap between the two requests allows memory to accumulate

### Hypothesis 2: Multiple WebScraper Instances
- The old version uses a single `webScraper` instance for the entire request
- The new version might be creating multiple `WebScraper` instances across the two requests
- Each instance would have its own browser, causing memory duplication

### Hypothesis 3: Feed Discovery Memory Leak
- The `check-feed` endpoint calls `feedDiscovery.discoverFeedUrl(url)`
- This might create browser instances or keep memory that isn't released
- Then `setup-scraping` adds more memory on top

## Solution Options

### Option 1: Keep Old Single-Button Workflow (Current State)
**Status:** ✅ Currently deployed and working
- No memory issues
- Simpler code
- Less user-friendly (CEO's concern)

### Option 2: Fix Multi-Step Workflow
**Changes needed:**
1. Ensure browser instance is properly closed after each scrape
2. Don't create browser during `check-feed` (it shouldn't need Playwright)
3. Add explicit memory cleanup between steps
4. Consider reusing the same `webScraper` instance across requests (it's already a singleton, but verify)

### Option 3: Hybrid Approach
- Keep single-button workflow for now
- Add better error messages and user feedback
- Make the single button more transparent about what it's doing

## Recommended Next Steps

1. **Keep current working version** (old single-button) deployed
2. **Investigate the specific memory leak** in the multi-step workflow:
   - Check if `feedDiscovery.discoverFeedUrl()` creates browser instances
   - Verify browser cleanup in `setup-scraping` endpoint
   - Add memory logging to identify where memory accumulates
3. **Fix the multi-step workflow** before re-enabling it
4. **Test thoroughly** on Render free tier before switching back

## Code to Investigate

1. `server/services/feedDiscovery.js` - Does `discoverFeedUrl()` use Playwright?
2. `server/index.js` - `/api/sources/check-feed` endpoint
3. `server/index.js` - `/api/sources/setup-scraping` endpoint
4. `server/services/webScraper.js` - Browser instance management



