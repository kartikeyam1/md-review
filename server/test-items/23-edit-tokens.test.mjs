// Item #23 — edit tokens on the REST API: issue, present, protected vs open writes, access info,
// rotation, expiry. Spec: docs/build/specs/23-view-edit-links.md rules 1–4, 6–8 (+ 00 §6, §9).
// Legacy sessions and claim: 23-legacy.test.mjs. MCP: 23-mcp-tokens.test.mjs. CLI: 23-cli.test.mjs.
//
// Runs against verify.sh's backend (E2E_API_URL + DATA_DIR) when given, else boots its own.
// Tests named EDGE-23 encode the "edge cases the adversarial verifier must try" whose outcome the
// spec states (or, for the Bearer spelling, RFC 7235: the auth scheme is case-insensitive).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  sharedBackend, cleanupTmp, http, openDbReadOnly, DB_NAME, TOKEN_RE, DAY, uniq, tok, hashForms, allFiles,
  create, getDoc, serverMarkdown, metaOf, putMd, putMeta, rotate, brief,
} from './23-helpers.mjs';

let B;
before(async () => { B = await sharedBackend(); });
after(async () => { await B?.stop(); cleanupTmp(); });

const xOf = (d) => d.slug || d.id;

/** 401 edit_token_required (rule 3). */
function assert401(r, what) {
  assert.equal(r.status, 401, `${what}: expected 401, got ${brief(r)}`);
  assert.equal(r.json?.code, 'edit_token_required', `${what}: code`);
  assert.equal(r.json?.error, 'Edit token required', `${what}: error`);
}
/** 403 edit_token_invalid (rule 3). */
function assert403(r, what) {
  assert.equal(r.status, 403, `${what}: expected 403, got ${brief(r)}`);
  assert.equal(r.json?.code, 'edit_token_invalid', `${what}: code`);
  assert.equal(r.json?.error, 'Invalid edit token', `${what}: error`);
}
const assert2xx = (r, what) => assert.ok(r.status >= 200 && r.status < 300, `${what}: expected 2xx, got ${brief(r)}`);

/** The token a fresh POST /paste returns (fails clearly while #23 is missing). */
async function newDoc(body = {}) {
  const d = await create(B.url, { sessionName: `Tok ${uniq()}`, mode: 'review', ...body });
  assert.match(String(d.editToken), TOKEN_RE, `POST /paste must return an editToken (got ${JSON.stringify(d)})`);
  return d;
}

/** A snapshot of everything a rejected write must leave alone. */
async function snapshot(x) {
  const full = await getDoc(B.url, x);
  const files = await http(B.url, 'GET', `/paste/${x}/files`);
  const revs = await http(B.url, 'GET', `/paste/${x}/revisions`);
  const j = full.json || {};
  return JSON.stringify({
    status: full.status, markdown: j.markdown, filename: j.filename, sessionName: j.sessionName, slug: j.slug,
    mode: j.mode, expires_at: j.expires_at, files: files.json, revisions: (revs.json?.revisions || []).length,
  });
}

// ── AC-23.1 / rule 1: issue ────────────────────────────────────────────────

