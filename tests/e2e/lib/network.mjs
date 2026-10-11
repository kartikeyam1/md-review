// Record which JS modules / chunks a page loads.
//
//   import { recordScripts } from './lib/network.mjs'
//   const rec = recordScripts(page)          // attach BEFORE page.goto
//   await page.goto(url); await page.waitForLoadState('networkidle')
//   assert.ok(!rec.loaded(/codemirror/i), rec.summary())
//   rec.stop()
//
// Works in both serving modes:
//   - vite dev (what scripts/verify.sh runs): one request per module, deps
//     pre-bundled as /node_modules/.vite/deps/<pkg>.js — e.g. @codemirror_view.js,
//     codemirror.js, vue-codemirror.js
//   - a production build: hashed chunks under /assets/, e.g. EditorPane-Ab12cd.js
// so match on package / component names (a RegExp or substring), not hashes.
//
// API: urls() — every script URL (in load order, de-duplicated)
//      paths() — the same as pathnames, without query strings
//      chunks() — basenames without the vite content hash, e.g. "EditorPane"
//      loaded(pattern) — true if any path matches (RegExp or substring)
//      matching(pattern) — the matching paths
//      summary() — newline-joined paths, handy as an assertion message
//      stop() — detach the listener

export function recordScripts(page, { sameOriginOnly = false } = {}) {
  const seen = new Set()
  let origin = null
  const onRequest = (req) => {
    if (req.resourceType() !== 'script') return
    const u = req.url()
    if (sameOriginOnly) {
      origin ??= new URL(page.url() === 'about:blank' ? u : page.url()).origin
      if (new URL(u).origin !== origin) return
    }
    seen.add(u)
  }
  page.on('request', onRequest)

  const urls = () => [...seen]
  const paths = () => urls().map((u) => { try { return new URL(u).pathname } catch { return u } })
  const test = (pattern, s) => (pattern instanceof RegExp ? pattern.test(s) : s.includes(pattern))
  return {
    urls,
    paths,
    chunks: () => paths().map((p) => p.split('/').pop().replace(/\.m?js$/, '').replace(/-[A-Za-z0-9_-]{8}$/, '')),
    loaded: (pattern) => paths().some((p) => test(pattern, p)),
    matching: (pattern) => paths().filter((p) => test(pattern, p)),
    summary: () => paths().join('\n'),
    stop: () => page.off('request', onRequest),
  }
}
