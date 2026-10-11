// Item #26 — library API, server half: AC-26.20, AC-26.21 and the API side of AC-26.6/26.7/26.9/26.10/26.11,
// plus the spec's server edge cases. Spec: docs/build/specs/26-library.md (+ 00 §7, §8, §9) and the captain's
// internal contract (pins / collections / tags / bulk / ?fields=library / created_by / protected).
// Runs against verify.sh's shared backend: other suites' docs exist, so every assertion is scoped to docs,
// tags, collections and reader keys this file creates.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sharedBackend, http, uniq, tok, brief, DB_NAME, cleanupTmp, create, makeLegacy, legacyBackend } from './23-helpers.mjs';

let B;
before(async () => { B = await sharedBackend(); });
after(async () => { await B?.stop(); cleanupTmp(); });

// ── helpers ─────────────────────────────────────────────────────────────────

const letters = () => uniq().replace(/[0-9]/g, (d) => 'ghijklmnop'[d]); // a-p only: one FTS token, no digits
const rid = () => `anon-${uniq()}${uniq()}`;
const readerHdr = (key) => ({ 'X-MdReview-Reader': encodeURIComponent(key) });
const qs = (o) => new URLSearchParams(o).toString();

async function docs(params = {}, headers = {}) {
  const r = await http(B.url, 'GET', `/library/docs?${qs(params)}`, { headers });
  assert.equal(r.status, 200, brief(r));
  return r.json;
}
const ids = (body) => body.items.map((i) => i.id);

async function sqlRun(stmt, ...args) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(B.dataDir, DB_NAME));
  try { db.exec('PRAGMA busy_timeout = 5000'); return db.prepare(stmt).run(...args); } finally { db.close(); }
}
async function sqlAll(stmt, ...args) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(B.dataDir, DB_NAME));
  try { db.exec('PRAGMA busy_timeout = 5000'); return db.prepare(stmt).all(...args); } finally { db.close(); }
}
const expire = (id) => sqlRun('UPDATE sessions SET expires_at = ?, version = version + 1 WHERE id = ?', new Date(Date.now() - 60000).toISOString(), id);

const newCollection = (name) => http(B.url, 'POST', '/library/collections', { body: { name } });
async function collection(name = `Col ${uniq()}`) {
  const r = await newCollection(name);
  assert.equal(r.status, 201, brief(r));
  return r.json;
}
const putTags = (d, tags, headers = tok(d.editToken)) => http(B.url, 'PUT', `/paste/${d.id}/tags`, { body: { tags }, headers });
const putCol = (d, collectionId, headers = tok(d.editToken)) => http(B.url, 'PUT', `/paste/${d.id}/collection`, { body: { collectionId }, headers });
const pin = (key, x) => http(B.url, 'PUT', `/library/pins/${x}`, { headers: readerHdr(key) });
const unpin = (key, x) => http(B.url, 'DELETE', `/library/pins/${x}`, { headers: readerHdr(key) });
async function pins(key) {
  const r = await http(B.url, 'GET', '/library/pins', { headers: readerHdr(key) });
  assert.equal(r.status, 200, brief(r));
  return r.json;
}
const bulk = (body) => http(B.url, 'POST', '/library/bulk', { body });
const addFile = (d, name, content, encoding) => http(B.url, 'POST', `/paste/${d.id}/files`, { body: { name, content, ...(encoding ? { encoding } : {}) }, headers: tok(d.editToken) });
const delFile = (d, name) => http(B.url, 'DELETE', `/paste/${d.id}/files/${encodeURIComponent(name)}`, { headers: tok(d.editToken) });
const segText = (snippet) => snippet.map((s) => s.text).join('');

// ── AC-26.20 GET /library/docs ──────────────────────────────────────────────

