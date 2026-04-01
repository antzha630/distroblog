# Scoopstream V1 vs V2 (same repo, env-only)

Deploy **two Render services** from this repo. Behavior is controlled by **`SCOOPSTREAM_MODE`**.

| | **V1** (`SCOOPSTREAM_MODE=v1`) | **V2** (`SCOOPSTREAM_MODE=v2`) |
|---|-------------------------------|--------------------------------|
| **Sources with RSS** | RSS | RSS |
| **Sources without RSS** | Playwright + static scraping | **ADK only** (no scraping fallback) |
| **ADK** | **Never** (ignored even if `SCOOPSTREAM_ENABLE_ADK=true`) | **On** by default |
| **Disable ADK on V2** | N/A | Set `SCOOPSTREAM_ENABLE_ADK=false` (no-RSS sources will find nothing; no scraping) |

## Required env

- **Both:** `DATABASE_URL`, API keys as today, `PORT`, etc.
- **V1:** `SCOOPSTREAM_MODE=v1` (or omit; defaults to v1).
- **V2:** `SCOOPSTREAM_MODE=v2`.

## Frontend

Build the client with **`REACT_APP_API_BASE_URL`** pointing at **that service’s public URL** (e.g. V2 → `https://scoopstream-v2.onrender.com`). Otherwise “Check now” hits the wrong backend and logs show up on the other service.

## ADK tuning (optional, V2)

| Variable | Purpose |
|----------|---------|
| `GOOGLE_GENAI_API_KEY` or `GEMINI_API_KEY` | Required for ADK. |
| `ADK_MODEL` or `SCOOPSTREAM_ADK_MODEL` | If set (e.g. `gemini-2.5-flash`), that model is tried **first**; falls back to the built-in list if unavailable. Use for A/B tests. |
| `ADK_VERBOSE=1` | Per-event logs (local debugging; noisy on Render). |

If results are often empty while the key works, check **Google AI / Cloud console** for **quota, billing, and rate limits** — flakiness is often upstream, not app config.

**Logs:** `[ADK] outcome=ok|empty` lines summarize attempts and counts (good for spotting spikes in `empty`). Verbose runs show `response_chars` and `finishReason` when the API returns `STOP` without text.

**NEAR (`near.org` blog):** Prompts nudge **www** and snippet-faithful URLs. After a **404**, the quality pass tries **slash + www** variants, then **short slug** heuristics for `near.org/blog/...` (e.g. long slugs with a leading `near-` segment or verbose tails → shorter paths like `/blog/legion-city-nodes`).

## Verify after deploy

Startup logs include:

`Scoopstream mode: v1 (RSS + scraping (no ADK)) | ADK=off`  
or  
`Scoopstream mode: v2 (RSS + ADK (no scraping fallback)) | ADK=on`
