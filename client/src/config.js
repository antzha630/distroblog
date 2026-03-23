// API configuration.
// Prefer an explicit env var, but default to same-origin in production so
// v1 UI talks to v1 backend and v2 UI talks to v2 backend automatically.
const runtimeOrigin =
  typeof window !== 'undefined' && window.location && window.location.origin
    ? window.location.origin
    : 'http://localhost:3001';

export const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || runtimeOrigin;

const config = { API_BASE_URL };
export default config;

