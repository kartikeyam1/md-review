// Helpers for the item #23 e2e tests (view link vs edit link, edit tokens, expiry picker).
// Not a test file (scripts/verify.sh runs tests/e2e/items/*.test.mjs only).
//
//   createDoc(body)            POST /paste on the throwaway backend → the full response
//                              ({id, slug, editToken, viewUrl, editUrl, …} once #23 lands)
//   makeLegacy(id)             clear the doc's edit_token_hash in the backend's SQLite DB
//                              (E2E_DATA_DIR, set by scripts/verify.sh) — a doc "created before #23"
//   serverDoc(x, token?)       GET /paste/:x?fields=meta (with X-Edit-Token when given)
//   serverMarkdown(x)          GET /paste/:x/markdown → string
//   rawPut(x, markdown, token) PUT /paste/:x/markdown → { status, json }
//   rotateToken(x, token)      POST /paste/:x/edit-token → { status, json }
//   installRecorder(context)   BEFORE page.goto: window.__mdr23 = { log: [{kind,url,state}], clipboard: [] }
//   editTokens(page)           the parsed localStorage map md-review-edit-tokens ({} when absent)
//   valueOf(locator)           an input's value, else its trimmed text
//   draftText(page)            every local draft (IndexedDB 'md-review' + localStorage) as one string
//   holdDocGets(page, keys)    gate GET /paste/<key> requests: { close(), open() }

import path from 'node:path'
import { API } from '../helpers.mjs'

export const uniq = (prefix = 'd') => `${prefix}-${Math.random().toString(36).slice(2, 8)}`
export const TOKEN_RE = /^mre_[A-Za-z0-9_-]{43}$/
export const tid = (id) => `[data-testid="${id}"]`
export const DAY = 86400000

async function body(res) {
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: res.status, json, text }
}

export async function createDoc(payload = {}) {
  const res = await fetch(`${API}/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'doc.md', comments: [], sharedAt: new Date().toISOString(), ...payload }),
  })
  const r = await body(res)
  if (r.status !== 200 || !r.json?.id) throw new Error(`POST /paste failed: ${r.status} ${r.text.slice(0, 300)}`)
  return r.json
}

/** createDoc + the precondition every protected-doc test needs: a token came back. */
export async function createProtectedDoc(payload = {}) {
  const d = await createDoc(payload)
  if (!TOKEN_RE.test(String(d.editToken))) {
    throw new Error(`POST /paste returned no editToken (item #23 not implemented): ${JSON.stringify(d)}`)
  }
  return d
}

export async function makeLegacy(id) {
  const dataDir = process.env.E2E_DATA_DIR
  if (!dataDir) throw new Error('E2E_DATA_DIR is not set — run through scripts/verify.sh (it exports the backend data dir)')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(dataDir, 'md-review.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const r = db.prepare('UPDATE sessions SET edit_token_hash = NULL WHERE id = ?').run(id)
    if (r.changes !== 1) throw new Error(`makeLegacy: no session row ${id}`)
  } finally { db.close() }
}

export async function serverDoc(x, token) {
  const res = await fetch(`${API}/paste/${encodeURIComponent(x)}?fields=meta`, { headers: token ? { 'X-Edit-Token': token } : {} })
  const r = await body(res)
  if (r.status !== 200) throw new Error(`GET /paste/${x}?fields=meta: ${r.status} ${r.text.slice(0, 200)}`)
  return r.json
}

export async function serverMarkdown(x) {
  const r = await body(await fetch(`${API}/paste/${encodeURIComponent(x)}/markdown`))
  return r.json?.markdown
}

export async function rawPut(x, markdown, token) {
  return body(await fetch(`${API}/paste/${encodeURIComponent(x)}/markdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Edit-Token': token } : {}) },
    body: JSON.stringify({ markdown }),
  }))
}

export async function rotateToken(x, token) {
  return body(await fetch(`${API}/paste/${encodeURIComponent(x)}/edit-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Edit-Token': token } : {}) },
    body: '{}',
  }))
}

