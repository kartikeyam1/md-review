/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

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

export default defineConfig({
  plugins: [vue(), localFileApi()],
  server: {
    port: parseInt(process.env.PORT || '58747'),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
})