describe('#26 AC-26.20 GET /library/docs shape, paging, pinned, protected', () => {
  test('items carry every 00 §8 key plus protected; paging with total + cursor; pinned per reader', async () => {
    const tag = `t-${uniq()}`;
    const made = [];
    for (let i = 0; i < 3; i++) {
      const d = await create(B.url, { markdown: `# Doc ${i} ${uniq()}\n\nbody\n`, author: i === 0 ? 'Asha' : undefined });
      assert.equal((await putTags(d, [tag])).status, 200);
      made.push(d);
    }
    const all = await docs({ tag });
    assert.equal(all.total, 3);
    assert.equal(all.next_cursor, null);
    assert.equal(all.query, null);
    for (const it of all.items) {
      for (const k of ['id', 'slug', 'title', 'filename', 'contentType', 'mode', 'created_by', 'created_at', 'updated_at', 'collection',
        'tags', 'file_count', 'reaction_count', 'view_count', 'must_fix_unresolved', 'pinned', 'match', 'protected']) {
        assert.ok(Object.hasOwn(it, k), `item has ${k}`);
      }
      assert.equal(it.pinned, false, 'no reader header → pinned false');
      assert.equal(it.protected, true, 'new docs have an edit token');
      assert.deepEqual(it.tags, [tag]);
      assert.equal(it.match, null);
    }
    assert.equal(all.items.find((i) => i.id === made[0].id).created_by, 'Asha');

    const p1 = await docs({ tag, limit: '2' });
    assert.equal(p1.total, 3);
    assert.equal(p1.items.length, 2);
    assert.ok(p1.next_cursor);
    const p2 = await docs({ tag, limit: '2', cursor: p1.next_cursor });
    assert.equal(p2.items.length, 1);
    assert.equal(p2.next_cursor, null);
    assert.deepEqual([...ids(p1), ...ids(p2)].sort(), made.map((d) => d.id).sort());

    const key = `name:${letters()}`;
    assert.equal((await pin(key, made[1].id)).status, 200);
    const mine = await docs({ tag }, readerHdr(key));
    assert.deepEqual(mine.items.filter((i) => i.pinned).map((i) => i.id), [made[1].id]);
    const other = await docs({ tag }, readerHdr(rid()));
    assert.ok(other.items.every((i) => i.pinned === false), 'another reader sees no pins');
  });

  test('pinned=1 keeps only the reader\'s pins, most recently pinned first; ANDs with filters; no reader → []', async () => {
    const tag = `pn-${uniq()}`;
    const key = rid();
    const made = [];
    for (let i = 0; i < 4; i++) { const d = await create(B.url); await putTags(d, i < 3 ? [tag] : ['other-pin-tag']); made.push(d); }
    for (const i of [2, 0, 3]) assert.equal((await pin(key, made[i].id)).status, 200);
    const all = await docs({ pinned: '1', limit: '50' }, readerHdr(key));
    assert.deepEqual(ids(all), [made[3].id, made[0].id, made[2].id]);
    assert.ok(all.items.every((i) => i.pinned));
    assert.deepEqual(ids(await docs({ pinned: '1', tag }, readerHdr(key))), [made[0].id, made[2].id]);
    const p1 = await docs({ pinned: '1', limit: '2' }, readerHdr(key));
    assert.equal(p1.total, 3);
    const p2 = await docs({ pinned: '1', limit: '2', cursor: p1.next_cursor }, readerHdr(key));
    assert.deepEqual([...ids(p1), ...ids(p2)], ids(all));
    assert.equal((await http(B.url, 'GET', `/library/docs?pinned=1&limit=2&cursor=${p1.next_cursor}`, { headers: readerHdr(rid()) })).status, 400, 'cursor bound to the reader');
    assert.deepEqual((await docs({ pinned: '1' })).items, [], 'no reader header → items: []');
    assert.deepEqual(ids(await docs({ pinned: '1', sort: 'created' }, readerHdr(key))).sort(), ids(all).sort());
    assert.equal((await http(B.url, 'GET', '/library/docs?pinned=yes')).status, 400);
  });

  test('an invalid X-MdReview-Reader is 400 {error:"invalid reader"}', async () => {
    for (const raw of ['bad key!', 'short', '%E0%A4%A', `name:${'x'.repeat(81)}`, 'name:', encodeURIComponent('a'.repeat(65))]) {
      const r = await http(B.url, 'GET', '/library/docs', { headers: { 'X-MdReview-Reader': raw } });
      assert.equal(r.status, 400, `${raw}: ${brief(r)}`);
      assert.deepEqual(r.json, { error: 'invalid reader' });
    }
    const ok = await http(B.url, 'GET', '/library/docs', { headers: readerHdr('name:Zoë Ünïcode') });
    assert.equal(ok.status, 200, 'a percent-encoded non-ASCII name is valid');
  });

  test('a legacy (link-editable) doc is protected:false', async () => {
    const tag = `t-${uniq()}`;
    const d = await create(B.url);
    await putTags(d, [tag]);
    await makeLegacy(B.dataDir, d.id);
    assert.equal((await docs({ tag })).items[0].protected, false);
  });

  test('FTS syntax in q never 4xx/5xx', async () => {
    for (const q of ['"', '*', '-', 'OR', 'NEAR(', '"unbalanced', 'a:b', '^x', '(', ')', 'AND', 'NOT', 'x OR y', '"a" * -b', '\\', '%', "'", 'col:term', '-- ;DROP TABLE sessions']) {
      const r = await http(B.url, 'GET', `/library/docs?${qs({ q })}`);
      assert.equal(r.status, 200, `q=${q}: ${brief(r)}`);
    }
  });
});

// ── AC-26.21 document files in the index ────────────────────────────────────

