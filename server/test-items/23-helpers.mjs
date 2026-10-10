// Shared helpers for the item #23 (view link vs edit link, edit tokens, expiry) server tests.
// Spec: docs/build/specs/23-view-edit-links.md (+ 00 §6 URLs, §9 CORS/headers, §10.5 server surface).
//
// Not a test file itself (scripts/verify.sh only runs server/test-items/*.test.mjs).
//
// Backends: suites that only need "a backend + its data dir" use sharedBackend(): the one
// scripts/verify.sh starts (E2E_API_URL / MDREVIEW_API / PASTE_API + DATA_DIR / E2E_DATA_DIR) when
// both are given, else a fresh throwaway one. Suites that need legacy sessions boot their own
// backend on a migrated copy of the #20 legacy JSON fixture (sessions created before #23 have no
// edit_token_hash — spec rule 5). Nothing here ever talks to :3100 / :3200.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  startServer, tmpDir, cleanupTmp, copyToTmp, http, openDbReadOnly, runMigrate, freePort, waitFor,
  LEGACY_FIXTURE, DB_NAME, SERVER_DIR, REPO_ROOT,
} from './lib/20-helpers.mjs';

export { startServer, tmpDir, cleanupTmp, http, openDbReadOnly, freePort, waitFor, DB_NAME, SERVER_DIR, REPO_ROOT };

export const MCP_HTTP_FILE = path.join(SERVER_DIR, 'mcp-server-http.js');
export const MCP_STDIO_FILE = path.join(SERVER_DIR, 'mcp-server.js');
export const CLI_FILE = path.join(SERVER_DIR, 'cli.mjs');

/** Rule 1: `mre_` + 32 random bytes, base64url (43 chars, no padding). */
export const TOKEN_RE = /^mre_[A-Za-z0-9_-]{43}$/;
/** Rule 11: the MCP guidance on 401/403. */
export const MCP_GUIDANCE = 'This document is edit-protected. Pass editToken (returned when it was created) or ask the owner for its edit link.';

export const uniq = () => crypto.randomBytes(4).toString('hex');
const trimSlash = (s) => String(s).replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DAY = 86400000;

// ── backends ────────────────────────────────────────────────────────────────

/** verify.sh's backend when its URL and data dir are both known, else a fresh one. */
export async function sharedBackend() {
  const ext = process.env.E2E_API_URL || process.env.MDREVIEW_API || process.env.PASTE_API;
  const dataDir = process.env.E2E_DATA_DIR || process.env.DATA_DIR;
  if (ext && dataDir && fs.existsSync(dataDir)) {
    return { url: trimSlash(ext), dataDir, external: true, stop: async () => {}, output: () => '' };
  }
  const dir = tmpDir('md-review-23-data');
  const s = await startServer({ dataDir: dir });
  return { ...s, dataDir: dir, external: false };
}

