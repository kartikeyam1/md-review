// Item #24 — reactions, server half: AC-24.1–24.6, 24.12 (+ edge cases from the spec).
// Spec: docs/build/specs/24-reactions.md (+ 00 §7 reader identity). Browser half:
// tests/e2e/items/24-reactions.test.mjs.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  sharedBackend, http, uniq, tok, brief, DAY, DB_NAME, tmpDir, cleanupTmp, startMcpHttp, mcpConnect, create,
} from './23-helpers.mjs';

let B;
before(async () => { B = await sharedBackend(); });
after(async () => { await B?.stop(); cleanupTmp(); });

const rid = (p = 'r') => `${p}-${uniq()}${uniq()}`; // ≥ 8 chars, [A-Za-z0-9_-]
const react = (x, body, headers = {}) => http(B.url, 'POST', `/paste/${x}/reactions`, { body, headers });
const summary = async (x, readerId) => {
  const r = await http(B.url, 'GET', `/paste/${x}/reactions${readerId ? `?reader_id=${readerId}` : ''}`);
  assert.equal(r.status, 200, brief(r));
  return r.json;
};
const group = (groups, code) => (groups || []).find((g) => g.code === code);

async function sql(stmt, ...args) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(B.dataDir, DB_NAME));
  try { db.exec('PRAGMA busy_timeout = 5000'); return db.prepare(stmt).run(...args); } finally { db.close(); }
}

