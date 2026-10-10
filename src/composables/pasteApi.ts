/**
 * Base URL of the paste backend: the build-time VITE_PASTE_API_URL, unless
 * the page that served the app set `window.__MDREVIEW_API__` before boot.
 * The e2e gate's static server (scripts/lib/preview-server.mjs) does that so
 * one production build can be pointed at a throwaway backend on any port.
 */
declare global {
  interface Window { __MDREVIEW_API__?: string }
}

export const PASTE_API: string =
  (typeof window !== 'undefined' && window.__MDREVIEW_API__) || import.meta.env.VITE_PASTE_API_URL || ''