describe('#23 rule 1 — token issued on create', () => {
  test('AC-23.1 POST /paste returns id, editToken, viewUrl (no token) and editUrl ending ?edit=<token>', async () => {
    const d = await create(B.url, { sessionName: `Issue ${uniq()}`, markdown: '# Issue\n\nbody' });
    assert.ok(d.id, 'id');
    assert.ok(d.slug, 'slug kept (existing {id, slug?} unchanged)');
    assert.match(String(d.editToken), TOKEN_RE, `editToken shape: ${JSON.stringify(d.editToken)}`);
    for (const k of ['viewUrl', 'editUrl', 'url', 'app_url']) assert.equal(typeof d[k], 'string', `${k} is a string`);
    assert.ok(!d.viewUrl.includes(d.editToken) && !d.viewUrl.includes('edit='), `viewUrl carries no token: ${d.viewUrl}`);
    assert.ok(!d.url.includes(d.editToken), 'url carries no token');
    assert.ok(!d.app_url.includes(d.editToken), 'app_url carries no token');
    assert.equal(d.viewUrl, d.url, 'viewUrl = url (00 §6)');
    assert.ok(d.app_url.endsWith(`/d/${d.slug}`), `app_url = FRONTEND_URL/d/<slug>: ${d.app_url}`);
    assert.ok(d.url.endsWith(`/d/${d.slug}`), `url ends /d/<slug>: ${d.url}`);
    assert.ok(d.editUrl.endsWith(`?edit=${d.editToken}`), `editUrl ends ?edit=<token>: ${d.editUrl}`);
    assert.equal(d.editUrl, `${d.app_url}?edit=${d.editToken}`, 'editUrl = app_url + "?edit=" + token (00 §6)');
  });

  test('AC-23.1 without a slug the links use the id', async () => {
    const d = await create(B.url, { markdown: '# No slug\n' });
    assert.equal(d.slug ?? null, null);
    assert.ok(d.app_url?.endsWith(`/d/${d.id}`), `app_url: ${d.app_url}`);
    assert.equal(d.editUrl, `${d.app_url}?edit=${d.editToken}`);
  });

  test('AC-23.1 tokens are unique per doc', async () => {
    const a = await newDoc(); const b = await newDoc();
    assert.notEqual(a.editToken, b.editToken);
  });

  test('AC-23.1 only sha256(token) is stored: the raw token is in no file under DATA_DIR', async () => {
    const d = await newDoc({ markdown: '# Stored hash\n' });
    // A write forces the WAL to hold recent pages too.
    assert.equal((await putMd(B.url, d.id, '# Stored hash\n\nv2', tok(d.editToken))).status, 200);
    const db = await openDbReadOnly(path.join(B.dataDir, DB_NAME));
    let row;
    try { row = db.prepare('SELECT edit_token_hash FROM sessions WHERE id = ?').get(d.id); } finally { db.close(); }
    assert.ok(row?.edit_token_hash, 'sessions.edit_token_hash is set');
    assert.ok(hashForms(d.editToken).includes(row.edit_token_hash), `edit_token_hash is sha256(token) (got ${row.edit_token_hash})`);
    const needle = Buffer.from(d.editToken, 'utf-8');
    const secret = Buffer.from(d.editToken.slice(4), 'utf-8'); // without the mre_ prefix
    for (const [rel, buf] of allFiles(B.dataDir)) {
      assert.equal(buf.indexOf(needle), -1, `raw token found in ${rel}`);
      assert.equal(buf.indexOf(secret), -1, `raw token body found in ${rel}`);
    }
  });

  test('EDGE-23 a client-supplied edit_token_hash on create is not kept (a forged token never works)', async () => {
    const forged = `mre_${'A'.repeat(43)}`;
    const d = await create(B.url, { markdown: '# forged\n', edit_token_hash: hashForms(forged)[0] });
    assert.match(String(d.editToken), TOKEN_RE);
    assert403(await putMd(B.url, d.id, 'pwned', tok(forged)), 'forged token');
    assert.equal(await serverMarkdown(B.url, d.id), '# forged\n');
  });
});

// ── AC-23.2 / rule 2–3: present ────────────────────────────────────────────

