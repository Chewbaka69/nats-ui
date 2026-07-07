/**
 * Application configuration
 * 
 * Modify these values before building to customize your NATS UI deployment
 */
export const config = {
  // Backend API base path. The browser only talks to this backend, which owns
  // the NATS connection. Relative by default so it works behind any host; in
  // dev, Vite proxies `/api` (HTTP + WebSocket) to the backend.
  api: {
    baseUrl: '/api',
  },

  nats: {
    // Default NATS server URL. This address is resolved FROM THE BACKEND host,
    // not the browser — so it can point to a NATS only reachable server-side.
    // Overridable at build time via VITE_NATS_URL (e.g. nats://nats:4222 in Docker).
    wsUrl: import.meta.env.VITE_NATS_URL || 'nats://localhost:4222',

    // HTTP URL for NATS monitoring API (proxied by the backend)
    httpUrl: import.meta.env.VITE_NATS_HTTP_URL || 'http://localhost:8222',

    // Default connection timeout (milliseconds)
    connectionTimeout: 5000,
  },

  app: {
    // Application title displayed in browser tab
    title: 'NATS UI',
    
    // Maximum number of messages to keep in memory
    maxMessages: 1000,
    
    // Refresh interval for monitoring data (milliseconds)
    monitoringRefreshInterval: 5000,
  },
} as const;

export type Config = typeof config;