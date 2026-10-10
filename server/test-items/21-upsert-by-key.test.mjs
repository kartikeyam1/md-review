// Item #21 — upsert by key (stable URL per recurring doc). Spec: docs/build/specs/21-upsert-by-key.md
// (+ 00 §6 URLs/reserved slugs, §10.5 server surface). Server ACs 21.1–21.11, 21.13; AC-21.12 is e2e
// (tests/e2e/items/21-upsert-by-key.test.mjs).
//
// Runs against verify.sh's backend when its URL + data dir are known (else a throwaway one).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  sharedBackend, http, uniq, tok, brief, DAY, DB_NAME, tmpDir, cleanupTmp, startMcpHttp, mcpConnect, runCli,
} from './23-helpers.mjs';

let B;
before(async () => { B = await sharedBackend(); });
after(async () => { await B?.stop(); cleanupTmp(); });

const HEX32 = /^[a-f0-9]{32}$/;
const enc = encodeURIComponent;
const put = (key, body, headers = {}) => http(B.url, 'PUT', `/paste/by-key/${enc(key)}`, { body, headers });
const getKey = (key) => http(B.url, 'GET', `/paste/by-key/${enc(key)}`);
const revs = async (x) => {
  const r = await http(B.url, 'GET', `/paste/${x}/revisions`);
  assert.equal(r.status, 200, brief(r));
  return r.json.revisions;
};
const newKey = (p = 't21') => `${p}:${uniq()}`;

async function sql(stmt, ...args) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(B.dataDir, DB_NAME));
  try { db.exec('PRAGMA busy_timeout = 5000'); return db.prepare(stmt).run(...args); } finally { db.close(); }
}