/** A data dir holding the #20 legacy fixture, migrated to SQLite (every session has no token hash). */
export function migratedLegacyDir() {
  const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-23-legacy');
  const r = runMigrate(['--data-dir', dir]);
  if (r.status !== 0) throw new Error(`test setup: migrating the legacy fixture failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return dir;
}

/** Fresh backend on a migrated legacy fixture. */
export async function legacyBackend() {
  const dir = migratedLegacyDir();
  const s = await startServer({ dataDir: dir });
  return { ...s, dataDir: dir, external: false };
}

/** Turn a session into a legacy one (no edit_token_hash) behind the running server's back (WAL, busy_timeout). */
export async function makeLegacy(dataDir, id) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, DB_NAME));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const r = db.prepare('UPDATE sessions SET edit_token_hash = NULL WHERE id = ?').run(id);
    if (r.changes !== 1) throw new Error(`test setup: no session row ${id}`);
  } finally { db.close(); }
}

// ── tokens / headers ────────────────────────────────────────────────────────

/** Header set presenting `token` the given way: 'x' (X-Edit-Token), 'bearer' (Authorization: Bearer). */
export function tok(token, how = 'x') {
  if (token == null) return {};
  return how === 'bearer' ? { Authorization: `Bearer ${token}` } : { 'X-Edit-Token': token };
}

/** Every plausible encoding of sha256(token) — the stored hash may be any of them. */
export function hashForms(token) {
  const d = crypto.createHash('sha256').update(token, 'utf-8').digest();
  return [d.toString('hex'), d.toString('base64'), d.toString('base64url'), d.toString('hex').toUpperCase()];
}

/** Every file under `dir` (recursively), as [relPath, Buffer]. */
export function allFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) out.push([path.relative(dir, p), fs.readFileSync(p)]);
    }
  };
  walk(dir);
  return out;
}

// ── REST helpers ────────────────────────────────────────────────────────────

/** POST /paste; asserts 200 and returns the body (incl. editToken once #23 lands). */
export async function create(base, body = {}, headers = {}) {
  const payload = { markdown: `# Doc ${uniq()}\n\nBody text.\n`, filename: 'doc.md', ...body };
  const r = await http(base, 'POST', '/paste', { body: payload, headers });
  if (r.status !== 200 || !r.json?.id) throw new Error(`POST /paste failed: ${r.status} ${r.text}`);
  return r.json;
}

export const getDoc = (base, x, headers = {}, qs = '') => http(base, 'GET', `/paste/${x}${qs}`, { headers });

export async function serverMarkdown(base, x) {
  const r = await http(base, 'GET', `/paste/${x}/markdown`);
  if (r.status !== 200) throw new Error(`GET /markdown ${x}: ${r.status} ${r.text}`);
  return r.json.markdown;
}

export async function metaOf(base, x, headers = {}) {
  const r = await http(base, 'GET', `/paste/${x}?fields=meta`, { headers });
  if (r.status !== 200) throw new Error(`GET ?fields=meta ${x}: ${r.status} ${r.text}`);
  return r.json;
}

export const putMd = (base, x, markdown, headers = {}) =>
  http(base, 'PUT', `/paste/${x}/markdown`, { body: { markdown }, headers });

export const putMeta = (base, x, body, headers = {}) =>
  http(base, 'PUT', `/paste/${x}/meta`, { body, headers });

export const rotate = (base, x, headers = {}) =>
  http(base, 'POST', `/paste/${x}/edit-token`, { body: {}, headers });

/** Status + code summary for assertion messages. */
export const brief = (r) => `${r.status} ${String(r.text || '').slice(0, 200)}`;

// ── MCP (real servers, real SDK client) ─────────────────────────────────────

/**
 * Spawn the HTTP MCP server on a free port against `apiUrl`, with the token store at
 * `storePath`. Returns { url, port, stop(), output() }.
 */
export async function startMcpHttp({ apiUrl, storePath, env = {} }) {
  const port = await freePort();
  const childEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    PASTE_API_URL: apiUrl, PASTE_PUBLIC_URL: apiUrl,
    FRONTEND_URL: 'https://frontend.test/md-review',
    MCP_PORT: String(port), MCP_TOKEN_STORE: storePath,
    ...env,
  };
  const proc = spawn(process.execPath, [MCP_HTTP_FILE], { cwd: SERVER_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    try { const r = await fetch(`${url}/health`); await r.arrayBuffer(); if (r.ok) { ready = true; break; } } catch { await sleep(50); }
  }
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 3000);
      await exited; clearTimeout(t);
    }
  };
  if (!ready) { await stop(); throw new Error(`MCP HTTP server did not become ready. Output:\n${out}`); }
  return { url, port, stop, output: () => out };
}

/** A NEW MCP connection (fresh initialize → new mcp-session-id) to an HTTP MCP server. */
export async function mcpConnect(mcpUrl) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'md-review-23-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`)));
  return wrapClient(client);
}

/** A stdio MCP server process (server/mcp-server.js) + connected client. */
export async function mcpStdio({ apiUrl, storePath, env = {} }) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_STDIO_FILE],
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PASTE_API_URL: apiUrl, FRONTEND_URL: 'https://frontend.test/md-review', MCP_TOKEN_STORE: storePath, ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'md-review-23-test', version: '1.0.0' });
  await client.connect(transport);
  return wrapClient(client);
}

function wrapClient(client) {
  return {
    client,
    /** Call a tool; returns the parsed JSON text result (or { __toolError } when the SDK reports an error). */
    async call(name, args = {}) {
      let r;
      try { r = await client.callTool({ name, arguments: args }); } catch (e) { return { __toolError: String(e?.message || e) }; }
      const text = r?.content?.find?.((c) => c.type === 'text')?.text;
      let parsed;
      try { parsed = text !== undefined ? JSON.parse(text) : undefined; } catch { parsed = { __text: text }; }
      if (r?.isError) return { __toolError: text ?? 'isError', ...(parsed && typeof parsed === 'object' ? parsed : {}) };
      return parsed;
    },
    async tools() { return (await client.listTools()).tools.map((t) => t.name); },
    async close() { try { await client.close(); } catch { /* ignore */ } },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** Run server/cli.mjs; resolves { code, stdout, stderr, json (last JSON line on stdout) }. */
export function runCli(args, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_FILE, ...args], {
      cwd: SERVER_DIR,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.on('exit', (code) => {
      clearTimeout(t);
      let json;
      for (const line of stdout.trim().split('\n').reverse()) {
        try { json = JSON.parse(line); break; } catch { /* keep looking */ }
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}