describe('#23 rules 2–3 — presenting the token on PUT /markdown', () => {
  test('AC-23.2 no token 401 / wrong 403 / Bearer 200 / X-Edit-Token 200, content changed only by the last two', async () => {
    const d = await newDoc({ markdown: 'v0' });
    assert401(await putMd(B.url, d.id, 'no-token'), 'no token');
    assert.equal(await serverMarkdown(B.url, d.id), 'v0', 'unchanged after 401');
    const other = await newDoc();
    assert403(await putMd(B.url, d.id, 'wrong-token', tok(other.editToken)), 'another doc\'s token');
    assert403(await putMd(B.url, d.id, 'garbage', tok('mre_nope')), 'garbage token');
    assert.equal(await serverMarkdown(B.url, d.id), 'v0', 'unchanged after 403');
    const r1 = await putMd(B.url, d.id, 'bearer-write', tok(d.editToken, 'bearer'));
    assert.equal(r1.status, 200, `Bearer: ${brief(r1)}`);
    assert.equal(await serverMarkdown(B.url, d.id), 'bearer-write');
    const r2 = await putMd(B.url, d.id, 'x-header-write', tok(d.editToken));
    assert.equal(r2.status, 200, `X-Edit-Token: ${brief(r2)}`);
    assert.equal(await serverMarkdown(B.url, d.id), 'x-header-write');
  });

  test('AC-23.2 the token works through the slug as well as the id', async () => {
    const d = await newDoc();
    assert.ok(d.slug);
    assert401(await putMd(B.url, d.slug, 'x'), 'slug, no token');
    assert.equal((await putMd(B.url, d.slug, 'via slug', tok(d.editToken))).status, 200);
    assert.equal(await serverMarkdown(B.url, d.id), 'via slug');
  });

  test('EDGE-23 both headers present: agreeing → 200, disagreeing → 403 (either one valid)', async () => {
    const d = await newDoc({ markdown: 'both' });
    const ok = await putMd(B.url, d.id, 'agree', { ...tok(d.editToken), ...tok(d.editToken, 'bearer') });
    assert.equal(ok.status, 200, `agreeing: ${brief(ok)}`);
    assert403(await putMd(B.url, d.id, 'x', { 'X-Edit-Token': d.editToken, Authorization: 'Bearer mre_other' }), 'X valid, Bearer wrong');
    assert403(await putMd(B.url, d.id, 'x', { 'X-Edit-Token': 'mre_other', Authorization: `Bearer ${d.editToken}` }), 'Bearer valid, X wrong');
    assert.equal(await serverMarkdown(B.url, d.id), 'agree');
  });

  test('EDGE-23 lowercase "bearer" scheme and surrounding whitespace are accepted (RFC 7235)', async () => {
    const d = await newDoc();
    const r1 = await putMd(B.url, d.id, 'lower', { Authorization: `bearer ${d.editToken}` });
    assert.equal(r1.status, 200, `lowercase bearer: ${brief(r1)}`);
    const r2 = await putMd(B.url, d.id, 'spaces', { Authorization: `Bearer   ${d.editToken}  ` });
    assert.equal(r2.status, 200, `padded Bearer: ${brief(r2)}`);
    const r3 = await putMd(B.url, d.id, 'xspaces', { 'X-Edit-Token': `  ${d.editToken} ` });
    assert.equal(r3.status, 200, `padded X-Edit-Token: ${brief(r3)}`);
    assert.equal(await serverMarkdown(B.url, d.id), 'xspaces');
  });

  test('rule 2 CORS preflight allows Authorization and X-Edit-Token (00 §9)', async () => {
    const r = await http(B.url, 'OPTIONS', '/paste/x/markdown', {
      headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-edit-token, authorization' },
    });
    const allow = (r.headers.get('access-control-allow-headers') || '').toLowerCase();
    assert.ok(allow.includes('authorization') && allow.includes('x-edit-token'), allow);
  });
});

// ── rule 3: every protected write ──────────────────────────────────────────