describe('#21 PUT /paste/by-key — create', () => {
  test('AC-21.1 unused key → 201 created/changed, 32-hex revision, editToken, url ends /d/<slug>', async () => {
    const key = newKey('test');
    const r = await put(key, { markdown: 'v1' });
    assert.equal(r.status, 201, brief(r));
    assert.equal(r.json.created, true);
    assert.equal(r.json.changed, true);
    assert.match(r.json.revision, HEX32);
    assert.match(String(r.json.editToken), /^mre_[A-Za-z0-9_-]{43}$/);
    assert.equal(r.json.key, key);
    assert.ok(r.json.slug, 'a keyed doc gets a slug');
    assert.equal(r.json.slug, key.replace(/[:.]/g, '-'), 'slug derived from the key');
    assert.ok(r.json.url.endsWith(`/d/${r.json.slug}`), r.json.url);
    assert.ok(r.json.app_url.endsWith(`/d/${r.json.slug}`), r.json.app_url);
    assert.ok(r.json.editUrl.endsWith(`?edit=${r.json.editToken}`));
    assert.equal(r.headers.get('etag'), `"${r.json.revision}"`);
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    // The created doc is an ordinary session: default mode publish, pending approval, 30-day expiry.
    const g = await http(B.url, 'GET', `/paste/${r.json.id}?fields=meta`);
    assert.equal(g.status, 200);
    assert.equal(g.json.mode, 'publish');
    assert.equal(g.json.approval_status, 'pending');
    assert.ok(Math.abs(Date.parse(g.json.expires_at) - Date.now() - 30 * DAY) < 60000, g.json.expires_at);
  });

  test('create honours slug → sessionName → key for the slug, and mode/filename/contentType', async () => {
    const s = `slug-${uniq()}`;
    const a = await put(newKey(), { markdown: '<h1>x</h1>', slug: s, sessionName: 'Ignored Name', mode: 'review', filename: 'r.html', contentType: 'html' });
    assert.equal(a.status, 201, brief(a));
    assert.equal(a.json.slug, s);
    const meta = (await http(B.url, 'GET', `/paste/${a.json.id}?fields=meta`)).json;
    assert.equal(meta.mode, 'review');
    assert.equal(meta.filename, 'r.html');
    assert.equal(meta.contentType, 'html');
    const n = `Weekly ${uniq()}`;
    const b = await put(newKey(), { markdown: 'x', sessionName: n });
    assert.equal(b.json.slug, n.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  });

  test('create with a slug taken by another doc → suffixed slug in the response', async () => {
    const s = `taken-${uniq()}`;
    const first = await put(newKey(), { markdown: 'a', slug: s });
    const second = await put(newKey(), { markdown: 'b', slug: s });
    assert.equal(first.json.slug, s);
    assert.equal(second.json.slug, `${s}-2`);
  });

  test('00 §6 reserved slugs: a key or slug "by-key"/"list" never gets that slug', async () => {
    for (const s of ['by-key', 'list']) {
      const r = await put(newKey(), { markdown: 'r', slug: s });
      assert.equal(r.status, 201, brief(r));
      assert.notEqual(r.json.slug, s);
      assert.ok(r.json.slug.startsWith(`${s}-`), r.json.slug);
    }
  });

  test('a key that equals an existing slug/id does not collide with it', async () => {
    const other = await http(B.url, 'POST', '/paste', { body: { markdown: 'other', slug: `cafe${uniq()}` } });
    const key = other.json.slug;
    const r = await put(key, { markdown: 'keyed' });
    assert.equal(r.status, 201, brief(r));
    assert.notEqual(r.json.id, other.json.id);
    assert.notEqual(r.json.slug, other.json.slug);
    assert.equal((await http(B.url, 'GET', `/paste/${other.json.id}/markdown`)).json.markdown, 'other');
  });
});

describe('#21 PUT /paste/by-key — update', () => {
  test('AC-21.2 update with token + changeNote → 200, same id/slug/url, new revision, note on the last revision, 2 revisions', async () => {
    const key = newKey('test');
    const c = await put(key, { markdown: 'v1' });
    const u = await put(key, { markdown: 'v2', changeNote: 'run 2', slug: 'ignored-on-update' }, tok(c.json.editToken));
    assert.equal(u.status, 200, brief(u));
    assert.equal(u.json.created, false);
    assert.equal(u.json.changed, true);
    for (const k of ['id', 'slug', 'url', 'app_url', 'key']) assert.equal(u.json[k], c.json[k], k);
    assert.notEqual(u.json.revision, c.json.revision);
    assert.match(u.json.revision, HEX32);
    assert.ok(!('editToken' in u.json), 'no editToken on update');
    const list = await revs(c.json.id);
    assert.equal(list.length, 2);
    assert.equal(list.at(-1).note, 'run 2');
    assert.equal(list.at(-1).hash, u.json.revision);
    assert.ok(!('note' in list[0]), 'note only present when set');
    const one = await http(B.url, 'GET', `/paste/${c.json.id}/revisions/${u.json.revision}`);
    assert.equal(one.json.note, 'run 2');
    const first = await http(B.url, 'GET', `/paste/${c.json.id}/revisions/${c.json.revision}`);
    assert.equal(first.json.note, null, 'GET /revisions/:hash note is null when absent');
  });

  test('AC-21.3 consecutive upserts by the same author never coalesce', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'a1', author: 'bot' });
    await put(key, { markdown: 'a2', author: 'bot' }, tok(c.json.editToken));
    await put(key, { markdown: 'a3', author: 'bot' }, tok(c.json.editToken));
    const list = await revs(c.json.id);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((r) => r.by), ['bot', 'bot', 'bot']);
  });

  test('fix: a later ordinary write by the same author never folds into a noted upsert revision', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'f1', author: 'bot' });
    await put(key, { markdown: 'f2', author: 'bot', changeNote: 'run 2' }, tok(c.json.editToken));
    const w = await http(B.url, 'PUT', `/paste/${c.json.id}/markdown`, { body: { markdown: 'f3', author: 'bot' }, headers: tok(c.json.editToken) });
    assert.equal(w.status, 200, brief(w));
    const list = await revs(c.json.id);
    assert.equal(list.length, 3);
    assert.equal(list[1].note, 'run 2');
    assert.ok(!('note' in list[2]));
  });

  test('fix: contentType is stored as given (like POST /paste)', async () => {
    const r = await put(newKey(), { markdown: '<p>x</p>', contentType: 'text/html' });
    assert.equal(r.status, 201, brief(r));
  });

  test('AC-21.4 identical content → 200 changed:false, no new revision', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'same' });
    const u = await put(key, { markdown: 'same', changeNote: 'nothing' }, tok(c.json.editToken));
    assert.equal(u.status, 200, brief(u));
    assert.equal(u.json.changed, false);
    assert.equal(u.json.created, false);
    assert.equal(u.json.revision, c.json.revision);
    assert.equal((await revs(c.json.id)).length, 1);
  });

  test('identical content with a changed filename/sessionName → changed:true, no new content revision', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'same', filename: 'a.md' });
    const u = await put(key, { markdown: 'same', filename: 'b.md' }, tok(c.json.editToken));
    assert.equal(u.json.changed, true);
    assert.equal(u.json.revision, c.json.revision);
    assert.equal((await http(B.url, 'GET', `/paste/${c.json.id}?fields=meta`)).json.filename, 'b.md');
  });

  test('AC-21.5 update without a token → 401 edit_token_required, content unchanged; wrong token → 403', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'orig' });
    const r = await put(key, { markdown: 'hijack' });
    assert.equal(r.status, 401, brief(r));
    assert.equal(r.json.code, 'edit_token_required');
    const w = await put(key, { markdown: 'hijack' }, tok('mre_' + 'x'.repeat(43)));
    assert.equal(w.status, 403, brief(w));
    assert.equal((await http(B.url, 'GET', `/paste/${c.json.id}/markdown`)).json.markdown, 'orig');
  });

  test('AC-21.7 stale If-Match (or base_hash) → 412 with content_hash + markdown', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'base' });
    await put(key, { markdown: 'moved on' }, tok(c.json.editToken));
    const r = await put(key, { markdown: 'mine' }, { ...tok(c.json.editToken), 'If-Match': `"${c.json.revision}"` });
    assert.equal(r.status, 412, brief(r));
    assert.equal(r.json.markdown, 'moved on');
    assert.match(r.json.content_hash, HEX32);
    const b = await put(key, { markdown: 'mine', base_hash: c.json.revision }, tok(c.json.editToken));
    assert.equal(b.status, 412);
    const ok = await put(key, { markdown: 'mine' }, { ...tok(c.json.editToken), 'If-Match': r.json.content_hash });
    assert.equal(ok.status, 200, brief(ok));
  });

  test('upsert then PUT /markdown with the old hash → 412', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'one' });
    await put(key, { markdown: 'two' }, tok(c.json.editToken));
    const r = await http(B.url, 'PUT', `/paste/${c.json.id}/markdown`, { body: { markdown: 'ui' }, headers: { ...tok(c.json.editToken), 'If-Match': c.json.revision } });
    assert.equal(r.status, 412);
  });

  test('contentType switch html → markdown is stored', async () => {
    const key = newKey();
    const c = await put(key, { markdown: '<p>x</p>', contentType: 'html', filename: 'x.html' });
    await put(key, { markdown: '# md', contentType: 'markdown', filename: 'x.md' }, tok(c.json.editToken));
    const meta = (await http(B.url, 'GET', `/paste/${c.json.id}?fields=meta`)).json;
    assert.equal(meta.contentType, 'markdown');
    assert.equal(meta.filename, 'x.md');
  });

  test('changeNote with HTML is stored verbatim; > 500 chars → 400; trimmed', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'n1' });
    const note = '  <img src=x onerror=alert(1)> **bold**  ';
    await put(key, { markdown: 'n2', changeNote: note }, tok(c.json.editToken));
    assert.equal((await revs(c.json.id)).at(-1).note, note.trim());
    const long = await put(key, { markdown: 'n3', changeNote: 'x'.repeat(501) }, tok(c.json.editToken));
    assert.equal(long.status, 400, brief(long));
    const okLong = await put(key, { markdown: 'n3', changeNote: 'y'.repeat(500) }, tok(c.json.editToken));
    assert.equal(okLong.status, 200, brief(okLong));
  });

  test('AC-21.8 an expired keyed doc is revived by an upsert without expiry_days', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'old' });
    await sql('UPDATE sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() - DAY).toISOString(), c.json.id);
    assert.equal((await http(B.url, 'GET', `/paste/${c.json.id}`)).status, 410);
    const g = await getKey(key);
    assert.equal(g.status, 200);
    assert.equal(g.json.expired, true);
    const u = await put(key, { markdown: 'new run' }, tok(c.json.editToken));
    assert.equal(u.status, 200, brief(u));
    const after = await http(B.url, 'GET', `/paste/${c.json.id}?fields=meta`);
    assert.equal(after.status, 200);
    assert.ok(Math.abs(Date.parse(after.json.expires_at) - Date.now() - 30 * DAY) < 60000, after.json.expires_at);
    assert.ok(!('expired' in (await getKey(key)).json));
  });

  test('expiry_days on update recomputes; absent on a live doc leaves it unchanged', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'e1', expiry_days: 7 });
    const m1 = (await http(B.url, 'GET', `/paste/${c.json.id}?fields=meta`)).json.expires_at;
    assert.ok(Math.abs(Date.parse(m1) - Date.now() - 7 * DAY) < 60000);
    await put(key, { markdown: 'e2' }, tok(c.json.editToken));
    assert.equal((await http(B.url, 'GET', `/paste/${c.json.id}?fields=meta`)).json.expires_at, m1);
    await put(key, { markdown: 'e3', expiry_days: 90 }, tok(c.json.editToken));
    const m3 = (await http(B.url, 'GET', `/paste/${c.json.id}?fields=meta`)).json.expires_at;
    assert.ok(Math.abs(Date.parse(m3) - Date.now() - 90 * DAY) < 60000);
  });

  test('AC-21.9 after deletion the key is free: 201 with a new id, old slug reused', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 'd1' });
    const del = await http(B.url, 'DELETE', `/paste/${c.json.id}`, { headers: tok(c.json.editToken) });
    assert.equal(del.status, 204);
    assert.equal((await getKey(key)).status, 404);
    const r = await put(key, { markdown: 'd2' });
    assert.equal(r.status, 201, brief(r));
    assert.equal(r.json.created, true);
    assert.notEqual(r.json.id, c.json.id);
    assert.notEqual(r.json.editToken, c.json.editToken);
    assert.equal(r.json.slug, c.json.slug);
  });

  test('AC-21.10 two parallel first-time upserts → one session, one 201 and one 401', async () => {
    const key = newKey();
    const [a, b] = await Promise.all([put(key, { markdown: 'p1' }), put(key, { markdown: 'p2' })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 401], `${brief(a)} | ${brief(b)}`);
    const g = await getKey(key);
    assert.equal(g.status, 200);
    const winner = a.status === 201 ? a : b;
    assert.equal(g.json.id, winner.json.id);
  });

  test('upserts and PUT /markdown on one doc serialise (no lost revision)', async () => {
    const key = newKey();
    const c = await put(key, { markdown: 's0' });
    const t = tok(c.json.editToken);
    await Promise.all([
      put(key, { markdown: 's1' }, t),
      http(B.url, 'PUT', `/paste/${c.json.id}/markdown`, { body: { markdown: 's2', author: 'ui' }, headers: t }),
      put(key, { markdown: 's3' }, t),
    ]);
    const list = await revs(c.json.id);
    const cur = (await getKey(key)).json.revision;
    assert.equal(list.at(-1).hash, cur, 'the last revision is the current content');
  });
});