describe('#26 AC-26.21 document files are searchable as match.field "file"', () => {
  test('a term only in appendix.md matches once with field file; deleting the file removes the match', async () => {
    const term = `zanzibar${letters()}`;
    const d = await create(B.url, { markdown: '# Report\n\nNothing to see.\n' });
    assert.equal((await addFile(d, 'appendix.md', `# Appendix\n\nThe **${term}** figures.\n`)).status, 201);
    const r = await docs({ q: term });
    assert.equal(r.total, 1);
    assert.deepEqual(ids(r), [d.id]);
    const m = r.items[0].match;
    assert.equal(m.field, 'file');
    assert.equal(m.file, 'appendix.md');
    assert.ok(m.snippet.some((s) => s.hit && s.text.toLowerCase() === term), JSON.stringify(m.snippet));
    assert.ok(!segText(m.snippet).includes('**'), 'markdown file snippets are plain text');

    assert.equal((await delFile(d, 'appendix.md')).status, 204);
    assert.equal((await docs({ q: term })).total, 0, 'no match after the file is deleted');
  });

  test('nested HTML files are stripped; a rewrite replaces the indexed text; non-document files are not indexed', async () => {
    const a = `quixotic${letters()}`; const b = `pellucid${letters()}`; const s = `scriptonly${letters()}`; const img = `pngterm${letters()}`;
    const d = await create(B.url, { markdown: '# Plain\n' });
    await addFile(d, 'data/report.html', `<html><head><script>var x="${s}"</script></head><body><p>The ${a} part</p></body></html>`);
    await addFile(d, 'notes.png', `fake image ${img}`);
    await addFile(d, 'Readme.TXT', `upper-case extension ${b}`);
    const r = await docs({ q: a });
    assert.deepEqual(ids(r), [d.id]);
    assert.equal(r.items[0].match.file, 'data/report.html');
    assert.ok(!segText(r.items[0].match.snippet).includes('<p>'));
    assert.equal((await docs({ q: s })).total, 0, 'script text is stripped');
    assert.equal((await docs({ q: img })).total, 0, '.png is an attachment, not indexed');
    assert.equal((await docs({ q: b })).items[0]?.match.file, 'Readme.TXT', 'extension match is case-insensitive');

    await addFile(d, 'data/report.html', '<p>rewritten</p>');
    assert.equal((await docs({ q: a })).total, 0, 'old file text is gone after a rewrite');
  });

  test('AC-26.3 markdown snippets keep inline HTML as literal text (session and file rows); HTML docs stay tag-stripped', async () => {
    const t1 = `kumquat${letters()}`; const t2 = `kumfile${letters()}`; const t3 = `kumhtml${letters()}`;
    const d = await create(B.url, { markdown: `# Fruit\n\nSee <img src=x onerror=alert(1)>${t1} here <!-- hidden -->.\n` });
    const r = await docs({ q: t1 });
    assert.deepEqual(ids(r), [d.id]);
    assert.equal(r.items[0].match.field, 'content');
    const text = segText(r.items[0].match.snippet);
    assert.ok(text.includes(`<img src=x onerror=alert(1)>${t1}`), text);
    assert.ok(!text.includes('hidden'), 'comments are still removed');
    assert.ok(r.items[0].match.snippet.some((s) => s.hit && s.text === t1));

    const f = await create(B.url, { markdown: '# Plain\n' });
    await addFile(f, 'notes.md', `x <b onclick="x()">${t2}</b>`);
    const rf = await docs({ q: t2 });
    assert.equal(rf.items[0].match.field, 'file');
    assert.ok(segText(rf.items[0].match.snippet).includes(`<b onclick="x()">${t2}</b>`), segText(rf.items[0].match.snippet));

    const h = await create(B.url, { markdown: `<p>x <img src=x onerror=alert(1)>${t3}</p>`, contentType: 'html', filename: 'h.html' });
    const rh = await docs({ q: t3 });
    assert.deepEqual(ids(rh), [h.id]);
    assert.ok(!segText(rh.items[0].match.snippet).includes('<'), 'HTML docs stay tag-stripped (00 §8)');
  });

  test('a session and its files collapse into one item; the best-ranked row decides match', async () => {
    const term = `collapse${letters()}`;
    const d = await create(B.url, { markdown: `# ${term} title\n\n${term} body\n` });
    await addFile(d, 'a.md', `${term} in a`);
    await addFile(d, 'b.md', `${term} in b`);
    const r = await docs({ q: term });
    assert.equal(r.total, 1);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].match.field, 'title', 'the title hit (weight 10) outranks file content');
  });
});

// ── created_by, ?fields=library ─────────────────────────────────────────────

