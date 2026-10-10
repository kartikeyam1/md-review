// Item #20 — fix round after QA / code review (the frozen 20-*.test.mjs files
// are untouched). One test group per fix:
//   1 control characters in q; 2 column-owned meta keys; 3 reactions/views
//   schema (specs 24/25); 4 revision blobs read only for revision bodies;
//   5 plain-text, capped, consistent snippets + HTML entities; 6 comment rows
//   rewritten only on change; 7 migration completion marker / rollback /
//   diverged; 8 slug deletes scoped to their owner.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, spawnExpectingExit, tmpDir, copyToTmp, cleanupTmp, http, openDbReadOnly, runMigrate, migrateWithReport,
  LEGACY_FIXTURE, DB_NAME,
} from './lib/20-helpers.mjs';
import { installFetchJar } from './lib/edit-token-jar.mjs';
installFetchJar(); // #23: this suite's own docs keep being writable (it is not about edit tokens)

after(cleanupTmp);

const docs = (base, params) => http(base, 'GET', `/library/docs?${new URLSearchParams(params)}`);
const joined = (item) => item.match.snippet.map((s) => s.text).join('');
const hits = (item) => item.match.snippet.filter((s) => s.hit).map((s) => s.text);
async function create(base, body) {
  const r = await http(base, 'POST', '/paste', { body });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
}
async function withDb(dir, fn) {
  const db = await openDbReadOnly(path.join(dir, DB_NAME));
  try { return fn(db); } finally { db.close(); }
}

let S; let sDir;
before(async () => { sDir = tmpDir('md-review-20-fixes'); S = await startServer({ dataDir: sDir }); });
after(async () => { await S?.stop(); });

test('fix 1: control characters (NUL, SOH, newline) in q never cause a 4xx/5xx', async () => {
  await create(S.url, { markdown: 'abc nulcheck', filename: 'n.md' });
  for (const q of ['ab\u0000c', '\u0000', 'nulcheck\u0001', 'a\u0000"b', '\u0007\u001b[31m', 'nul\ncheck']) {
    const r = await docs(S.url, { q });
    assert.equal(r.status, 200, `q=${JSON.stringify(q)} → ${r.status} ${r.text.slice(0, 200)}`);
    assert.ok(Array.isArray(r.json.items));
  }
  const r = await docs(S.url, { q: 'nulcheck\u0000' });
  assert.ok(r.json.items.length >= 1, 'a control character is a separator, not part of the token');
});

test('fix 2: client-supplied column-owned keys never round-trip into extra_json or responses', async () => {
  const forged = {
    edit_token_hash: 'forged-hash', upsert_key: 'forged-key', created_by: 'Mallory', from_template_json: '{"x":1}',
    version: 999, title: 'Forged title', fts_rowid: 1, source_sig: 'sig', comments_sig: 'sig', extra_json: '{}',
    created_at: '1999-01-01T00:00:00.000Z', updated_at: '1999-01-01T00:00:00.000Z', id: 'not-the-id',
  };
  const id = await create(S.url, { markdown: '# Real title\n\nbody', filename: 'f.md', author: 'Ann', keep_me: 1, ...forged });
  for (const p of [`/paste/${id}`, `/paste/${id}?fields=meta`]) {
    const g = await http(S.url, 'GET', p);
    assert.equal(g.status, 200);
    // #23 rule 6 adds the real `id` to GET responses; the forged one must still never come back.
    for (const k of Object.keys(forged)) {
      if (k === 'id') assert.equal(g.json.id, id, `${p}: id is the real one, never the forged value`);
      else assert.ok(!(k in g.json), `${p}: ${k} must not be echoed`);
    }
    assert.equal(g.json.keep_me, 1, 'ordinary extra keys still round-trip');
  }
  await withDb(sDir, (db) => {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    assert.notEqual(row.edit_token_hash, 'forged-hash', 'edit_token_hash is server-owned (#23 sets its own)');
    assert.equal(row.upsert_key, null);
    assert.equal(row.created_by, 'Ann');
    assert.equal(row.from_template_json, null);
    assert.ok(row.version < 10, `version is server-owned (${row.version})`);
    assert.equal(row.title, 'Real title');
    assert.ok(row.created_at > '2000');
    assert.deepEqual(Object.keys(JSON.parse(row.extra_json)).sort(), ['keep_me']);
  });
});

