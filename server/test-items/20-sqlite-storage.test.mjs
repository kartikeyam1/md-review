// Item #20 — SQLite + FTS5 storage, boot safety, GET /library/docs, CORS.
// Spec: docs/build/specs/20-sqlite-storage.md (+ 00 §5, §8, §9).
// Migration-script ACs live in 20-migration.test.mjs, golden compatibility in
// 20-golden-compat.test.mjs, real-data verification in 20-real-data.test.mjs.
//
// Every test boots its own backend(s) on throwaway data dirs; PASTE_API is not used.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  startServer, spawnExpectingExit, tmpDir, copyToTmp, cleanupTmp, http, openDbReadOnly, snapshotTree, diffSnapshots,
  runMigrate, LEGACY_FIXTURE, DB_NAME,
} from './lib/20-helpers.mjs';

const md5 = (s) => crypto.createHash('md5').update(Buffer.from(s, 'utf-8')).digest('hex');
const qs = (params) => new URLSearchParams(params).toString();
const docs = (base, params = {}) => http(base, 'GET', `/library/docs${Object.keys(params).length ? `?${qs(params)}` : ''}`);
async function docsOk(base, params = {}) {
  const r = await docs(base, params);
  assert.equal(r.status, 200, `GET /library/docs?${qs(params)} → ${r.status} ${r.text.slice(0, 200)}`);
  return r;
}
const hits = (item) => (item?.match?.snippet || []).filter((s) => s.hit).map((s) => s.text);
const uniq = () => crypto.randomBytes(3).toString('hex');

async function create(base, body, headers = {}) {
  const r = await http(base, 'POST', '/paste', { body, headers });
  assert.equal(r.status, 200, `POST /paste failed: ${r.status} ${r.text}`);
  return r.json;
}
async function putMd(base, id, body, headers = {}) {
  const r = await http(base, 'PUT', `/paste/${id}/markdown`, { body, headers });
  assert.equal(r.status, 200, `PUT markdown failed: ${r.status} ${r.text}`);
  return r.json;
}

after(cleanupTmp);

// One fresh server (empty data dir) shared by the FTS / CORS / schema tests.
let S; let sDir;
before(async () => {
  sDir = tmpDir('md-review-20-main');
  S = await startServer({ dataDir: sDir });
});
after(async () => { await S?.stop(); });

// ── AC-20.1 schema ────────────────────────────────────────────────────────

const REQUIRED_COLUMNS = {
  sessions: ['id', 'slug', 'session_name', 'filename', 'content_type', 'approval_status', 'approved_by', 'approved_at',
    'shared_at', 'expires_at', 'callback_url', 'mode', 'upsert_key', 'edit_token_hash', 'created_by', 'from_template_json',
    'extra_json', 'version', 'created_at', 'updated_at'],
  contents: ['session_id', 'markdown', 'content_hash'],
  revisions: ['session_id', 'seq', 'hash', 'at', 'at_end', 'by', 'client', 'size', 'parent', 'writes', 'seeded', 'note', 'blob'],
  comments: ['pk', 'session_id', 'ord', 'id', 'data_json'],
  replies: ['pk', 'comment_pk', 'ord', 'id', 'data_json'],
  files: ['session_id', 'name', 'size', 'type', 'updated_at'],
  slugs: ['slug', 'kind', 'target_id'],
  sites: ['id', 'slug', 'name', 'created_at', 'expires_at', 'file_count', 'spa'],
  schema_meta: ['key', 'value'],
};
const LATER_TABLES = ['reactions', 'views', 'collections', 'collection_items', 'tags', 'session_tags', 'pins', 'templates'];

