# V2 “Check now” + Render logs (ADK cheat sheet)

Use this when **`SCOOPSTREAM_MODE=v2`** and a source has **no RSS** (or ADK monitoring type): the pipeline is **ADK-first** and **does not** fall back to Playwright/static scraping so logs reflect what ADK actually returned.

## What to do

1. Trigger **Check now** on a source in the V2 app.
2. Open **Render → service → Logs** (live tail).
3. Filter mentally for: `[CHECK NOW]`, `[ADK]`, `[ADK][V2]`, `[ACCURACY REPORT]`.

## How to read the log lines

| Signal | Likely cause |
|--------|----------------|
| `No response text` / `empty or minimal` / `responseChars` very low in `🔬 [ADK][V2][diag]` | Model didn’t finish JSON, search blocked, or prompt/format issue — **prompt/ADK execution** |
| `rawJson=0` but `responseChars` high | **Parsing** — prose instead of JSON, or JSON not array-shaped |
| `googleRedirect` high | Model returned **Google/vertex redirect URLs** — **model / grounding** behavior |
| `filteredWrongDomain` high | URLs not on target domain — **search results** or **prompt** (domain discipline) |
| `outsideDate` high | `rawJson` & URL filters OK but dates older than cutoff — **strict date filter** vs prompt |
| `429` / `quota` | **API rate limit** — not a code bug; space requests or raise quota |
| `Search as tool is not enabled` | **Wrong model / API config** — not a scraper issue |
| `📈 [ADK][V2] observability … final=0 rawReturned=… validAfterDomainRules=…` | One-line summary: **raw** vs **after rules** |

## Product behavior (V2)

- **`ADK returned 0 articles — V2 ADK-only path`** → expected message when ADK returns nothing; **no** “falling back to traditional scraper”.
- If you still see Playwright/static for a no-RSS source, confirm **`SCOOPSTREAM_MODE=v2`** on that Render service and that **`enableAdk`** / ADK is actually on.

## Quick triage

1. **If `rawJson` > 0 and `afterDateFilter` = 0** → filter/prompt date window vs model dates.
2. **If `rawJson` = 0** → search/tool usage or JSON instruction; check `[ADK] Event` / function call logs.
3. **If errors in `[ADK]` then `Returning empty result after error` (V2)** → API/model; fix keys, quota, or model name — not HTML scraping.
