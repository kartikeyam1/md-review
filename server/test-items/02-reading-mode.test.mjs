// #2 Reading mode — per-doc `mode` on the backend, REST and MCP
// (docs/build/specs/02-reading-mode.md rules 12–13, 00 §1.4).
//
// REST tests hit the throwaway backend that scripts/verify.sh starts (API base:
// E2E_API_URL, MDREVIEW_API or PASTE_API — never :3100). AC-02.2 pokes the
// session JSON on disk, so it needs that backend's DATA_DIR (verify.sh exports
// it). MCP is exercised three ways: the in-process handlers, the stdio server
// and the streamable-HTTP server (both spawned here, on a free port, against
// the same throwaway backend) — the zod schemas strip unknown arguments, so
// only a protocol-level call proves a tool really accepts `mode`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHandlers } from '../mcp-server.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(HERE, '..')
const API = (process.env.E2E_API_URL || process.env.MDREVIEW_API || process.env.PASTE_API || '').replace(/\/+$/, '')
const DATA_DIR = process.env.DATA_DIR || process.env.E2E_DATA_DIR || ''
const FRONTEND_URL = 'https://example.test/md-review'
const MODE_ERROR = { error: 'mode must be "publish" or "review"' }

function requireApi() {
  assert.ok(API, 'set E2E_API_URL (scripts/verify.sh does) — these tests need a throwaway backend')
  assert.ok(!/:3100\b/.test(API), 'refusing to write into the live backend on :3100')
}

const uniq = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  return { status: res.status, json, text }
}

const basePaste = (extra = {}) => ({
  markdown: `# Mode test\n\nbody ${uniq('m')}\n`,
  filename: 'mode.md',
  sharedAt: new Date().toISOString(),
  comments: [],
  ...extra,
})

async function createPaste(extra) {
  const r = await call('POST', '/paste', basePaste(extra))
  assert.equal(r.status, 200, `POST /paste: ${r.status} ${r.text}`)
  return r.json
}

async function modeOf(id) {
  const full = await call('GET', `/paste/${id}`)
  assert.equal(full.status, 200, full.text)
  const meta = await call('GET', `/paste/${id}?fields=meta`)
  assert.equal(meta.status, 200, meta.text)
  const list = await call('GET', '/paste/list')
  assert.equal(list.status, 200, list.text)
  const item = list.json.find((s) => s.id === id)
  assert.ok(item, `session ${id} is in /paste/list`)
  return { full: full.json.mode, meta: meta.json.mode, list: item.mode }
}

// ── REST: POST /paste ───────────────────────────────────────────────────────

test('AC-02.3 POST /paste with mode:"draft" → 400 with the documented error', async () => {
  requireApi()
  const r = await call('POST', '/paste', basePaste({ mode: 'draft' }))
  assert.equal(r.status, 400, r.text)
  assert.deepEqual(r.json, MODE_ERROR)
})

test('AC-02.3 POST /paste rejects other invalid modes (wrong case, non-string)', async () => {
  requireApi()
  for (const mode of ['REVIEW', 'Publish', 42, ['review']]) {
    const r = await call('POST', '/paste', basePaste({ mode }))
    assert.equal(r.status, 400, `mode ${JSON.stringify(mode)}: ${r.status} ${r.text}`)
    assert.deepEqual(r.json, MODE_ERROR)
  }
})

test('AC-02.3 POST /paste with callback_url and no mode stores mode "review"', async () => {
  requireApi()
  const created = await createPaste({ callback_url: 'http://127.0.0.1:9/approval-hook' })
  assert.equal(created.mode, 'review', 'POST response carries the stored mode')
  assert.deepEqual(await modeOf(created.id), { full: 'review', meta: 'review', list: 'review' })
})

test('AC-02.3 (rule 12) POST /paste without mode or callback_url stores "publish"; response adds mode', async () => {
  requireApi()
  const created = await createPaste()
  assert.ok(created.id)
  assert.equal(created.mode, 'publish')
  assert.deepEqual(await modeOf(created.id), { full: 'publish', meta: 'publish', list: 'publish' })
})

test('AC-02.3 (rule 12) an explicit mode wins over callback_url', async () => {
  requireApi()
  const review = await createPaste({ mode: 'review' })
  assert.equal(review.mode, 'review')
  assert.deepEqual(await modeOf(review.id), { full: 'review', meta: 'review', list: 'review' })
  const publish = await createPaste({ mode: 'publish', callback_url: 'http://127.0.0.1:9/approval-hook' })
  assert.equal(publish.mode, 'publish')
  assert.deepEqual(await modeOf(publish.id), { full: 'publish', meta: 'publish', list: 'publish' })
})

// ── REST: legacy sessions ───────────────────────────────────────────────────

