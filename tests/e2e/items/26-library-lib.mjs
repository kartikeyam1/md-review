// Helpers for the item #26 library e2e tests. Not a test file (scripts/verify.sh
// runs tests/e2e/items/*.test.mjs only).
//
// The library lists *every* doc in a backend, so tests that count rows need a
// backend nobody else writes to. privateBackend() starts one (server/server.cjs
// on a free port, fresh temp DATA_DIR, never the reserved 3100/3200/58747 ports)
// and routeToBackend(context, be) points a browser context's API traffic at it:
// the app keeps calling the shared API origin (window.__MDREVIEW_API__), and the
// route rewrites each request to the private backend.
//
//   const be = await privateBackend()       → { api, dataDir, stop() }
//   await routeToBackend(context, be)
//   const d = await mkDoc(be, { markdown, sessionName, mode, contentType, author })  → { id, slug }   legacy (link-editable)
//   const p = await mkDoc(be, { …, protected: true })                                  → { id, slug, editToken }
//   await api(be, 'POST', '/library/collections', { name })                             → { status, json }

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { API } from '../helpers.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const RESERVED = new Set([3100, 3200, 58747])

export const tid = (id) => `[data-testid="${id}"]`
export const uniq = (prefix = 'd') => `${prefix}-${Math.random().toString(36).slice(2, 8)}`

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

export async function privateBackend() {
  let port
  do { port = await freePort() } while (RESERVED.has(port))
  const dataDir = mkdtempSync(path.join(tmpdir(), 'md-review-e2e26-'))
  const child = spawn(process.execPath, [path.join(REPO, 'server/server.cjs')], {
    cwd: REPO,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const api = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`private backend exited (${child.exitCode}):\n${log.slice(-2000)}`)
    try { if ((await fetch(`${api}/`)).status < 500) break } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`private backend not ready:\n${log.slice(-2000)}`) }
    await new Promise((r) => setTimeout(r, 150))
  }
  return {
    api,
    dataDir,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r() }, 3000); child.once('exit', () => { clearTimeout(t); r() }) })
      }
      try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}

/** Point the context's calls to the shared API at `be`. */
export async function routeToBackend(context, be) {
  const shared = new URL(API)
  await context.route((u) => u.origin === shared.origin, (route) => {
    const u = new URL(route.request().url())
    return route.continue({ url: be.api + u.pathname + u.search })
  })
}

export async function api(be, method, pathname, body, headers = {}) {
  const res = await fetch(be.api + pathname, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: res.status, json, text }
}

async function makeLegacy(be, id) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(be.dataDir, 'md-review.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const r = db.prepare('UPDATE sessions SET edit_token_hash = NULL WHERE id = ?').run(id)
    if (r.changes !== 1) throw new Error(`makeLegacy: no session row ${id}`)
  } finally { db.close() }
}

export async function mkDoc(be, { markdown = '# Doc\n\nBody.\n', filename = 'doc.md', protected: isProtected = false, ...rest } = {}) {
  const r = await api(be, 'POST', '/paste', { markdown, filename, comments: [], sharedAt: new Date().toISOString(), ...rest })
  if (r.status !== 200 || !r.json?.id) throw new Error(`POST /paste failed: ${r.status} ${r.text.slice(0, 300)}`)
  if (isProtected) return { id: r.json.id, slug: r.json.slug ?? null, editToken: r.json.editToken }
  await makeLegacy(be, r.json.id)
  return { id: r.json.id, slug: r.json.slug ?? null }
}

/** Library list from the backend (for cross-checking the UI). */
export async function libDocs(be, query = '', headers = {}) {
  const r = await api(be, 'GET', `/library/docs${query ? `?${query}` : ''}`, undefined, headers)
  if (r.status !== 200) throw new Error(`GET /library/docs?${query}: ${r.status} ${r.text.slice(0, 200)}`)
  return r.json
}

/** Poll `fn` until it returns truthy (or throw after `timeout`). */
export async function until(fn, { timeout = 5000, step = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  let last
  for (;;) {
    last = await fn()
    if (last) return last
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, step))
  }
}