describe('AC-20.1 schema on a fresh DATA_DIR', () => {
  test('AC-20.1 md-review.sqlite exists with every rule-2 table and schema_version = 1', async () => {
    const dbPath = path.join(sDir, DB_NAME);
    assert.ok(fs.existsSync(dbPath), `${DB_NAME} must exist in DATA_DIR after boot`);
    const db = await openDbReadOnly(dbPath);
    try {
      const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name));
      for (const t of [...Object.keys(REQUIRED_COLUMNS), ...LATER_TABLES, 'doc_fts']) assert.ok(names.has(t), `table ${t} missing`);
      for (const [t, cols] of Object.entries(REQUIRED_COLUMNS)) {
        const have = new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name));
        for (const c of cols) assert.ok(have.has(c), `${t}.${c} missing`);
      }
      const v = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
      assert.equal(String(v?.value), '1');
      assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
    } finally { db.close(); }
  });

  test('AC-20.1 doc_fts is FTS5 with the 00 §8 columns, tokenizer and prefix indexes', async () => {
    const db = await openDbReadOnly(path.join(sDir, DB_NAME));
    try {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'doc_fts'").get();
      const sql = String(row?.sql || '').replace(/["`]/g, "'").replace(/\s+/g, ' ');
      assert.match(sql, /using fts5/i);
      assert.match(sql, /unicode61 remove_diacritics 2/);
      assert.match(sql, /prefix\s*=\s*'2 3'/);
      assert.match(sql, /session_id UNINDEXED/i);
      assert.match(sql, /file_name UNINDEXED/i);
      const cols = db.prepare('PRAGMA table_info(doc_fts)').all().map((c) => c.name);
      assert.deepEqual(cols.slice(0, 5), ['title', 'filename', 'content', 'session_id', 'file_name']);
    } finally { db.close(); }
  });

  test('AC-20.1 DB_PATH overrides the DB location', async () => {
    const dir = tmpDir('md-review-20-dbpath');
    const dbFile = path.join(tmpDir('md-review-20-dbpath-db'), 'custom.sqlite');
    const s = await startServer({ dataDir: dir, env: { DB_PATH: dbFile } });
    try {
      assert.ok(fs.existsSync(dbFile), 'DB must be created at DB_PATH');
      assert.ok(!fs.existsSync(path.join(dir, DB_NAME)), 'no DB in DATA_DIR when DB_PATH is set');
    } finally { await s.stop(); }
  });

  test('R-20.2 sessions.version increments on every write; one doc_fts row per session (file_name = \'\') removed on delete', async () => {
    const { id } = await create(S.url, { markdown: '# Versioned\n\nbody', filename: 'v.md' });
    const db0 = await openDbReadOnly(path.join(sDir, DB_NAME));
    let v1;
    try {
      v1 = db0.prepare('SELECT version FROM sessions WHERE id = ?').get(id)?.version;
      assert.ok(Number.isInteger(Number(v1)), 'sessions row with integer version');
      assert.equal(db0.prepare("SELECT count(*) AS c FROM doc_fts WHERE session_id = ? AND file_name = ''").get(id).c, 1);
    } finally { db0.close(); }
    const c = await http(S.url, 'POST', `/paste/${id}/comments`, { body: { startLine: 1, endLine: 1, selectedText: 'V', body: 'x', category: 'nit' } });
    assert.equal(c.status, 201);
    await putMd(S.url, id, { markdown: '# Versioned\n\nbody 2' });
    const db1 = await openDbReadOnly(path.join(sDir, DB_NAME));
    try {
      const v3 = db1.prepare('SELECT version FROM sessions WHERE id = ?').get(id).version;
      assert.ok(Number(v3) >= Number(v1) + 2, `version must increase per write (was ${v1}, now ${v3})`);
      assert.equal(db1.prepare('SELECT content_hash FROM contents WHERE session_id = ?').get(id).content_hash, md5('# Versioned\n\nbody 2'));
    } finally { db1.close(); }
    assert.equal((await http(S.url, 'DELETE', `/paste/${id}`)).status, 204);
    const db2 = await openDbReadOnly(path.join(sDir, DB_NAME));
    try {
      assert.equal(db2.prepare('SELECT count(*) AS c FROM doc_fts WHERE session_id = ?').get(id).c, 0);
      assert.equal(db2.prepare('SELECT count(*) AS c FROM sessions WHERE id = ?').get(id).c, 0);
    } finally { db2.close(); }
  });
});

// ── AC-20.7 boot safety ──────────────────────────────────────────────────