// Under #20 sessions live in SQLite (mode is a NOT NULL column), so "a session
// JSON on disk with no mode key" is a legacy JSON data dir run through the
// migration script: it must read as review, and reads must not write the row.
test('AC-02.2 a legacy session JSON with no mode key reads as "review" after migration, and reads write nothing', async () => {
  const { tmpDir, runMigrate, startServer, http, openDbReadOnly, DB_NAME, cleanupTmp } = await import('./lib/20-helpers.mjs')
  const dir = tmpDir('md-review-02-legacy')
  const id = 'b2b2b2b2b2b2'
  const legacy = { markdown: '# Legacy\n\nno mode key\n', filename: 'legacy.md', sessionName: 'Legacy no mode', sharedAt: '2025-03-01T10:00:00.000Z', comments: [] }
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(legacy))
  assert.ok(!readFileSync(join(dir, `${id}.json`), 'utf-8').includes('"mode"'), 'fixture has no mode key')
  const mig = runMigrate(['--data-dir', dir])
  assert.equal(mig.status, 0, `migration: ${mig.stdout}\n${mig.stderr}`)
  const s = await startServer({ dataDir: dir })
  try {
    const rowBefore = (await openDbReadOnly(join(dir, DB_NAME))).prepare('SELECT mode, version, extra_json FROM sessions WHERE id = ?').get(id)
    assert.equal(rowBefore.mode, 'review')
    const full = await http(s.url, 'GET', `/paste/${id}`)
    assert.equal(full.status, 200, full.text)
    assert.equal(full.json.mode, 'review')
    assert.ok(full.text.includes('"mode":"review"'), 'body contains "mode":"review"')
    assert.equal((await http(s.url, 'GET', `/paste/${id}?fields=meta`)).json.mode, 'review')
    assert.equal((await http(s.url, 'GET', '/paste/list')).json.find((x) => x.id === id)?.mode, 'review')
    const rowAfter = (await openDbReadOnly(join(dir, DB_NAME))).prepare('SELECT mode, version, extra_json FROM sessions WHERE id = ?').get(id)
    assert.deepEqual({ ...rowAfter }, { ...rowBefore }, 'the stored session row is unchanged by the reads')
  } finally { await s.stop(); cleanupTmp() }
})

// ── REST: PUT /paste/:id/meta ───────────────────────────────────────────────

