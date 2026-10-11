// Item #27 — templates, server + MCP half: AC-27.1, 27.2, 27.4, 27.12, 27.13, 27.14 (+ API validation and
// the spec's server edge cases). Spec: docs/build/specs/27-templates.md (+ 00 §1.4, §4.9, §6, §10.5).
//
// Collections come from item #26 (`POST /library/collections {name}`, `DELETE /library/collections/:id`).
// Where that API is absent (this suite predates #26 landing) the helpers fall back to the
// `collections` table directly, so the suite passes both before and after #26.
//
// Clock: AC-27.2 boots its own backend with the MDREVIEW_NOW test clock (00 §10.5, #25).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  sharedBackend, startServer, http, uniq, tok, brief, DB_NAME, tmpDir, cleanupTmp, startMcpHttp, mcpConnect, mcpStdio,
  TOKEN_RE,
} from './23-helpers.mjs';

const SEED_IDS = ['seed-design-doc', 'seed-pr-review', 'seed-qa-findings', 'seed-research-brief', 'seed-weekly-update'];

let B;
before(async () => { B = await sharedBackend(); });
after(async () => { await B?.stop(); cleanupTmp(); });

async function sql(dataDir, stmt, ...args) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, DB_NAME));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const s = db.prepare(stmt);
    return /^\s*select/i.test(stmt) ? s.all(...args) : s.run(...args);
  } finally { db.close(); }
}

