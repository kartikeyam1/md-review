/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { readFile, copyFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

function localFileApi(): Plugin {
  return {
    name: 'local-file-api',
    configureServer(server) {
      server.middlewares.use('/api/file', async (req, res) => {
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

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/md-review/' : '/',
  plugins: [vue(), localFileApi(), spaFallback404()],
  server: {
    port: parseInt(process.env.PORT || '58747'),
    // VITE_NO_WATCH=1 (set by scripts/lib/stack.sh) runs a one-shot dev server
    // with no file watcher: tests don't need HMR, and the watcher dies with
    // EMFILE on hosts whose inotify instances are exhausted.
    watch: process.env.VITE_NO_WATCH === '1' ? null : undefined,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
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