describe('#23 rule 3 — every protected write needs the token', () => {
  /** [name, fn(doc, headers) → response] — each a protected write per rule 3. */
  const WRITES = [
    ['PUT /markdown', (d, h) => putMd(B.url, d.id, `changed ${uniq()}`, h)],
    ['PUT /markdown (patch)', (d, h) => http(B.url, 'PUT', `/paste/${d.id}/markdown`, { body: { patch: '@@ -2 +2 @@\n-Body\n+Patched\n' }, headers: h })],
    ['PUT /meta sessionName', (d, h) => putMeta(B.url, d.id, { sessionName: `Renamed ${uniq()}` }, h)],
    ['PUT /meta slug', (d, h) => putMeta(B.url, d.id, { slug: `moved-${uniq()}` }, h)],
    ['PUT /meta mode (#2 mode change)', (d, h) => putMeta(B.url, d.id, { mode: 'publish' }, h)],
    ['PUT /meta expiry_days', (d, h) => putMeta(B.url, d.id, { expiry_days: 7 }, h)],
    ['POST /files', (d, h) => http(B.url, 'POST', `/paste/${d.id}/files`, { body: { name: `n-${uniq()}.txt`, content: 'file body' }, headers: h })],
    ['DELETE /files/:name', (d, h) => http(B.url, 'DELETE', `/paste/${d.id}/files/keep.txt`, { headers: h })],
    ['POST /upload/start', (d, h) => http(B.url, 'POST', `/paste/${d.id}/upload/start`, { body: { totalChunks: 1, target: 'markdown' }, headers: h })],
    ['POST /edit-token (rotation)', (d, h) => http(B.url, 'POST', `/paste/${d.id}/edit-token`, { body: {}, headers: h })],
    ['DELETE /paste/:id', (d, h) => http(B.url, 'DELETE', `/paste/${d.id}`, { headers: h })],
  ];

  async function protectedDoc() {
    const d = await newDoc({ markdown: '# Title\nBody\n' });
    const f = await http(B.url, 'POST', `/paste/${d.id}/files`, { body: { name: 'keep.txt', content: 'keep me' }, headers: tok(d.editToken) });
    assert.equal(f.status, 201, `setup POST /files with token: ${brief(f)}`);
    return d;
  }

  for (const [name, write] of WRITES) {
    test(`AC-23.2 (rule 3) ${name}: no token → 401, wrong token → 403, nothing changes; valid token → 2xx`, async () => {
      const d = await protectedDoc();
      const before = await snapshot(d.id);
      assert401(await write(d, {}), `${name} without token`);
      assert.equal(await snapshot(d.id), before, `${name}: a 401 write changed state`);
      const other = await newDoc();
      assert403(await write(d, tok(other.editToken)), `${name} with another doc's token`);
      assert403(await write(d, tok(other.editToken, 'bearer')), `${name} with another doc's token (Bearer)`);
      assert.equal(await snapshot(d.id), before, `${name}: a 403 write changed state`);
      assert2xx(await write(d, tok(d.editToken)), `${name} with the token`);
    });
  }

  test('AC-23.2 (rule 3) chunked upload: start with token, chunk / complete without → 401 and content unchanged', async () => {
    const d = await newDoc({ markdown: 'before-upload' });
    const start = await http(B.url, 'POST', `/paste/${d.id}/upload/start`, { body: { totalChunks: 1, target: 'markdown' }, headers: tok(d.editToken) });
    assert.equal(start.status, 200, brief(start));
    const { uploadId } = start.json;
    assert401(await http(B.url, 'POST', `/paste/${d.id}/upload/chunk`, { body: { uploadId, index: 0, data: 'CHUNKED' } }), 'chunk without token');
    assert403(await http(B.url, 'POST', `/paste/${d.id}/upload/chunk`, { body: { uploadId, index: 0, data: 'CHUNKED' }, headers: tok('mre_wrong') }), 'chunk with wrong token');
    assert.equal((await http(B.url, 'POST', `/paste/${d.id}/upload/chunk`, { body: { uploadId, index: 0, data: 'CHUNKED' }, headers: tok(d.editToken) })).status, 200);
    assert401(await http(B.url, 'POST', `/paste/${d.id}/upload/complete`, { body: { uploadId } }), 'complete without token');
    assert.equal(await serverMarkdown(B.url, d.id), 'before-upload', 'unchanged after rejected complete');
    const done = await http(B.url, 'POST', `/paste/${d.id}/upload/complete`, { body: { uploadId }, headers: tok(d.editToken) });
    assert.equal(done.status, 200, brief(done));
    assert.equal(await serverMarkdown(B.url, d.id), 'CHUNKED');
  });

  test('AC-23.2 (rule 3) a rejected chunk is not stored: completing afterwards with the token does not apply it', async () => {
    const d = await newDoc({ markdown: 'orig' });
    const start = await http(B.url, 'POST', `/paste/${d.id}/upload/start`, { body: { totalChunks: 1, target: 'markdown' }, headers: tok(d.editToken) });
    const { uploadId } = start.json;
    assert401(await http(B.url, 'POST', `/paste/${d.id}/upload/chunk`, { body: { uploadId, index: 0, data: 'SNEAKY' } }), 'chunk without token');
    await http(B.url, 'POST', `/paste/${d.id}/upload/complete`, { body: { uploadId }, headers: tok(d.editToken) });
    assert.equal(await serverMarkdown(B.url, d.id), 'orig');
  });

  test('AC-23.2 (rule 3) order: unknown doc → 404 before the token check', async () => {
    const ghost = 'ffffffffffff';
    for (const [m, p, body] of [
      ['PUT', `/paste/${ghost}/markdown`, { markdown: 'x' }], ['PUT', `/paste/${ghost}/meta`, { sessionName: 'x' }],
      ['DELETE', `/paste/${ghost}`], ['POST', `/paste/${ghost}/files`, { name: 'a', content: 'b' }],
      ['POST', `/paste/${ghost}/upload/start`, {}], ['POST', `/paste/${ghost}/edit-token`, {}],
    ]) {
      const r = await http(B.url, m, p, { body });
      assert.equal(r.status, 404, `${m} ${p} without token: ${brief(r)}`);
    }
  });

  test('AC-23.2 (rule 3) order: invalid JSON → 400 before the token check', async () => {
    const d = await newDoc();
    for (const p of [`/paste/${d.id}/markdown`, `/paste/${d.id}/meta`]) {
      const r = await http(B.url, 'PUT', p, { body: '{not json', headers: { 'Content-Type': 'application/json' } });
      assert.equal(r.status, 400, `PUT ${p} invalid JSON, no token: ${brief(r)}`);
    }
  });

  test('AC-23.2 (rule 3) order: the token check comes before other validation (400/409/412)', async () => {
    const d = await newDoc({ markdown: 'line one\n' });
    assert401(await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { body: {} }), 'empty body (would be 400)');
    assert401(await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { body: { markdown: 'x' }, headers: { 'If-Match': '0'.repeat(32) } }), 'stale If-Match (would be 412)');
    assert401(await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { body: { patch: '@@ -1 +1 @@\n-nope\n+x\n' } }), 'bad patch (would be 409)');
    assert401(await putMeta(B.url, d.id, { mode: 'BOGUS' }), 'invalid mode (would be 400)');
    assert403(await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { body: {}, headers: tok('mre_x') }), 'empty body, wrong token');
    // With the token the usual validation applies.
    assert.equal((await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { body: {}, headers: tok(d.editToken) })).status, 400);
    assert.equal((await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { body: { markdown: 'x' }, headers: { 'If-Match': '0'.repeat(32), ...tok(d.editToken) } })).status, 412);
  });

  test('EDGE-23 delete with the token, then re-create with the same slug: the old token never writes the new doc', async () => {
    const slug = `reuse-${uniq()}`;
    const a = await newDoc({ slug, markdown: 'first' });
    assert.equal(a.slug, slug);
    assert.equal((await http(B.url, 'DELETE', `/paste/${a.id}`, { headers: tok(a.editToken) })).status, 204);
    const b = await newDoc({ slug, markdown: 'second' });
    assert.equal(b.slug, slug, 'the freed slug is reused');
    const byOldId = await putMd(B.url, a.id, 'x', tok(a.editToken));
    assert.equal(byOldId.status, 404, `old id with old token: ${brief(byOldId)}`);
    assert403(await putMd(B.url, slug, 'x', tok(a.editToken)), 'slug with the deleted doc\'s token');
    assert.equal(await serverMarkdown(B.url, b.id), 'second');
  });

  test('EDGE-23 PUT /meta cannot overwrite the stored hash (edit_token_hash in the body is ignored)', async () => {
    const d = await newDoc();
    const forged = `mre_${'B'.repeat(43)}`;
    await putMeta(B.url, d.id, { edit_token_hash: hashForms(forged)[0], sessionName: 'still mine' }, tok(d.editToken));
    assert403(await putMd(B.url, d.id, 'x', tok(forged)), 'forged token after meta write');
    assert.equal((await putMd(B.url, d.id, 'mine', tok(d.editToken))).status, 200);
  });
});