describe('AC-20.7 boot safety', () => {
  test('AC-20.7 legacy *.json sessions and no DB → exits non-zero naming migrate-json-to-sqlite.mjs, creates no DB, touches nothing', async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-unmigrated');
    const before = snapshotTree(dir);
    const r = await spawnExpectingExit({ dataDir: dir, timeoutMs: 6000 });
    assert.notEqual(r.signal, 'TIMEOUT', `server must refuse to boot, but it kept running. stdout: ${r.stdout.slice(0, 300)}`);
    assert.ok(r.code !== 0 && r.code !== null, `exit code must be non-zero (got ${r.code}, signal ${r.signal})`);
    assert.match(r.stderr, /migrate-json-to-sqlite\.mjs/, 'stderr must name the migration script');
    assert.ok(!fs.existsSync(path.join(dir, DB_NAME)), 'refusing to boot must not leave an (empty) DB behind');
    assert.deepEqual(diffSnapshots(before, snapshotTree(dir)), [], 'legacy files must not be read-converted or changed');
  });

  test('AC-20.7 with ALLOW_EMPTY_DB=1 it starts, serves an empty DB and never reads legacy JSON', async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-allow-empty');
    const legacyBefore = snapshotTree(dir, { exclude: (rel) => rel.startsWith(DB_NAME) || rel.startsWith('chunks') });
    const s = await startServer({ dataDir: dir, env: { ALLOW_EMPTY_DB: '1' } });
    try {
      assert.equal((await http(s.url, 'GET', '/')).status, 200);
      assert.equal((await http(s.url, 'GET', '/paste/a1a1a1a1a1a1')).status, 404, 'legacy sessions are not served without migration');
      assert.equal((await http(s.url, 'GET', '/paste/c3c3c3c3c3c3')).status, 404);
      const list = await http(s.url, 'GET', '/paste/list');
      assert.deepEqual(list.json, []);
    } finally { await s.stop(); }
    const legacyAfter = snapshotTree(dir, { exclude: (rel) => rel.startsWith(DB_NAME) || rel.startsWith('chunks') });
    assert.deepEqual(diffSnapshots(legacyBefore, legacyAfter), [], 'inline-markdown meta must not be converted at boot or on read');
  });

  test('AC-20.7 index files alone (_slug-index.json / _site-index.json) do not block boot', async () => {
    const dir = tmpDir('md-review-20-index-only');
    fs.writeFileSync(path.join(dir, '_slug-index.json'), '{}');
    fs.writeFileSync(path.join(dir, '_site-index.json'), '{}');
    const s = await startServer({ dataDir: dir });
    try { assert.equal((await http(s.url, 'GET', '/')).status, 200); } finally { await s.stop(); }
  });

  test('AC-20.7 an existing DB boots even when legacy JSON is still present (post-migration)', async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-migrated-boot');
    const m = runMigrate(['--data-dir', dir]);
    assert.equal(m.status, 0, `migration failed: ${m.stdout}\n${m.stderr}`);
    const s = await startServer({ dataDir: dir });
    try { assert.equal((await http(s.url, 'GET', '/paste/a1a1a1a1a1a1')).status, 200); } finally { await s.stop(); }
  });
});

// ── AC-20.8 … AC-20.14 search (00 §8) ────────────────────────────────────

