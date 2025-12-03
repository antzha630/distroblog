# Time Card for November 24-30, 2025

**Monday, November 24 - 1.5 hours**
- Added comprehensive date extraction improvements: enhanced parsing from article headers and text content to fix 90% missing dates issue
- Implemented URL and title filtering to exclude category pages, search pages, and generic titles (e.g., "blockchain web3", "cybersecurity")

**Tuesday, November 25 - 2 hours**
- Added Cloudflare challenge detection and handling in Playwright scraping with longer waits and specific checks
- Improved content extraction with better selectors and minimum content length validation (200+ chars) to prevent 85-character placeholder content

**Wednesday, November 26 - 1.5 hours**
- Created bulk re-scrape endpoint `/api/sources/re-scrape-all` to process all active scraping sources sequentially
- Added article deletion logic to remove non-article pages and articles with duplicate/generic titles during re-scrape operations

**Thursday, November 27 - 1.5 hours**
- Fixed bulk re-scrape bug: changed `is_active` check to `!is_paused` to correctly identify active sources
- Added `getArticlesBySourceId()` database method and updated re-scrape to check ALL existing articles (not just current scrape results)

**Friday, November 28 - 1 hour**
- Fixed syntax error: removed orphaned `else` block in feedMonitor.js that caused deployment failure
- Fixed duplicate `totalDeleted` declaration in bulk re-scrape endpoint

**Saturday, November 29 - 1.5 hours**
- Optimized bulk re-scrape memory usage: added Playwright browser cleanup, cached duplicate title checks, reduced batch sizes, and added 3-second delays between sources
- Limited existing articles check to 100 most recent per source and reduced second pass from 10 to 5 articles to stay within 512MB limit

**Sunday, November 30 - 1 hour**
- Applied same memory optimizations to single-source re-scrape endpoint for consistency
- Added extensive logging throughout scraping and re-scrape processes for better debugging and visibility

**Total: 10 hours**