// ── AC-23.3 / rule 4: open actions ─────────────────────────────────────────

describe('#23 rule 4 — open actions need no token', () => {
  test('AC-23.3 comment, reply, edit, resolve/unresolve, approve, request changes and deletes all succeed without a token', async () => {
    const d = await newDoc({ markdown: '# T\n\nNeeds review.\n' });
    const c = await http(B.url, 'POST', `/paste/${d.id}/comments`, {
      body: { startLine: 2, endLine: 2, selectedText: 'Needs review.', body: 'viewer comment', category: 'suggestion', author: 'Viewer' },
    });
    assert.equal(c.status, 201, `comment: ${brief(c)}`);
    const cid = c.json.id;
    const rep = await http(B.url, 'POST', `/paste/${d.id}/comments/${cid}/replies`, { body: { body: 'viewer reply', author: 'Viewer' } });
    assert.equal(rep.status, 201, `reply: ${brief(rep)}`);
    const rid = rep.json.id;
    assert.equal((await http(B.url, 'PUT', `/paste/${d.id}/comments/${cid}/replies/${rid}`, { body: { body: 'edited reply' } })).status, 200, 'edit reply');
    assert.equal((await http(B.url, 'PUT', `/paste/${d.id}/comments/${cid}`, { body: { body: 'edited comment' } })).status, 200, 'edit comment');
    assert.equal((await http(B.url, 'PUT', `/paste/${d.id}/comments/${cid}/resolve`, { body: { resolved_by: 'Viewer' } })).status, 200, 'resolve');
    assert.equal((await http(B.url, 'PUT', `/paste/${d.id}/comments/${cid}/unresolve`, { body: {} })).status, 200, 'unresolve');
    const ap = await http(B.url, 'PUT', `/paste/${d.id}/approval`, { body: { status: 'approved', approved_by: 'Lead' } });
    assert.equal(ap.status, 200, `approve: ${brief(ap)}`);
    assert.equal(ap.json.approval_status, 'approved');
    assert.equal((await http(B.url, 'PUT', `/paste/${d.id}/approval`, { body: { status: 'changes_requested' } })).status, 200, 'request changes');
    assert.equal((await http(B.url, 'DELETE', `/paste/${d.id}/comments/${cid}/replies/${rid}`)).status, 204, 'delete reply');
    assert.equal((await http(B.url, 'DELETE', `/paste/${d.id}/comments/${cid}`)).status, 204, 'delete comment');
    const meta = await metaOf(B.url, d.id);
    assert.equal(meta.approval_status, 'changes_requested');
    assert.equal(meta.access?.protected, true, 'the doc is protected all along');
  });

  test('AC-23.3 reads and search need no token', async () => {
    const word = `zx${uniq()}`;
    const d = await newDoc({ markdown: `# Findable\n\n${word}\n` });
    for (const p of [`/paste/${d.id}`, `/paste/${d.id}?fields=meta`, `/paste/${d.id}/markdown`, `/paste/${d.id}/comments`,
      `/paste/${d.id}/revisions`, `/paste/${d.id}/approval`, `/paste/${d.id}/files`, '/paste/list']) {
      const r = await http(B.url, 'GET', p);
      assert.equal(r.status, 200, `GET ${p}: ${brief(r)}`);
    }
    const s = await http(B.url, 'GET', `/library/docs?q=${word}`);
    assert.equal(s.status, 200, brief(s));
    assert.ok(s.json.items.some((i) => i.id === d.id), 'search finds the protected doc');
  });
});