describe('#26 GET /paste/:id created_by and ?fields=library', () => {
  test('created_by on the full GET and ?fields=meta (null when no author)', async () => {
    const d = await create(B.url, { author: 'Ann' });
    assert.equal((await http(B.url, 'GET', `/paste/${d.id}`)).json.created_by, 'Ann');
    assert.equal((await http(B.url, 'GET', `/paste/${d.id}?fields=meta`)).json.created_by, 'Ann');
    const n = await create(B.url);
    const full = (await http(B.url, 'GET', `/paste/${n.id}`)).json;
    assert.ok(Object.hasOwn(full, 'created_by'));
    assert.equal(full.created_by, null);
    assert.ok(!Object.hasOwn(full, 'tags') && !Object.hasOwn(full, 'collection'), 'library keys only with ?fields=library');
  });

  test('?fields=library adds title, collection, tags (combinable); a tag change is never a stale 304', async () => {
    const d = await create(B.url, { markdown: '# The Library Title\n\nx\n', sessionName: '' });
    const lib = (await http(B.url, 'GET', `/paste/${d.id}?fields=library`)).json;
    assert.equal(lib.title, 'The Library Title');
    assert.equal(lib.collection, null);
    assert.deepEqual(lib.tags, []);

    const c = await collection();
    await putCol(d, c.id);
    await putTags(d, ['zeta', 'alpha']);
    const r1 = await http(B.url, 'GET', `/paste/${d.id}?fields=meta,files,library`);
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json.collection, { id: c.id, name: c.name });
    assert.deepEqual(r1.json.tags, ['alpha', 'zeta']);
    assert.ok(Array.isArray(r1.json.files));
    assert.equal(r1.json.id, d.id);
    assert.ok(Object.hasOwn(r1.json, 'created_by'));

    await putTags(d, ['beta']);
    const r2 = await http(B.url, 'GET', `/paste/${d.id}?fields=meta,files,library`, { headers: { 'If-None-Match': r1.headers.get('etag') } });
    assert.equal(r2.status, 200, 'the ETag changes with the tags');
    assert.deepEqual(r2.json.tags, ['beta']);
    await http(B.url, 'PATCH', `/library/collections/${c.id}`, { body: { name: `${c.name} renamed` } });
    const r3 = await http(B.url, 'GET', `/paste/${d.id}?fields=library`, { headers: { 'If-None-Match': r2.headers.get('etag') } });
    assert.equal(r3.status, 200, 'a collection rename is visible on the next read');
    assert.equal(r3.json.collection.name, `${c.name} renamed`);
  });
});

// ── collections (AC-26.9 API side) ──────────────────────────────────────────

describe('#26 collections', () => {
  test('create → 201 shape; name rules → 400; case-insensitive duplicate → 409', async () => {
    const name = `  Ops ${uniq()}  `;
    const r = await newCollection(name);
    assert.equal(r.status, 201, brief(r));
    assert.deepEqual(Object.keys(r.json).sort(), ['doc_count', 'id', 'name', 'slug']);
    assert.equal(r.json.name, name.trim());
    assert.equal(r.json.doc_count, 0);
    assert.ok(r.json.id && r.json.slug);

    const dup = await newCollection(name.trim().toUpperCase());
    assert.equal(dup.status, 409, brief(dup));
    assert.deepEqual(dup.json, { error: 'A collection with that name already exists' });

    for (const bad of ['', '   ', 'x'.repeat(61), 42, null]) {
      const b = await newCollection(bad);
      assert.equal(b.status, 400, `${JSON.stringify(bad)}: ${brief(b)}`);
      assert.ok(b.json.error);
    }
    assert.equal((await http(B.url, 'POST', '/library/collections', { body: 'not json' })).status, 400);
    const sixty = await newCollection(`${uniq()}${'y'.repeat(52)}`);
    assert.equal(sixty.status, 201, '60 chars is allowed');
  });

  test('GET is sorted by name case-insensitively with doc_count excluding expired docs', async () => {
    const stem = uniq();
    const b = await collection(`${stem} beta`);
    const a = await collection(`${stem} Alpha`);
    const c = await collection(`${stem} charlie`);
    const d1 = await create(B.url); const d2 = await create(B.url);
    await putCol(d1, a.id); await putCol(d2, a.id);
    await expire(d2.id);
    const list = (await http(B.url, 'GET', '/library/collections')).json;
    const mine = list.filter((x) => x.name.startsWith(stem));
    assert.deepEqual(mine.map((x) => x.id), [a.id, b.id, c.id]);
    assert.equal(mine[0].doc_count, 1, 'the expired doc is not counted');
    for (const x of list) assert.deepEqual(Object.keys(x).sort(), ['doc_count', 'id', 'name', 'slug']);
    const names = list.map((x) => x.name.toLowerCase());
    assert.deepEqual(names, [...names].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0)));
  });

  test('PATCH renames (own name in another case allowed, another collection\'s name → 409, unknown → 404)', async () => {
    const a = await collection(`Ren ${uniq()}`);
    const b = await collection(`Other ${uniq()}`);
    const self = await http(B.url, 'PATCH', `/library/collections/${a.id}`, { body: { name: a.name.toUpperCase() } });
    assert.equal(self.status, 200, brief(self));
    assert.equal(self.json.name, a.name.toUpperCase());
    assert.equal(self.json.id, a.id);
    const clash = await http(B.url, 'PATCH', `/library/collections/${a.id}`, { body: { name: b.name.toLowerCase() } });
    assert.equal(clash.status, 409);
    assert.equal((await http(B.url, 'PATCH', `/library/collections/${a.id}`, { body: { name: '' } })).status, 400);
    assert.equal((await http(B.url, 'PATCH', '/library/collections/nope-nope', { body: { name: 'x' } })).status, 404);
  });

  test('DELETE leaves its docs unfiled (never deletes docs); filtering on a deleted collection is items:[]', async () => {
    const c = await collection(`Del ${uniq()}`);
    const d = await create(B.url);
    const set = await putCol(d, c.id);
    assert.equal(set.status, 200, brief(set));
    assert.deepEqual(set.json, { collection: { id: c.id, name: c.name } });
    assert.deepEqual(ids(await docs({ collection: c.id })), [d.id]);
    assert.deepEqual(ids(await docs({ collection: c.slug })), [d.id], 'by slug too');

    const del = await http(B.url, 'DELETE', `/library/collections/${c.id}`);
    assert.equal(del.status, 204);
    assert.equal((await http(B.url, 'GET', `/paste/${d.id}`)).status, 200, 'the doc still exists');
    assert.ok(ids(await docs({ collection: 'none', limit: '100' })).includes(d.id), 'now unfiled');
    const gone = await docs({ collection: c.id });
    assert.deepEqual(gone.items, []);
    assert.equal((await http(B.url, 'DELETE', `/library/collections/${c.id}`)).status, 404);
  });

  test('PUT /paste/:id/collection: edit capability, unknown collection 404, null unfiles', async () => {
    const c = await collection();
    const d = await create(B.url);
    assert.equal((await putCol(d, c.id, {})).status, 401);
    assert.equal((await putCol(d, c.id, tok('mre_wrong'))).status, 403);
    assert.equal((await putCol(d, 'no-such-collection')).status, 404);
    assert.equal((await putCol(d, 42)).status, 400);
    assert.equal((await http(B.url, 'PUT', '/paste/ffffffffffff/collection', { body: { collectionId: c.id } })).status, 404);
    await putCol(d, c.id);
    const un = await putCol(d, null);
    assert.equal(un.status, 200);
    assert.deepEqual(un.json, { collection: null });
    assert.equal((await http(B.url, 'GET', '/library/collections')).json.find((x) => x.id === c.id).doc_count, 0);
  });
});