/** Create a collection via the #26 API, else (route absent) straight into the table. Returns {id, name}. */
async function makeCollection(base, dataDir, name) {
  const r = await http(base, 'POST', '/library/collections', { body: { name } });
  if (r.status === 201) return { id: r.json.id, name: r.json.name };
  if (r.status !== 404) throw new Error(`POST /library/collections: ${brief(r)}`);
  const id = `col-${uniq()}${uniq()}`;
  await sql(dataDir, 'INSERT INTO collections (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, new Date().toISOString(), new Date().toISOString());
  return { id, name };
}
async function deleteCollection(base, dataDir, id) {
  const r = await http(base, 'DELETE', `/library/collections/${id}`);
  if (r.status === 204) return;
  await sql(dataDir, 'DELETE FROM collections WHERE id = ?', id);
}

const postTemplate = (body, base = B.url) => http(base, 'POST', '/templates', { body });
const listTemplates = async (base = B.url) => {
  const r = await http(base, 'GET', '/templates');
  assert.equal(r.status, 200, brief(r));
  return r.json;
};
async function userTemplate(body = {}, base = B.url) {
  const r = await postTemplate({ name: `Tpl ${uniq()}`, content: '# {{title}}\n\nBy {{author}} on {{date}}.\n', contentType: 'markdown', ...body }, base);
  assert.equal(r.status, 201, brief(r));
  return r.json;
}
const instantiate = (id, body, base = B.url) => http(base, 'POST', `/templates/${id}/instantiate`, { body });
const markdownOf = async (x, base = B.url) => {
  const r = await http(base, 'GET', `/paste/${x}/markdown`);
  assert.equal(r.status, 200, brief(r));
  return r.json.markdown;
};
const metaOf = async (x, base = B.url) => {
  const r = await http(base, 'GET', `/paste/${x}?fields=meta`);
  assert.equal(r.status, 200, brief(r));
  return r.json;
};
/** The doc's library row (00 §8): carries created_by and collection. */
async function libraryRow(id, base = B.url) {
  const meta = await metaOf(id, base);
  const r = await http(base, 'GET', `/library/docs?q=${encodeURIComponent(meta.sessionName)}&limit=100`);
  assert.equal(r.status, 200, brief(r));
  const row = r.json.items.find((i) => i.id === id);
  assert.ok(row, `doc ${id} not in /library/docs`);
  return row;
}

// ── AC-27.1 / boot upsert (fresh data dir) ─────────────────────────────────

describe('#27 seed templates on a fresh data dir', () => {
  let S; let dir;
  before(async () => { dir = tmpDir('md-review-27-fresh'); S = await startServer({ dataDir: dir, env: { ALLOW_EMPTY_DB: '1' } }); });
  after(async () => { await S?.stop(); });

  test('AC-27.1 exactly the 5 seed ids, builtin, weekly update variables = author,date,title,week', async () => {
    const list = await listTemplates(S.url);
    assert.deepEqual(list.map((t) => t.id).sort(), SEED_IDS);
    for (const t of list) {
      assert.equal(t.builtin, true, t.id);
      assert.equal(t.content, undefined, 'the list carries no content');
      assert.equal(t.contentType, 'markdown');
      assert.ok(['publish', 'review'].includes(t.mode));
      assert.equal(typeof t.description, 'string');
      assert.equal(t.collectionId, null);
    }
    const w = list.find((t) => t.id === 'seed-weekly-update');
    assert.deepEqual(w.variables, ['author', 'date', 'title', 'week']);
    assert.equal(w.name, 'Weekly leadership update');
    assert.equal(w.description, 'One-screen status for leadership, readable on a phone.');
    assert.equal(w.mode, 'publish');
    assert.equal(list.find((t) => t.id === 'seed-qa-findings').mode, 'review');
    assert.equal(list.find((t) => t.id === 'seed-pr-review').mode, 'review');
    assert.equal(list.find((t) => t.id === 'seed-design-doc').mode, 'publish');
    assert.equal(list.find((t) => t.id === 'seed-research-brief').mode, 'publish');
  });

  test('GET /templates/:id returns the exact seed content', async () => {
    const r = await http(S.url, 'GET', '/templates/seed-weekly-update');
    assert.equal(r.status, 200, brief(r));
    assert.ok(r.json.content.startsWith('# {{title}}\n\n**Week {{week}}** · {{author}} · {{date}}\n'), r.json.content);
    assert.match(r.json.content, /\| Workstream A \| :rag-green\[On track\] \| \|/);
    const d = await http(S.url, 'GET', '/templates/seed-design-doc');
    assert.match(d.json.content, /^# \{\{title\}\}\n\n\{\{author\}\} · \{\{date\}\} · Status: :rag-amber\[Draft\]\n/);
    const missing = await http(S.url, 'GET', '/templates/nope-123');
    assert.equal(missing.status, 404);
  });

  test('boot upsert restores builtin rows and never touches user templates', async () => {
    const u = await userTemplate({ name: 'Mine stays' }, S.url);
    await sql(dir, "UPDATE templates SET name = 'Tampered', data_json = '{}' WHERE id = 'seed-pr-review'");
    await sql(dir, "UPDATE templates SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", u.id);
    await S.stop();
    S = await startServer({ dataDir: dir });
    const list = await listTemplates(S.url);
    assert.deepEqual(list.filter((t) => t.builtin).map((t) => t.id).sort(), SEED_IDS);
    assert.equal(list.find((t) => t.id === 'seed-pr-review').name, 'PR review');
    const mine = list.find((t) => t.id === u.id);
    assert.equal(mine.name, 'Mine stays');
    assert.equal(mine.updated_at, '2000-01-01T00:00:00.000Z', 'user row untouched');
  });

  test('order: builtins first, then user templates by name (case-insensitive)', async () => {
    await userTemplate({ name: 'zeta' }, S.url);
    await userTemplate({ name: 'Alpha' }, S.url);
    const list = await listTemplates(S.url);
    const firstUser = list.findIndex((t) => !t.builtin);
    assert.ok(list.slice(0, firstUser).every((t) => t.builtin));
    const names = list.slice(firstUser).map((t) => t.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });
});

// ── AC-27.2 (test clock) ───────────────────────────────────────────────────

describe('#27 instantiate with the MDREVIEW_NOW clock', () => {
  let S;
  before(async () => { S = await startServer({ dataDir: tmpDir('md-review-27-clock'), env: { MDREVIEW_NOW: '2026-10-10T20:00:00.000Z', ALLOW_EMPTY_DB: '1' } }); });
  after(async () => { await S?.stop(); });

  test('AC-27.2 weekly update in Asia/Kolkata at 2026-10-10T20:00Z → Week 2026-W41 · Asha · 2026-10-11', async () => {
    const r = await instantiate('seed-weekly-update', { title: 'Ops W41', author: 'Asha', timezone: 'Asia/Kolkata' }, S.url);
    assert.equal(r.status, 201, brief(r));
    assert.ok(r.json.id && r.json.slug, JSON.stringify(r.json));
    const md = await markdownOf(r.json.slug, S.url);
    assert.ok(md.startsWith('# Ops W41'), md);
    assert.ok(md.includes('**Week 2026-W41** · Asha · 2026-10-11'), md);
  });

  test('invalid timezone → UTC date', async () => {
    const r = await http(S.url, 'POST', '/templates/seed-weekly-update/render', { body: { title: 'x', timezone: 'Not/AZone' } });
    assert.equal(r.status, 200, brief(r));
    assert.ok(r.json.content.includes('**Week 2026-W41** · {{author}} · 2026-10-10'), r.json.content);
  });
});

// ── REST API ───────────────────────────────────────────────────────────────

describe('#27 POST /templates validation and name rules', () => {
  test('creates a user template (201) with variables, builtin:false, created_by from author', async () => {
    const name = `Incident review ${uniq()}`;
    const r = await postTemplate({ name, description: 'd', content: '# {{title}}\n{{owner}}', contentType: 'markdown', mode: 'review', author: 'Asha' });
    assert.equal(r.status, 201, brief(r));
    assert.equal(r.json.name, name);
    assert.equal(r.json.builtin, false);
    assert.equal(r.json.mode, 'review');
    assert.equal(r.json.created_by, 'Asha');
    assert.deepEqual(r.json.variables, ['owner', 'title']);
    const g = await http(B.url, 'GET', `/templates/${r.json.id}`);
    assert.equal(g.json.content, '# {{title}}\n{{owner}}');
    assert.equal(g.json.description, 'd');
  });

  test('name is trimmed; mode defaults to publish; contentType html kept', async () => {
    const name = `Trim ${uniq()}`;
    const r = await postTemplate({ name: `   ${name}  `, content: '<h1>{{title}}</h1>', contentType: 'html' });
    assert.equal(r.status, 201, brief(r));
    assert.equal(r.json.name, name);
    assert.equal(r.json.mode, 'publish');
    assert.equal(r.json.contentType, 'html');
  });

  test('400s: name empty / > 80, description > 280, content missing, bad contentType, bad mode, invalid JSON', async () => {
    const ok = { name: `V ${uniq()}`, content: 'x', contentType: 'markdown' };
    const bad = [
      { ...ok, name: '' }, { ...ok, name: '   ' }, { ...ok, name: 'n'.repeat(81) }, { ...ok, name: 3 },
      { ...ok, description: 'd'.repeat(281) }, { ...ok, content: undefined }, { ...ok, content: 5 },
      { ...ok, contentType: 'pdf' }, { ...ok, mode: 'Review' },
    ];
    for (const b of bad) {
      const r = await postTemplate(b);
      assert.equal(r.status, 400, `${JSON.stringify(b).slice(0, 120)} → ${brief(r)}`);
      assert.equal(typeof r.json.error, 'string');
    }
    const inv = await http(B.url, 'POST', '/templates', { body: '{nope' });
    assert.equal(inv.status, 400);
    assert.equal((await postTemplate({ ...ok, name: 'n'.repeat(80) })).status, 201, '80 chars is allowed');
  });

  test('content over 1 MB → 400 with a clear error; exactly 1 MB is accepted', async () => {
    const big = await postTemplate({ name: `Big ${uniq()}`, content: 'x'.repeat(1024 * 1024 + 1), contentType: 'markdown' });
    assert.equal(big.status, 400, brief(big));
    assert.match(big.json.error, /1 MB/);
    const edge = await postTemplate({ name: `Edge ${uniq()}`, content: 'x'.repeat(1024 * 1024), contentType: 'markdown' });
    assert.equal(edge.status, 201, brief(edge));
  });

  test('name clash differing only by case / surrounding whitespace → 409; replace:true → 200 replaces content+fields', async () => {
    const name = `Clash ${uniq()}`;
    const a = await userTemplate({ name, content: 'v1', description: 'one' });
    for (const n of [name.toUpperCase(), `  ${name.toLowerCase()} `]) {
      const r = await postTemplate({ name: n, content: 'v2', contentType: 'markdown' });
      assert.equal(r.status, 409, brief(r));
      assert.equal(r.json.builtin, false);
      assert.equal(r.json.id, a.id);
    }
    const rep = await postTemplate({ name: name.toUpperCase(), content: 'v2 {{x}}', contentType: 'html', mode: 'review', description: 'two', replace: true });
    assert.equal(rep.status, 200, brief(rep));
    assert.equal(rep.json.id, a.id, 'same template replaced');
    const g = (await http(B.url, 'GET', `/templates/${a.id}`)).json;
    assert.equal(g.content, 'v2 {{x}}');
    assert.equal(g.contentType, 'html');
    assert.equal(g.mode, 'review');
    assert.equal(g.description, 'two');
    assert.equal((await listTemplates()).filter((t) => t.name.toLowerCase() === name.toLowerCase()).length, 1);
  });

  test("a builtin's name → 409 even with replace:true (builtin:true in the body); builtin unchanged", async () => {
    for (const replace of [false, true]) {
      const r = await postTemplate({ name: 'design doc', content: 'hijack', contentType: 'markdown', replace });
      assert.equal(r.status, 409, brief(r));
      assert.equal(r.json.builtin, true);
    }
    const d = (await http(B.url, 'GET', '/templates/seed-design-doc')).json;
    assert.notEqual(d.content, 'hijack');
    assert.equal(d.name, 'Design doc');
  });
});

describe('#27 PATCH / DELETE /templates/:id', () => {
  test('AC-27.12 PATCH or DELETE a builtin → 403, unchanged', async () => {
    const before = (await http(B.url, 'GET', '/templates/seed-design-doc')).json;
    const p = await http(B.url, 'PATCH', '/templates/seed-design-doc', { body: { name: 'Renamed' } });
    assert.equal(p.status, 403, brief(p));
    const d = await http(B.url, 'DELETE', '/templates/seed-design-doc');
    assert.equal(d.status, 403, brief(d));
    const after = (await http(B.url, 'GET', '/templates/seed-design-doc')).json;
    assert.deepEqual(after, before);
  });

  test('PATCH renames (same rules), edits description and collectionId; 409 on clash; unknown → 404', async () => {
    const a = await userTemplate();
    const b = await userTemplate();
    const newName = `Renamed ${uniq()}`;
    const r = await http(B.url, 'PATCH', `/templates/${a.id}`, { body: { name: `  ${newName} `, description: 'new d' } });
    assert.equal(r.status, 200, brief(r));
    assert.equal(r.json.name, newName);
    assert.equal(r.json.description, 'new d');
    const self = await http(B.url, 'PATCH', `/templates/${a.id}`, { body: { name: newName.toUpperCase() } });
    assert.equal(self.status, 200, 'renaming to its own name in another case is allowed');
    const clash = await http(B.url, 'PATCH', `/templates/${b.id}`, { body: { name: newName.toLowerCase() } });
    assert.equal(clash.status, 409, brief(clash));
    const builtinClash = await http(B.url, 'PATCH', `/templates/${b.id}`, { body: { name: 'QA FINDINGS' } });
    assert.equal(builtinClash.status, 409, brief(builtinClash));
    for (const body of [{ name: '' }, { name: 'x'.repeat(81) }, { description: 'x'.repeat(281) }]) {
      assert.equal((await http(B.url, 'PATCH', `/templates/${b.id}`, { body })).status, 400, JSON.stringify(body));
    }
    const col = await makeCollection(B.url, B.dataDir, `PatchCol ${uniq()}`);
    const c = await http(B.url, 'PATCH', `/templates/${b.id}`, { body: { collectionId: col.id } });
    assert.equal(c.status, 200, brief(c));
    assert.equal(c.json.collectionId, col.id);
    assert.deepEqual(c.json.collection, { id: col.id, name: col.name });
    const unknownCol = await http(B.url, 'PATCH', `/templates/${b.id}`, { body: { collectionId: 'col-nope' } });
    assert.equal(unknownCol.status, 400, brief(unknownCol));
    const unset = await http(B.url, 'PATCH', `/templates/${b.id}`, { body: { collectionId: null } });
    assert.equal(unset.json.collectionId, null);
    assert.equal((await http(B.url, 'PATCH', '/templates/tpl-unknown', { body: { name: 'x' } })).status, 404);
  });

  test('DELETE a user template → 204, gone; docs created from it still open; unknown → 404', async () => {
    const t = await userTemplate();
    const doc = await instantiate(t.id, { title: `From deleted ${uniq()}` });
    assert.equal(doc.status, 201, brief(doc));
    const d = await http(B.url, 'DELETE', `/templates/${t.id}`);
    assert.equal(d.status, 204, brief(d));
    assert.equal((await http(B.url, 'GET', `/templates/${t.id}`)).status, 404);
    assert.ok(!(await listTemplates()).some((x) => x.id === t.id));
    assert.equal((await http(B.url, 'GET', `/paste/${doc.json.id}`)).status, 200);
    assert.equal((await http(B.url, 'DELETE', `/templates/${t.id}`)).status, 404);
  });
});

describe('#27 render (dry run) and instantiate', () => {
  test('render returns substituted content and creates nothing', async () => {
    const t = await userTemplate({ content: '# {{title}}\n{{author}}|{{collection}}|{{x}}' });
    const [count0] = await sql(B.dataDir, 'SELECT count(*) AS c FROM sessions');
    const r = await http(B.url, 'POST', `/templates/${t.id}/render`, { body: { title: 'Preview', author: 'Ann', variables: { x: 'X' } } });
    assert.equal(r.status, 200, brief(r));
    assert.equal(r.json.content, '# Preview\nAnn|{{collection}}|X');
    const [count1] = await sql(B.dataDir, 'SELECT count(*) AS c FROM sessions');
    assert.equal(count1.c, count0.c, 'no session created');
    const empty = await http(B.url, 'POST', `/templates/${t.id}/render`, { body: {} });
    assert.equal(empty.status, 200, 'title is optional for a preview');
    assert.ok(empty.json.content.startsWith('# {{title}}'));
    assert.equal((await http(B.url, 'POST', '/templates/tpl-nope/render', { body: { title: 'x' } })).status, 404);
  });

  test('render validation: variables limits → 400', async () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    for (const variables of [many, { a: 'x'.repeat(501) }, { a: 1 }, ['x']]) {
      const r = await http(B.url, 'POST', '/templates/seed-design-doc/render', { body: { title: 'x', variables } });
      assert.equal(r.status, 400, brief(r));
    }
  });

  test('created doc meta: sessionName, filename, contentType, mode, created_by, from_template, 30-day expiry, collection', async () => {
    const col = await makeCollection(B.url, B.dataDir, `Ops ${uniq()}`);
    const title = `Cache rewrite ${uniq()}`;
    const r = await instantiate('seed-qa-findings', { title, author: 'Asha', collectionId: col.id });
    assert.equal(r.status, 201, brief(r));
    assert.match(r.json.editToken, TOKEN_RE);
    assert.equal(r.json.slug, title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    assert.ok(r.json.url.endsWith(`/d/${r.json.slug}`), r.json.url);
    assert.ok(r.json.editUrl.endsWith(`/d/${r.json.slug}?edit=${r.json.editToken}`), r.json.editUrl);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const m = await metaOf(r.json.id);
    assert.equal(m.sessionName, title);
    assert.equal(m.filename, `${r.json.slug}.md`);
    assert.equal(m.contentType, 'markdown');
    assert.equal(m.mode, 'review', 'QA findings seed is review mode (00 §1.4)');
    assert.deepEqual(m.from_template, { id: 'seed-qa-findings', name: 'QA findings' });
    const days = (Date.parse(m.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 29.9 && days <= 30, `expiry ${m.expires_at}`);
    assert.equal(m.access.protected, true);
    const row = await libraryRow(r.json.id);
    assert.equal(row.created_by, 'Asha');
    assert.deepEqual(row.collection, { id: col.id, name: col.name });
    const [dbRow] = await sql(B.dataDir, 'SELECT created_by, from_template_json FROM sessions WHERE id = ?', r.json.id);
    assert.equal(dbRow.created_by, 'Asha');
    assert.deepEqual(JSON.parse(dbRow.from_template_json), { id: 'seed-qa-findings', name: 'QA findings' });
    const md = await markdownOf(r.json.id);
    assert.ok(md.startsWith(`# ${title}\n\nTested by Asha on `), md);
    // first revision is by the author
    const rev = await http(B.url, 'GET', `/paste/${r.json.id}/revisions`);
    assert.equal(rev.json.revisions?.[0]?.by ?? rev.json[0]?.by, 'Asha', rev.text.slice(0, 300));
  });

  test('the returned edit token is valid; without it the doc is protected', async () => {
    const r = await instantiate('seed-design-doc', { title: `Tok ${uniq()}` });
    assert.equal(r.status, 201, brief(r));
    const no = await http(B.url, 'PUT', `/paste/${r.json.id}/markdown`, { body: { markdown: 'x' } });
    assert.equal(no.status, 401, brief(no));
    const yes = await http(B.url, 'PUT', `/paste/${r.json.id}/markdown`, { body: { markdown: 'edited' }, headers: tok(r.json.editToken) });
    assert.equal(yes.status, 200, brief(yes));
    const m = await metaOf(r.json.id, B.url);
    assert.equal(m.mode, 'publish');
    assert.equal(m.access.can_edit, false, 'no token presented');
  });

  test('defaults: the template collection; expiryDays and slug honoured; html filename; unfilled author verbatim', async () => {
    const col = await makeCollection(B.url, B.dataDir, `Default ${uniq()}`);
    const t = await userTemplate({ content: '<title>{{title}}</title><h1>{{title}}</h1><p>{{author}}</p>', contentType: 'html', collectionId: col.id, mode: 'review' });
    assert.deepEqual(t.collection, { id: col.id, name: col.name });
    const slug = `custom-${uniq()}`;
    const r = await instantiate(t.id, { title: 'Html doc', slug, expiryDays: 7 });
    assert.equal(r.status, 201, brief(r));
    assert.equal(r.json.slug, slug);
    const m = await metaOf(r.json.id);
    assert.equal(m.filename, 'html-doc.html');
    assert.equal(m.contentType, 'html');
    assert.equal(m.mode, 'review');
    const days = (Date.parse(m.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 6.9 && days <= 7, m.expires_at);
    assert.deepEqual((await libraryRow(r.json.id)).collection, { id: col.id, name: col.name });
    assert.equal(await markdownOf(r.json.id), '<title>Html doc</title><h1>Html doc</h1><p>{{author}}</p>');
    // collectionId:null overrides the default → unfiled; expiryDays null → never
    const n = await instantiate(t.id, { title: `Unfiled ${uniq()}`, collectionId: null, expiryDays: null });
    assert.equal(n.status, 201, brief(n));
    assert.equal((await libraryRow(n.json.id)).collection, null);
    assert.equal((await metaOf(n.json.id)).expires_at ?? null, null);
  });

  test('AC-27.4 html template + title "<script>x</script>" → escaped, no <script> element', async () => {
    const t = await userTemplate({ content: '<h1>{{title}}</h1>', contentType: 'html' });
    const r = await instantiate(t.id, { title: '<script>x</script>' });
    assert.equal(r.status, 201, brief(r));
    const html = await markdownOf(r.json.id);
    assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'), html);
    assert.ok(!/<script/i.test(html), html);
  });

  test('title with $&, $1 and backslashes is inserted literally', async () => {
    const title = 'Cost $& $1 \\ $$ (x)';
    const r = await instantiate('seed-research-brief', { title });
    assert.equal(r.status, 201, brief(r));
    assert.ok((await markdownOf(r.json.id)).startsWith(`# ${title}\n`));
  });

  test('instantiate validation: title required 1–200, variables limits, unknown template 404, nothing created', async () => {
    const [c0] = await sql(B.dataDir, 'SELECT count(*) AS c FROM sessions');
    for (const body of [{}, { title: '' }, { title: '   ' }, { title: 't'.repeat(201) }, { title: 5 },
      { title: 'x', variables: { a: 'x'.repeat(501) } }, { title: 'x', variables: 'nope' }]) {
      const r = await instantiate('seed-design-doc', body);
      assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)} → ${brief(r)}`);
      assert.equal(typeof r.json.error, 'string');
    }
    assert.equal((await instantiate('tpl-nope', { title: 'x' })).status, 404);
    const [c1] = await sql(B.dataDir, 'SELECT count(*) AS c FROM sessions');
    assert.equal(c1.c, c0.c);
    assert.equal((await instantiate('seed-design-doc', { title: 't'.repeat(200) })).status, 201, '200 chars is allowed');
  });

  test('instantiate with a deleted collectionId → 400 naming it, nothing created', async () => {
    const col = await makeCollection(B.url, B.dataDir, `Gone ${uniq()}`);
    await deleteCollection(B.url, B.dataDir, col.id);
    const [c0] = await sql(B.dataDir, 'SELECT count(*) AS c FROM sessions');
    const r = await instantiate('seed-design-doc', { title: `X ${uniq()}`, collectionId: col.id });
    assert.equal(r.status, 400, brief(r));
    assert.match(r.json.error, /collection/i);
    const [c1] = await sql(B.dataDir, 'SELECT count(*) AS c FROM sessions');
    assert.equal(c1.c, c0.c);
  });

  test("deleting a template's collection → the template reads collectionId null; instantiate lands unfiled", async () => {
    const col = await makeCollection(B.url, B.dataDir, `Doomed ${uniq()}`);
    const t = await userTemplate({ collectionId: col.id });
    assert.equal(t.collectionId, col.id);
    await deleteCollection(B.url, B.dataDir, col.id);
    const listed = (await listTemplates()).find((x) => x.id === t.id);
    assert.equal(listed.collectionId, null);
    assert.equal(listed.collection, null);
    assert.equal((await http(B.url, 'GET', `/templates/${t.id}`)).json.collectionId, null);
    const r = await instantiate(t.id, { title: `Orphan ${uniq()}` });
    assert.equal(r.status, 201, brief(r));
    assert.equal((await libraryRow(r.json.id)).collection, null);
  });

  test('the collection variable is the target collection name', async () => {
    const col = await makeCollection(B.url, B.dataDir, `Named ${uniq()}`);
    const t = await userTemplate({ content: 'in {{collection}}' });
    const r = await http(B.url, 'POST', `/templates/${t.id}/render`, { body: { title: 'x', collectionId: col.id } });
    assert.equal(r.json.content, `in ${col.name}`);
  });

  test('CORS preflight allows PATCH on /templates', async () => {
    const r = await http(B.url, 'OPTIONS', '/templates/x');
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-methods'), /PATCH/);
  });
});

// ── MCP ─────────────────────────────────────────────────────────────────────

describe('#27 MCP list_templates / create_from_template', () => {
  test('AC-27.13 create_from_template by name (case-insensitive) into a collection by name; unknown template → error listing names, nothing created', async () => {
    const col = await makeCollection(B.url, B.dataDir, `Ops-${uniq()}`);
    const m = await startMcpHttp({ apiUrl: B.url, storePath: path.join(tmpDir('md-review-27-mcp'), 't.json') });
    try {
      const c = await mcpConnect(m.url);
      try {
        const tools = await c.tools();
        assert.ok(tools.includes('list_templates') && tools.includes('create_from_template'), tools.join(','));
        const out = await c.call('create_from_template', { template: 'weekly leadership update', title: `W41 ${uniq()}`, author: 'agent-x', collection: col.name.toUpperCase() });
        assert.ok(!out.error && !out.__toolError, JSON.stringify(out));
        assert.ok(out.id && out.slug, JSON.stringify(out));
        assert.ok(out.shareUrl.endsWith(`/d/${out.slug}`), out.shareUrl);
        assert.match(out.editUrl, /\?edit=mre_/);
        const meta = await metaOf(out.id);
        assert.equal(meta.from_template.id, 'seed-weekly-update');
        assert.equal(meta.mode, 'publish');
        const row = await libraryRow(out.id);
        assert.deepEqual(row.collection, { id: col.id, name: col.name });
        assert.equal(row.created_by, 'agent-x');
        assert.ok((await markdownOf(out.id)).includes('· agent-x ·'));
        // the token is remembered: a later write through MCP without editToken succeeds
        const upd = await c.call('update_markdown', { sessionId: out.id, markdown: '# edited by agent\n' });
        assert.ok(!upd.error, JSON.stringify(upd));
        // collection by id works too
        const byId = await c.call('create_from_template', { template: 'seed-design-doc', title: `By id ${uniq()}`, collection: col.id });
        assert.ok(byId.id, JSON.stringify(byId));
        assert.deepEqual((await libraryRow(byId.id)).collection, { id: col.id, name: col.name });

        const [c0] = await sql(B.dataDir, 'SELECT count(*) AS c FROM sessions');
        const bad = await c.call('create_from_template', { template: 'nope', title: 'W41' });
        assert.equal(typeof bad.error, 'string', JSON.stringify(bad));
        for (const n of ['Weekly leadership update', 'Design doc', 'QA findings', 'PR review', 'Research brief']) {
          assert.ok(bad.error.includes(n), `error lists "${n}": ${bad.error}`);
        }
        const badCol = await c.call('create_from_template', { template: 'design doc', title: 'x', collection: `nope-${uniq()}` });
        assert.equal(typeof badCol.error, 'string', JSON.stringify(badCol));
        assert.ok(badCol.error.includes(col.name), `error lists collections: ${badCol.error}`);
        const [c1] = await sql(B.dataDir, 'SELECT count(*) AS c FROM sessions');
        assert.equal(c1.c, c0.c, 'nothing created');
      } finally { await c.close(); }
    } finally { await m.stop(); }
  });

  test('AC-27.14 list_templates on stdio and HTTP return the same list (with variables and collection)', async () => {
    const col = await makeCollection(B.url, B.dataDir, `List ${uniq()}`);
    const t = await userTemplate({ collectionId: col.id });
    const store = path.join(tmpDir('md-review-27-list'), 't.json');
    const m = await startMcpHttp({ apiUrl: B.url, storePath: store });
    let httpList; let stdioList;
    try {
      const c = await mcpConnect(m.url);
      try { httpList = await c.call('list_templates', {}); } finally { await c.close(); }
    } finally { await m.stop(); }
    const s = await mcpStdio({ apiUrl: B.url, storePath: store });
    try { stdioList = await s.call('list_templates', {}); } finally { await s.close(); }
    assert.ok(Array.isArray(httpList), JSON.stringify(httpList).slice(0, 300));
    assert.deepEqual(stdioList, httpList);
    const w = httpList.find((x) => x.id === 'seed-weekly-update');
    assert.deepEqual(Object.keys(w).sort(), ['builtin', 'collection', 'contentType', 'description', 'id', 'mode', 'name', 'variables']);
    assert.deepEqual(w.variables, ['author', 'date', 'title', 'week']);
    assert.equal(w.collection, null);
    assert.deepEqual(httpList.find((x) => x.id === t.id).collection, { id: col.id, name: col.name });
  });

  test('create_from_template description tells agents to pass author and that unfilled placeholders stay verbatim', async () => {
    const m = await startMcpHttp({ apiUrl: B.url, storePath: path.join(tmpDir('md-review-27-desc'), 't.json') });
    try {
      const c = await mcpConnect(m.url);
      try {
        const tools = (await c.client.listTools()).tools;
        const d = tools.find((x) => x.name === 'create_from_template').description;
        assert.match(d, /author/);
        assert.match(d, /verbatim/);
      } finally { await c.close(); }
    } finally { await m.stop(); }
  });
});


// ── review fixes (27-review-server.md SHOULD-FIX + NIT) ────────────────────

describe('#27 review fixes', () => {
  test('from_template lives in its column: a meta PUT can neither drop nor spoof it; POST /paste cannot set it', async () => {
    const r = await instantiate('seed-design-doc', { title: `Prov ${uniq()}` });
    assert.equal(r.status, 201, brief(r));
    const [row] = await sql(B.dataDir, 'SELECT extra_json FROM sessions WHERE id = ?', r.json.id);
    assert.ok(!('from_template' in JSON.parse(row.extra_json || '{}')), `not duplicated in extra_json: ${row.extra_json}`);
    const m = await metaOf(r.json.id);
    assert.deepEqual(m.from_template, { id: 'seed-design-doc', name: 'Design doc' });
    // A full-meta save that omits it, then one that forges it: the column wins both times.
    const { from_template: _omit, ...rest } = m;
    const put1 = await http(B.url, 'PUT', `/paste/${r.json.id}/meta`, { body: { ...rest, sessionName: m.sessionName }, headers: tok(r.json.editToken) });
    assert.ok(put1.status < 300, brief(put1));
    assert.deepEqual((await metaOf(r.json.id)).from_template, { id: 'seed-design-doc', name: 'Design doc' });
    const put2 = await http(B.url, 'PUT', `/paste/${r.json.id}/meta`, { body: { ...rest, from_template: { id: 'forged', name: 'x' } }, headers: tok(r.json.editToken) });
    assert.ok(put2.status < 300, brief(put2));
    assert.deepEqual((await metaOf(r.json.id)).from_template, { id: 'seed-design-doc', name: 'Design doc' });
    const plain = await http(B.url, 'POST', '/paste', { body: { markdown: '# p', filename: 'p.md', from_template: { id: 'forged', name: 'x' } } });
    assert.ok(plain.status < 300, brief(plain));
    const pm = await metaOf(plain.json.id);
    assert.ok(!('from_template' in pm), 'a client cannot claim template provenance');
  });

  test('unknown collectionId on POST and PATCH /templates → 400 with the same {error, code, available} shape as instantiate', async () => {
    const col = await makeCollection(B.url, B.dataDir, `Shape ${uniq()}`);
    const p = await postTemplate({ name: `Bad col ${uniq()}`, content: 'x', collectionId: 'col-nope' });
    assert.equal(p.status, 400, brief(p));
    assert.equal(p.json.code, 'unknown_collection');
    assert.ok(Array.isArray(p.json.available) && p.json.available.includes(col.name), brief(p));
    assert.match(p.json.error, /col-nope/);
    const t = await userTemplate();
    const q = await http(B.url, 'PATCH', `/templates/${t.id}`, { body: { collectionId: 'col-nope' } });
    assert.equal(q.status, 400, brief(q));
    assert.deepEqual(Object.keys(q.json).sort(), ['available', 'code', 'error']);
    const i = await instantiate(t.id, { title: 'x', collectionId: 'col-nope' });
    assert.deepEqual(Object.keys(i.json).sort(), Object.keys(q.json).sort());
  });

  test('builtins list in manifest order (Weekly leadership update first)', async () => {
    const list = await listTemplates();
    assert.deepEqual(list.filter((t) => t.builtin).map((t) => t.id),
      ['seed-weekly-update', 'seed-design-doc', 'seed-qa-findings', 'seed-pr-review', 'seed-research-brief']);
  });

  test('PATCH a builtin with an invalid JSON body → 403 (builtin check before the body)', async () => {
    const r = await fetch(`${B.url}/templates/seed-design-doc`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(r.status, 403);
    const u = await fetch(`${B.url}/templates/tpl-unknown00`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(u.status, 404);
  });

  test('MCP create_from_template: a template deleted between the list and instantiate → "no longer exists"', async () => {
    const { createHandlers } = await import('../mcp-server.js');
    const fetchFn = async (url) => {
      if (String(url).endsWith('/templates')) {
        return new Response(JSON.stringify([{ id: 'tpl-gone000000', name: 'Gone one', builtin: false }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Template not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    };
    const store = { save() {}, get() { return null; }, tokenFor() { return null; } };
    const h = createHandlers({ pasteApiUrl: 'http://127.0.0.1:9', frontendUrl: 'http://127.0.0.1:9', fetchFn, tokenStore: store });
    const out = await h.create_from_template({ template: 'gone one', title: 'x' });
    assert.match(out.error, /Template "Gone one" no longer exists/);
  });

  test('boot warns when a seed name is held by a user template', async () => {
    const dir = tmpDir('md-review-27-clash');
    let S = await startServer({ dataDir: dir, env: { ALLOW_EMPTY_DB: '1' } });
    await S.stop();
    const now = new Date().toISOString();
    await sql(dir, "INSERT INTO templates (id, name, data_json, created_by, created_at, updated_at) VALUES ('tpl-clash0000000', 'design DOC', '{\"content\":\"x\",\"builtin\":false}', NULL, ?, ?)", now, now);
    S = await startServer({ dataDir: dir });
    try {
      assert.match(S.output(), /seed template "Design doc" \(seed-design-doc\) has the same name as user template tpl-clash0000000/);
    } finally { await S.stop(); }
  });
});

describe('#27 fix round', () => {
  test('a 409 clash names the existing template; replace keeps its name (only content and fields change)', async () => {
    const name = `Kept Name ${uniq()}`;
    const a = await userTemplate({ name, content: 'v1 {{alpha}}' });
    const typed = `  ${name.toUpperCase()} `;
    const r = await postTemplate({ name: typed, content: 'v2', contentType: 'markdown' });
    assert.equal(r.status, 409, brief(r));
    assert.equal(r.json.name, name, '409 carries the existing name');
    const rep = await postTemplate({ name: typed, content: 'v2 {{beta}}', contentType: 'markdown', replace: true });
    assert.equal(rep.status, 200, brief(rep));
    assert.equal(rep.json.id, a.id);
    assert.equal(rep.json.name, name, 'the existing casing is kept');
    assert.deepEqual(rep.json.variables, ['beta'], 'variables follow the new content');
    const listed = (await listTemplates()).find((t) => t.id === a.id);
    assert.equal(listed.name, name);
    assert.deepEqual(listed.variables, ['beta']);
    assert.equal(listed.content, undefined, 'the list never carries content');
  });

  test('variables are stored on write; a row from before that (no stored variables) and a corrupt row still list', async () => {
    const now = new Date().toISOString();
    const legacy = `tpl-legacy${uniq()}`.slice(0, 20);
    const corrupt = `tpl-corrupt${uniq()}`.slice(0, 20);
    await sql(B.dataDir, 'INSERT INTO templates (id, name, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
      legacy, `Legacy ${uniq()}`, JSON.stringify({ content: '# {{title}} by {{author}} \\{{date}}', contentType: 'markdown', builtin: false }), now, now);
    await sql(B.dataDir, 'INSERT INTO templates (id, name, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
      corrupt, `Corrupt ${uniq()}`, '{not json', now, now);
    try {
      const list = await listTemplates();
      assert.deepEqual(list.find((t) => t.id === legacy).variables, ['author', 'title']);
      assert.deepEqual(list.find((t) => t.id === corrupt).variables, []);
      assert.deepEqual((await http(B.url, 'GET', `/templates/${legacy}`)).json.variables, ['author', 'title']);
      const fresh = await userTemplate({ content: '{{zeta}} {{ eta }}' });
      const row = (await sql(B.dataDir, 'SELECT data_json FROM templates WHERE id = ?', fresh.id))[0];
      assert.deepEqual(JSON.parse(row.data_json).variables, ['eta', 'zeta']);
      // Name checks still see a row whose content was never read.
      const legacyName = list.find((t) => t.id === legacy).name;
      const clash = await postTemplate({ name: legacyName.toLowerCase(), content: 'x', contentType: 'markdown' });
      assert.equal(clash.status, 409, brief(clash));
      assert.equal(clash.json.id, legacy);
    } finally {
      await sql(B.dataDir, 'DELETE FROM templates WHERE id IN (?, ?)', legacy, corrupt);
    }
  });
});