describe('GET /library/docs search (00 §8)', () => {
  let routingId; let cafeId;
  before(async () => {
    routingId = (await create(S.url, { markdown: '# Weekly routing status\n\nNumbers for the week.\n', filename: 'weekly.md', sessionName: 'Weekly routing status' })).id;
    cafeId = (await create(S.url, { markdown: '# Meeting notes\n\nWe met at the café on Friday and talked.\n', filename: 'notes.md', sessionName: 'Meeting notes' })).id;
  });

  test('AC-20.8 q=rout → title match with a hit segment "routing"; q=cafe → content match with hit "café"', async () => {
    const r1 = await docs(S.url, { q: 'rout' });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.query, 'rout');
    const it1 = r1.json.items.find((i) => i.id === routingId);
    assert.ok(it1, 'routing doc must match q=rout');
    assert.equal(it1.match.field, 'title');
    assert.ok(hits(it1).includes('routing'), `hit segments ${JSON.stringify(it1.match.snippet)} must include "routing"`);

    const r2 = await docs(S.url, { q: 'cafe' });
    assert.equal(r2.status, 200);
    const it2 = r2.json.items.find((i) => i.id === cafeId);
    assert.ok(it2, 'café doc must match q=cafe (diacritics removed)');
    assert.equal(it2.match.field, 'content');
    assert.ok(hits(it2).includes('café'), `hit segments ${JSON.stringify(it2.match.snippet)} must include "café"`);
    // segments are plain text that concatenate to an excerpt containing the term
    assert.ok(it2.match.snippet.every((s) => typeof s.text === 'string' && typeof s.hit === 'boolean'));
    assert.match(it2.match.snippet.map((s) => s.text).join(''), /café/);
    assert.equal(it2.match.file, null);
  });

  test('AC-20.8 response and item shape follow 00 §8 (later-item fields at their empty values)', async () => {
    const r = await docs(S.url, { q: 'routing' });
    assert.equal(r.status, 200);
    for (const k of ['query', 'total', 'next_cursor', 'items']) assert.ok(k in r.json, `response.${k}`);
    assert.equal(typeof r.json.total, 'number');
    const it = r.json.items.find((i) => i.id === routingId);
    assert.ok(it);
    for (const k of ['id', 'slug', 'title', 'filename', 'contentType', 'mode', 'created_by', 'created_at', 'updated_at', 'collection',
      'tags', 'file_count', 'reaction_count', 'view_count', 'must_fix_unresolved', 'pinned', 'match']) assert.ok(k in it, `item.${k}`);
    assert.equal(it.title, 'Weekly routing status');
    assert.equal(it.slug, 'weekly-routing-status');
    assert.equal(it.filename, 'weekly.md');
    assert.equal(it.contentType, 'markdown');
    assert.ok(['publish', 'review'].includes(it.mode));
    assert.equal(it.created_by, null);
    assert.equal(it.collection, null);
    assert.deepEqual(it.tags, []);
    assert.equal(it.file_count, 0);
    assert.equal(it.reaction_count, null);
    assert.equal(it.view_count, null);
    assert.equal(it.must_fix_unresolved, 0);
    assert.equal(it.pinned, false);
    assert.equal(r.json.items.length <= r.json.total, true);
  });

  test('AC-20.9 a title match ranks above a body-only match (default sort)', async () => {
    const term = `zanzib${uniq()}`;
    const titleDoc = (await create(S.url, { markdown: 'Nothing relevant in the body.', filename: 'a.md', sessionName: `${term} logistics` })).id;
    // created later (newer) and mentions the term many times: must still rank below
    const bodyDoc = (await create(S.url, { markdown: `${term} ${term} ${term}\n\nMore ${term} here and ${term} there.`, filename: 'b.md', sessionName: 'Other doc' })).id;
    const r = await docs(S.url, { q: term });
    assert.equal(r.status, 200);
    const ids = r.json.items.map((i) => i.id);
    assert.ok(ids.includes(titleDoc) && ids.includes(bodyDoc), `both docs must match (${ids})`);
    assert.ok(ids.indexOf(titleDoc) < ids.indexOf(bodyDoc), 'title match must rank first');
    assert.equal(r.json.total, 2);
  });

  test('AC-20.10 FTS syntax in q never causes a 4xx/5xx', async () => {
    for (const q of ['"', 'foo-bar', 'a:b', '(', 'NEAR', '*', ')', '^', 'AND', 'OR', 'NOT', '-', '"unbalanced', 'a AND (b OR', 'NEAR(a b)', 'col:x*', "'", '\\', '🚚', '%']) {
      const r = await docs(S.url, { q });
      assert.equal(r.status, 200, `q=${JSON.stringify(q)} → ${r.status} ${r.text.slice(0, 200)}`);
      assert.ok(Array.isArray(r.json.items), `q=${JSON.stringify(q)} items array`);
    }
  });

  test('R-20.6 tokens are prefix-matched and ANDed; diacritics fold both ways', async () => {
    const both = await docsOk(S.url, { q: 'week stat' });
    assert.ok(both.json.items.some((i) => i.id === routingId), 'all prefixes present → match');
    const notAll = await docsOk(S.url, { q: `weekly nomatch${uniq()}` });
    assert.ok(!notAll.json.items.some((i) => i.id === routingId), 'tokens are ANDed');
    const accented = await docsOk(S.url, { q: 'café' });
    assert.ok(accented.json.items.some((i) => i.id === cafeId), 'accented query matches too');
  });

  test('R-20.6 filename matches report match.field = filename', async () => {
    const term = `quokkaplan${uniq()}`;
    const id = (await create(S.url, { markdown: 'unrelated body', filename: `${term}.md`, sessionName: 'Some other title' })).id;
    const r = await docsOk(S.url, { q: term });
    const it = r.json.items.find((i) => i.id === id);
    assert.ok(it, 'filename-only match must be found');
    assert.equal(it.match.field, 'filename');
  });

  test('AC-20.12 content change alpha → beta re-indexes; delete removes from the index', async () => {
    const alpha = `alphawomb${uniq()}`; const beta = `betawomb${uniq()}`;
    const { id } = await create(S.url, { markdown: `# Doc\n\nThe word ${alpha} is here.`, filename: 'ab.md' });
    assert.ok((await docsOk(S.url, { q: alpha })).json.items.some((i) => i.id === id), 'alpha matches before the change');
    await putMd(S.url, id, { markdown: `# Doc\n\nThe word ${beta} is here.` });
    assert.ok(!(await docsOk(S.url, { q: alpha })).json.items.some((i) => i.id === id), 'alpha no longer matches');
    assert.ok((await docsOk(S.url, { q: beta })).json.items.some((i) => i.id === id), 'beta matches');
    assert.equal((await http(S.url, 'DELETE', `/paste/${id}`)).status, 204);
    assert.equal((await docsOk(S.url, { q: alpha })).json.items.length, 0);
    assert.equal((await docsOk(S.url, { q: beta })).json.items.length, 0);
  });

  test('R-20.6 renaming (sessionName via PUT /meta) re-indexes the title', async () => {
    const before = `oldtitle${uniq()}`; const afterName = `newtitle${uniq()}`;
    const { id } = await create(S.url, { markdown: 'body', filename: 'r.md', sessionName: before });
    const m = await http(S.url, 'PUT', `/paste/${id}/meta`, { body: { sessionName: afterName } });
    assert.equal(m.status, 200);
    assert.ok(!(await docsOk(S.url, { q: before })).json.items.some((i) => i.id === id));
    const r = await docsOk(S.url, { q: afterName });
    const it = r.json.items.find((i) => i.id === id);
    assert.ok(it); assert.equal(it.match.field, 'title'); assert.equal(it.title, afterName);
  });

  test('AC-20.14 HTML docs index visible text only (no <script>/<style> contents)', async () => {
    const html = '<!doctype html><html><head><title>Html doc</title><style>.stylesecretzz{color:red}</style></head>'
      + '<body><script>var secretvar = "x";</script><p>visible words</p></body></html>';
    const { id } = await create(S.url, { markdown: html, filename: 'page.html', contentType: 'html' });
    assert.ok(!(await docsOk(S.url, { q: 'secretvar' })).json.items.some((i) => i.id === id), 'script text must not be searchable');
    assert.ok(!(await docsOk(S.url, { q: 'stylesecretzz' })).json.items.some((i) => i.id === id), 'style text must not be searchable');
    const v = await docsOk(S.url, { q: 'visible' });
    const it = v.json.items.find((i) => i.id === id);
    assert.ok(it, 'visible text must match');
    assert.equal(it.contentType, 'html');
    assert.equal(it.title, 'Html doc', 'HTML <title> is the doc title (00 §5)');
    assert.ok(!JSON.stringify(it.match.snippet).includes('<p>'), 'snippet is plain text, no tags');
  });

  test('R-20.6 filters: unknown collection / tag give items [], mode/type filters, invalid sort / cursor', async () => {
    for (const p of [{ collection: 'no-such-collection' }, { tag: 'no-such-tag' }, { q: 'routing', collection: 'nope' }]) {
      const r = await docs(S.url, p);
      assert.equal(r.status, 200, JSON.stringify(p));
      assert.deepEqual(r.json.items, []);
    }
    const html = await docs(S.url, { type: 'html', limit: '100' });
    assert.equal(html.status, 200);
    assert.ok(html.json.items.length >= 1 && html.json.items.every((i) => i.contentType === 'html'));
    const md = await docsOk(S.url, { type: 'md', limit: '100' });
    assert.ok(md.json.items.every((i) => i.contentType === 'markdown'));
    for (const mode of ['publish', 'review']) {
      const r = await docs(S.url, { mode, limit: '100' });
      assert.equal(r.status, 200);
      assert.ok(r.json.items.every((i) => i.mode === mode));
    }
    const bogus = await docs(S.url, { sort: 'bogus' });
    assert.equal(bogus.status, 400);
    assert.deepEqual(bogus.json, { error: 'invalid sort' });
    for (const sort of ['updated', 'created', 'title', 'views', 'relevance']) assert.equal((await docsOk(S.url, { sort })).status, 200, sort);
    const future = await docs(S.url, { updated_after: '2999-01-01T00:00:00.000Z' });
    assert.equal(future.status, 200);
    assert.deepEqual(future.json.items, []);
    const all = await docsOk(S.url, { updated_after: '2000-01-01T00:00:00.000Z' });
    assert.ok(all.json.items.length > 0);
  });
});