// ── tags (AC-26.10 API side) ────────────────────────────────────────────────

describe('#26 tags', () => {
  test('PUT normalises, de-duplicates and sorts; the tag filter finds the doc; GET /library/tags counts', async () => {
    const d = await create(B.url);
    const word = letters();
    const r = await putTags(d, [` Q4 Plan ${word} `, `q4-plan-${word}`, `B-${word}`]);
    assert.equal(r.status, 200, brief(r));
    assert.deepEqual(r.json, { tags: [`b-${word}`, `q4-plan-${word}`] });
    assert.deepEqual(ids(await docs({ tag: `q4-plan-${word}` })), [d.id]);
    assert.deepEqual(ids(await docs({ tag: `Q4-PLAN-${word}` })), [d.id], 'tag filter is case-insensitive');

    const e = await create(B.url);
    await putTags(e, [`b-${word}`]);
    const tags = (await http(B.url, 'GET', '/library/tags')).json;
    assert.deepEqual(tags.find((t) => t.tag === `b-${word}`), { tag: `b-${word}`, count: 2 });
    for (const t of tags) assert.ok(t.count > 0);
    const names = tags.map((t) => t.tag);
    assert.deepEqual(names, [...names].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0)));

    await expire(e.id);
    assert.equal((await http(B.url, 'GET', '/library/tags')).json.find((t) => t.tag === `b-${word}`).count, 1, 'expired docs not counted');
    await putTags(d, []);
    assert.equal((await http(B.url, 'GET', '/library/tags')).json.find((t) => t.tag === `b-${word}`), undefined, 'count 0 → omitted');
  });

  test('invalid tags → 400 and nothing saved (café, 33 chars, 21 tags, not an array)', async () => {
    const d = await create(B.url);
    await putTags(d, ['keep']);
    for (const body of [['café'], ['x'.repeat(33)], Array.from({ length: 21 }, (_, i) => `t${i}`), 'ops', [42], null]) {
      const r = await putTags(d, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${brief(r)}`);
      assert.ok(r.json.error);
    }
    assert.deepEqual((await http(B.url, 'GET', `/paste/${d.id}?fields=library`)).json.tags, ['keep']);
  });

  test('PUT tags needs edit capability; legacy docs need none', async () => {
    const d = await create(B.url);
    const no = await putTags(d, ['x'], {});
    assert.equal(no.status, 401);
    assert.equal(no.json.code, 'edit_token_required');
    assert.equal((await putTags(d, ['x'], tok('mre_wrong'))).status, 403);
    assert.equal((await http(B.url, 'PUT', '/paste/ffffffffffff/tags', { body: { tags: ['x'] } })).status, 404);
    await makeLegacy(B.dataDir, d.id);
    assert.equal((await putTags(d, ['x'], {})).status, 200);
  });
});

// ── pins (AC-26.6 / AC-26.7 API side) ───────────────────────────────────────

describe('#26 pins', () => {
  test('header required; PUT by slug stores the id; idempotent; most recent first; per reader; DELETE idempotent', async () => {
    assert.equal((await http(B.url, 'GET', '/library/pins')).status, 400);
    assert.equal((await http(B.url, 'GET', '/library/pins', { headers: { 'X-MdReview-Reader': 'bad key!' } })).status, 400);
    const asha = `name:asha-${uniq()}`;
    const a = await create(B.url, { slug: `pin-${uniq()}` });
    const b = await create(B.url);
    const p1 = await pin(asha, a.slug);
    assert.equal(p1.status, 200, brief(p1));
    assert.equal(p1.json.docId, a.id);
    assert.ok(!Number.isNaN(Date.parse(p1.json.pinnedAt)));
    const again = await pin(asha, a.id);
    assert.deepEqual(again.json, p1.json, 'idempotent: same pinnedAt');
    await pin(asha, b.id);
    assert.deepEqual((await pins(asha)).map((p) => p.docId), [b.id, a.id]);
    assert.deepEqual(await pins(`name:ben-${uniq()}`), []);
    assert.equal((await pin(asha, 'ffffffffffff')).status, 404);
    assert.equal((await unpin(asha, a.id)).status, 204);
    assert.equal((await unpin(asha, a.id)).status, 204);
    assert.deepEqual((await pins(asha)).map((p) => p.docId), [b.id]);
  });

  test('a name key is case-insensitive (name:Asha ≡ name:asha)', async () => {
    const stem = `asha${uniq()}`;
    const d = await create(B.url);
    await pin(`name:${stem.toUpperCase()}`, d.id);
    assert.deepEqual((await pins(`name:${stem}`)).map((p) => p.docId), [d.id]);
  });

  test('a name key is length-checked before lower-casing (80 chars that grow when lower-cased are accepted)', async () => {
    const name = 'İ'.repeat(80); // each lower-cases to 2 code points (i + combining dot)
    const d = await create(B.url);
    assert.equal((await pin(`name:${name}`, d.id)).status, 200);
    assert.deepEqual((await pins(`name:${name}`)).map((p) => p.docId), [d.id]);
    assert.equal((await pin(`name:${'a'.repeat(81)}`, d.id)).status, 400, '81 chars is still too long');
  });

  test('pin then delete the doc: no dead row; expired docs are not listed', async () => {
    const key = rid();
    const a = await create(B.url); const b = await create(B.url); const c = await create(B.url);
    for (const d of [a, b, c]) await pin(key, d.id);
    assert.equal((await http(B.url, 'DELETE', `/paste/${a.id}`, { headers: tok(a.editToken) })).status, 204);
    await expire(b.id);
    assert.deepEqual((await pins(key)).map((p) => p.docId), [c.id]);
  });

  test('pin limit 50: the 51st → 409 pin_limit and nothing changes', async () => {
    const key = rid();
    const made = [];
    for (let i = 0; i < 51; i++) made.push(await create(B.url, { markdown: `# p${i}\n` }));
    for (let i = 0; i < 50; i++) assert.equal((await pin(key, made[i].id)).status, 200);
    const r = await pin(key, made[50].id);
    assert.equal(r.status, 409, brief(r));
    assert.deepEqual(r.json, { error: 'Pin limit reached (50)', code: 'pin_limit' });
    const list = await pins(key);
    assert.equal(list.length, 50);
    assert.ok(!list.some((p) => p.docId === made[50].id));
    assert.equal((await pin(key, made[3].id)).status, 200, 're-pinning an already pinned doc at the limit is fine');
  });

  test('AC-26.7 merge copies the anonymous pins to the name key (keeps the source, skips duplicates)', async () => {
    const anon = rid();
    const name = `name:asha-${uniq()}`;
    const a = await create(B.url); const b = await create(B.url);
    await pin(anon, a.id); await pin(anon, b.id);
    const m = await http(B.url, 'POST', '/library/pins/merge', { body: { from: anon }, headers: readerHdr(name) });
    assert.equal(m.status, 200, brief(m));
    assert.deepEqual(m.json, { merged: 2 });
    const r = await http(B.url, 'GET', '/library/pins', { headers: { 'X-MdReview-Reader': encodeURIComponent(name) } });
    assert.deepEqual(r.json.map((p) => p.docId).sort(), [a.id, b.id].sort());
    assert.equal((await pins(anon)).length, 2, 'source rows kept');
    const again = await http(B.url, 'POST', '/library/pins/merge', { body: { from: anon }, headers: readerHdr(name) });
    assert.deepEqual(again.json, { merged: 0 });
    for (const from of ['x', 'name:asha', 'has space here', 42, undefined]) {
      const bad = await http(B.url, 'POST', '/library/pins/merge', { body: { from }, headers: readerHdr(name) });
      assert.equal(bad.status, 400, `${from}: ${brief(bad)}`);
    }
    assert.equal((await http(B.url, 'POST', '/library/pins/merge', { body: { from: anon } })).status, 400, 'header required');
  });

  test('merge never exceeds 50: the most recently pinned source pins win', async () => {
    const target = rid(); const src = rid();
    const made = [];
    for (let i = 0; i < 52; i++) made.push(await create(B.url, { markdown: `# m${i}\n` }));
    for (let i = 0; i < 49; i++) await pin(target, made[i].id);
    await pin(src, made[49].id); await pin(src, made[50].id); await pin(src, made[51].id);
    const m = await http(B.url, 'POST', '/library/pins/merge', { body: { from: src }, headers: readerHdr(target) });
    assert.deepEqual(m.json, { merged: 1 });
    const list = (await pins(target)).map((p) => p.docId);
    assert.equal(list.length, 50);
    assert.ok(list.includes(made[51].id), 'the most recent source pin won');
  });
});