test('fix 3: reactions and views tables have the columns and keys of specs 24 and 25', async () => {
  await withDb(sDir, (db) => {
    const cols = (t) => db.prepare(`PRAGMA table_info("${t}")`).all();
    const pk = (t) => cols(t).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const r = Object.fromEntries(cols('reactions').map((c) => [c.name, c]));
    for (const c of ['session_id', 'section', 'code', 'reader_id', 'name', 'created_at']) assert.ok(r[c], `reactions.${c}`);
    assert.equal(r.section.notnull, 1);
    assert.equal(r.section.dflt_value, "''");
    assert.deepEqual(pk('reactions'), ['session_id', 'section', 'code', 'reader_id']);
    const v = Object.fromEntries(cols('views').map((c) => [c.name, c]));
    for (const c of ['session_id', 'reader_id', 'day', 'name', 'revision', 'first_viewed_at', 'last_viewed_at', 'is_editor']) assert.ok(v[c], `views.${c}`);
    assert.deepEqual(pk('views'), ['session_id', 'reader_id', 'day']);
    for (const t of ['reactions', 'views']) {
      const fk = db.prepare(`PRAGMA foreign_key_list("${t}")`).all();
      assert.ok(fk.some((f) => f.table === 'sessions' && f.on_delete === 'CASCADE'), `${t} rows are deleted with the doc`);
    }
  });
});

test('fix 4: only a revision-body request reads revision blobs', async () => {
  const id = await create(S.url, { markdown: 'r1', filename: 'r.md', author: 'a' });
  await http(S.url, 'PUT', `/paste/${id}/markdown`, { body: { markdown: 'r2', author: 'b' } });
  const { DatabaseSync } = await import('node:sqlite');
  const w = new DatabaseSync(path.join(sDir, DB_NAME));
  w.exec('PRAGMA busy_timeout = 5000');
  w.prepare('UPDATE revisions SET blob = ? WHERE session_id = ?').run(Buffer.from('not gzip'), id);
  w.close();
  for (const p of [`/paste/${id}`, `/paste/${id}?fields=meta`, `/paste/${id}/revisions`, '/paste/list', `/paste/${id}/markdown`]) {
    assert.equal((await http(S.url, 'GET', p)).status, 200, p);
  }
  const list = (await http(S.url, 'GET', `/paste/${id}/revisions`)).json;
  assert.equal(list.revisions.length, 2);
  assert.equal((await http(S.url, 'PUT', `/paste/${id}/markdown`, { body: { markdown: 'r3', author: 'c' } })).status, 200, 'writes do not read blobs either');
  assert.equal((await http(S.url, 'GET', `/paste/${id}/revisions/${list.revisions[0].hash}`)).status, 500, 'the body request does');
});

describe('fix 5: snippets', () => {
  test('are plain text: no markdown syntax, whitespace collapsed', async () => {
    const id = await create(S.url, { markdown: '# Heading here\n\n> **Bold** _zebrafish_ in [a link](http://x)\n\n- item\n\n```\ncode\n```\n', filename: 'z.md', sessionName: 'Plain' });
    const it = (await docs(S.url, { q: 'zebrafish' })).json.items.find((i) => i.id === id);
    assert.ok(it);
    assert.equal(it.match.field, 'content');
    assert.deepEqual(hits(it), ['zebrafish']);
    const text = joined(it);
    for (const bad of ['#', '**', '>', '](', '```', '\n']) assert.ok(!text.includes(bad), `snippet ${JSON.stringify(text)} contains ${JSON.stringify(bad)}`);
    assert.match(text, /Heading here Bold zebrafish in a link item code/);
  });

  test('HTML entities are decoded in indexed text and snippets', async () => {
    const id = await create(S.url, { markdown: '<p>Caf&eacute; cr&egrave;me &amp; cr&#232;me br&#xFB;l&eacute;e&nbsp;day</p>', filename: 'e.html', contentType: 'html' });
    const it = (await docs(S.url, { q: 'creme brulee' })).json.items.find((i) => i.id === id);
    assert.ok(it, 'entity-encoded words are searchable by their plain form');
    assert.deepEqual(hits(it), ['crème', 'crème', 'brûlée']);
    assert.ok(!joined(it).includes('&'.concat('eacute;')));
  });

  test('field names where the snippet came from', async () => {
    const t = await create(S.url, { markdown: 'unrelated body', filename: 'x.md', sessionName: 'Okapi quarterly' });
    const both = await create(S.url, { markdown: 'The okapi lives here.', filename: 'y.md', sessionName: 'Okapi notes' });
    const accent = await create(S.url, { markdown: 'Ökapi, as some spell it.', filename: 'w.md', sessionName: 'Okapi spelling' });
    const b = await create(S.url, { markdown: 'An okapi sighting.', filename: 'z.md', sessionName: 'Nothing' });
    const items = (await docs(S.url, { q: 'okapi' })).json.items;
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    assert.equal(by[t].match.field, 'title');
    assert.equal(joined(by[t]), 'Okapi quarterly');
    assert.equal(by[both].match.field, 'title', 'the body adds nothing but case ("okapi" vs "Okapi")');
    assert.equal(by[accent].match.field, 'content', 'the body has a hit word ("Ökapi") the title does not show');
    assert.deepEqual(hits(by[accent]), ['Ökapi']);
    assert.equal(by[b].match.field, 'content');
    for (const it of items) {
      if (it.match.field === 'title') assert.equal(joined(it), it.title);
      if (it.match.field === 'content') assert.notEqual(joined(it), it.title);
    }
  });

  test('the body scan is capped: a hit only past ~256 KB still answers fast, unmarked', async () => {
    const id = await create(S.url, { markdown: `${'filler words here. '.repeat(30000)} farawaytoken`, filename: 'big.md', sessionName: 'Big' });
    const t0 = Date.now();
    const r = await docs(S.url, { q: 'farawaytoken' });
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < 2000);
    const it = r.json.items.find((i) => i.id === id);
    assert.ok(it, 'the index still finds it');
    assert.equal(it.match.field, 'content');
    assert.deepEqual(hits(it), []);
    assert.ok(joined(it).startsWith('filler words here.'));
  });
});

