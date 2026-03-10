## Proposed GitHub issue: ADK accuracy + “80k context” reliability problems (causes slow fallback + instability)

### Title
ADK (Google Search agent) accuracy/reliability issues: empty/minimal responses, wrong-domain links, JSON truncation → frequent Playwright fallback

### Summary
When ADK is used to discover recent articles for a source, it sometimes returns:
- An empty array (`[]`) even for active sites
- A minimal/truncated response that fails JSON parsing
- Links/titles from the wrong domain (off-domain results)
- Rate limit / quota errors (429), triggering fallback

In ScoopStream, these failures cause the pipeline to fall back to traditional scraping (often Playwright), which is slow and memory intensive. This can materially increase “Check now” runtime and contribute to memory pressure / crashes.

### Where in code
- `server/services/adkScraper.js`
  - Logs minimal/truncated responses:
    - `⚠️ [ADK] [ISSUE] Response is empty or minimal (...)`
    - `⚠️ [ADK] JSON parse error in part ...`
  - Logs off-domain filtering:
    - `⚠️ [ADK] [ACCURACY] Filtering out wrong domain: ... (expected: ...)`
- `server/services/feedMonitor.js`
  - ADK → fallback behavior:
    - `⚠️ [CHECK NOW] [X] ADK returned 0 articles, falling back to traditional scraper`
    - `⚠️ [CHECK NOW] [X] ADK returned N articles from wrong domain, falling back to traditional scraper`

### Repro steps
1. Deploy/run in ADK-enabled mode:
   - Set `SCOOPSTREAM_MODE=v2` (or `SCOOPSTREAM_ENABLE_ADK=true`)
   - Set `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) to a valid Gemini key
2. Ensure at least one source is configured such that ADK is used (e.g., `monitoring_type=ADK`, or no RSS feed where the ADK-first path is active).
3. Click “Check now” and watch logs.

### Observed failures (examples)
These are recurring patterns seen in logs:
- **Empty/minimal response**
  - `⚠️ [ADK] [ISSUE] Response is empty or minimal (...)`
  - ADK returns `[]` and we immediately fallback to Playwright/static scraping.
- **Wrong domain**
  - ADK returns results, but URLs resolve off-domain; code filters them out:
    - `⚠️ [ADK] [ACCURACY] Filtering out wrong domain: ... (expected: ...)`
  - Feed monitor then treats this as a failure and falls back.
- **JSON truncation / parse errors**
  - `⚠️ [ADK] JSON parse error in part ...`
  - Often correlated with longer responses or partial events.
- **429 / quota**
  - `⚠️ [ADK] Rate limit/quota exceeded. Will fallback to traditional scraper.`

### Why this matters (performance/UX impact)
- Playwright fallback can take ~60s per source on JS-heavy sites.
- When ADK fails for multiple sources, the run becomes much slower and memory usage increases due to browser lifecycle overhead.
- Even if ADK is “fast when it works”, unreliable ADK makes the worst-case run time and stability materially worse.

### Suggested prompt improvements (agent instruction)
The current instruction in `adkScraper.js` is already reasonably structured, but we can make it more robust by:

1. **Hard constrain output**
   - “Return ONLY a JSON array. No prose. No code fences.”
   - “If you cannot find on-domain articles, return [] (do not guess).”
2. **Enforce on-domain coupling**
   - “Each result must be on the target domain (exact match).”
   - Add explicit example of rejecting aggregator/cached URLs and Google redirect URLs.
3. **Limit output size**
   - “Return at most 5–10 items.”
   - Prefer the newest items first.
   - This reduces risk of truncation/partial responses on large-context models.
4. **Search query pattern (few-shot)**
   - Provide 2–3 query templates as examples:
     - `site:{domain} (blog OR news OR posts) (2026 OR 2025)`
     - `site:{domain} (announcing OR introduce OR update) (blog OR news)`
   - Add a rule: if the first query yields poor results, try a second query.
5. **Date handling**
   - Keep datePublished optional, but add:
     - “If the date is a relative string (e.g. ‘3 days ago’), convert to YYYY-MM-DD.”

### Suggested code-side improvements (beyond prompting)
1. **Structured output / JSON schema (if supported by ADK)**
   - If ADK supports a JSON schema or “response format = json”, use it to eliminate parse failures.
2. **Retry strategy on empty results**
   - If ADK returns `[]`, retry once with an alternate query prompt before falling back to Playwright.
3. **Tighter, earlier fallback**
   - If ADK is slow or partial, cut off earlier and fallback (protects runtime).
4. **Keep ADK isolated**
   - Keep ADK as V2-only (experimental) until the above issues are resolved.

### Acceptance criteria
- For a representative set of sources that previously triggered fallback:
  - ADK returns valid JSON consistently
  - Results are predominantly on-domain and recent
  - “ADK returned 0 articles” occurrences are significantly reduced
  - Check-now runtime decreases vs. the ADK→fallback baseline

---

### How to create the issue (once logged into GitHub CLI)
1. `gh auth login`
2. Create issue in ScoopStream repo:

```bash
gh issue create \
  --repo Distro-Media/ScoopStream \
  --title "ADK accuracy/reliability issues: empty/minimal responses, wrong-domain links, JSON truncation → frequent Playwright fallback" \
  --body "$(cat docs/ADK-ACCURACY-80K-CONTEXT-ISSUE.md)"
```

