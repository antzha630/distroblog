require('dotenv').config();

// Global Scoopstream config shared by server modules (same repo; two Render services differ only by env).
// - SCOOPSTREAM_MODE=v1 → RSS + traditional scraping (Playwright/static) for sources without feeds. ADK is never used.
// - SCOOPSTREAM_MODE=v2 → RSS + ADK for sources without feeds. No Playwright/static fallback (ADK-only).
const rawMode = (process.env.SCOOPSTREAM_MODE || 'v1').toLowerCase();
const mode = rawMode === 'v2' ? 'v2' : 'v1';

const enableAdkEnv = (process.env.SCOOPSTREAM_ENABLE_ADK || '').toLowerCase();
// ADK runs only on v2. SCOOPSTREAM_ENABLE_ADK=false disables ADK on v2 (emergency kill-switch; no-RSS sources then yield nothing).
const enableAdk = mode === 'v2' && enableAdkEnv !== 'false';

// Web Search Provider Configuration
// SEARCH_PROVIDER: "parallel", "tavily", or "parallel,tavily" (fallback chain)
const searchProviderRaw = (process.env.SEARCH_PROVIDER || 'parallel,tavily').toLowerCase();
const searchProviders = searchProviderRaw.split(',').map(s => s.trim()).filter(Boolean);

module.exports = {
  mode,
  adk: {
    enabled: enableAdk,
  },
  search: {
    providers: searchProviders,
    parallelApiKey: process.env.PARALLEL_API_KEY || '',
    tavilyApiKey: process.env.TAVILY_API_KEY || '',
  },
  distro: {
    // Distro API (staging by default – override with DISTRO_API_ENDPOINT / DISTRO_API_KEY for production)
    apiKey: process.env.DISTRO_API_KEY || 'dv_WxgyqdDNJxofDkywhmuHXQ',
    apiEndpoint: process.env.DISTRO_API_ENDPOINT || 'http://3.233.81.252:5001/api/external/news',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    channelId: process.env.TELEGRAM_CHANNEL_ID || '', // Channel username (e.g., @channelname) or numeric ID
    messageThreadId: process.env.TELEGRAM_MESSAGE_THREAD_ID || null, // Optional: for topics in channels
  },
};

