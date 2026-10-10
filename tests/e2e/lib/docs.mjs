// Helpers for e2e tests that open shared docs by URL and watch what the app
// does to the address bar.
//
//   import { createDoc, putMarkdown, listRevisions, installUrlRecorder, urlLog,
//            waitForDoc, readingOffset, collectShareUrls } from '../lib/docs.mjs'
//
// Backend (the throwaway API from helpers.mjs, never :3100):
//   createDoc({ markdown, filename?, sessionName?, slug?, author?, contentType?, mode? })
//       -> { id, slug }   (slug is null when the server assigned none)
//   putMarkdown(idOrSlug, markdown, { author? })  -> { content_hash, ... }
//   listRevisions(idOrSlug)                       -> { current, revisions: [...] }
//   uniq(prefix)                                  -> `${prefix}-<random>` (slug-safe)
//
// Browser:
//   installUrlRecorder(context)   BEFORE page.goto. In the top frame it keeps
//     window.__mdr = {
//       initialHistoryLength,   // history.length before any app script ran
//       log: [{ kind: 'push'|'replace'|'hashchange'|'popstate', url, state }],
//       clipboard: [string],    // navigator.clipboard.writeText / execCommand('copy')
//       firstRender: null | { href, at },   // see watchFirstRender
//     }
//   urlLog(page)                 -> window.__mdr.log
//   historyLength(page)          -> history.length now
//   watchFirstRender(context, marker)  BEFORE page.goto: records location.href
//     the first time `marker` text appears anywhere in the DOM.
//   waitForDoc(page, text, { timeout })  -> waits until the rendered markdown
//     (.preview-pane, the read view's container — 00 §4.6) contains `text`.
//   readingOffset(page, selector) -> px between the target's top and the top
//     of the reading area. The reading area starts at the bottom of the sticky
//     doc header, or at the top of the element that actually scrolls the
//     content, whichever is lower — so it measures "scrolled to the top of the
//     reading area" both for the document-scroll layout (#5) and for an inner
//     scroll pane with banners above it.
//   collectShareUrls(page)        -> opens the copy-link / share UI that the
//     current build has (copy-link-btn, share-btn, or the legacy "Share"
//     header button) and returns every http(s) URL it put on the clipboard or
//     on screen.

import { API } from '../helpers.mjs'

export const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`

async function json(res, what) {
  const body = await res.text()
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${body.slice(0, 300)}`)
  return body ? JSON.parse(body) : null
}

export async function createDoc({ markdown, filename = 'doc.md', sessionName, slug, author, contentType, mode } = {}) {
  const payload = { markdown, filename, sharedAt: new Date().toISOString(), comments: [] }
  if (sessionName !== undefined) payload.sessionName = sessionName
  if (slug !== undefined) payload.slug = slug
  if (author !== undefined) payload.author = author
  if (contentType !== undefined) payload.contentType = contentType
  if (mode !== undefined) payload.mode = mode
  const data = await json(await fetch(`${API}/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }), 'POST /paste')
  return { id: data.id, slug: data.slug ?? null }
}

export async function putMarkdown(idOrSlug, markdown, { author } = {}) {
  return json(await fetch(`${API}/paste/${encodeURIComponent(idOrSlug)}/markdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(author ? { markdown, author } : { markdown }),
  }), 'PUT /paste/:id/markdown')
}

export async function listRevisions(idOrSlug) {
  return json(await fetch(`${API}/paste/${encodeURIComponent(idOrSlug)}/revisions`), 'GET /paste/:id/revisions')
}