// ── AC-23.5 / rule 6: access info ──────────────────────────────────────────

describe('#23 rule 6 — access info on GET', () => {
  test('AC-23.5 GET without / with token: access.can_edit false / true; id present (full and fields=meta)', async () => {
    const d = await newDoc();
    for (const qs of ['', '?fields=meta']) {
      const anon = await getDoc(B.url, d.id, {}, qs);
      assert.equal(anon.status, 200);
      assert.equal(anon.json.id, d.id, `id on GET${qs}`);
      assert.equal(anon.json.access?.protected, true, `access.protected on GET${qs}: ${JSON.stringify(anon.json.access)}`);
      assert.equal(anon.json.access?.can_edit, false, `anonymous access.can_edit on GET${qs}`);
      for (const how of ['x', 'bearer']) {
        const ed = await getDoc(B.url, d.id, tok(d.editToken, how), qs);
        assert.equal(ed.status, 200);
        assert.equal(ed.json.access?.protected, true, `access.protected with token (${how}) on GET${qs}`);
        assert.equal(ed.json.access?.can_edit, true, `access.can_edit with token (${how}) on GET${qs}`);
      }
      const wrong = await getDoc(B.url, d.id, tok('mre_definitely_not_it'), qs);
      assert.equal(wrong.status, 200, 'GETs stay open with a wrong token');
      assert.equal(wrong.json.access?.can_edit, false, `wrong token → can_edit false on GET${qs}`);
    }
    const bySlug = await getDoc(B.url, d.slug, tok(d.editToken));
    assert.equal(bySlug.json.id, d.id, 'id when fetched by slug');
    assert.equal(bySlug.json.access?.can_edit, true);
  });

  test('AC-23.5 no response ever contains edit_token_hash, the hash value or the raw token', async () => {
    const d = await newDoc({ markdown: '# Secret\n\nbody\n' });
    await http(B.url, 'POST', `/paste/${d.id}/files`, { body: { name: 'a.txt', content: 'x' }, headers: tok(d.editToken) });
    const forbidden = [d.editToken, d.editToken.slice(4), 'edit_token_hash', ...hashForms(d.editToken)];
    const paths = [`/paste/${d.id}`, `/paste/${d.slug}`, `/paste/${d.id}?fields=meta`, `/paste/${d.id}?fields=meta,content,comments,files`,
      `/paste/${d.id}/markdown`, `/paste/${d.id}/comments`, `/paste/${d.id}/revisions`, `/paste/${d.id}/revisions/current`,
      `/paste/${d.id}/approval`, `/paste/${d.id}/files`, '/paste/list', '/library/docs', `/library/docs?q=Secret`];
    for (const p of paths) {
      for (const h of [{}, tok(d.editToken), tok(d.editToken, 'bearer')]) {
        const r = await http(B.url, 'GET', p, { headers: h });
        for (const f of forbidden) assert.ok(!r.text.includes(f), `GET ${p} (${Object.keys(h).join(',') || 'no token'}) leaks ${f === d.editToken ? 'the raw token' : f}`);
      }
    }
    // Write responses must not echo it either (rotation/claim are the only exceptions, rule 1).
    const writes = [
      await putMd(B.url, d.id, 'v2', tok(d.editToken)),
      await putMeta(B.url, d.id, { sessionName: 'Secret 2' }, tok(d.editToken)),
      await http(B.url, 'POST', `/paste/${d.id}/comments`, { body: { startLine: 0, endLine: 0, selectedText: 'v2', body: 'c', category: 'nit' } }),
    ];
    for (const r of writes) for (const f of forbidden) assert.ok(!r.text.includes(f), `write response leaks ${f}`);
  });
});

