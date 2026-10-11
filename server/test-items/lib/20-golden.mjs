// Golden-response machinery for item #20 (AC-20.3 + spec rule 5).
//
// One request runner is used twice:
//   - record-goldens.mjs runs it against the JSON-file server (pre-#20) on a
//     copy of fixtures/20/legacy-data and freezes the normalised responses in
//     fixtures/20/goldens.json;
//   - 20-golden-compat.test.mjs runs it against the SQLite server on a migrated
//     copy of the same fixture and compares.
//
// Normalisation (applied identically to both sides) only touches values that
// are volatile by nature: ids/uuids/timestamps generated during the run (never
// fixture values), the webhook receiver URL, ETag VALUES (presence is kept),
// and the order of session-file arrays (legacy order = readdir order, which is
// filesystem-dependent). Everything else must match.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { http as req } from './20-helpers.mjs';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HEXID_RE = /\b(?:[0-9a-f]{16}|[0-9a-f]{12})\b/g;
const UNKNOWN_HASH = 'ffffffffffffffffffffffffffffffff';

// ── fixture introspection ──────────────────────────────────────────────────

export function readFixture(dir) {
  const sessions = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()) {
    const id = f.slice(0, -5);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; } // corrupt: not a session
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const files = [];
    const fdir = path.join(dir, 'files', id);
    const walk = (d, prefix) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), rel); else files.push(rel);
      }
    };
    walk(fdir, '');
    sessions.push({ id, meta, files });
  }
  const siteIndex = fs.existsSync(path.join(dir, '_site-index.json'))
    ? JSON.parse(fs.readFileSync(path.join(dir, '_site-index.json'), 'utf-8')) : {};
  const siteDirs = fs.existsSync(path.join(dir, 'sites')) ? fs.readdirSync(path.join(dir, 'sites')).sort() : [];
  return { sessions, siteIndex, siteDirs };
}

/** Every string / number appearing in the fixture (never normalised away). */
export function fixtureKnownValues(dir) {
  const known = new Set();
  const visit = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach(visit);
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) { known.add(k); visit(x); } return; }
    known.add(typeof v === 'number' ? `n:${v}` : String(v));
  };
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    known.add(f.replace(/\.json$/, ''));
    try { visit(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))); } catch { /* corrupt variants */ }
  }
  for (const d of fs.existsSync(path.join(dir, 'sites')) ? fs.readdirSync(path.join(dir, 'sites')) : []) known.add(d);
  return known;
}

// ── request lists ───────────────────────────────────────────────────────────

/** The GET replay list for a fixture dir (AC-20.3). Deterministic. */
export function deriveGetRequests(fixtureDir) {
  const { sessions, siteIndex, siteDirs } = readFixture(fixtureDir);
  const R = [];
  const add = (p, extra = {}) => R.push({ name: `GET ${p}${extra.headers ? ` ${JSON.stringify(extra.headers)}` : ''}${extra.conditional ? ' (If-None-Match)' : ''}`, method: 'GET', path: p, ...extra });

  add('/');
  for (const { id, meta, files } of sessions) {
    const keys = [id, ...(meta.slug ? [meta.slug] : [])];
    for (const x of keys) {
      add(`/paste/${x}`);
      add(`/paste/${x}`, { conditional: true });
      add(`/paste/${x}/comments`);
      add(`/paste/${x}/approval`);
      add(`/paste/${x}/revisions`);
    }
    for (const f of ['meta', 'content', 'comments', 'files', 'meta,content,comments,files', 'meta,files']) add(`/paste/${id}?fields=${f}`);
    add(`/paste/${id}/markdown`);
    add(`/paste/${id}/revisions/current`);
    for (const r of meta.revisions || []) add(`/paste/${id}/revisions/${r.hash}`);
    add(`/paste/${id}/revisions/${UNKNOWN_HASH}`);
    add(`/paste/${id}/files`);
    for (const f of files) {
      add(`/paste/${id}/files/${f}`);
      add(`/paste/${id}/files/${encodeURIComponent(f)}`);
      add(`/paste/${id}/files/${f}`, { conditional: true });
    }
    add(`/paste/${id}/files/no-such-file.txt`);
  }
  for (const q of ['', '?status=approved', '?status=pending', '?status=changes_requested', '?name=weekly', '?name=CAFE',
    '?name=%5Ecjk', '?limit=2', '?status=pending&limit=3', '?limit=0']) add(`/paste/list${q}`);
  // An invalid regex must not crash the server; 400 is allowed (legacy: 500).
  R.push({ name: 'GET /paste/list?name=( (invalid regex)', method: 'GET', path: '/paste/list?name=(', lenient: 'invalid-regex' });
  add('/paste/list?status=pending'); // still serving after the bad regex

  for (const p of ['/paste/ffffffffffff', '/paste/no-such-slug', '/paste/ffffffffffff/comments', '/paste/ffffffffffff/markdown',
    '/paste/ffffffffffff/revisions', '/paste/ffffffffffff/approval', '/paste/ffffffffffff/files', '/paste/ffffffffffff?fields=meta']) add(p);

  add('/site/list');
  for (const [id, s] of Object.entries(siteIndex)) {
    for (const x of [id, s.slug].filter(Boolean)) { add(`/site/${x}/`); add(`/site/${x}`); }
  }
  for (const d of siteDirs) if (!siteIndex[d]) add(`/site/${d}/`); // orphan site dir
  add('/site/demo-site/assets/app.js');
  add('/site/demo-site/assets/app.js', { conditional: true });
  add('/site/demo-site/deep/spa/route');
  add('/site/shared-name/page.html');
  add('/site/shared-name/missing.html');
  add('/site/no-such-site/');
  add('/assets/app.js');
  add('/assets/app.js', { headers: { Referer: 'http://localhost:5173/site/demo-site/' } });
  add('/github');
  add('/github?foo=1');
  add('/github?url=https%3A%2F%2Fexample.com%2Fa.md');
  add('/definitely/not/a/route');
  R.push({ name: 'OPTIONS /paste', method: 'OPTIONS', path: '/paste', statusOnly: true });
  return R;
}