// ── bulk (AC-26.11 API side) ────────────────────────────────────────────────

describe('#26 POST /library/bulk', () => {
  test('delete: per-doc results in request order; token-protected docs without a token are skipped', async () => {
    const a = await create(B.url); const b = await create(B.url); const c = await create(B.url);
    const legacy = await create(B.url); await makeLegacy(B.dataDir, legacy.id);
    const r = await bulk({ action: 'delete', ids: [a.id, c.id, b.id, legacy.id, 'ffffffffffff'], editTokens: { [a.id]: a.editToken, [b.id]: b.editToken, [c.id]: 'mre_wrong' } });
    assert.equal(r.status, 200, brief(r));
    assert.deepEqual(r.json.results, [
      { id: a.id, ok: true },
      { id: c.id, ok: false, error: 'edit_token_invalid' },
      { id: b.id, ok: true },
      { id: legacy.id, ok: true },
      { id: 'ffffffffffff', ok: false, error: 'not_found' },
    ]);
    assert.equal((await http(B.url, 'GET', `/paste/${a.id}`)).status, 404);
    assert.equal((await http(B.url, 'GET', `/paste/${b.id}`)).status, 404);
    assert.equal((await http(B.url, 'GET', `/paste/${legacy.id}`)).status, 404);
    assert.equal((await http(B.url, 'GET', `/paste/${c.id}`)).status, 200);
    const d = await create(B.url);
    const skip = await bulk({ action: 'delete', ids: [d.id] });
    assert.deepEqual(skip.json.results, [{ id: d.id, ok: false, error: 'edit_token_required' }]);
  });

  test('add-tag and move; tag_limit; invalid action/tag/collection/ids → 400 with nothing done', async () => {
    const tag = `bulk-${uniq()}`;
    const a = await create(B.url); const b = await create(B.url);
    const full = await create(B.url);
    await putTags(full, Array.from({ length: 20 }, (_, i) => `f${i}`));
    const toks = { [a.id]: a.editToken, [b.id]: b.editToken, [full.id]: full.editToken };
    const t = await bulk({ action: 'add-tag', ids: [a.id, b.id, full.id], tag: ` ${tag.toUpperCase()} `, editTokens: toks });
    assert.equal(t.status, 200, brief(t));
    assert.deepEqual(t.json.results, [{ id: a.id, ok: true }, { id: b.id, ok: true }, { id: full.id, ok: false, error: 'tag_limit' }]);
    assert.deepEqual(ids(await docs({ tag })).sort(), [a.id, b.id].sort());

    const c = await collection();
    const mv = await bulk({ action: 'move', ids: [a.id, b.id], collectionId: c.id, editTokens: toks });
    assert.deepEqual(mv.json.results.map((x) => x.ok), [true, true]);
    assert.deepEqual(ids(await docs({ collection: c.id })).sort(), [a.id, b.id].sort());
    const un = await bulk({ action: 'move', ids: [a.id], collectionId: null, editTokens: toks });
    assert.deepEqual(un.json.results, [{ id: a.id, ok: true }]);
    assert.deepEqual(ids(await docs({ collection: c.id })), [b.id]);

    const before = (await http(B.url, 'GET', `/paste/${a.id}?fields=library`)).json;
    for (const body of [
      { action: 'archive', ids: [a.id] },
      { action: 'add-tag', ids: [a.id], tag: 'café', editTokens: toks },
      { action: 'add-tag', ids: [a.id], editTokens: toks },
      { action: 'move', ids: [a.id], collectionId: 'no-such-collection', editTokens: toks },
      { action: 'move', ids: [a.id], editTokens: toks },
      { action: 'delete', ids: [] },
      { action: 'delete', ids: 'abc' },
      { action: 'delete', ids: Array.from({ length: 501 }, () => a.id), editTokens: toks },
      { action: 'delete', ids: [a.id], editTokens: 'nope' },
    ]) {
      const r = await bulk(body);
      assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)}: ${brief(r)}`);
    }
    assert.deepEqual((await http(B.url, 'GET', `/paste/${a.id}?fields=library`)).json, before, 'nothing done');
    assert.equal((await http(B.url, 'GET', `/paste/${a.id}`)).status, 200);
  });
});

// ── delete cascade + expired docs ───────────────────────────────────────────

describe('#26 delete cascade and expiry', () => {
  test('deleting a doc removes its pins, tags, membership and every doc_fts row', async () => {
    const d = await create(B.url);
    const c = await collection();
    await putCol(d, c.id);
    await putTags(d, ['cascade']);
    await pin(rid(), d.id);
    await addFile(d, 'appendix.md', 'cascade text');
    await addFile(d, 'sub/more.html', '<p>more</p>');
    assert.equal((await sqlAll('SELECT count(*) AS c FROM doc_fts WHERE session_id = ?', d.id))[0].c, 3, 'session row + 2 file rows');
    assert.equal((await http(B.url, 'DELETE', `/paste/${d.id}`, { headers: tok(d.editToken) })).status, 204);
    for (const [t, col] of [['pins', 'session_id'], ['session_tags', 'session_id'], ['collection_items', 'session_id'], ['doc_fts', 'session_id']]) {
      assert.equal((await sqlAll(`SELECT count(*) AS c FROM ${t} WHERE ${col} = ?`, d.id))[0].c, 0, `${t} rows removed`);
    }
    assert.equal((await http(B.url, 'GET', '/library/collections')).json.find((x) => x.id === c.id).doc_count, 0);
  });

  test('deleting a doc (single and bulk) drops tags no other doc uses; shared tags stay', async () => {
    const solo1 = `solo-${uniq()}`; const solo2 = `solo-${uniq()}`; const shared = `shared-${uniq()}`;
    const a = await create(B.url); const b = await create(B.url); const c = await create(B.url);
    await putTags(a, [solo1, shared]); await putTags(b, [solo2, shared]); await putTags(c, [shared]);
    const tagRows = async (name) => (await sqlAll('SELECT count(*) AS c FROM tags WHERE name = ?', name))[0].c;
    assert.equal((await http(B.url, 'DELETE', `/paste/${a.id}`, { headers: tok(a.editToken) })).status, 204);
    assert.equal(await tagRows(solo1), 0, 'single delete drops its orphan tag');
    assert.equal(await tagRows(shared), 1);
    const r = await bulk({ action: 'delete', ids: [b.id], editTokens: { [b.id]: b.editToken } });
    assert.equal(r.status, 200, brief(r));
    assert.equal(await tagRows(solo2), 0, 'bulk delete drops its orphan tag');
    assert.equal(await tagRows(shared), 1, 'a tag still used by c stays');
  });

  test('expired docs are excluded from lists, search, tag counts and collection counts', async () => {
    const tag = `exp-${uniq()}`;
    const term = `expiring${letters()}`;
    const c = await collection();
    const d = await create(B.url, { markdown: `# ${term}\n` });
    await putTags(d, [tag]); await putCol(d, c.id);
    await expire(d.id);
    assert.equal((await docs({ tag })).total, 0);
    assert.equal((await docs({ q: term })).total, 0);
    assert.equal((await docs({ collection: c.id })).total, 0);
    assert.equal((await http(B.url, 'GET', '/library/tags')).json.find((t) => t.tag === tag), undefined);
    assert.equal((await http(B.url, 'GET', '/library/collections')).json.find((x) => x.id === c.id).doc_count, 0);
  });
});

