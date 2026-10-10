// Shared helpers for the item #22 (/d/:slug meta route + PNG cover) server tests.
// Spec: docs/build/specs/22-og-meta-route.md (+ 00 §5, §6).
//
// Not a test file itself (scripts/verify.sh only runs server/test-items/*.test.mjs).
//
// Backend: the meta/cover suites run against E2E_API_URL (or MDREVIEW_API /
// PASTE_API, which scripts/verify.sh sets) when given, else they boot their own
// throwaway backend. An external backend is assumed to run with the default
// FRONTEND_URL / PUBLIC_BASE_URL (scripts/lib/stack.sh starts it with `env -i`);
// override the expectations with MDREVIEW_TEST_FRONTEND_URL /
// MDREVIEW_TEST_PUBLIC_BASE_URL. Its data dir (for the covers/ cache checks)
// comes from E2E_DATA_DIR or DATA_DIR. Suites that need specific env
// (PUBLIC_BASE_URL, FRONTEND_URL) always boot their own backends.
//
// Item gating (common.md): the suites are skipped unless 22 is listed in
// VERIFY_ITEMS or docs/build/LANDED. Run them directly with
//   VERIFY_ITEMS=22 node --test --test-concurrency=1 server/test-items/22-*.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(SERVER_DIR, '..');
export const SERVER_FILE = path.join(SERVER_DIR, 'server.cjs');
export const MCP_SERVER_FILE = path.join(SERVER_DIR, 'mcp-server.js');
export const FIXTURE_DIR = path.join(SERVER_DIR, 'test-items', 'fixtures', '22');
export const DEFAULT_FRONTEND_URL = 'https://kartikeyam1.github.io/md-review';

// ── item gating ─────────────────────────────────────────────────────────────
function itemEnabled(n) {
  const listed = (process.env.VERIFY_ITEMS || '').split(/[\s,]+/).filter(Boolean);
  if (listed.includes(String(n)) || listed.includes('all')) return true;
  try {
    const landed = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'build', 'LANDED'), 'utf-8');
    return landed.split('\n').some((l) => new RegExp(`^\\s*#?0*${n}\\b`).test(l));
  } catch { return false; }
}
export const SKIP = itemEnabled(22) ? false : 'item #22 is not in VERIFY_ITEMS or docs/build/LANDED';

