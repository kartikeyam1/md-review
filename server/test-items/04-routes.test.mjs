// #4 Path-based routes — share URLs handed out by MCP and the CLI (AC-04.16,
// rule 17, 00 §6: `<frontendUrl>/d/<slug||id>`, no fragment, one slash).
//
// MCP handlers are exercised with a mocked fetch (like ../test-mcp.mjs); the
// CLI runs for real against the throwaway backend that scripts/verify.sh
// starts. API base: E2E_API_URL, MDREVIEW_API or PASTE_API (never :3100).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHandlers } from '../mcp-server.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'cli.mjs')
const API = (process.env.E2E_API_URL || process.env.MDREVIEW_API || process.env.PASTE_API || '').replace(/\/+$/, '')
const PASTE_API_URL = 'http://paste.test'
const FRONTEND_URL = 'https://example.test/md-review'

function mockFetch(status, body) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  fn.calls = calls
  return fn
}

const handlers = (fetchFn, frontendUrl = FRONTEND_URL) =>
  createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl, fetchFn })

// ── MCP ─────────────────────────────────────────────────────────────────────

test('AC-04.16 MCP create_session — shareUrl is <FRONTEND_URL>/d/<slug> when the server assigned a slug', async () => {
  const r = await handlers(mockFetch(200, { id: 'a1b2c3d4e5f6', slug: 'weekly' })).create_session({ markdown: '# W', filename: 'w.md', sessionName: 'Weekly' })
  assert.equal(r.shareUrl, `${FRONTEND_URL}/d/weekly`)
  assert.ok(!r.shareUrl.includes('#'), r.shareUrl)
})

test('AC-04.16 MCP create_session — shareUrl falls back to /d/<id> without a slug', async () => {
  const r = await handlers(mockFetch(200, { id: 'a1b2c3d4e5f6' })).create_session({ markdown: '# W', filename: 'w.md' })
  assert.equal(r.shareUrl, `${FRONTEND_URL}/d/a1b2c3d4e5f6`)
  assert.ok(!r.shareUrl.includes('#'), r.shareUrl)
})

test('AC-04.16 MCP create_session — a trailing slash on FRONTEND_URL still yields exactly one slash', async () => {
  const r = await handlers(mockFetch(200, { id: 'a1b2c3d4e5f6', slug: 'weekly' }), `${FRONTEND_URL}/`).create_session({ markdown: '# W', filename: 'w.md' })
  assert.equal(r.shareUrl, `${FRONTEND_URL}/d/weekly`)
})

test('AC-04.16 MCP get_session — shareUrl is <FRONTEND_URL>/d/<slug||id>, no fragment', async () => {
  const withSlug = await handlers(mockFetch(200, { markdown: '# T', filename: 't.md', comments: [], slug: 'weekly' })).get_session({ sessionId: 'a1b2c3d4e5f6' })
  assert.equal(withSlug.shareUrl, `${FRONTEND_URL}/d/weekly`)
  const noSlug = await handlers(mockFetch(200, { markdown: '# T', filename: 't.md', comments: [] })).get_session({ sessionId: 'a1b2c3d4e5f6' })
  assert.equal(noSlug.shareUrl, `${FRONTEND_URL}/d/a1b2c3d4e5f6`)
  for (const u of [withSlug.shareUrl, noSlug.shareUrl]) assert.ok(!u.includes('#'), u)
})

test('AC-04.16 MCP create_via_shell — the instruction points at <FRONTEND_URL>/d/, never #shared=', async () => {
  const r = await handlers(mockFetch(200, {})).create_via_shell({ filePath: '/tmp/doc.md' })
  assert.ok(r.instruction.includes(`${FRONTEND_URL}/d/`), r.instruction)
  assert.ok(!r.instruction.includes('#shared='), r.instruction)
})

// ── CLI ─────────────────────────────────────────────────────────────────────

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`cli failed: ${err.message}\n${stderr}`))
      resolve(JSON.parse(stdout.trim().split('\n').pop()))
    })
  })
}

test('AC-04.16 CLI create prints url = <frontend>/d/<slug||id> (flag, env and trailing slash)', async (t) => {
  assert.ok(API, 'set E2E_API_URL (scripts/verify.sh does) — the CLI test needs a throwaway backend')
  assert.ok(!/:3100\b/.test(API), 'refusing to write into the live backend on :3100')
  const dir = mkdtempSync(join(tmpdir(), 'md-review-cli-04-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'routes.md')
  writeFileSync(file, '# CLI routes\n\nAC-04.16\n')

  const named = await runCli(['create', file, '--api', API, '--frontend', FRONTEND_URL, '--name', `CLI routes ${Date.now()}`])
  assert.ok(named.slug, 'a named session gets a slug')
  assert.equal(named.url, `${FRONTEND_URL}/d/${named.slug}`)

  const unnamed = await runCli(['create', file, '--api', API, '--frontend', `${FRONTEND_URL}/`])
  assert.equal(unnamed.slug, null)
  assert.equal(unnamed.url, `${FRONTEND_URL}/d/${unnamed.id}`)

  const viaEnv = await runCli(['create', file, '--api', API], { FRONTEND_URL })
  assert.equal(viaEnv.url, `${FRONTEND_URL}/d/${viaEnv.id}`)

  for (const u of [named.url, unnamed.url, viaEnv.url]) assert.ok(!u.includes('#'), u)
})