// ── AC-23.6 / rule 7: rotation ─────────────────────────────────────────────

describe('#23 rule 7 — rotation', () => {
  test('AC-23.6 rotating with the current token: old token 403, new token 200', async () => {
    const d = await newDoc({ markdown: 'r0' });
    const r = await rotate(B.url, d.id, tok(d.editToken));
    assert.equal(r.status, 200, brief(r));
    const fresh = r.json.editToken;
    assert.match(String(fresh), TOKEN_RE);
    assert.notEqual(fresh, d.editToken);
    assert.ok(String(r.json.editUrl).endsWith(`/d/${xOf(d)}?edit=${fresh}`), `editUrl: ${r.json.editUrl}`);
    assert403(await putMd(B.url, d.id, 'old', tok(d.editToken)), 'old token after rotation');
    assert.equal((await putMd(B.url, d.id, 'new', tok(fresh))).status, 200);
    assert.equal(await serverMarkdown(B.url, d.id), 'new');
    assert.equal((await getDoc(B.url, d.id, tok(d.editToken))).json.access?.can_edit, false, 'old token no longer grants can_edit');
  });

  test('AC-23.6 rotation without / with a wrong token → 401 / 403, and the token keeps working', async () => {
    const d = await newDoc();
    assert401(await rotate(B.url, d.id), 'rotate without token');
    assert403(await rotate(B.url, d.id, tok('mre_bad')), 'rotate with wrong token');
    assert.equal((await putMd(B.url, d.id, 'still', tok(d.editToken))).status, 200);
  });

  test('AC-23.6 rotation via Bearer and by slug', async () => {
    const d = await newDoc();
    const r = await rotate(B.url, d.slug, tok(d.editToken, 'bearer'));
    assert.equal(r.status, 200, brief(r));
    assert.equal((await putMd(B.url, d.id, 'x', tok(r.json.editToken, 'bearer'))).status, 200);
  });
});

// ── AC-23.7 / rule 8: expiry ───────────────────────────────────────────────

