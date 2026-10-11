/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { readFile, copyFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

async function serveLocalFile(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, `http://${req.headers.host}`)
  const filePath = url.searchParams.get('path')

  if (!filePath) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: 'Missing ?path= parameter' }))
    return
  }

  try {
    const content = await readFile(filePath, 'utf-8')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ content, filename: basename(filePath) }))
  } catch (err: any) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: `Cannot read file: ${err.message}` }))
  }
}

// The ?filePath= loader's backend: dev server, and `vite preview` (the e2e gate
// serves the production build with it — scripts/lib/stack.sh).
function localFileApi(): Plugin {
  return {
    name: 'local-file-api',
    configureServer(server) {
      server.middlewares.use('/api/file', serveLocalFile)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/file', serveLocalFile)
    },
  }
}

// `vite preview` only: when MDREVIEW_RUNTIME_API is set, every HTML response
// (index.html and the SPA fallback for deep paths) gets an inline
// `window.__MDREVIEW_API__ = ...` ahead of the app bundle, so one production
// build can be pointed at a backend whose port is only known at run time
// (src/composables/pasteApi.ts). Asset requests are untouched.
function runtimeApiInjection(): Plugin {
  let outDir = 'dist'
  return {
    name: 'runtime-api-injection',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configurePreviewServer(server) {
      const api = process.env.MDREVIEW_RUNTIME_API
      if (!api) return
      const tag = `<script>window.__MDREVIEW_API__=${JSON.stringify(api).replace(/</g, '\\u003c')}</script>`
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
        // Real files other than HTML (the bundle, fonts, ...) pass through.
        // Anything else is index.html or an SPA route (paths like /f/a.md can
        // carry a dot, so decide by existence, not by extension).
        if (!path.endsWith('.html')) {
          const file = resolve(outDir, '.' + path)
          const isFile = file.startsWith(outDir) && (await stat(file).then((st) => st.isFile(), () => false))
          if (isFile) return next()
          const accept = req.headers.accept || '*/*'
          if (!accept.includes('text/html') && !accept.includes('*/*')) return next()
        }
        try {
          const html = await readFile(resolve(outDir, 'index.html'), 'utf-8')
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(html.replace('<head>', `<head>${tag}`))
        } catch (err) {
          next(err)
        }
      })
    },
  }
}

// GitHub Pages has no SPA rewrites: deep paths (/md-review/d/<id>) are served
// 404.html. Emitting it as a byte-identical copy of index.html lets the app
// boot from any depth (spec #4 rule 18); asset URLs are absolute under `base`.
function spaFallback404(): Plugin {
  let outDir = 'dist'
  return {
    name: 'spa-fallback-404',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    async writeBundle() {
      await copyFile(resolve(outDir, 'index.html'), resolve(outDir, '404.html'))
    },
  }
}

// #6: CodeMirror (everything EditorPane statically needs from node_modules and
// the entry doesn't) gets a vendor chunk of its own. The EditorPane chunk is
// then a plain facade with a `default` export, and the language-data chunks
// import CodeMirror from the vendor chunk — so a cache-busted retry of a failed
// EditorPane load (useEditorLoader) never duplicates CodeMirror.
const EDITOR_PANE = fileURLToPath(new URL('./src/components/EditorPane.vue', import.meta.url))
const MAIN = fileURLToPath(new URL('./src/main.ts', import.meta.url))
type ModuleInfoGetter = (id: string) => { importedIds: readonly string[] } | null
function staticClosure(start: string, getModuleInfo: ModuleInfoGetter): Set<string> {
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length) {
    const id = queue.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const dep of getModuleInfo(id)?.importedIds ?? []) queue.push(dep)
  }
  return seen
}
let editorVendor: Set<string> | null = null
function editorVendorChunk(id: string, { getModuleInfo }: { getModuleInfo: ModuleInfoGetter }): string | undefined {
  // Vite's preload helper is used by the entry and by language-data's dynamic
  // imports; left alone, Rollup drags it into the vendor chunk and the entry
  // would then import (and preload) CodeMirror. Keep it out.
  if (id.includes('vite/preload-helper')) return 'preload-helper'
  if (!id.includes('/node_modules/')) return undefined
  if (!editorVendor) {
    const eager = staticClosure(MAIN, getModuleInfo)
    editorVendor = new Set([...staticClosure(EDITOR_PANE, getModuleInfo)].filter((m) => m.includes('/node_modules/') && !eager.has(m)))
  }
  return editorVendor.has(id) ? 'codemirror' : undefined
}

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/md-review/' : '/',
  // VITE_CACHE_DIR (set by scripts/lib/stack.sh) keeps each worktree's
  // pre-bundled deps apart: worktrees share one node_modules, and a dev server
  // re-optimising node_modules/.vite under another one's feet makes its lazy
  // chunks (mermaid diagrams) fail with "Failed to fetch dynamically imported module".
  cacheDir: process.env.VITE_CACHE_DIR || undefined,
  plugins: [vue(), localFileApi(), runtimeApiInjection(), spaFallback404()],
  server: {
    port: parseInt(process.env.PORT || '58747'),
    // VITE_NO_WATCH=1 (set by scripts/lib/stack.sh) runs a one-shot dev server
    // with no file watcher: tests don't need HMR, and the watcher dies with
    // EMFILE on hosts whose inotify instances are exhausted.
    watch: process.env.VITE_NO_WATCH === '1' ? null : undefined,
  },
  build: {
    rollupOptions: {
      output: { manualChunks: editorVendorChunk },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // FE + server pure modules (00 §4.8).
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Node >= 25's built-in Web Storage shadows jsdom's — see the setup file.
    setupFiles: ['tests/setup/jsdom-storage.ts'],
    // server/ has its own node_modules whose packages ship test suites (zod
    // alone adds ~1,800 tests) — keep vitest on the app's own tests.
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**', 'server/**'],
  },
})