export async function installRecorder(context) {
  await context.addInitScript(() => {
    if (window.top !== window) return
    const rec = { log: [], clipboard: [] }
    Object.defineProperty(window, '__mdr23', { value: rec, configurable: true })
    const str = (s) => { try { return JSON.stringify(s) ?? null } catch { return String(s) } }
    for (const kind of ['push', 'replace']) {
      const name = `${kind}State`
      const orig = history[name]
      history[name] = function (state, unused, url) {
        const r = orig.apply(this, arguments)
        rec.log.push({ kind, url: location.href, state: str(state) })
        return r
      }
    }
    try {
      const clip = navigator.clipboard
      if (clip) {
        clip.writeText = (t) => { rec.clipboard.push(String(t)); return Promise.resolve() }
        clip.write = async (items) => {
          for (const item of items || []) {
            for (const type of item.types || []) {
              if (type === 'text/plain') { try { rec.clipboard.push(await (await item.getType(type)).text()) } catch { /* ignore */ } }
            }
          }
        }
      }
    } catch { /* not patchable */ }
    const origExec = document.execCommand.bind(document)
    document.execCommand = function (cmd, ...rest) {
      if (String(cmd).toLowerCase() === 'copy') {
        const a = document.activeElement
        rec.clipboard.push(a && typeof a.value === 'string'
          ? a.value.slice(a.selectionStart ?? 0, a.selectionEnd ?? a.value.length)
          : String(getSelection() ?? ''))
      }
      return origExec(cmd, ...rest)
    }
  })
}

export const recorded = (page) => page.evaluate(() => window.__mdr23 ?? { log: [], clipboard: [] })

export async function editTokens(page) {
  return page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('md-review-edit-tokens') || '{}') || {} } catch { return { __unparseable: true } }
  })
}

export async function valueOf(locator) {
  return locator.evaluate((el) => (typeof el.value === 'string' && el.tagName !== 'BUTTON' ? el.value : el.textContent || '').trim())
}

export async function draftText(page) {
  return page.evaluate(async () => {
    const parts = []
    try { for (let i = 0; i < localStorage.length; i++) parts.push(localStorage.getItem(localStorage.key(i)) || '') } catch { /* ignore */ }
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('md-review')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      for (const name of db.objectStoreNames) {
        const all = await new Promise((resolve, reject) => {
          const req = db.transaction(name, 'readonly').objectStore(name).getAll()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        parts.push(JSON.stringify(all))
      }
      db.close()
    } catch { /* no IndexedDB */ }
    return parts.join('\n')
  })
}

/**
 * Hold the app's GET /paste/<key>[?…] requests while closed (so a poll cannot change the doc's
 * capability mid-test); open() releases them. Other requests pass straight through.
 */
export async function holdDocGets(page, keys) {
  let closed = false
  let release = () => {}
  let gate = Promise.resolve()
  const re = new RegExp(`^/paste/(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`)
  await page.route((url) => url.href.startsWith(API) && re.test(url.pathname), async (route) => {
    if (route.request().method() === 'GET' && closed) await gate
    try { await route.continue() } catch { /* page gone */ }
  })
  return {
    close() { closed = true; gate = new Promise((r) => { release = r }) },
    open() { closed = false; release() },
  }
}

/** Read the options of the expiry picker (native <select> or a listbox/menu) in order. */
export async function expiryOptions(page) {
  const sel = page.locator(tid('share-expiry-select'))
  const tag = await sel.evaluate((el) => el.tagName)
  if (tag === 'SELECT') {
    return sel.evaluate((el) => ({
      labels: [...el.options].map((o) => o.textContent.trim()),
      selected: el.selectedOptions[0]?.textContent.trim() ?? null,
    }))
  }
  await sel.click()
  const opts = page.locator('[role="option"], [role="menuitemradio"]')
  await opts.first().waitFor({ state: 'visible', timeout: 5000 })
  const labels = (await opts.allTextContents()).map((s) => s.trim())
  const checked = page.locator('[role="option"][aria-selected="true"], [role="menuitemradio"][aria-checked="true"]')
  const selected = (await checked.count()) ? (await checked.first().textContent()).trim() : null
  await page.keyboard.press('Escape')
  return { labels, selected }
}

/** Pick an expiry option by its label. */
export async function pickExpiry(page, label) {
  const sel = page.locator(tid('share-expiry-select'))
  if ((await sel.evaluate((el) => el.tagName)) === 'SELECT') {
    await sel.selectOption({ label })
    return
  }
  await sel.click()
  await page.locator('[role="option"], [role="menuitemradio"]').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first().click()
}

/** Strings a "date N days ahead" may be written as, computed in the page's locale/timezone. */
export async function dateForms(page, days) {
  return page.evaluate((n) => {
    const d = new Date(Date.now() + n * 86400000)
    const day = d.getDate()
    const m = d.getMonth() + 1
    return {
      day: String(day),
      months: [
        d.toLocaleString('en-US', { month: 'short' }), d.toLocaleString('en-US', { month: 'long' }),
        d.toLocaleString(undefined, { month: 'short' }), d.toLocaleString(undefined, { month: 'long' }),
        `${m}/`, `/${m}/`, `-${String(m).padStart(2, '0')}-`, `.${String(m).padStart(2, '0')}.`, `.${m}.`,
      ],
      full: [d.toLocaleDateString(), d.toLocaleDateString('en-US'), d.toISOString().slice(0, 10)],
    }
  }, days)
}