describe('#23 rule 8 — expiry', () => {
  const near = (iso, ms, what) => {
    assert.ok(iso, `${what}: expires_at is set`);
    const delta = Date.parse(iso) - (Date.now() + ms);
    assert.ok(Math.abs(delta) <= 60000, `${what}: expires_at ${iso} is ${Math.round(delta / 1000)} s off`);
  };

  test('AC-23.7 PUT /meta {expiry_days:1} with token → expires_at ≈ now+24h, expiry_days:1; null clears; no token → 401', async () => {
    const d = await newDoc();
    const one = await putMeta(B.url, d.id, { expiry_days: 1 }, tok(d.editToken));
    assert.equal(one.status, 200, brief(one));
    assert.equal(one.json.expiry_days, 1, 'response echoes expiry_days');
    near(one.json.expires_at, DAY, 'response');
    near((await metaOf(B.url, d.id)).expires_at, DAY, 'stored');
    const never = await putMeta(B.url, d.id, { expiry_days: null }, tok(d.editToken));
    assert.equal(never.status, 200, brief(never));
    assert.equal(never.json.expiry_days, null);
    assert.equal(never.json.expires_at ?? null, null);
    assert.equal((await metaOf(B.url, d.id)).expires_at ?? null, null, 'cleared');
    const before = (await metaOf(B.url, d.id)).expires_at ?? null;
    assert401(await putMeta(B.url, d.id, { expiry_days: 1 }), 'expiry without token');
    assert.equal((await metaOf(B.url, d.id)).expires_at ?? null, before, 'unchanged after 401');
  });

  test('AC-23.7 (rule 8) PUT /meta accepts 1, 7, 30, 90 and echoes what was applied', async () => {
    const d = await newDoc();
    for (const n of [1, 7, 30, 90]) {
      const r = await putMeta(B.url, d.id, { expiry_days: n }, tok(d.editToken));
      assert.equal(r.status, 200, `${n}: ${brief(r)}`);
      assert.equal(r.json.expiry_days, n);
      near(r.json.expires_at, n * DAY, `${n} days`);
    }
  });

  test('AC-23.7 (rule 8) POST /paste accepts 1, 7, 30, 90 and null', async () => {
    for (const n of [1, 7, 30, 90]) {
      const d = await create(B.url, { expiry_days: n });
      near((await metaOf(B.url, d.id)).expires_at, n * DAY, `create ${n}`);
    }
    const forever = await create(B.url, { expiry_days: null });
    assert.equal((await metaOf(B.url, forever.id)).expires_at ?? null, null, 'null = never');
    const dflt = await create(B.url, {});
    near((await metaOf(B.url, dflt.id)).expires_at, 30 * DAY, 'default');
  });

  test('EDGE-23 odd expiry values ("7", 0, -1, 365, 2.5) coerce to 30 days on create and on meta, never a crash', async () => {
    for (const v of ['7', 0, -1, 365, 2.5]) {
      const d = await create(B.url, { expiry_days: v });
      near((await metaOf(B.url, d.id)).expires_at, 30 * DAY, `create ${JSON.stringify(v)}`);
      const r = await putMeta(B.url, d.id, { expiry_days: v }, tok(d.editToken));
      assert.equal(r.status, 200, `meta ${JSON.stringify(v)}: ${brief(r)}`);
      assert.equal(r.json.expiry_days, 30, `meta ${JSON.stringify(v)} applies 30`);
      near(r.json.expires_at, 30 * DAY, `meta ${JSON.stringify(v)}`);
    }
  });
});

// ── #21 upsert by key ───────────────────────────────────────────────────────

describe('#23 rule 1/3 — PUT /paste/by-key (#21) issues and requires the token', () => {
  test('AC-23.1/23.2 (rule 1, 3) upsert-create returns editToken; update without it → 401', async () => {
    const key = `t23:${uniq()}`;
    const c = await http(B.url, 'PUT', `/paste/by-key/${encodeURIComponent(key)}`, { body: { markdown: 'v1' } });
    assert.equal(c.status, 201, brief(c));
    assert.match(String(c.json.editToken), TOKEN_RE);
    assert401(await http(B.url, 'PUT', `/paste/by-key/${encodeURIComponent(key)}`, { body: { markdown: 'v2' } }), 'upsert update without token');
    const ok = await http(B.url, 'PUT', `/paste/by-key/${encodeURIComponent(key)}`, { body: { markdown: 'v2' }, headers: tok(c.json.editToken) });
    assert.equal(ok.status, 200, brief(ok));
  });
});