// ── AC-20.13 list mode + paging on its own server ─────────────────────────

describe('AC-20.13 list mode and cursor paging', () => {
  let L; const ids = new Set();
  before(async () => {
    L = await startServer({ dataDir: tmpDir('md-review-20-list') });
    for (let i = 0; i < 105; i++) {
      const { id } = await create(L.url, { markdown: `# Doc ${i}\n\nbody ${i}`, filename: `d${i}.md`, sessionName: `List doc ${String(i).padStart(3, '0')}` });
      ids.add(id);
    }
  });
  after(async () => { await L?.stop(); });

  test('AC-20.13 no / blank q → list mode: query null, match null, updated_at desc, default limit 50', async () => {
    for (const p of [{}, { q: '' }, { q: '   ' }]) {
      const r = await docs(L.url, p);
      assert.equal(r.status, 200, JSON.stringify(p));
      assert.equal(r.json.query, null);
      assert.equal(r.json.total, 105);
      assert.equal(r.json.items.length, 50, 'default limit is 50');
      assert.ok(r.json.items.every((i) => i.match === null));
      for (let k = 1; k < r.json.items.length; k++) {
        assert.ok(r.json.items[k - 1].updated_at >= r.json.items[k].updated_at, `items sorted by updated_at desc at ${k}`);
      }
    }
  });

  test('AC-20.13 limit=500 is capped at 100 with a next_cursor; cursors visit every doc exactly once', async () => {
    const big = await docs(L.url, { limit: '500' });
    assert.equal(big.status, 200);
    assert.ok(big.json.items.length <= 100 && big.json.items.length > 0);
    assert.notEqual(big.json.next_cursor, null);
    const seen = [];
    let cursor = null; let pages = 0;
    do {
      const r = await docs(L.url, { limit: '40', ...(cursor ? { cursor } : {}) });
      assert.equal(r.status, 200);
      seen.push(...r.json.items.map((i) => i.id));
      cursor = r.json.next_cursor;
      assert.ok(++pages < 20, 'paging must terminate');
    } while (cursor);
    assert.equal(seen.length, 105, 'every doc once');
    assert.equal(new Set(seen).size, 105, 'no duplicates');
    assert.deepEqual(new Set(seen), ids);
  });

  test('AC-20.13 sort=bogus → 400; a cursor reused with different filters → 400 invalid cursor', async () => {
    const r = await docs(L.url, { sort: 'bogus' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: 'invalid sort' });
    const p1 = await docsOk(L.url, { limit: '10' });
    assert.ok(p1.json.next_cursor);
    const bad = await docs(L.url, { limit: '10', type: 'html', cursor: p1.json.next_cursor });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'invalid cursor' });
  });

  test('R-20.6 sort=title is case-insensitive A→Z; sort=created is newest first', async () => {
    const t = await docsOk(L.url, { sort: 'title', limit: '100' });
    const titles = t.json.items.map((i) => i.title.toLowerCase());
    assert.deepEqual(titles, [...titles].sort());
    const c = await docsOk(L.url, { sort: 'created', limit: '100' });
    for (let k = 1; k < c.json.items.length; k++) assert.ok(c.json.items[k - 1].created_at >= c.json.items[k].created_at);
  });
});