test('fix 6: comment rows are rewritten only when the comments change', async () => {
  const id = await create(S.url, { markdown: 'c', filename: 'c.md', comments: [{ id: 'k1', body: 'x', category: 'nit', replies: [] }] });
  const pks = () => withDb(sDir, (db) => db.prepare('SELECT pk FROM comments WHERE session_id = ? ORDER BY ord').all(id).map((r) => r.pk));
  const before = await pks();
  assert.equal(before.length, 1);
  assert.equal((await http(S.url, 'PUT', `/paste/${id}/markdown`, { body: { markdown: 'c2' } })).status, 200);
  assert.equal((await http(S.url, 'PUT', `/paste/${id}/meta`, { body: { sessionName: 'Renamed' } })).status, 200);
  assert.deepEqual(await pks(), before, 'content and meta saves leave comment rows alone');
  assert.equal((await http(S.url, 'POST', `/paste/${id}/comments`, { body: { startLine: 1, endLine: 1, selectedText: 'c', body: 'y', category: 'nit' } })).status, 201);
  const after = await pks();
  assert.equal(after.length, 2);
  assert.deepEqual((await http(S.url, 'GET', `/paste/${id}/comments`)).json.comments.map((c) => c.id).slice(0, 1), ['k1']);
});

describe('fix 7: migration robustness', () => {
  const marker = (dir, dbFile = path.join(dir, DB_NAME)) => withDb(path.dirname(dbFile), (db) => Object.fromEntries(
    db.prepare("SELECT key, value FROM schema_meta WHERE key LIKE 'migration_%'").all().map((r) => [r.key, r.value])));

  test('a clean run marks the DB complete; a started-but-incomplete DB is refused at boot', async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-fix-marker');
    assert.equal(runMigrate(['--data-dir', dir]).status, 0);
    const m = await marker(dir);
    assert.ok(m.migration_started && m.migration_complete === m.migration_started, JSON.stringify(m));
    const { DatabaseSync } = await import('node:sqlite');
    const w = new DatabaseSync(path.join(dir, DB_NAME));
    w.prepare("DELETE FROM schema_meta WHERE key = 'migration_complete'").run();
    w.close();
    const r = await spawnExpectingExit({ dataDir: dir, timeoutMs: 6000 });
    assert.ok(r.code !== 0 && r.code !== null, `must refuse to boot (code ${r.code}, signal ${r.signal})`);
    assert.match(r.stderr, /migrate-json-to-sqlite\.mjs/);
    const again = await spawnExpectingExit({ dataDir: dir, env: { ALLOW_EMPTY_DB: '1' }, timeoutMs: 6000 });
    assert.ok(again.code !== 0 && again.code !== null, 'ALLOW_EMPTY_DB does not override an incomplete migration');
    assert.equal(runMigrate(['--data-dir', dir]).status, 0, 're-running completes it');
    const s = await startServer({ dataDir: dir });
    await s.stop();
  });

  test('a verification failure rolls the session back and leaves the migration incomplete', async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-fix-rollback');
    const mp = path.join(dir, 'cafe00000001.json');
    fs.writeFileSync(mp, JSON.stringify({ ...JSON.parse(fs.readFileSync(mp, 'utf-8')), content_hash: 'f'.repeat(32) }));
    const r = migrateWithReport(dir);
    assert.notEqual(r.status, 0);
    const st = Object.fromEntries(r.report.sessions.map((x) => [x.id, x.status]));
    assert.equal(st.cafe00000001, 'failed');
    assert.equal(r.report.complete, false);
    await withDb(dir, (db) => {
      for (const t of ['sessions', 'contents', 'comments', 'files']) {
        const col = t === 'sessions' ? 'id' : 'session_id';
        assert.equal(db.prepare(`SELECT count(*) AS c FROM ${t} WHERE ${col} = ?`).get('cafe00000001').c, 0, `${t} rolled back`);
      }
      assert.equal(db.prepare("SELECT count(*) AS c FROM doc_fts WHERE session_id = 'cafe00000001'").get().c, 0);
      assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key = 'migration_complete'").get(), undefined);
    });
    const boot = await spawnExpectingExit({ dataDir: dir, timeoutMs: 6000 });
    assert.ok(boot.code !== 0 && boot.code !== null);
    assert.match(boot.stderr, /migrate-json-to-sqlite\.mjs/);
  });

  test('sessions written by the server after migration are reported as diverged, not failed', async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-fix-diverged');
    assert.equal(runMigrate(['--data-dir', dir]).status, 0);
    const s = await startServer({ dataDir: dir });
    try {
      assert.equal((await http(s.url, 'PUT', '/paste/a1a1a1a1a1a1/markdown', { body: { markdown: 'edited after cutover' } })).status, 200);
      assert.equal((await http(s.url, 'POST', '/paste/d4d4d4d4d4d4/comments', { body: { startLine: 1, endLine: 1, selectedText: 'x', body: 'y', category: 'nit' } })).status, 201);
    } finally { await s.stop(); }
    const r = migrateWithReport(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const st = Object.fromEntries(r.report.sessions.map((x) => [x.id, x.status]));
    assert.equal(st.a1a1a1a1a1a1, 'diverged');
    assert.equal(st.d4d4d4d4d4d4, 'diverged');
    assert.ok(Object.entries(st).filter(([k]) => !['a1a1a1a1a1a1', 'd4d4d4d4d4d4'].includes(k)).every(([, v]) => v === 'unchanged'));
    assert.match(r.stdout, /0 errors, 2 diverged/);
    const s2 = await startServer({ dataDir: dir });
    try {
      assert.equal((await http(s2.url, 'GET', '/paste/a1a1a1a1a1a1/markdown')).json.markdown, 'edited after cutover', 'the DB wins');
    } finally { await s2.stop(); }
  });
});