// ── capture ─────────────────────────────────────────────────────────────────

function captureBody(r, { hashBodies = false } = {}) {
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (r.status === 304 || r.buf.length === 0) return null;
  if (ct === 'application/json') {
    try { return { json: JSON.parse(r.text) }; } catch { return { text: r.text }; }
  }
  if (hashBodies) return { sha256: crypto.createHash('sha256').update(r.buf).digest('hex'), bytes: r.buf.length };
  if (ct.startsWith('text/') || ct === 'application/javascript') return { text: r.text };
  return { base64: r.buf.toString('base64') };
}

function entryFrom(name, method, p, r, extra = {}, captureOpts = {}) {
  const ct = r.headers.get('content-type');
  return {
    name, method, path: p,
    status: r.status,
    headers: {
      contentType: ct ? ct.split(';')[0].trim() : null,
      cacheControl: r.headers.get('cache-control'),
      etag: r.headers.has('etag'),
    },
    body: extra.statusOnly ? null : captureBody(r, captureOpts),
    ...(extra.lenient ? { lenient: extra.lenient } : {}),
  };
}

export async function replay(base, requests, captureOpts = {}) {
  const out = [];
  for (const q of requests) {
    let headers = { ...(q.headers || {}) };
    if (q.conditional) {
      const first = await req(base, 'GET', q.path, { headers });
      const etag = first.headers.get('etag');
      if (etag) headers = { ...headers, 'If-None-Match': etag };
    }
    const r = await req(base, q.method, q.path, { headers });
    out.push(entryFrom(q.name, q.method, q.path, r, q, captureOpts));
  }
  return out;
}

// ── write sequence (spec rule 5: same request sequence → same responses) ─────