// ── AC-20.11 + migrated-fixture search (needs the migration script) ───────

describe('search over a migrated legacy fixture', () => {
  let M;
  before(async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-search-fixture');
    const m = runMigrate(['--data-dir', dir]);
    assert.equal(m.status, 0, `migration failed (${m.status}): ${m.stdout}\n${m.stderr}`);
    M = await startServer({ dataDir: dir });
  });
  after(async () => { await M?.stop(); });

  test('AC-20.11 an expired session is absent from search and lists until PUT /meta {expiry_days:null}', async () => {
    const id = 'e5e5e5e5e5e5';
    const has = (r) => r.json.items.some((i) => i.id === id);
    assert.ok(!has(await docsOk(M.url, { q: 'expiredterm' })), 'expired: not in search');
    assert.ok(!has(await docsOk(M.url, { limit: '100' })), 'expired: not in list mode');
    assert.ok(!(await http(M.url, 'GET', '/paste/list')).json.some((i) => i.id === id), 'expired: not in /paste/list');
    const u = await http(M.url, 'PUT', `/paste/${id}/meta`, { body: { expiry_days: null } });
    assert.equal(u.status, 200);
    assert.equal(u.json.expires_at, null);
    assert.ok(has(await docsOk(M.url, { q: 'expiredterm' })), 'un-expired: in search');
    assert.ok(has(await docsOk(M.url, { limit: '100' })), 'un-expired: in list mode');
    assert.ok((await http(M.url, 'GET', '/paste/list')).json.some((i) => i.id === id), 'un-expired: in /paste/list');
  });

  test('R-20.6 migrated items: title per 00 §5, mode per 00 §1.4, contentType, file_count, must_fix_unresolved', async () => {
    const r = await docs(M.url, { limit: '100' });
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.json.items.map((i) => [i.id, i]));
    for (const id of ['a1a1a1a1a1a1', 'b2b2b2b2b2b2', 'c3c3c3c3c3c3', 'd4d4d4d4d4d4', 'f6f6f6f6f6f6', '0a0a0a0a0a0a', 'cafe00000001',
      '1b1b1b1b1b1b', '2c2c2c2c2c2c', '3d3d3d3d3d3d', '4e4e4e4e4e4e']) assert.ok(by[id], `non-expired fixture session ${id} listed`);
    assert.equal(by.a1a1a1a1a1a1.title, 'Weekly routing status');      // sessionName
    assert.equal(by['4e4e4e4e4e4e'].title, 'Front matter title');       // front matter
    assert.equal(by.b2b2b2b2b2b2.title, 'Quarterly report');            // HTML <title>
    assert.equal(by.f6f6f6f6f6f6.title, 'Seeded');                      // first H1
    assert.equal(by.c3c3c3c3c3c3.title, 'Old format');                  // H1 of inline legacy markdown
    assert.equal(by['2c2c2c2c2c2c'].title, 'Untitled');                 // nothing at all
    assert.equal(by['3d3d3d3d3d3d'].mode, 'publish');
    assert.equal(by['4e4e4e4e4e4e'].mode, 'review', 'invalid stored mode migrates as review');
    assert.equal(by.a1a1a1a1a1a1.mode, 'review', 'no stored mode → review');
    assert.equal(by.b2b2b2b2b2b2.contentType, 'html');
    assert.equal(by.a1a1a1a1a1a1.contentType, 'markdown');
    assert.equal(by.a1a1a1a1a1a1.file_count, 2);
    assert.equal(by['1b1b1b1b1b1b'].must_fix_unresolved, 1);
    assert.equal(by.cafe00000001.slug, 'cafe');
  });

  test('R-20.6 migrated content is indexed: café, CJK title, HTML script excluded', async () => {
    const cafe = await docsOk(M.url, { q: 'cafe' });
    const it = cafe.json.items.find((i) => i.id === 'cafe00000001');
    assert.ok(it); assert.ok(hits(it).includes('café'));
    const cjk = await docsOk(M.url, { q: '路线' });
    const c = cjk.json.items.find((i) => i.id === '3d3d3d3d3d3d');
    assert.ok(c, 'CJK title token must match');
    assert.equal(c.match.field, 'title');
    assert.ok(hits(c).includes('路线'));
    assert.ok(!(await docsOk(M.url, { q: 'secretvar' })).json.items.some((i) => i.id === 'b2b2b2b2b2b2'));
    assert.ok((await docsOk(M.url, { q: 'visible' })).json.items.some((i) => i.id === 'b2b2b2b2b2b2'));
  });
});