describe('#26 boot backfill', () => {
  test('document files migrated from the JSON-file server are indexed at boot (once)', async () => {
    const L = await legacyBackend(); // fixture session a1a1a1a1a1a1 has notes/readme.md ("Attached notes for the weekly status."; the session text never says "attached")
    try {
      const r = await http(L.url, 'GET', '/library/docs?q=attached%20notes');
      assert.equal(r.status, 200, brief(r));
      const it = r.json.items.find((i) => i.id === 'a1a1a1a1a1a1');
      assert.ok(it, JSON.stringify(r.json.items.map((i) => i.id)));
      assert.equal(it.match.field, 'file');
      assert.equal(it.match.file, 'notes/readme.md');
    } finally { await L.stop(); }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(L.dataDir, DB_NAME), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS c FROM doc_fts WHERE session_id = 'a1a1a1a1a1a1' AND file_name <> ''").get().c, 1, 'readme.md only (diagram.png is an attachment)');
    } finally { db.close(); }
  });
});

describe('#26 CORS', () => {
  test('preflight allows PATCH and X-MdReview-Reader', async () => {
    const r = await http(B.url, 'OPTIONS', '/library/collections/x');
    assert.match(r.headers.get('access-control-allow-methods'), /PATCH/);
    assert.match(r.headers.get('access-control-allow-headers'), /X-MdReview-Reader/);
  });
});