/** Local webhook receiver; returns { url, events, close }. */
export async function startHookReceiver() {
  const events = [];
  const server = http.createServer((rq, rs) => {
    let b = '';
    rq.on('data', (d) => { b += d; });
    rq.on('end', () => { try { events.push(JSON.parse(b)); } catch { events.push({ raw: b }); } rs.writeHead(204); rs.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, events, close: () => new Promise((r) => server.close(r)) };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runWriteSequence(base, { hookUrl, hookEvents }) {
  const E = [];
  const rec = async (name, method, p, opts = {}) => {
    const r = await req(base, method, p, opts);
    E.push(entryFrom(name, method, p, r));
    return r;
  };
  const UI = { 'X-MdReview-Client': 'ui' };
  const MCP = { 'X-MdReview-Client': 'mcp' };

  // create
  const a = await rec('create A', 'POST', '/paste', { headers: UI, body: {
    markdown: '# Golden write\n\nFirst line.\n', filename: 'golden.md', sessionName: 'Golden write', author: 'alice',
    custom_field: { a: 1, b: [true, null] }, expiry_days: 7 } });
  const A = a.json.id; await pause(15);
  await rec('get A', 'GET', `/paste/${A}`);
  await rec('get A by slug', 'GET', '/paste/golden-write');
  const b = await rec('create B (callback)', 'POST', '/paste', { body: {
    markdown: '# Hook\n', filename: 'hook.md', sessionName: 'Golden hook', callback_url: hookUrl, expiry_days: null } });
  const B = b.json.id; await pause(15);
  await rec('create C (same name → -2 slug)', 'POST', '/paste', { body: { markdown: 'c', sessionName: 'Golden write' } });
  await pause(15);
  await rec('create D (explicit slug, 30d)', 'POST', '/paste', { body: { markdown: 'd', slug: 'My Explicit Slug', expiry_days: 30, contentType: 'markdown' } });
  await pause(15);
  await rec('create: wrong content type', 'POST', '/paste', { headers: { 'Content-Type': 'text/plain' }, body: '{"markdown":"x"}' });
  await rec('create: invalid json', 'POST', '/paste', { body: '{nope' });

  // comments + replies on A
  await rec('comment: missing fields', 'POST', `/paste/${A}/comments`, { body: { body: 'x' } });
  const c1 = (await rec('comment c1', 'POST', `/paste/${A}/comments`, { body: { startLine: 1, endLine: 1, selectedText: 'Golden', body: 'c1', category: 'question', author: 'Ann' } })).json.id;
  const c2 = (await rec('comment c2 must-fix', 'POST', `/paste/${A}/comments`, { body: { startLine: 3, endLine: 3, selectedText: 'First line.', body: 'c2', category: 'must-fix' } })).json.id;
  await rec('comment c1 edit', 'PUT', `/paste/${A}/comments/${c1}`, { body: { body: 'c1 edited', category: 'suggestion' } });
  await rec('comment edit unknown', 'PUT', `/paste/${A}/comments/nope-nope`, { body: { body: 'x' } });
  await rec('comment on unknown session', 'POST', '/paste/ffffffffffff/comments', { body: { startLine: 1, endLine: 1, selectedText: 'x', body: 'y', category: 'nit' } });
  await rec('comment: invalid json', 'POST', `/paste/${A}/comments`, { body: '{bad' });
  const r1 = (await rec('reply r1', 'POST', `/paste/${A}/comments/${c1}/replies`, { body: { body: 'r1', author: 'Bob' } })).json.id;
  await rec('reply: missing body', 'POST', `/paste/${A}/comments/${c1}/replies`, { body: { author: 'Bob' } });
  await rec('reply r1 edit', 'PUT', `/paste/${A}/comments/${c1}/replies/${r1}`, { body: { body: 'r1 edited' } });
  await rec('reply edit unknown', 'PUT', `/paste/${A}/comments/${c1}/replies/nope`, { body: { body: 'x' } });
  const r2 = (await rec('reply r2', 'POST', `/paste/${A}/comments/${c1}/replies`, { body: { body: 'r2' } })).json.id;
  await rec('reply r2 delete', 'DELETE', `/paste/${A}/comments/${c1}/replies/${r2}`);
  await rec('reply delete unknown', 'DELETE', `/paste/${A}/comments/${c1}/replies/${r2}`);
  await rec('reply on unknown comment', 'POST', `/paste/${A}/comments/nope/replies`, { body: { body: 'x' } });
  await rec('resolve c1', 'PUT', `/paste/${A}/comments/${c1}/resolve`, { body: { resolved_by: 'Ann' } });
  await rec('unresolve c1', 'PUT', `/paste/${A}/comments/${c1}/unresolve`);
  await rec('resolve c1 (no body)', 'PUT', `/paste/${A}/comments/${c1}/resolve`);
  await rec('resolve unknown comment', 'PUT', `/paste/${A}/comments/nope/resolve`);
  const c3 = (await rec('comment c3', 'POST', `/paste/${A}/comments`, { body: { startLine: 1, endLine: 2, selectedText: 'x', body: 'to delete', category: 'nit' } })).json.id;
  await rec('comment c3 delete', 'DELETE', `/paste/${A}/comments/${c3}`);
  await rec('comment delete unknown', 'DELETE', `/paste/${A}/comments/${c3}`);
  await rec('get A comments', 'GET', `/paste/${A}/comments`);

  // approval on A
  await rec('approval A get', 'GET', `/paste/${A}/approval`);
  await rec('approve A blocked by must-fix', 'PUT', `/paste/${A}/approval`, { body: { status: 'approved', approved_by: 'Dana' } });
  await rec('resolve c2', 'PUT', `/paste/${A}/comments/${c2}/resolve`, { body: { resolved_by: 'Dana' } });
  await rec('approve A', 'PUT', `/paste/${A}/approval`, { body: { status: 'approved', approved_by: 'Dana' } });
  await rec('approve A again (invalid)', 'PUT', `/paste/${A}/approval`, { body: { status: 'approved' } });
  await rec('approval bogus status', 'PUT', `/paste/${A}/approval`, { body: { status: 'bogus' } });
  await rec('request changes A', 'PUT', `/paste/${A}/approval`, { body: { status: 'changes_requested' } });
  await rec('approval A get 2', 'GET', `/paste/${A}/approval`);

  // approval on B fires the webhook
  await rec('approve B (webhook)', 'PUT', `/paste/${B}/approval`, { body: { status: 'approved', approved_by: 'Hal' } });
  const deadline = Date.now() + 5000;
  while (hookEvents.length === 0 && Date.now() < deadline) await pause(20);
  E.push({ name: 'webhook payload after approve B', method: 'WEBHOOK', path: '<hook>', status: hookEvents.length ? 200 : 0,
    headers: {}, body: { json: hookEvents[0] ?? null } });

  // markdown writes on A
  await rec('md: empty body', 'PUT', `/paste/${A}/markdown`, { body: {} });
  await rec('md: non-string', 'PUT', `/paste/${A}/markdown`, { body: { markdown: 5 } });
  await rec('md: invalid json', 'PUT', `/paste/${A}/markdown`, { body: '{x' });
  await rec('md: full write alice/ui', 'PUT', `/paste/${A}/markdown`, { headers: UI, body: { markdown: '# Golden write\n\nSecond.\n', author: 'alice' } });
  const w2 = await rec('md: coalesced write alice/ui', 'PUT', `/paste/${A}/markdown`, { headers: UI, body: { markdown: '# Golden write\n\nSecond, again.\n', author: 'alice' } });
  const h2 = w2.json.content_hash;
  await rec('md: stale If-Match → 412', 'PUT', `/paste/${A}/markdown`, { headers: { 'If-Match': '"0123456789abcdef0123456789abcdef"' }, body: { markdown: 'clobber' } });
  await rec('md: bad patch → 409', 'PUT', `/paste/${A}/markdown`, { body: { patch: '@@ -1 +1 @@\n-not there\n+x\n' } });
  await rec('md: no hunks → 409', 'PUT', `/paste/${A}/markdown`, { body: { patch: 'garbage' } });
  await rec('md: good patch bob/mcp', 'PUT', `/paste/${A}/markdown`, { headers: { ...MCP, 'If-Match': `"${h2}"` }, body: { patch: '@@ -3 +3 @@\n-Second, again.\n+Patched.\n', author: 'bob' } });
  await rec('md: delta without If-Match', 'PUT', `/paste/${A}/markdown`, { body: { delta: { keepStart: 0, keepEnd: 0, insert: 'x' } } });
  await rec('md: delta bad shape', 'PUT', `/paste/${A}/markdown`, { headers: { 'If-Match': '*' }, body: { delta: { keepStart: -1, keepEnd: 0, insert: 'x' } } });
  const cur = (await req(base, 'GET', `/paste/${A}/revisions`)).json.current;
  await rec('md: delta too big → 409', 'PUT', `/paste/${A}/markdown`, { body: { base_hash: cur, delta: { keepStart: 999, keepEnd: 999, insert: 'x' } } });
  await rec('md: delta ok (base_hash)', 'PUT', `/paste/${A}/markdown`, { headers: MCP, body: { base_hash: cur, delta: { keepStart: 0, keepEnd: 0, insert: '> note\n' }, author: 'bob' } });
  await rec('md: If-Match * full write', 'PUT', `/paste/${A}/markdown`, { headers: { 'If-Match': '*' }, body: { markdown: '# Golden write\n\nFinal.\n', author: '  Carol  ' } });
  await rec('md: same content again (no new revision)', 'PUT', `/paste/${A}/markdown`, { body: { markdown: '# Golden write\n\nFinal.\n', author: 'Carol' } });
  await rec('md: filename only', 'PUT', `/paste/${A}/markdown`, { body: { filename: 'renamed.md' } });
  await rec('md: unknown session', 'PUT', '/paste/ffffffffffff/markdown', { body: { markdown: 'x' } });
  await rec('get A markdown', 'GET', `/paste/${A}/markdown`);
  await rec('get A full', 'GET', `/paste/${A}`);
  await rec('get A meta fields', 'GET', `/paste/${A}?fields=meta`);

  // revisions on A
  const revs = await rec('revisions A', 'GET', `/paste/${A}/revisions`);
  for (const r of revs.json?.revisions || []) await rec(`revision A ${r.hash}`, 'GET', `/paste/${A}/revisions/${r.hash}`);
  await rec('revision A current', 'GET', `/paste/${A}/revisions/current`);
  await rec('revision A unknown', 'GET', `/paste/${A}/revisions/${UNKNOWN_HASH}`);

  // fixture sessions after migration
  await rec('seed: write pre-history doc', 'PUT', '/paste/0a0a0a0a0a0a/markdown', { headers: MCP, body: { markdown: '# Pre history doc\n\nNow edited.\n', author: 'agent' } });
  const seeded = await rec('seed: revisions', 'GET', '/paste/0a0a0a0a0a0a/revisions');
  for (const r of seeded.json?.revisions || []) await rec(`seed: revision ${r.hash}`, 'GET', `/paste/0a0a0a0a0a0a/revisions/${r.hash}`);
  await rec('seed: comment-only write adds no revision', 'POST', '/paste/0a0a0a0a0a0a/comments', { body: { startLine: 1, endLine: 1, selectedText: 'Pre', body: 'first comment ever', category: 'praise' } });
  await rec('seed: revisions after comment', 'GET', '/paste/0a0a0a0a0a0a/revisions');
  await rec('seed: full', 'GET', '/paste/0a0a0a0a0a0a');
  await rec('inline legacy: comment', 'POST', '/paste/c3c3c3c3c3c3/comments', { body: { startLine: 1, endLine: 1, selectedText: 'Old', body: 'on legacy', category: 'nit' } });
  await rec('inline legacy: write', 'PUT', '/paste/c3c3c3c3c3c3/markdown', { body: { markdown: '# Old format\n\nRewritten.\n', author: 'x' } });
  await rec('inline legacy: revisions', 'GET', '/paste/c3c3c3c3c3c3/revisions');
  await rec('inline legacy: full', 'GET', '/paste/c3c3c3c3c3c3');
  await rec('id-less: add comment', 'POST', '/paste/d4d4d4d4d4d4/comments', { body: { startLine: 1, endLine: 1, selectedText: 'Agent', body: 'with id', category: 'nit' } });
  await rec('id-less: reply to legacy-1', 'POST', '/paste/agent-created-plan/comments/legacy-1/replies', { body: { body: 'reply via slug' } });
  await rec('id-less: comments', 'GET', '/paste/d4d4d4d4d4d4/comments');
  await rec('id-less: approve', 'PUT', '/paste/d4d4d4d4d4d4/approval', { body: { status: 'approved', approved_by: 'Ivy' } });
  await rec('S1: reply to fixture comment', 'POST', '/paste/a1a1a1a1a1a1/comments/11111111-1111-4111-8111-111111111111/replies', { body: { body: 'late reply', author: 'Zed' } });
  await rec('S1: unresolve fixture comment', 'PUT', '/paste/weekly-routing-status/comments/44444444-4444-4444-8444-444444444444/unresolve');
  await rec('S1: full', 'GET', '/paste/a1a1a1a1a1a1');
  await rec('S9: approve blocked', 'PUT', '/paste/1b1b1b1b1b1b/approval', { body: { status: 'approved' } });
  await rec('S10: write into missing-content session', 'PUT', '/paste/2c2c2c2c2c2c/markdown', { body: { markdown: 'now has content' } });
  await rec('S10: revisions', 'GET', '/paste/2c2c2c2c2c2c/revisions');
  await rec('S10: markdown', 'GET', '/paste/2c2c2c2c2c2c/markdown');
  await rec('expired: get (410)', 'GET', '/paste/old-expired');
  await rec('expired: revisions (410)', 'GET', '/paste/e5e5e5e5e5e5/revisions');
  await rec('expired: un-expire', 'PUT', '/paste/e5e5e5e5e5e5/meta', { body: { expiry_days: null } });
  await rec('expired: get after un-expire', 'GET', '/paste/old-expired');
  await rec('list after un-expire', 'GET', '/paste/list?name=expired');

  // meta on A
  await rec('meta A: rename + slug + 90d', 'PUT', `/paste/${A}/meta`, { body: { sessionName: 'Golden renamed', slug: 'Golden Renamed!', expiry_days: 90 } });
  await rec('meta A: get by new slug', 'GET', '/paste/golden-renamed');
  await rec('meta A: old slug gone', 'GET', '/paste/golden-write');
  await rec('meta A: filename', 'PUT', `/paste/${A}/meta`, { body: { filename: 'meta-renamed.md', expiry_days: 13 } });
  await rec('meta A: clear slug', 'PUT', `/paste/${A}/meta`, { body: { slug: '' } });
  await rec('meta A: slug back', 'PUT', `/paste/${A}/meta`, { body: { slug: 'golden-renamed' } });
  await rec('meta A: never expire', 'PUT', `/paste/${A}/meta`, { body: { expiry_days: null } });
  await rec('meta A: invalid json', 'PUT', `/paste/${A}/meta`, { body: '{x' });
  await rec('meta: unknown session', 'PUT', '/paste/ffffffffffff/meta', { body: { sessionName: 'x' } });
  await rec('meta A: full', 'GET', `/paste/${A}`);

  // files on A
  await rec('files A: add text', 'POST', `/paste/${A}/files`, { body: { name: 'a.txt', content: 'hello' } });
  await rec('files A: add nested base64', 'POST', `/paste/${A}/files`, { body: { name: 'img/b.bin', content: Buffer.from([0, 1, 2, 250]).toString('base64'), encoding: 'base64' } });
  await rec('files A: overwrite text', 'POST', `/paste/${A}/files`, { body: { name: 'a.txt', content: 'hello again' } });
  await rec('files A: missing fields', 'POST', `/paste/${A}/files`, { body: { name: 'x.txt' } });
  await rec('files A: traversal', 'POST', `/paste/${A}/files`, { body: { name: '../evil.txt', content: 'x' } });
  await rec('files A: invalid json', 'POST', `/paste/${A}/files`, { body: '{x' });
  await rec('files A: list', 'GET', `/paste/${A}/files`);
  await rec('files A: get a.txt', 'GET', `/paste/${A}/files/a.txt`);
  await rec('files A: get nested (encoded)', 'GET', `/paste/${A}/files/img%2Fb.bin`);
  await rec('files A: delete a.txt', 'DELETE', `/paste/${A}/files/a.txt`);
  await rec('files A: delete again', 'DELETE', `/paste/${A}/files/a.txt`);
  await rec('files A: full shows files', 'GET', `/paste/${A}`);
  await rec('files A: list endpoint shows file_count', 'GET', '/paste/list?name=golden');
  await rec('files: unknown session', 'GET', '/paste/ffffffffffff/files');

  // chunked uploads on A
  const up = await rec('upload: start (markdown)', 'POST', `/paste/${A}/upload/start`, { headers: UI, body: { totalChunks: 2, filename: 'chunked.md', author: 'up' } });
  const uid = up.json?.uploadId;
  await rec('upload: chunk 0', 'POST', `/paste/${A}/upload/chunk`, { body: { uploadId: uid, index: 0, data: '# Chunked\n\npart one, ' } });
  await rec('upload: chunk 1', 'POST', `/paste/${A}/upload/chunk`, { body: { uploadId: uid, index: 1, data: 'part two.\n' } });
  await rec('upload: chunk missing fields', 'POST', `/paste/${A}/upload/chunk`, { body: { uploadId: uid } });
  await rec('upload: chunk unknown upload', 'POST', `/paste/${A}/upload/chunk`, { body: { uploadId: '0000000000000000', index: 0, data: 'x' } });
  await rec('upload: complete', 'POST', `/paste/${A}/upload/complete`, { body: { uploadId: uid } });
  await rec('upload: complete again', 'POST', `/paste/${A}/upload/complete`, { body: { uploadId: uid } });
  await rec('upload: markdown after', 'GET', `/paste/${A}/markdown`);
  const up2 = await rec('upload: start (file)', 'POST', `/paste/${A}/upload/start`, { body: { target: 'file', filename: 'big.txt' } });
  await rec('upload: file chunk', 'POST', `/paste/${A}/upload/chunk`, { body: { uploadId: up2.json?.uploadId, index: 0, data: 'big file body' } });
  await rec('upload: file complete', 'POST', `/paste/${A}/upload/complete`, { body: { uploadId: up2.json?.uploadId } });
  await rec('upload: files after', 'GET', `/paste/${A}/files`);
  await rec('upload: start unknown session', 'POST', '/paste/ffffffffffff/upload/start', { body: {} });
  await rec('upload: revisions after', 'GET', `/paste/${A}/revisions`);

  // lists
  await rec('list name=golden', 'GET', '/paste/list?name=golden');
  await rec('list limit=4', 'GET', '/paste/list?limit=4');
  await rec('list status=changes_requested', 'GET', '/paste/list?status=changes_requested');
  await rec('list status=approved', 'GET', '/paste/list?status=approved');

  // sites
  await rec('site: create', 'POST', '/site', { body: { name: 'Golden site', files: { 'index.html': '<h1>golden</h1>', 'css/s.css': 'h1{color:red}' }, expiry_days: 7 } });
  await pause(15);
  await rec('site: create same name', 'POST', '/site', { body: { name: 'Golden site', files: { 'index.html': 'two' }, spa: false, expiry_days: null } });
  await rec('site: wrong content type', 'POST', '/site', { headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  await rec('site: missing name', 'POST', '/site', { body: { files: { 'index.html': 'x' } } });
  await rec('site: no files', 'POST', '/site', { body: { name: 'x' } });
  await rec('site: traversal', 'POST', '/site', { body: { name: 'evil', files: { '../x.html': 'x' } } });
  await rec('site: list', 'GET', '/site/list');
  await rec('site: index', 'GET', '/site/golden-site/');
  await rec('site: css', 'GET', '/site/golden-site/css/s.css');
  await rec('site: second (spa off) missing', 'GET', '/site/golden-site-2/missing');
  await rec('site: delete', 'DELETE', '/site/golden-site');
  await rec('site: gone', 'GET', '/site/golden-site/');
  await rec('site: delete again', 'DELETE', '/site/golden-site');
  await rec('site: session slug untouched', 'GET', '/paste/golden-renamed?fields=meta');
  await rec('site: list after delete', 'GET', '/site/list');

  // delete
  await rec('delete A', 'DELETE', `/paste/${A}`);
  await rec('delete A: get', 'GET', `/paste/${A}`);
  await rec('delete A: slug gone', 'GET', '/paste/golden-renamed');
  await rec('delete A: revisions gone', 'GET', `/paste/${A}/revisions`);
  await rec('delete A: files gone', 'GET', `/paste/${A}/files`);
  await rec('delete A: again', 'DELETE', `/paste/${A}`);
  await rec('delete A: slug reusable', 'POST', '/paste', { body: { markdown: 'again', sessionName: 'Golden renamed' } });
  await pause(15);
  await rec('delete S1 (fixture with files)', 'DELETE', '/paste/weekly-routing-status');
  await rec('delete S1: get', 'GET', '/paste/a1a1a1a1a1a1');
  await rec('delete S1: files', 'GET', '/paste/a1a1a1a1a1a1/files/diagram.png');
  await rec('list final', 'GET', '/paste/list');
  return E;
}

// ── normalisation ─────────────────────────────────────────────────────────

const isFileList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x)
  && typeof x.name === 'string' && typeof x.size === 'number' && 'type' in x);

/**
 * Normalise entries in place-order. `known` = fixtureKnownValues(); `literals`
 * = { '<string>': '<placeholder>' } (e.g. the webhook URL).
 */
export function normalizeEntries(entries, known, literals = {}) {
  const map = new Map();
  let n = 0;
  const ph = (kind, v) => {
    if (!map.has(v)) map.set(v, `<${kind}:${++n}>`);
    return map.get(v);
  };
  const subst = (s) => {
    for (const [lit, rep] of Object.entries(literals)) if (lit) s = s.split(lit).join(rep);
    s = s.replace(UUID_RE, (m) => (known.has(m) ? m : ph('uuid', m)));
    s = s.replace(HEXID_RE, (m) => (known.has(m) ? m : ph('hex', m)));
    return s;
  };
  const norm = (v) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      if (ISO_RE.test(v) && !known.has(v)) return '<time>';
      return subst(v);
    }
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v > 1e12 && v < 1e13 && !known.has(`n:${v}`)) return '<ms>';
      return v;
    }
    if (Array.isArray(v)) {
      const arr = isFileList(v) ? [...v].sort((x, y) => x.name.localeCompare(y.name)) : v;
      return arr.map(norm);
    }
    if (typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
      return o;
    }
    return v;
  };
  return entries.map((e) => ({ ...e, path: subst(e.path), body: norm(e.body) }));
}

