// Item #25 — view counts and named readers, server half: AC-25.1–25.7, 25.13, 25.14 (+ spec edge cases).
// Spec: docs/build/specs/25-view-analytics.md (+ 00 §7, §8). Browser half: tests/e2e/items/25-view-analytics.test.mjs.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  sharedBackend, http, uniq, tok, brief, DAY, DB_NAME, tmpDir, cleanupTmp, startMcpHttp, mcpConnect, create, makeLegacy,
  startServer,
} from './23-helpers.mjs';

let B;
before(async () => { B = await sharedBackend(); });
after(async () => { await B?.stop(); cleanupTmp(); });

const rid = (p = 'r') => `${p}-${uniq()}${uniq()}`;
const view = (base, x, body, headers = {}) => http(base, 'POST', `/paste/${x}/views`, { body, headers });
const stats = async (base, x, headers = {}) => {
  const r = await http(base, 'GET', `/paste/${x}/views`, { headers });
  assert.equal(r.status, 200, brief(r));
  return r.json;
};
const AGG = ['total_views', 'unique_readers', 'last_viewed_at'];

async function sql(dataDir, stmt, ...args) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, DB_NAME));
  try { db.exec('PRAGMA busy_timeout = 5000'); return db.prepare(stmt).run(...args); } finally { db.close(); }
}
const hashOf = async (x) => (await http(B.url, 'GET', `/paste/${x}/revisions`)).json.current;