// ── misc ────────────────────────────────────────────────────────────────────
export const uniq = () => crypto.randomBytes(4).toString('hex');
export const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
export const trimSlash = (s) => String(s).replace(/\/+$/, '');
export const cpLen = (s) => [...s].length;
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RESERVED_PORTS = new Set([3100, 3200, 58747]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Temp dirs: prefer /dev/shm (RAM) — the root disk on this box fills up.
const TMP_ROOT = process.env.MDREVIEW_TEST_TMP || (fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir());
const tmpDirs = [];
export function tmpDir(label = 'md-review-22') {
  const d = fs.mkdtempSync(path.join(TMP_ROOT, `${label}-`));
  tmpDirs.push(d);
  return d;
}
export function cleanupTmp() {
  if (process.env.MDREVIEW_KEEP_TMP === '1') { console.log('[22] kept tmp dirs:', tmpDirs.join(' ')); return; }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
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

// ── backends ────────────────────────────────────────────────────────────────

/** Boot a throwaway backend with an env built from scratch. */
export async function startServer({ env = {}, readyTimeoutMs = 30000 } = {}) {
  const port = await freePort();
  const dataDir = tmpDir('md-review-22-data');
  const childEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    GITHUB_TOKEN: 'test-no-gh', // skips the `gh auth token` probe
    PORT: String(port), DATA_DIR: dataDir,
    ...env,
  };
  const proc = spawn(process.execPath, [SERVER_FILE], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.on('exit', resolve));
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
  if (!ready) { await stop(); throw new Error(`server did not become ready (exit=${proc.exitCode}). Output:\n${out}`); }
  const frontend = trimSlash(env.FRONTEND_URL || DEFAULT_FRONTEND_URL);
  const publicBase = trimSlash(env.PUBLIC_BASE_URL || `http://localhost:${port}`);
  return { url, port, dataDir, frontend, publicBase, external: false, output: () => out, stop };
}

/**
 * The backend for suites that need no special env: E2E_API_URL / MDREVIEW_API /
 * PASTE_API when set, else a fresh one.
 */
export async function sharedBackend() {
  const ext = process.env.E2E_API_URL || process.env.MDREVIEW_API || process.env.PASTE_API;
  if (!ext) return startServer();
  const u = new URL(ext);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return {
    url: trimSlash(ext),
    port: Number(port),
    dataDir: process.env.E2E_DATA_DIR || process.env.DATA_DIR || null,
    frontend: trimSlash(process.env.MDREVIEW_TEST_FRONTEND_URL || DEFAULT_FRONTEND_URL),
    publicBase: trimSlash(process.env.MDREVIEW_TEST_PUBLIC_BASE_URL || `http://localhost:${port}`),
    external: true,
    output: () => '',
    stop: async () => {},
  };
}

// ── raw HTTP (exact control of the path and of the User-Agent header) ───────

/**
 * request(base, method, rawPath, { headers, body }) — node:http, so the path is
 * sent byte-for-byte and no User-Agent is added unless given.
 */
export function request(base, method, rawPath, { headers = {}, body } = {}) {
  const u = new URL(base);
  const h = { ...headers };
  let payload;
  if (body !== undefined) {
    payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
    if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    h['Content-Length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf-8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, buf, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── API helpers (existing /paste contract) ──────────────────────────────────

export async function createDoc(base, body, { author = 'Test Author', client = 'test-22' } = {}) {
  const r = await request(base, 'POST', '/paste', {
    body: { ...(author ? { author } : {}), ...body },
    headers: { 'X-MdReview-Client': client },
  });
  if (r.status !== 200 || !r.json?.id) throw new Error(`POST /paste failed: ${r.status} ${r.text}`);
  const { id, slug = null } = r.json;
  return { id, slug, x: slug || id };
}

/** A doc whose expires_at is in the past (POST keeps a given expires_at when expiry_days is null). */
export async function createExpiredDoc(base, body) {
  const doc = await createDoc(base, { ...body, expiry_days: null, expires_at: '2001-01-01T00:00:00.000Z' });
  const g = await request(base, 'GET', `/paste/${doc.id}`);
  if (g.status !== 410) throw new Error(`test setup: expected the doc to be expired (410), got ${g.status}`);
  return doc;
}

export async function putMeta(base, id, body) {
  const r = await request(base, 'PUT', `/paste/${id}/meta`, { body });
  if (r.status !== 200) throw new Error(`PUT /meta failed: ${r.status} ${r.text}`);
  return r.json;
}

export async function putMarkdown(base, id, markdown) {
  const r = await request(base, 'PUT', `/paste/${id}/markdown`, { body: { markdown }, headers: { 'X-MdReview-Client': 'test-22' } });
  if (r.status !== 200) throw new Error(`PUT /markdown failed: ${r.status} ${r.text}`);
  return r.json;
}

// ── User-Agents ─────────────────────────────────────────────────────────────

export const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  curl: 'curl/8.5.0',
  slack: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
};

/** One realistic UA per token in rule 5. */
export const BOT_UAS = {
  Slackbot: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'Slack-ImgProxy': 'Slack-ImgProxy (+https://api.slack.com/robots)',
  Twitterbot: 'Twitterbot/1.0',
  facebookexternalhit: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  LinkedInBot: 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  Discordbot: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  WhatsApp: 'WhatsApp/2.23.20.0 A',
  TelegramBot: 'TelegramBot (like TwitterBot)',
  SkypeUriPreview: 'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5',
  'Microsoft Teams': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Teams/1.6.00.4472 Microsoft Teams',
  Googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  Embedly: 'Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)',
  redditbot: 'Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)',
  Applebot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
};

// ── HTML parsing (just enough for the meta page contract) ───────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    if (!(name in attrs)) attrs[name] = decodeEntities(raw);
  }
  return attrs;
}

const textOf = (inner) => decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** Parse a meta page into the pieces the spec talks about. */
export function parseHtml(html) {
  const tagRe = (name) => new RegExp(`<(${name})\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'gi');
  const metas = [...html.matchAll(tagRe('meta'))].map((m) => parseAttrs(m[2]));
  const links = [...html.matchAll(tagRe('link'))].map((m) => parseAttrs(m[2]));
  const titleM = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const scripts = [...html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)]
    .map((m) => ({ attrs: parseAttrs(m[1]), code: m[2] }));
  const bodyM = html.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  const body = bodyM ? bodyM[1] : html;
  const h1s = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)].map((m) => textOf(m[1]));
  const ps = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map((m) => textOf(m[1]));
  const anchors = [...body.matchAll(tagRe('a'))].map((m) => parseAttrs(m[2]));
  /** All content values of <meta property=key> / <meta name=key>. */
  const metaAll = (key) => metas
    .filter((a) => (a.property || '').toLowerCase() === key.toLowerCase() || (a.name || '').toLowerCase() === key.toLowerCase())
    .map((a) => a.content);
  const refreshes = metas.filter((a) => (a['http-equiv'] || '').toLowerCase() === 'refresh').map((a) => a.content);
  return {
    html, metas, links, scripts, h1s, ps, anchors, metaAll, refreshes,
    title: titleM ? textOf(titleM[1]) : null,
    canonical: links.filter((l) => (l.rel || '').toLowerCase().split(/\s+/).includes('canonical')).map((l) => l.href),
  };
}

/** The single value of a meta key (throws a readable error otherwise). */
export function one(doc, key) {
  const v = doc.metaAll(key);
  if (v.length !== 1) throw new Error(`expected exactly one <meta ${key}>, found ${v.length}: ${JSON.stringify(v)}`);
  return v[0];
}

/** Target URL of a `<meta http-equiv=refresh content="0; url=…">`. */
export function refreshTarget(content) {
  const m = String(content).match(/^\s*\d+(?:\.\d+)?\s*[;,]\s*url\s*=\s*(.*)$/is);
  if (!m) return null;
  let u = m[1].trim();
  if ((u.startsWith("'") && u.endsWith("'")) || (u.startsWith('"') && u.endsWith('"'))) u = u.slice(1, -1);
  return u;
}

/**
 * Run every inline <script> in a sandbox whose location.hash is `hash`; returns
 * the URLs it navigated to (location.replace / assign / href=).
 */
export function scriptNavigations(doc, hash = '') {
  const navs = [];
  const loc = {
    hash, search: '', pathname: '/d/x', origin: 'http://backend.test',
    replace(u) { navs.push(String(u)); }, assign(u) { navs.push(String(u)); },
  };
  let href = 'http://backend.test/d/x' + hash;
  Object.defineProperty(loc, 'href', { get: () => href, set: (u) => { href = String(u); navs.push(String(u)); } });
  loc.toString = () => href;
  const ctx = { location: loc, document: { location: loc }, navigator: { userAgent: '' }, console: { log() {}, error() {} } };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const s of doc.scripts) {
    if (s.attrs.src) continue;
    vm.runInContext(s.code, ctx, { timeout: 500 });
  }
  return navs;
}

/** True if the page would navigate a browser anywhere. */
export function hasRedirect(doc) {
  return doc.refreshes.length > 0
    || /location\s*\.\s*(replace|assign|href)\b/.test(doc.html)
    || /(window|document)\s*\.\s*location\s*=/.test(doc.html)
    || /http-equiv\s*=\s*["']?refresh/i.test(doc.html);
}

/** GET a meta page with a UA (`null` = no User-Agent header at all). */
export async function getMeta(base, rawPath, ua = UA.slack, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (ua !== null) headers['User-Agent'] = ua;
  const r = await request(base, 'GET', rawPath, { headers });
  return { ...r, doc: r.status === 304 ? null : parseHtml(r.text) };
}

/** Path + query of an absolute og:image URL (fetched against the test backend). */
export function pathOf(absUrl) {
  const u = new URL(absUrl);
  return u.pathname + u.search;
}

// ── PNG ─────────────────────────────────────────────────────────────────────

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal PNG reader: IHDR + (for 8-bit non-interlaced images) RGBA pixels. */
export function readPng(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return { valid: false };
  let off = 8;
  let ihdr = null; let plte = null; let trns = null; const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) return { valid: false };
  const out = { valid: true, ...ihdr, pixel: null };
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0 || !channels) return out;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = ihdr;
  const stride = w * channels;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 0xff;
    }
  }
  out.pixel = (x, y) => {
    const i = y * stride + x * channels;
    switch (ihdr.colorType) {
      case 0: return [px[i], px[i], px[i], 255];
      case 4: return [px[i], px[i], px[i], px[i + 1]];
      case 2: return [px[i], px[i + 1], px[i + 2], 255];
      case 3: { const k = px[i]; return [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], trns && k < trns.length ? trns[k] : 255]; }
      default: return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    }
  };
  return out;
}

export const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
export const near = (p, rgb, tol) => Math.abs(p[0] - rgb[0]) <= tol && Math.abs(p[1] - rgb[1]) <= tol && Math.abs(p[2] - rgb[2]) <= tol;

/** Covers cached on disk for a doc id: DATA_DIR/covers/{id}-*.png. */
export function coverFiles(dataDir, id) {
  const dir = path.join(dataDir, 'covers');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${id}-`) && f.endsWith('.png')).sort();
}

/** The local calendar day and the UTC day — a cover's "Updated" date can only change when one of them does. */
export const dayStamp = () => `${new Date().toDateString()}|${new Date().toISOString().slice(0, 10)}`;