test('AC-02.3 (rule 12) PUT /paste/:id/meta {mode} switches the mode and echoes it', async () => {
  requireApi()
  const { id } = await createPaste()
  const r = await call('PUT', `/paste/${id}/meta`, { mode: 'review' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.mode, 'review')
  assert.deepEqual(await modeOf(id), { full: 'review', meta: 'review', list: 'review' })

  const back = await call('PUT', `/paste/${id}/meta`, { mode: 'publish' })
  assert.equal(back.status, 200, back.text)
  assert.equal(back.json.mode, 'publish')
  assert.equal((await modeOf(id)).full, 'publish')
})

test('AC-02.3 (rule 12) PUT /paste/:id/meta validates mode like POST; {} leaves it unchanged', async () => {
  requireApi()
  const { id } = await createPaste({ mode: 'review' })
  for (const mode of ['REVIEW', null, 'draft', 1]) {
    const r = await call('PUT', `/paste/${id}/meta`, { mode })
    assert.equal(r.status, 400, `mode ${JSON.stringify(mode)}: ${r.status} ${r.text}`)
    assert.deepEqual(r.json, MODE_ERROR)
  }
  assert.equal((await modeOf(id)).full, 'review', 'rejected writes change nothing')

  const empty = await call('PUT', `/paste/${id}/meta`, {})
  assert.equal(empty.status, 200, empty.text)
  assert.equal(empty.json.mode, 'review')
  const rename = await call('PUT', `/paste/${id}/meta`, { sessionName: uniq('Renamed') })
  assert.equal(rename.status, 200, rename.text)
  assert.equal(rename.json.mode, 'review')
  assert.equal((await modeOf(id)).full, 'review')
})

test('AC-02.3 (rule 12) comment and approval endpoints keep working on a publish doc', async () => {
  requireApi()
  const { id } = await createPaste({ mode: 'publish' })
  const c = await call('POST', `/paste/${id}/comments`, {
    startLine: 2, endLine: 2, selectedText: 'body', body: 'must fix this (publish)', category: 'must-fix', author: 'agent',
  })
  assert.equal(c.status, 201, c.text)
  const comments = await call('GET', `/paste/${id}/comments`)
  assert.equal(comments.status, 200)
  assert.ok(comments.json.comments.some((x) => x.body === 'must fix this (publish)'))
  const full = await call('GET', `/paste/${id}`)
  assert.equal(full.json.mode, 'publish')
  assert.equal(full.json.comments.length, 1, 'comments are still returned by REST in publish mode')
  const approval = await call('GET', `/paste/${id}/approval`)
  assert.equal(approval.status, 200, approval.text)
})

// ── MCP: in-process handlers against the real backend ───────────────────────

const liveHandlers = () => createHandlers({ pasteApiUrl: API, pastePublicUrl: API, frontendUrl: FRONTEND_URL, fetchFn: fetch })

test('AC-02.13 MCP handlers: create_session(mode:"review") → get_session; update_session_meta(publish) → list_sessions', async () => {
  requireApi()
  const h = liveHandlers()
  const created = await h.create_session({ markdown: '# MCP review\n\nbody\n', filename: 'mcp.md', sessionName: uniq('MCP review'), mode: 'review' })
  assert.ok(created.id, JSON.stringify(created))
  const got = await h.get_session({ sessionId: created.id })
  assert.equal(got.mode, 'review')
  const meta = await h.get_session({ sessionId: created.id, fields: 'meta' })
  assert.equal(meta.mode, 'review')

  const upd = await h.update_session_meta({ sessionId: created.id, mode: 'publish' })
  assert.ok(!upd.error, JSON.stringify(upd))
  const list = await h.list_sessions({})
  assert.equal(list.find((s) => s.id === created.id)?.mode, 'publish')
})

test('AC-02.13 (00 §1.4) MCP create_session without mode stores "publish"', async () => {
  requireApi()
  const h = liveHandlers()
  const created = await h.create_session({ markdown: '# MCP default\n\nbody\n', filename: 'mcp-default.md' })
  assert.ok(created.id, JSON.stringify(created))
  assert.equal((await h.get_session({ sessionId: created.id })).mode, 'publish')
})

test('AC-02.13 (rule 13) create_via_shell passes mode through to POST /paste', async (t) => {
  requireApi()
  const jq = await new Promise((ok) => execFile('jq', ['--version'], (err) => ok(!err)))
  if (!jq) { t.skip('jq is not installed'); return }
  const dir = mkdtempSync(join(tmpdir(), 'md-review-02-shell-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'shell.md')
  writeFileSync(file, '# Shell\n\nvia shell\n')

  const h = liveHandlers()
  const { command } = await h.create_via_shell({ filePath: file, mode: 'review' })
  const out = await new Promise((ok, fail) => execFile('bash', ['-c', command], { timeout: 30_000 }, (err, stdout, stderr) =>
    err ? fail(new Error(`${err.message}\n${stderr}`)) : ok(stdout)))
  const { id } = JSON.parse(out.trim())
  assert.ok(id, out)
  assert.equal((await modeOf(id)).full, 'review')
})

// ── MCP: protocol level (stdio + streamable HTTP) ───────────────────────────

const toolResult = (r) => JSON.parse(r.content[0].text)

async function roundTrip(client) {
  const { tools } = await client.listTools()
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]))
  for (const name of ['create_session', 'update_session_meta']) {
    const mode = byName[name]?.inputSchema?.properties?.mode
    assert.ok(mode, `${name} declares a mode argument`)
    const values = mode.enum ?? mode.anyOf?.flatMap((s) => s.enum ?? []) ?? []
    assert.deepEqual([...values].sort(), ['publish', 'review'], `${name}.mode enum`)
  }
  const desc = byName.create_session.inputSchema.properties.mode.description ?? ''
  assert.match(desc, /publish = read-only page for humans \(default\)/, `create_session.mode description: ${desc}`)
  assert.match(desc, /review = comments and approval/, `create_session.mode description: ${desc}`)

  const created = toolResult(await client.callTool({
    name: 'create_session',
    arguments: { markdown: '# MCP protocol\n\nbody\n', filename: 'proto.md', sessionName: uniq('MCP proto'), mode: 'review' },
  }))
  assert.ok(created.id, JSON.stringify(created))
  const got = toolResult(await client.callTool({ name: 'get_session', arguments: { sessionId: created.id } }))
  assert.equal(got.mode, 'review')

  const upd = toolResult(await client.callTool({ name: 'update_session_meta', arguments: { sessionId: created.id, mode: 'publish' } }))
  assert.ok(!upd.error, JSON.stringify(upd))
  const list = toolResult(await client.callTool({ name: 'list_sessions', arguments: {} }))
  assert.equal(list.find((s) => s.id === created.id)?.mode, 'publish')
}

test('AC-02.13 MCP over stdio: create_session/update_session_meta accept mode; get_session/list_sessions return it', async (t) => {
  requireApi()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(SERVER_DIR, 'mcp-server.js')],
    env: { ...process.env, PASTE_API_URL: API, FRONTEND_URL },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'test-02', version: '1.0.0' })
  await client.connect(transport)
  t.after(() => client.close().catch(() => {}))
  await roundTrip(client)
})

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) })
  })
}

test('AC-02.13 MCP over streamable HTTP: the same contract holds', async (t) => {
  requireApi()
  let port
  do { port = await freePort() } while (port === 3200 || port === 3100 || port === 58747)
  const child = spawn(process.execPath, [join(SERVER_DIR, 'mcp-server-http.js')], {
    env: { ...process.env, PASTE_API_URL: API, PASTE_PUBLIC_URL: API, FRONTEND_URL, MCP_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  let client = null
  t.after(async () => {
    await client?.close().catch(() => {})
    if (child.exitCode === null) child.kill('SIGKILL')
  })

  const deadline = Date.now() + 15_000
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch { /* not up yet */ }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`MCP HTTP server did not start:\n${log}`)
    await new Promise((r) => setTimeout(r, 100))
  }

  client = new Client({ name: 'test-02-http', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  await roundTrip(client)
})