// ── AC-20.15 revision retention ─────────────────────────────────────────

test('AC-20.15 REVISIONS_MAX=3: 5 alternating-author writes keep 3 revisions; the oldest hash is 404; pruned rows deleted', async () => {
  const dir = tmpDir('md-review-20-revmax');
  const R = await startServer({ dataDir: dir, env: { REVISIONS_MAX: '3' } });
  try {
    const { id } = await create(R.url, { markdown: 'r0', filename: 'r.md', author: 'odd' });
    const hashes = [md5('r0')];
    for (let i = 1; i <= 5; i++) {
      await putMd(R.url, id, { markdown: `r${i}`, author: i % 2 ? 'even' : 'odd' });
      hashes.push(md5(`r${i}`));
    }
    const list = (await http(R.url, 'GET', `/paste/${id}/revisions`)).json;
    assert.equal(list.revisions.length, 3);
    assert.deepEqual(list.revisions.map((r) => r.hash), hashes.slice(-3));
    assert.equal(list.current, hashes[5]);
    assert.equal((await http(R.url, 'GET', `/paste/${id}/revisions/${hashes[0]}`)).status, 404);
    assert.deepEqual((await http(R.url, 'GET', `/paste/${id}/revisions/${hashes[0]}`)).json, { error: 'unknown revision' });
    assert.equal((await http(R.url, 'GET', `/paste/${id}/revisions/${hashes[2]}`)).status, 404);
    assert.equal((await http(R.url, 'GET', `/paste/${id}/revisions/${hashes[3]}`)).json.markdown, 'r3');
    const db = await openDbReadOnly(path.join(dir, DB_NAME));
    try {
      assert.equal(db.prepare('SELECT count(*) AS c FROM revisions WHERE session_id = ?').get(id).c, 3, 'pruned revision rows are deleted');
    } finally { db.close(); }
  } finally { await R.stop(); }
});

