// Shared helpers for the item #20 (SQLite storage) server tests.
// These tests boot their OWN throwaway backends (they need fresh / migrated
// data dirs and specific env such as REVISIONS_MAX or ALLOW_EMPTY_DB), so they
// ignore the PASTE_API backend that scripts/verify.sh starts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = path.resolve(SERVER_DIR, '..');
export const SERVER_FILE = path.join(SERVER_DIR, 'server.cjs');
export const MIGRATE_SCRIPT = path.join(SERVER_DIR, 'scripts', 'migrate-json-to-sqlite.mjs');
export const FIXTURE_DIR = path.join(SERVER_DIR, 'test-items', 'fixtures', '20');
export const LEGACY_FIXTURE = path.join(FIXTURE_DIR, 'legacy-data');
export const DB_NAME = 'md-review.sqlite';

const RESERVED_PORTS = new Set([3100, 3200, 58747]);

// Temp dirs: prefer /dev/shm (RAM) — the root disk on this box fills up.
const TMP_ROOT = process.env.MDREVIEW_TEST_TMP
  || (fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir());
const tmpDirs = [];
export function tmpDir(label = 'md-review-20') {
  const d = fs.mkdtempSync(path.join(TMP_ROOT, `${label}-`));
  tmpDirs.push(d);
  return d;
}
export function cleanupTmp() {
  if (process.env.MDREVIEW_KEEP_TMP === '1') { console.log('[20] kept tmp dirs:', tmpDirs.join(' ')); return; }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** Copy a directory tree (a fixture or a data dir) to a fresh temp dir. */
export function copyToTmp(src, label) {
  const dst = tmpDir(label);
  fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true });
  return dst;
}

export async function freePort() {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error('no free port');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a backend. Returns { url, port, proc, output(), stop() }.
 * `serverFile` defaults to the working tree's server.cjs; the env is built
 * from scratch (like scripts/lib/stack.sh) so nothing leaks in from the shell.
 */
export async function startServer({ dataDir, env = {}, serverFile = SERVER_FILE, readyTimeoutMs = 20000 } = {}) {
  const port = await freePort();
  const childEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    GITHUB_TOKEN: 'test-no-gh', // skips the `gh auth token` probe
    PORT: String(port),
    ...(dataDir ? { DATA_DIR: dataDir } : {}),
    ...env,
  };
  const proc = spawn(process.execPath, [serverFile], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    try { const r = await fetch(`${url}/`); await r.arrayBuffer(); ready = true; break; } catch { await sleep(50); }
  }
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 3000);
      await exited; clearTimeout(t);
    }
  };
  if (!ready) {
    await stop();
    throw new Error(`server did not become ready (exit=${proc.exitCode}). Output:\n${out}`);
  }
  return { url, port, proc, exited, output: () => out, stop };
}

/**
 * Spawn a server that is EXPECTED to refuse to boot. Resolves with
 * { code, signal, output, startedListening } once it exits or the timeout hits
 * (then it is killed and code is null).
 */
export async function spawnExpectingExit({ dataDir, env = {}, timeoutMs = 8000 } = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER_FILE], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_TOKEN: 'test-no-gh', PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  const res = await new Promise((resolve) => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); resolve({ code: null, signal: 'TIMEOUT' }); }, timeoutMs);
    proc.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
  return { ...res, stdout, stderr, startedListening: /running on/i.test(stdout) };
}

/** Run the migration script synchronously. Fails loudly if it does not exist yet. */
export function runMigrate(args, { timeoutMs = 300000 } = {}) {
  if (!fs.existsSync(MIGRATE_SCRIPT)) {
    throw new Error(`migration script missing: ${path.relative(REPO_ROOT, MIGRATE_SCRIPT)} (item #20 not implemented)`);
  }
  const r = spawnSync(process.execPath, [MIGRATE_SCRIPT, ...args], {
    encoding: 'utf-8', timeout: timeoutMs, env: { PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** Migrate `dataDir` (DB at default location unless --db given) and return the parsed --report. */
export function migrateWithReport(dataDir, extraArgs = []) {
  const reportPath = path.join(tmpDir('md-review-20-report'), 'report.json');
  const r = runMigrate(['--data-dir', dataDir, ...extraArgs, '--report', reportPath]);
  let report = null;
  if (fs.existsSync(reportPath)) report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  return { ...r, report, reportPath };
}

/** Open an SQLite DB read-only (node:sqlite). */
export async function openDbReadOnly(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** Row counts for every user table (FTS shadow tables excluded). */
export async function tableCounts(dbPath) {
  const db = await openDbReadOnly(dbPath);
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'doc_fts_%' ORDER BY name").all().map((r) => r.name);
    const counts = {};
    for (const n of names) counts[n] = db.prepare(`SELECT count(*) AS c FROM "${n}"`).get().c;
    return counts;
  } finally { db.close(); }
}

/** sha256 + mtime + size of every file under `dir` (relative paths). */
export function snapshotTree(dir, { exclude = () => false } = {}) {
  const snap = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      const rel = path.relative(dir, p);
      if (exclude(rel)) continue;
      if (ent.isDirectory()) { snap[`${rel}/`] = { dir: true, mtimeMs: fs.statSync(p).mtimeMs }; walk(p); }
      else if (ent.isFile()) {
        const st = fs.statSync(p);
        snap[rel] = { sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), mtimeMs: st.mtimeMs, size: st.size };
      } else if (ent.isSymbolicLink()) {
        snap[rel] = { link: fs.readlinkSync(p) };
      }
    }
  };
  walk(dir);
  return snap;
}

/** List differences between two snapshots (added / removed / changed paths). */
export function diffSnapshots(a, b) {
  const diffs = [];
  for (const k of Object.keys(a)) {
    if (!(k in b)) diffs.push(`removed ${k}`);
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`changed ${k}`);
  }
  for (const k of Object.keys(b)) if (!(k in a)) diffs.push(`added ${k}`);
  return diffs;
}

/** Minimal HTTP helper: returns { status, headers, text, json }. */
export async function http(base, method, p, { body, headers = {} } = {}) {
  const h = { ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
  }
  const res = await fetch(base + p, { method, headers: h, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf-8');
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, buf, json };
}

/** Poll `fn` until it returns truthy or the timeout expires. */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}
