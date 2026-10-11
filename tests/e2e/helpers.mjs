// Shared configuration for the Playwright e2e suites.
//
// scripts/verify.sh starts a throwaway backend + vite dev server on free ports
// and exports their URLs; run by hand, the defaults match `npm run dev` and a
// locally running backend.
//
//   E2E_BASE_URL  app (vite dev) origin        default http://localhost:58747
//   E2E_API_URL   paste backend (server.cjs)   required — no default, so a hand
//                 run can never write into the live backend on :3100
//
// The older per-file names (E2E_BASE, PASTE_API) are still honoured.

const trim = (u) => u.replace(/\/+$/, '')

export const BASE = trim(process.env.E2E_BASE_URL || process.env.E2E_BASE || 'http://localhost:58747')
const apiUrl = process.env.E2E_API_URL || process.env.PASTE_API
if (!apiUrl) throw new Error('E2E_API_URL is not set — run e2e through scripts/verify.sh or scripts/lib/stack.sh')
export const API = trim(apiUrl)