describe('#21 key rules and GET /paste/by-key', () => {
  test('AC-21.6 invalid keys → 400 invalid_key', async () => {
    for (const key of ['Test', '-x', 'a b', 'a/b', 'a'.repeat(129), '.x', 'ünï']) {
      const r = await put(key, { markdown: 'x' });
      assert.equal(r.status, 400, `${JSON.stringify(key)}: ${brief(r)}`);
      assert.equal(r.json?.code, 'invalid_key', `${JSON.stringify(key)}: ${brief(r)}`);
    }
    const max = await put(`a${'b'.repeat(127)}`, { markdown: 'x' });
    assert.equal(max.status, 201, `128 chars ok: ${brief(max)}`);
    assert.equal((await getKey('Bad Key')).status, 400);
  });

  test('body validation: markdown required string; invalid mode → 400', async () => {
    assert.equal((await put(newKey(), {})).status, 400);
    assert.equal((await put(newKey(), { markdown: 42 })).status, 400);
    assert.equal((await put(newKey(), { markdown: 'x', mode: 'Draft' })).status, 400);
    assert.equal((await http(B.url, 'PUT', `/paste/by-key/${enc(newKey())}`, { body: '{nope' })).status, 400);
  });

  test('AC-21.13 GET unknown key → 404; existing → 200 with the current revision', async () => {
    assert.equal((await getKey('unknown:key-' + uniq())).status, 404);
    const key = newKey();
    const c = await put(key, { markdown: 'g1' });
    const u = await put(key, { markdown: 'g2' }, tok(c.json.editToken));
    const g = await getKey(key);
    assert.equal(g.status, 200, brief(g));
    assert.equal(g.json.revision, u.json.revision);
    for (const k of ['id', 'slug', 'key', 'url', 'app_url']) assert.equal(g.json[k], c.json[k], k);
    assert.ok(g.json.updated_at);
    assert.ok(!('editToken' in g.json));
  });
});

