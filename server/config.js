require('dotenv').config();

// Global Scoopstream config shared by server modules
const mode = process.env.SCOOPSTREAM_MODE || 'v1';

// ADK is disabled by default in v1 for performance/reliability.
// It can be explicitly enabled via SCOOPSTREAM_ENABLE_ADK=true or by running in v2 mode.
const enableAdkEnv = (process.env.SCOOPSTREAM_ENABLE_ADK || '').toLowerCase();
const enableAdk =
  enableAdkEnv === 'true' ||
  (enableAdkEnv === '' && mode === 'v2');

module.exports = {
  mode,
  adk: {
    enabled: enableAdk,
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