export async function installUrlRecorder(context) {
  await context.addInitScript(() => {
    if (window.top !== window) return
    const rec = {
      initialHistoryLength: history.length,
      log: [],
      clipboard: [],
      firstRender: null,
    }
    Object.defineProperty(window, '__mdr', { value: rec, configurable: true })
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
    addEventListener('hashchange', () => rec.log.push({ kind: 'hashchange', url: location.href, state: str(history.state) }))
    addEventListener('popstate', () => rec.log.push({ kind: 'popstate', url: location.href, state: str(history.state) }))
    try {
      const clip = navigator.clipboard
      if (clip) {
        clip.writeText = (t) => { rec.clipboard.push(String(t)); return Promise.resolve() }
        const origWrite = clip.write?.bind(clip)
        clip.write = async (items) => {
          for (const item of items || []) {
            for (const type of item.types || []) {
              if (type.startsWith('text/')) {
                try { rec.clipboard.push(await (await item.getType(type)).text()) } catch { /* ignore */ }
              }
            }
          }
          return origWrite ? origWrite(items).catch(() => {}) : undefined
        }
      }
    } catch { /* clipboard API not patchable — execCommand path below still records */ }
    const origExec = document.execCommand.bind(document)
    document.execCommand = function (cmd, ...rest) {
      if (String(cmd).toLowerCase() === 'copy') {
        const active = document.activeElement
        const sel = active && 'value' in active && typeof active.value === 'string'
          ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? active.value.length)
          : String(getSelection() ?? '')
        rec.clipboard.push(sel)
      }
      return origExec(cmd, ...rest)
    }
  })
}

export async function watchFirstRender(context, marker) {
  await context.addInitScript((m) => {
    if (window.top !== window) return
    const check = () => {
      const rec = window.__mdr
      if (!rec || rec.firstRender) return true
      if (document.body && document.body.textContent.includes(m)) {
        rec.firstRender = { href: location.href, at: performance.now() }
        return true
      }
      return false
    }
    const obs = new MutationObserver(() => { if (check()) obs.disconnect() })
    obs.observe(document, { childList: true, subtree: true, characterData: true })
  }, marker)
}

export const urlLog = (page) => page.evaluate(() => window.__mdr?.log ?? [])
export const historyLength = (page) => page.evaluate(() => history.length)

export async function waitForDoc(page, text, { timeout = 15000 } = {}) {
  await page.locator('.preview-pane').filter({ hasText: text }).first().waitFor({ state: 'visible', timeout })
}

export async function readingOffset(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const header = document.querySelector('[data-testid="doc-header"]') || document.querySelector('header')
    let top = 0
    if (header) {
      const r = header.getBoundingClientRect()
      if (r.height > 0 && r.bottom > 0) top = r.bottom
    }
    // The nearest ancestor that actually scrolls the content (not the page).
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) {
        top = Math.max(top, p.getBoundingClientRect().top)
        break
      }
    }
    return el.getBoundingClientRect().top - top
  }, selector)
}

export async function collectShareUrls(page) {
  const trigger = async (sel) => {
    const loc = page.locator(sel).first()
    if (await loc.count() && await loc.isVisible()) { await loc.click(); return true }
    return false
  }
  let opened = false
  // copy-link-btn (#2) may live in the header or in the overflow menu (00 §2.3).
  if (await trigger('[data-testid="copy-link-btn"]')) opened = true
  else if (await trigger('[data-testid="header-overflow-btn"]')) {
    if (await trigger('[data-testid="copy-link-btn"]')) opened = true
    else await page.keyboard.press('Escape')
  }
  if (await trigger('[data-testid="share-btn"]')) opened = true
  else if (!opened && await trigger('header button:has-text("Share")')) opened = true
  if (!opened) throw new Error('no copy-link / share control found')
  // Let the dialog or clipboard write land.
  await page.waitForFunction(() => {
    const rec = window.__mdr
    if (rec && rec.clipboard.length) return true
    return /https?:\/\/\S+\/d\//.test(document.body.innerText) ||
      [...document.querySelectorAll('input, textarea')].some((i) => /https?:\/\//.test(i.value))
  }, null, { timeout: 5000 }).catch(() => {})
  const seen = await page.evaluate(() => [
    ...(window.__mdr?.clipboard ?? []),
    document.body.innerText,
    ...[...document.querySelectorAll('input, textarea')].map((i) => i.value),
  ])
  return [...new Set(seen.flatMap((s) => String(s).match(/https?:\/\/[^\s"'<>`]+/g) ?? []))]
}