// ── AC-20.16 CORS ───────────────────────────────────────────────────────

const ALLOW_HEADERS = ['Content-Type', 'If-None-Match', 'If-Match', 'X-MdReview-Client', 'Authorization', 'X-Edit-Token', 'X-MdReview-Reader'];
const headerSet = (v) => new Set(String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

test('AC-20.16 every response carries the 00 §9 CORS headers', async () => {
  const { id } = await create(S.url, { markdown: 'cors', filename: 'c.md' });
  const probes = [
    ['GET', '/'], ['OPTIONS', '/paste'], ['OPTIONS', `/paste/${id}/markdown`], ['GET', `/paste/${id}`], ['GET', '/paste/ffffffffffff'],
    ['GET', '/library/docs'], ['GET', '/library/docs?sort=bogus'], ['GET', '/paste/list'], ['GET', '/no/such/route'],
    ['PUT', `/paste/${id}/markdown`], ['POST', '/paste'],
  ];
  for (const [method, p] of probes) {
    const body = method === 'PUT' ? { markdown: 'cors 2' } : method === 'POST' ? { markdown: 'x' } : undefined;
    const r = await http(S.url, method, p, { body });
    const h = r.headers;
    const where = `${method} ${p} (${r.status})`;
    assert.equal(h.get('access-control-allow-origin'), '*', where);
    assert.deepEqual(headerSet(h.get('access-control-allow-headers')), new Set(ALLOW_HEADERS.map((x) => x.toLowerCase())), `${where} Allow-Headers`);
    const methods = headerSet(h.get('access-control-allow-methods'));
    for (const m of ['get', 'post', 'put', 'patch', 'delete', 'options']) assert.ok(methods.has(m), `${where} Allow-Methods has ${m}`);
    const expose = headerSet(h.get('access-control-expose-headers'));
    assert.ok(expose.has('etag'), `${where} Expose-Headers has ETag`);
    assert.ok(expose.has('x-agent-sections'), `${where} Expose-Headers has X-Agent-Sections`);
  }
});