// ── comparison ──────────────────────────────────────────────────────────────

// Keys later items may ADD (spec 20 rule 5 / 00 §10.5). `content_hash` and
// `comments` may be added where the legacy server omitted them (rule 5 lists
// them as always-present on full GETs).
const ADDITIVE = new Set(['view', 'agentSections', 'mode', 'id', 'access', 'upsert_key', 'note', 'editToken', 'editUrl', 'url', 'viewUrl', 'app_url', 'expiry_days', 'shareUrl', 'created_by', 'content_hash', 'comments']);
const VALID_MODES = new Set(['publish', 'review']);
// #2: a pinned revision never GETs /paste/<id>, so a revision body
// (GET /paste/:id/revisions/:hash, recognised by `is_current`) also carries the
// doc's name (and `mode`, above) for the reader header.
const REVISION_ADDITIVE = new Set(['sessionName', 'filename']);

function isPlain(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlain(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
// Served file / site bytes are user data: compared exactly, no API allowances.
const STRICT_PATH = /\/files\/.+|^\/site\/(?!list$)|^\/assets\//;

function cmp(g, a, at, diffs, strict = false, depth = 0) {
  if (strict) {
    if (JSON.stringify(sortKeys(g)) !== JSON.stringify(sortKeys(a))) diffs.push(`${at}: differs (strict) — got ${JSON.stringify(a)?.slice(0, 160)}, legacy ${JSON.stringify(g)?.slice(0, 160)}`);
    return;
  }
  // Additive keys and the mode rule apply to API objects (session, list item,
  // revision entry …), never deep inside user data such as stored meta values.
  if (depth > 3) strict = true;
  if (strict) return cmp(g, a, at, diffs, true, depth);
  if (isPlain(g) && isPlain(a)) {
    for (const k of Object.keys(a)) if (k === 'edit_token_hash') diffs.push(`${at}.edit_token_hash must never appear`);
    for (const k of Object.keys(g)) {
      if (k === 'mode' && depth <= 2) {
        const want = VALID_MODES.has(g.mode) ? g.mode : 'review';
        if (a.mode !== want) diffs.push(`${at}.mode: expected ${JSON.stringify(want)} (legacy ${JSON.stringify(g.mode)}), got ${JSON.stringify(a.mode)}`);
        continue;
      }
      if (!(k in a)) { diffs.push(`${at}.${k}: missing (legacy ${JSON.stringify(g[k])?.slice(0, 120)})`); continue; }
      cmp(g[k], a[k], `${at}.${k}`, diffs, false, depth + 1);
    }
    for (const k of Object.keys(a)) {
      if (k in g) continue;
      if (!ADDITIVE.has(k) && !(REVISION_ADDITIVE.has(k) && 'is_current' in g)) { diffs.push(`${at}.${k}: unexpected new key (value ${JSON.stringify(a[k])?.slice(0, 120)})`); continue; }
      if (k === 'mode' && !VALID_MODES.has(a.mode)) diffs.push(`${at}.mode: invalid value ${JSON.stringify(a.mode)}`);
      if (k === 'comments' && !(Array.isArray(a.comments) && a.comments.length === 0)) diffs.push(`${at}.comments: added key must be [] (got ${JSON.stringify(a.comments).slice(0, 120)})`);
      if (k === 'content_hash' && !/^[0-9a-f]{32}$/.test(String(a.content_hash))) diffs.push(`${at}.content_hash: added key must be an md5`);
    }
    return;
  }
  if (Array.isArray(g) && Array.isArray(a)) {
    if (g.length !== a.length) { diffs.push(`${at}: array length ${a.length}, legacy ${g.length}`); }
    for (let i = 0; i < Math.min(g.length, a.length); i++) cmp(g[i], a[i], `${at}[${i}]`, diffs, false, depth + 1);
    return;
  }
  if (g !== a) diffs.push(`${at}: got ${JSON.stringify(a)?.slice(0, 160)}, legacy ${JSON.stringify(g)?.slice(0, 160)}`);
}

// Legacy behaviours a later fix changed on purpose, by entry name → check of the new answer
// (null = as intended). Justified in docs/build/reports/fix-api.md.
const INTENDED_CHANGES = {
  // persona-agent #5: a renamed doc keeps its old slug as an alias, so links already handed out keep working.
  'meta A: old slug gone': (a) => (a.status === 200 && a.body?.json?.slug === 'golden-renamed'
    ? null : `expected the old slug to resolve to the renamed doc (200, slug golden-renamed), got ${a.status} ${JSON.stringify(a.body)?.slice(0, 120)}`),
};

/** Compare normalised entry lists; returns human-readable diffs (empty = equal). */
export function compareEntries(golden, actual) {
  const diffs = [];
  if (golden.length !== actual.length) diffs.push(`entry count ${actual.length}, golden ${golden.length}`);
  for (let i = 0; i < Math.min(golden.length, actual.length); i++) {
    const g = golden[i]; const a = actual[i];
    const where = `#${i} ${g.name}`;
    if (g.name !== a.name || g.method !== a.method || g.path !== a.path) { diffs.push(`${where}: request mismatch (${a.method} ${a.path} vs ${g.method} ${g.path})`); continue; }
    if (INTENDED_CHANGES[g.name]) {
      const problem = INTENDED_CHANGES[g.name](a);
      if (problem) diffs.push(`${where}: ${problem}`);
      continue;
    }
    if (g.lenient === 'invalid-regex') {
      if (![400, 500].includes(a.status)) diffs.push(`${where}: status ${a.status}, expected 400 (or legacy 500)`);
      continue;
    }
    if (g.status !== a.status) diffs.push(`${where}: status ${a.status}, legacy ${g.status}`);
    if (g.headers.contentType !== a.headers.contentType) diffs.push(`${where}: content-type ${a.headers.contentType}, legacy ${g.headers.contentType}`);
    // #23: responses carrying a raw edit token add Cache-Control: no-store (additive).
    const tokenNoStore = g.headers.cacheControl == null && a.headers.cacheControl === 'no-store' && !!a.body?.json?.editToken;
    if (g.headers.cacheControl !== a.headers.cacheControl && !tokenNoStore) diffs.push(`${where}: cache-control ${a.headers.cacheControl}, legacy ${g.headers.cacheControl}`);
    if (g.headers.etag && !a.headers.etag) diffs.push(`${where}: ETag header missing`);
    const before = diffs.length;
    if (g.body === null || a.body === null) {
      if (g.body !== a.body) diffs.push(`${where}: body ${JSON.stringify(a.body)?.slice(0, 120)}, legacy ${JSON.stringify(g.body)?.slice(0, 120)}`);
    } else {
      cmp(g.body, a.body, `${where} body`, diffs, STRICT_PATH.test(g.path));
    }
    if (diffs.length - before > 20) diffs.splice(before + 20, Infinity, `${where}: … more body diffs truncated`);
  }
  return diffs;
}