test('fix 8: deleting a site or a session removes only slugs that point at it', async () => {
  const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-fix-slugs');
  assert.equal(runMigrate(['--data-dir', dir]).status, 0);
  const s = await startServer({ dataDir: dir });
  try {
    // "shared-name" is the slug of session 1b1b… and (in the site index) of site 6a6a…
    assert.equal((await http(s.url, 'DELETE', '/site/shared-name')).status, 204);
    assert.equal((await http(s.url, 'GET', '/paste/shared-name')).status, 200, 'the session keeps its slug');
    const sid = await create(s.url, { markdown: 'x', sessionName: 'Owner check' });
    const site = await http(s.url, 'POST', '/site', { body: { name: 'Owner check site', files: { 'index.html': 'hi' } } });
    assert.equal(site.status, 201);
    assert.equal((await http(s.url, 'DELETE', `/paste/${sid}`)).status, 204);
    assert.equal((await http(s.url, 'GET', `/site/${site.json.slug}/`)).status, 200, 'the site keeps its slug');
    await withDb(dir, (db) => {
      assert.equal(db.prepare('SELECT count(*) AS c FROM slugs WHERE target_id = ?').get(sid).c, 0);
      assert.deepEqual({ ...db.prepare('SELECT kind, target_id FROM slugs WHERE slug = ?').get('shared-name') }, { kind: 'session', target_id: '1b1b1b1b1b1b' });
    });
    // releasing a slug via PUT /meta never frees another doc's slug
    await create(s.url, { markdown: 'y', sessionName: 'Taken slug' });
    const mine = await create(s.url, { markdown: 'z', sessionName: 'Mine' });
    const u = await http(s.url, 'PUT', `/paste/${mine}/meta`, { body: { slug: 'taken-slug' } });
    assert.equal(u.json.slug, 'taken-slug-2');
    assert.equal((await http(s.url, 'GET', '/paste/taken-slug?fields=meta')).json.slug, 'taken-slug');
  } finally { await s.stop(); }
});

test('fix 2 (migration): column-owned keys in legacy meta are not imported', async () => {
  const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-fix-owned');
  const mp = path.join(dir, '0a0a0a0a0a0a.json');
  fs.writeFileSync(mp, JSON.stringify({ ...JSON.parse(fs.readFileSync(mp, 'utf-8')), edit_token_hash: 'x', created_by: 'y', version: 7 }));
  const r = migrateWithReport(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  await withDb(dir, (db) => {
    const row = db.prepare('SELECT edit_token_hash, created_by, version, extra_json FROM sessions WHERE id = ?').get('0a0a0a0a0a0a');
    assert.deepEqual([row.edit_token_hash, row.created_by, row.version, row.extra_json], [null, null, 1, '{}']);
  });
});
