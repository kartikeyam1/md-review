// A production build served the way GitHub Pages serves it, for testing the
// `/md-review/` base path and the 404.html SPA fallback.
//
//   import { buildForPages, startPagesServer } from './lib/pages.mjs'
//   const dist = await buildForPages({ apiUrl: API })      // vite build --base /md-review/
//   const pages = await startPagesServer({ root: dist })   // -> pages.url = http://127.0.0.1:<port>/md-review
//   await page.goto(`${pages.url}/d/weekly`)               // served from 404.html, status 404
//   ...
//   await pages.close(); rmSync(dist, { recursive: true, force: true })
//
// buildForPages({ apiUrl, base = '/md-review/', outDir? })
//   Runs `vite build --base <base>` with GITHUB_PAGES=true and
//   VITE_PASTE_API_URL=<apiUrl> into outDir (default: a fresh temp dir) and
//   returns that directory. The repo's own dist/ is never touched. ~10 s.
//
// startPagesServer({ root, base = '/md-review/', host = '127.0.0.1' })
//   Mimics GitHub Pages for a project site:
//   - `<base>` without its trailing slash        -> 301 to `<base>`
//   - a path under `<base>` naming a file in root -> 200 with that file
//   - a directory with index.html                 -> that index.html (a
//     directory path without a trailing slash is 301'd to one, like Pages)
//   - anything else under `<base>`                -> root/404.html with
//     status 404 (plain-text 404 when the build emitted no 404.html)
//   - anything outside `<base>`                   -> plain-text 404
//   The query string never affects which file is served.
//   Returns { origin, url /* origin + base without trailing slash */, base,
//             requests /* [{ method, path, status }] */, close() }.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, existsSync, statSync, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, extname, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const withSlashes = (b) => `/${b.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')

export async function buildForPages({ apiUrl, base = '/md-review/', outDir } = {}) {
  if (!apiUrl) throw new Error('buildForPages: apiUrl is required (the throwaway backend, never :3100)')
  const out = outDir ?? mkdtempSync(join(tmpdir(), 'md-review-pages-'))
  const b = withSlashes(base)
  const args = [join(REPO_ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--base', b, '--outDir', out, '--emptyOutDir', '--logLevel', 'warn']
  const env = { ...process.env, GITHUB_PAGES: 'true', VITE_PASTE_API_URL: apiUrl, NO_COLOR: '1' }
  await new Promise((ok, fail) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 240_000)
    child.on('error', (e) => { clearTimeout(timer); fail(e) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) ok()
      else fail(new Error(`vite build for Pages failed (code ${code}, signal ${signal}):\n${log.slice(-4000)}`))
    })
  })
  if (!existsSync(join(out, 'index.html'))) throw new Error(`vite build produced no index.html in ${out}`)
  return out
}

export async function startPagesServer({ root, base = '/md-review/', host = '127.0.0.1' } = {}) {
  if (!root) throw new Error('startPagesServer: root is required')
  const rootAbs = resolve(root)
  const b = withSlashes(base)
  const requests = []

  const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
  const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

  const send = (res, status, file) => {
    res.writeHead(status, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
    createReadStream(file).pipe(res)
  }
  const plain404 = (res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 — File not found (pages test server)')
  }

  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://pages.local')
    let status = 200
    const done = () => requests.push({ method: req.method, path: u.pathname + u.search, status })
    res.on('finish', done)

    if (req.method !== 'GET' && req.method !== 'HEAD') { status = 405; res.writeHead(405); return res.end() }

    if (b !== '/' && u.pathname === b.slice(0, -1)) {
      status = 301; res.writeHead(301, { Location: b + u.search }); return res.end()
    }
    if (!u.pathname.startsWith(b)) { status = 404; return plain404(res) }

    let rel
    try { rel = decodeURIComponent(u.pathname.slice(b.length)) } catch { rel = null }
    const target = rel === null ? null : resolve(rootAbs, '.' + sep + rel)
    const inside = target !== null && (target === rootAbs || target.startsWith(rootAbs + sep))

    if (inside && isFile(target)) return send(res, 200, target)
    if (inside && isDir(target) && isFile(join(target, 'index.html'))) {
      if (!u.pathname.endsWith('/')) {
        status = 301; res.writeHead(301, { Location: u.pathname + '/' + u.search }); return res.end()
      }
      return send(res, 200, join(target, 'index.html'))
    }
    const fallback = join(rootAbs, '404.html')
    status = 404
    if (isFile(fallback)) return send(res, 404, fallback)
    return plain404(res)
  })

  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, host, ok) })
  const { port } = server.address()
  const origin = `http://${host}:${port}`
  return {
    origin,
    base: b,
    url: origin + b.slice(0, -1),
    requests,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()) }),
  }
}