describe('#21 MCP upsert_session + CLI publish', () => {
  let m, store;
  before(async () => {
    store = path.join(tmpDir('md-review-21-store'), 'tokens.json');
    m = await startMcpHttp({ apiUrl: B.url, storePath: store });
  });
  after(async () => { await m?.stop(); });

  const once = async (name, args) => {
    const c = await mcpConnect(m.url);
    try { return await c.call(name, args); } finally { await c.close(); }
  };

  test('AC-21.11 upsert_session twice from separate connections without editToken → created:false, same url', async () => {
    const key = newKey('mcp');
    const a = await once('upsert_session', { key, markdown: 'm1', changeNote: 'first' });
    assert.equal(a.created, true, JSON.stringify(a));
    assert.equal(a.shareUrl, a.url);
    const b = await once('upsert_session', { key, markdown: 'm2', changeNote: 'second' });
    assert.ok(!b.__toolError && !b.error, JSON.stringify(b));
    assert.equal(b.created, false);
    assert.equal(b.changed, true);
    assert.equal(b.url, a.url);
    const list = await revs(a.id);
    assert.equal(list.at(-1).note, 'second');
    assert.equal(list.at(-1).by, 'agent', 'MCP author defaults to agent');
    const lr = await once('list_revisions', { sessionId: a.id });
    assert.equal(lr.revisions.at(-1).note, 'second');
  });

  test('fix: MCP errors carry the REST code (invalid_key)', async () => {
    const r = await once('upsert_session', { key: 'Bad Key', markdown: 'x' });
    assert.equal(r.code, 'invalid_key', JSON.stringify(r));
  });

  test('fix: a stale stored token says so', async () => {
    const key = newKey('mcp');
    const a = await once('upsert_session', { key, markdown: 's1' });
    // The doc is deleted and re-created elsewhere (new token the store does not know).
    await http(B.url, 'DELETE', `/paste/${a.id}`, { headers: tok(a.editToken) });
    await put(key, { markdown: 'elsewhere' });
    const r = await once('upsert_session', { key, markdown: 's2' });
    assert.equal(r.code, 'edit_token_invalid', JSON.stringify(r));
    assert.match(r.error, /no longer valid.*Pass editToken/);
  });

  test('upsert_session rejects content > 10 MB with a pointer to the CLI', async () => {
    const r = await once('upsert_session', { key: newKey('mcp'), markdown: 'x'.repeat(10 * 1024 * 1024 + 1) });
    const msg = JSON.stringify(r);
    assert.ok(r.__toolError || r.error, msg.slice(0, 200));
    assert.match(msg, /publish|create_via_shell/);
  });

  test('upsert_session is listed with the spec description', async () => {
    const c = await mcpConnect(m.url);
    try {
      const { tools } = await c.client.listTools();
      const t = tools.find((x) => x.name === 'upsert_session');
      assert.ok(t);
      assert.match(t.description, /stable key/);
    } finally { await c.close(); }
  });

  test('CLI publish creates, then updates with --token and --note', async () => {
    const dir = tmpDir('md-review-21-cli');
    const f = path.join(dir, 'r.md');
    fs.writeFileSync(f, '# Run 1\n');
    const key = newKey('cli');
    const env = { PASTE_API_URL: B.url, MCP_TOKEN_STORE: path.join(dir, 'none.json') };
    const a = await runCli(['publish', key, f, '--name', 'CLI weekly', '--api', B.url], { env });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.json.created, true, a.stdout);
    assert.match(a.json.revision, HEX32);
    assert.ok(a.json.url);
    assert.ok(a.json.editToken);
    fs.writeFileSync(f, '# Run 2\n');
    const no = await runCli(['publish', key, f, '--api', B.url], { env });
    assert.notEqual(no.code, 0, 'update without a token fails');
    const b = await runCli(['publish', key, f, '--note', 'second run', '--token', a.json.editToken, '--api', B.url], { env });
    assert.equal(b.code, 0, b.stderr);
    assert.equal(b.json.created, false);
    assert.equal(b.json.url, a.json.url);
    assert.equal((await revs(a.json.id)).at(-1).note, 'second run');
  });
});