describe('#24 POST/GET /paste/:id/reactions', () => {
  test('AC-24.1 toggle twice: active → count 1 names [Ana]; then inactive, group absent', async () => {
    const d = await create(B.url);
    const a = await react(d.id, { code: '+1', reader_id: 'r-aaaaaaaa', name: 'Ana' });
    assert.equal(a.status, 200, brief(a));
    assert.equal(a.json.active, true);
    assert.equal(a.json.code, '+1');
    assert.equal(a.json.section, null);
    const g = group(a.json.summary.doc, '+1');
    assert.deepEqual(g, { code: '+1', emoji: '👍', count: 1, names: ['Ana'], anonymous: 0, mine: true });
    assert.equal(a.json.summary.total, 1);
    const b = await react(d.id, { code: '+1', reader_id: 'r-aaaaaaaa', name: 'Ana' });
    assert.equal(b.json.active, false);
    assert.equal(group(b.json.summary.doc, '+1'), undefined);
    assert.equal(b.json.summary.total, 0);
    assert.deepEqual(await summary(d.id), { total: 0, doc: [], sections: {} });
  });

  test('AC-24.2 on:true twice keeps 1; on:false twice leaves 0', async () => {
    const d = await create(B.url);
    const r = rid();
    for (let i = 0; i < 2; i++) assert.equal((await react(d.id, { code: 'tada', reader_id: r, on: true })).json.active, true);
    assert.equal(group((await summary(d.id)).doc, 'tada').count, 1);
    for (let i = 0; i < 2; i++) assert.equal((await react(d.id, { code: 'tada', reader_id: r, on: false })).json.active, false);
    assert.equal((await summary(d.id)).total, 0);
  });

  test('AC-24.3 unknown code / bad section / bad reader_id → 400', async () => {
    const d = await create(B.url);
    const bad = [
      [{ code: 'thumbsup', reader_id: rid() }, 'invalid_reaction'],
      [{ code: '+1', section: 'a b', reader_id: rid() }, 'invalid_section'],
      [{ code: '+1', reader_id: 'x' }, 'invalid_reader'],
      [{ code: '+1', reader_id: 'has space here' }, 'invalid_reader'],
      [{ code: '+1', reader_id: 'a'.repeat(65) }, 'invalid_reader'],
      [{ code: '+1', section: 's'.repeat(201), reader_id: rid() }, 'invalid_section'],
      [{ code: '+1', section: 42, reader_id: rid() }, 'invalid_section'],
    ];
    for (const [body, code] of bad) {
      const r = await react(d.id, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${brief(r)}`);
      assert.equal(r.json.code, code, JSON.stringify(body));
    }
    assert.equal((await react(d.id, { code: '+1', reader_id: rid(), on: 'yes' })).status, 400);
    assert.equal((await summary(d.id)).total, 0);
  });

  test('AC-24.4 three readers on a section: count 3, 2 names, anonymous 1, mine for the anonymous one', async () => {
    const d = await create(B.url);
    const anon = rid('anon');
    await react(d.id, { code: 'tada', section: 'rollout-plan', reader_id: rid(), name: 'Ana' });
    await react(d.id, { code: 'tada', section: 'rollout-plan', reader_id: rid(), name: 'Ben' });
    await react(d.id, { code: 'tada', section: 'rollout-plan', reader_id: anon });
    const s = await summary(d.id, anon);
    const g = group(s.sections['rollout-plan'], 'tada');
    assert.equal(g.count, 3);
    assert.deepEqual(g.names, ['Ben', 'Ana'], 'most recent first');
    assert.equal(g.anonymous, 1);
    assert.equal(g.mine, true);
    assert.deepEqual(s.doc, []);
    assert.equal(group((await summary(d.id, rid())).sections['rollout-plan'], 'tada').mine, false);
  });

  test('groups follow the fixed order; doc and section reactions are separate', async () => {
    const d = await create(B.url);
    const r = rid();
    for (const code of ['rocket', 'eyes', '+1', 'heart', 'question', 'tada']) await react(d.id, { code, reader_id: r });
    await react(d.id, { code: 'eyes', section: 'intro', reader_id: r });
    await react(d.id, { code: '+1', section: 'intro-1', reader_id: r });
    const s = await summary(d.id, r);
    assert.deepEqual(s.doc.map((g) => g.code), ['+1', 'tada', 'question', 'eyes', 'heart', 'rocket']);
    assert.deepEqual(s.doc.map((g) => g.emoji), ['👍', '🎉', '❓', '👀', '❤️', '🚀']);
    assert.deepEqual(Object.keys(s.sections).sort(), ['intro', 'intro-1']);
    assert.equal(s.sections.intro[0].code, 'eyes');
    assert.equal(s.sections['intro-1'][0].code, '+1');
    assert.equal(s.total, 8);
  });

  test('Unicode section ids (CJK, accents) are accepted', async () => {
    const d = await create(B.url);
    for (const section of ['计划', 'café-plan', 'über_alles']) {
      const r = await react(d.id, { code: 'eyes', section, reader_id: rid() });
      assert.equal(r.status, 200, `${section}: ${brief(r)}`);
    }
    assert.deepEqual(Object.keys((await summary(d.id)).sections).sort(), ['café-plan', 'über_alles', '计划'].sort());
  });

  test('fix: a section id "__proto__" is an ordinary key in GET', async () => {
    const d = await create(B.url);
    await react(d.id, { code: 'eyes', section: '__proto__', reader_id: rid() });
    const s = await summary(d.id);
    assert.equal(s.total, 1);
    assert.ok(Object.prototype.hasOwnProperty.call(s.sections, '__proto__'), JSON.stringify(s));
    assert.equal(s.sections.__proto__[0].code, 'eyes');
  });

  test('a repeat with a different name updates the name; names trimmed to 80', async () => {
    const d = await create(B.url);
    const r = rid();
    await react(d.id, { code: '+1', reader_id: r, name: 'Old' });
    const u = await react(d.id, { code: '+1', reader_id: r, name: 'New', on: true });
    assert.deepEqual(group(u.json.summary.doc, '+1').names, ['New']);
    const long = await react(d.id, { code: 'heart', reader_id: rid(), name: `  ${'n'.repeat(100)}  ` });
    assert.equal(group(long.json.summary.doc, 'heart').names[0].length, 80);
    const blank = await react(d.id, { code: 'rocket', reader_id: rid(), name: '   ' });
    assert.deepEqual(group(blank.json.summary.doc, 'rocket'), { code: 'rocket', emoji: '🚀', count: 1, names: [], anonymous: 1, mine: true });
  });

  test('AC-24.5 a protected doc accepts reactions without an edit token; slug works too', async () => {
    const d = await create(B.url, { sessionName: `React ${uniq()}` });
    assert.ok(d.editToken, 'protected doc');
    const r = await react(d.slug, { code: 'rocket', reader_id: rid() });
    assert.equal(r.status, 200, brief(r));
    assert.equal((await summary(d.id)).total, 1);
    const w = await react(d.id, { code: 'rocket', reader_id: rid() }, tok('mre_' + 'z'.repeat(43)));
    assert.equal(w.status, 200, 'a wrong token is ignored for an open action');
  });

  test('AC-24.6 expired → 410 on POST and GET; deleted doc → reactions gone (re-created slug shows 0)', async () => {
    const slug = `react-del-${uniq()}`;
    const d = await create(B.url, { slug });
    await react(d.id, { code: '+1', reader_id: rid() });
    await sql('UPDATE sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() - DAY).toISOString(), d.id);
    assert.equal((await react(d.id, { code: '+1', reader_id: rid() })).status, 410);
    assert.equal((await http(B.url, 'GET', `/paste/${d.id}/reactions`)).status, 410);
    await sql('UPDATE sessions SET expires_at = NULL WHERE id = ?', d.id);
    assert.equal((await http(B.url, 'DELETE', `/paste/${d.id}`, { headers: tok(d.editToken) })).status, 204);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(B.dataDir, DB_NAME), { readOnly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS c FROM reactions WHERE session_id = ?').get(d.id).c, 0); } finally { db.close(); }
    const again = await create(B.url, { slug });
    assert.equal(again.slug, slug);
    assert.equal((await summary(slug)).total, 0);
    assert.equal((await http(B.url, 'GET', '/paste/ffffffffffff/reactions')).status, 404);
    assert.equal((await react('ffffffffffff', { code: '+1', reader_id: rid() })).status, 404);
  });

  test('1 000 reactions: GET < 100 ms, names capped at 20, count exact', async () => {
    const d = await create(B.url);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(B.dataDir, DB_NAME));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const ins = db.prepare('INSERT INTO reactions (session_id, section, code, reader_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      db.exec('BEGIN');
      for (let i = 0; i < 1000; i++) ins.run(d.id, i % 2 ? '' : `s${i % 7}`, ['+1', 'eyes', 'heart'][i % 3], `reader-${i}-xxxx`, i % 4 ? `Name ${i}` : null, new Date(Date.now() + i).toISOString());
      db.exec('COMMIT');
    } finally { db.close(); }
    await summary(d.id); // warm
    const t0 = performance.now();
    const s = await summary(d.id);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `GET took ${ms.toFixed(1)} ms`);
    assert.equal(s.total, 1000);
    const g = group(s.doc, '+1');
    assert.ok(g.names.length <= 20);
    assert.equal(g.names.length, 20);
    assert.equal(g.count, s.doc.find((x) => x.code === '+1').count);
    const all = [...s.doc, ...Object.values(s.sections).flat()];
    assert.equal(all.reduce((n, x) => n + x.count, 0), 1000);
  });

  test('rapid parallel toggles never go negative and end consistent', async () => {
    const d = await create(B.url);
    const r = rid();
    const results = await Promise.all(Array.from({ length: 7 }, () => react(d.id, { code: 'eyes', reader_id: r })));
    assert.ok(results.every((x) => x.status === 200));
    const s = await summary(d.id, r);
    const g = group(s.doc, 'eyes');
    assert.equal(g?.count ?? 0, 1, '7 toggles = on');
    assert.ok(s.total >= 0);
  });
});

describe('#24 MCP get_reactions', () => {
  let m;
  before(async () => { m = await startMcpHttp({ apiUrl: B.url, storePath: path.join(tmpDir('md-review-24-store'), 't.json') }); });
  after(async () => { await m?.stop(); });

  test('AC-24.12 emoji-keyed doc and a sections array sorted by total', async () => {
    const d = await create(B.url);
    await react(d.id, { code: '+1', reader_id: rid(), name: 'Ana' });
    await react(d.id, { code: '+1', reader_id: rid() });
    for (let i = 0; i < 3; i++) await react(d.id, { code: 'eyes', section: 'big', reader_id: rid(), name: `R${i}` });
    await react(d.id, { code: 'question', section: 'small', reader_id: rid() });
    const c = await mcpConnect(m.url);
    try {
      assert.ok((await c.tools()).includes('get_reactions'));
      const r = await c.call('get_reactions', { sessionId: d.id });
      assert.equal(r.total, 6);
      assert.deepEqual(r.doc, { '👍': { count: 2, names: ['Ana'] } });
      assert.deepEqual(r.sections.map((s) => s.section), ['big', 'small']);
      assert.deepEqual(r.sections[0].reactions['👀'].count, 3);
      assert.deepEqual(r.sections[1].reactions, { '❓': { count: 1, names: [] } });
    } finally { await c.close(); }
  });
});

describe('#24 00 §8 library rows carry reaction_count', () => {
  test('GET /library/docs reaction_count = the doc total', async () => {
    const name = `Libreact ${uniq()}`;
    const d = await create(B.url, { sessionName: name });
    await react(d.id, { code: '+1', reader_id: rid() });
    await react(d.id, { code: 'eyes', section: 'x', reader_id: rid() });
    const r = await http(B.url, 'GET', `/library/docs?q=${encodeURIComponent(name)}`);
    const it = r.json.items.find((i) => i.id === d.id);
    assert.ok(it, brief(r));
    assert.equal(it.reaction_count, 2);
  });
});