describe('#25 POST/GET /paste/:id/views', () => {
  test('AC-25.1 three posts by one reader in a day → total_views 1, unique_readers 1; POST is 204', async () => {
    const d = await create(B.url);
    const r = rid();
    for (let i = 0; i < 3; i++) {
      const p = await view(B.url, d.id, { reader_id: r });
      assert.equal(p.status, 204, brief(p));
      assert.equal(p.text, '');
    }
    const s = await stats(B.url, d.id);
    assert.equal(s.total_views, 1);
    assert.equal(s.unique_readers, 1);
    assert.ok(Math.abs(Date.parse(s.last_viewed_at) - Date.now()) < 60000);
    assert.deepEqual(Object.keys(s).sort(), AGG.slice().sort(), 'a protected doc without token: aggregates only');
  });

  test('AC-25.2 the same reader on two UTC days (seeded row) → total 2, unique 1', async () => {
    const d = await create(B.url);
    const r = rid();
    await view(B.url, d.id, { reader_id: r });
    const y = new Date(Date.now() - DAY).toISOString();
    await sql(B.dataDir, 'INSERT INTO views (session_id, reader_id, day, name, revision, first_viewed_at, last_viewed_at, is_editor) VALUES (?, ?, ?, NULL, NULL, ?, ?, 0)', d.id, r, y.slice(0, 10), y, y);
    const s = await stats(B.url, d.id);
    assert.equal(s.total_views, 2);
    assert.equal(s.unique_readers, 1);
  });

  test('AC-25.3 readers grouped by name case-insensitively; anonymous_readers; non-editors get only aggregates', async () => {
    const d = await create(B.url);
    await view(B.url, d.id, { reader_id: rid('a1'), name: 'Ana' });
    await view(B.url, d.id, { reader_id: rid('a2'), name: 'Ana' });
    await view(B.url, d.id, { reader_id: rid('a3'), name: 'ana' });
    await view(B.url, d.id, { reader_id: rid('anon') });
    const ed = await stats(B.url, d.id, tok(d.editToken));
    assert.equal(ed.total_views, 4);
    assert.equal(ed.unique_readers, 4);
    assert.equal(ed.readers.length, 1);
    assert.equal(ed.readers[0].name, 'ana', 'latest spelling');
    assert.equal(ed.readers[0].views, 3);
    assert.equal(ed.readers[0].is_current, true);
    assert.equal(ed.anonymous_readers, 1);
    const viewer = await stats(B.url, d.id);
    assert.deepEqual(Object.keys(viewer).sort(), AGG.slice().sort());
    const wrong = await stats(B.url, d.id, tok('mre_' + 'q'.repeat(43)));
    assert.deepEqual(Object.keys(wrong).sort(), AGG.slice().sort(), 'a wrong token is a viewer');
  });

  test('AC-25.4 a reader who saw revision A has is_current:false and revision A after the doc changed', async () => {
    const d = await create(B.url, { markdown: 'A' });
    const a = await hashOf(d.id);
    await view(B.url, d.id, { reader_id: rid(), name: 'Ana', revision: a });
    await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { body: { markdown: 'B' }, headers: tok(d.editToken) });
    const s = await stats(B.url, d.id, tok(d.editToken));
    assert.equal(s.readers[0].revision, a);
    assert.equal(s.readers[0].is_current, false);
    // revision omitted → the current hash
    await view(B.url, d.id, { reader_id: rid(), name: 'Ben' });
    const s2 = await stats(B.url, d.id, tok(d.editToken));
    const ben = s2.readers.find((r) => r.name === 'Ben');
    assert.equal(ben.revision, await hashOf(d.id));
    assert.equal(ben.is_current, true);
    assert.equal(s2.readers[0].name, 'Ben', 'sorted by last_viewed_at desc');
  });

  test('AC-25.5 a view with the valid edit token does not change the counts', async () => {
    const d = await create(B.url);
    await view(B.url, d.id, { reader_id: rid(), name: 'Reader' });
    const before = await stats(B.url, d.id);
    const p = await view(B.url, d.id, { reader_id: rid('author'), name: 'Author' }, tok(d.editToken));
    assert.equal(p.status, 204);
    const after = await stats(B.url, d.id, tok(d.editToken));
    assert.equal(after.total_views, before.total_views);
    assert.equal(after.unique_readers, before.unique_readers);
    assert.ok(!after.readers.some((r) => r.name === 'Author'), 'editor rows excluded from readers');
  });

  test('AC-25.6 a legacy (unprotected) doc gives readers without any token', async () => {
    const d = await create(B.url);
    await makeLegacy(B.dataDir, d.id);
    await view(B.url, d.id, { reader_id: rid(), name: 'Leg' });
    const s = await stats(B.url, d.id);
    assert.ok(Array.isArray(s.readers), JSON.stringify(s));
    assert.equal(s.readers[0].name, 'Leg');
    assert.equal(s.anonymous_readers, 0);
    // On a legacy doc a token proves nothing: the view counts.
    assert.equal(s.total_views, 1);
  });

  test('AC-25.7 invalid reader_id / revision → 400; unknown 404; expired 410', async () => {
    const d = await create(B.url);
    for (const body of [{ reader_id: 'x' }, { reader_id: 'bad id here' }, {}, { reader_id: rid(), revision: 'xyz' }, { reader_id: rid(), revision: 'A'.repeat(32) }, { reader_id: rid(), revision: 5 }]) {
      const r = await view(B.url, d.id, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${brief(r)}`);
    }
    assert.equal((await view(B.url, 'ffffffffffff', { reader_id: rid() })).status, 404);
    assert.equal((await http(B.url, 'GET', '/paste/ffffffffffff/views')).status, 404);
    await sql(B.dataDir, 'UPDATE sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() - DAY).toISOString(), d.id);
    assert.equal((await view(B.url, d.id, { reader_id: rid() })).status, 410);
    assert.equal((await http(B.url, 'GET', `/paste/${d.id}/views`)).status, 410);
  });

  test('a name set after the first view of the day joins the same row (anonymous count drops)', async () => {
    const d = await create(B.url);
    const r = rid();
    await view(B.url, d.id, { reader_id: r });
    assert.equal((await stats(B.url, d.id, tok(d.editToken))).anonymous_readers, 1);
    await view(B.url, d.id, { reader_id: r, name: 'Late Name' });
    const s = await stats(B.url, d.id, tok(d.editToken));
    assert.equal(s.total_views, 1);
    assert.equal(s.anonymous_readers, 0);
    assert.equal(s.readers[0].name, 'Late Name');
    // An empty name later never erases it.
    await view(B.url, d.id, { reader_id: r, name: '' });
    assert.equal((await stats(B.url, d.id, tok(d.editToken))).readers[0].name, 'Late Name');
  });

  test('deleted doc + re-used slug → counts start at 0', async () => {
    const slug = `views-del-${uniq()}`;
    const d = await create(B.url, { slug });
    await view(B.url, d.id, { reader_id: rid() });
    assert.equal((await http(B.url, 'DELETE', `/paste/${d.id}`, { headers: tok(d.editToken) })).status, 204);
    const again = await create(B.url, { slug });
    assert.equal(again.slug, slug);
    assert.equal((await stats(B.url, slug)).total_views, 0);
  });

  test('5 000 view rows → GET < 100 ms', async () => {
    const d = await create(B.url);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(B.dataDir, DB_NAME));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const ins = db.prepare('INSERT INTO views (session_id, reader_id, day, name, revision, first_viewed_at, last_viewed_at, is_editor) VALUES (?, ?, ?, ?, NULL, ?, ?, 0)');
      db.exec('BEGIN');
      for (let i = 0; i < 5000; i++) {
        const at = new Date(Date.now() - (i % 60) * DAY).toISOString();
        ins.run(d.id, `reader-${i % 1000}-${Math.floor(i / 1000)}x`, at.slice(0, 10), i % 3 ? `Person ${i % 120}` : null, at, at);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } finally { db.close(); }
    await stats(B.url, d.id, tok(d.editToken));
    const t0 = performance.now();
    const s = await stats(B.url, d.id, tok(d.editToken));
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `GET took ${ms.toFixed(1)} ms`);
    assert.ok(s.total_views > 0);
  });
});

describe('#25 MDREVIEW_NOW test clock (day bucketing at midnight UTC)', () => {
  test('a view at 23:59:59 and one at 00:00:01 UTC are two rows', async () => {
    const dir = tmpDir('md-review-25-clock');
    const s1 = await startServer({ dataDir: dir, env: { MDREVIEW_NOW: '2026-03-01T23:59:59.000Z', ALLOW_EMPTY_DB: '1' } });
    let d;
    const r = rid();
    try {
      d = await create(s1.url);
      assert.equal((await view(s1.url, d.id, { reader_id: r })).status, 204);
    } finally { await s1.stop(); }
    const s2 = await startServer({ dataDir: dir, env: { MDREVIEW_NOW: '2026-03-02T00:00:01.000Z', ALLOW_EMPTY_DB: '1' } });
    try {
      await view(s2.url, d.id, { reader_id: r });
      const s = await stats(s2.url, d.id);
      assert.equal(s.total_views, 2);
      assert.equal(s.unique_readers, 1);
      assert.equal(s.last_viewed_at, '2026-03-02T00:00:01.000Z');
    } finally { await s2.stop(); }
  });
});

describe('#25 views are recorded only by POST /views', () => {
  test('AC-25.13 GET /d/<slug> as Slackbot, GET /paste/:id and MCP get_session leave the counts unchanged', async () => {
    const d = await create(B.url, { sessionName: `Unfurl ${uniq()}` });
    await http(B.url, 'GET', `/d/${d.slug}`, { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' } });
    await http(B.url, 'GET', `/paste/${d.id}`);
    const m = await startMcpHttp({ apiUrl: B.url, storePath: path.join(tmpDir('md-review-25-s'), 't.json') });
    try {
      const c = await mcpConnect(m.url);
      try { await c.call('get_session', { sessionId: d.id }); await c.call('get_views', { sessionId: d.id }); } finally { await c.close(); }
    } finally { await m.stop(); }
    const s = await stats(B.url, d.id);
    assert.equal(s.total_views, 0);
    assert.equal(s.unique_readers, 0);
    assert.equal(s.last_viewed_at, null);
  });

  test('AC-25.14 MCP get_views after the agent created the doc includes readers (token from the store)', async () => {
    const m = await startMcpHttp({ apiUrl: B.url, storePath: path.join(tmpDir('md-review-25-store'), 't.json') });
    try {
      const c = await mcpConnect(m.url);
      let created;
      try { created = await c.call('create_session', { markdown: '# Agent doc\n', filename: 'a.md' }); } finally { await c.close(); }
      await view(B.url, created.id, { reader_id: rid(), name: 'Lead' });
      const c2 = await mcpConnect(m.url);
      try {
        assert.ok((await c2.tools()).includes('get_views'));
        const v = await c2.call('get_views', { sessionId: created.id });
        assert.equal(v.total_views, 1, JSON.stringify(v));
        assert.ok(Array.isArray(v.readers), JSON.stringify(v));
        assert.equal(v.readers[0].name, 'Lead');
      } finally { await c2.close(); }
    } finally { await m.stop(); }
  });
});

describe('#25 MCP get_views with a wrong token', () => {
  test('fix: counts only, plus a warning that the token was not accepted', async () => {
    const d = await create(B.url);
    const m = await startMcpHttp({ apiUrl: B.url, storePath: path.join(tmpDir('md-review-25-w'), 't.json') });
    try {
      const c = await mcpConnect(m.url);
      try {
        const v = await c.call('get_views', { sessionId: d.id, editToken: 'mre_' + 'w'.repeat(43) });
        assert.equal(v.readers, undefined);
        assert.match(String(v.warning), /not accepted/);
        const ok = await c.call('get_views', { sessionId: d.id, editToken: d.editToken });
        assert.ok(Array.isArray(ok.readers));
        assert.equal(ok.warning, undefined);
      } finally { await c.close(); }
    } finally { await m.stop(); }
  });
});

describe('#25 00 §8 library view_count and sort=views', () => {
  test('view_count = total_views; sort=views orders by it', async () => {
    const tag = `Viewsort ${uniq()}`;
    const a = await create(B.url, { sessionName: `${tag} a` });
    const b = await create(B.url, { sessionName: `${tag} b` });
    for (let i = 0; i < 3; i++) await view(B.url, b.id, { reader_id: rid() });
    await view(B.url, a.id, { reader_id: rid() });
    await view(B.url, a.id, { reader_id: rid() }, tok(a.editToken)); // editor: not counted
    const r = await http(B.url, 'GET', `/library/docs?q=${encodeURIComponent(tag)}&sort=views`);
    assert.equal(r.status, 200, brief(r));
    const ids = r.json.items.map((i) => i.id);
    assert.deepEqual(ids.filter((x) => x === a.id || x === b.id), [b.id, a.id]);
    assert.equal(r.json.items.find((i) => i.id === b.id).view_count, 3);
    assert.equal(r.json.items.find((i) => i.id === a.id).view_count, 1);
  });
});
