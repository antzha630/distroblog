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

## Verify after deploy

Startup logs include:

`Scoopstream mode: v1 (RSS + scraping (no ADK)) | ADK=off`  
or  
`Scoopstream mode: v2 (RSS + ADK (no scraping fallback)) | ADK=on`
