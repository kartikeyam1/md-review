// Item #23 — legacy sessions (created before #23, no edit_token_hash) and claim.
// Spec: docs/build/specs/23-view-edit-links.md rules 5–7.
//
// Legacy docs are the real thing: the #20 legacy JSON fixture migrated to SQLite (the migration
// never invents a token hash). Every test boots its own backend on a fresh copy, so claims in one
// test never leak into another.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  legacyBackend, cleanupTmp, http, TOKEN_RE, tok, getDoc, serverMarkdown, metaOf, putMd, putMeta, rotate, brief,
} from './23-helpers.mjs';

// From server/test-items/fixtures/20/legacy-data (all unexpired, markdown).
const CAFE = { id: 'cafe00000001', slug: 'cafe' };
const PRE = { id: '0a0a0a0a0a0a', slug: 'pre-history-doc' };
const CJK = { id: '3d3d3d3d3d3d', slug: 'cjk-plan' };
const SEEDED = { id: 'f6f6f6f6f6f6', slug: null };
const SHARED = { id: '1b1b1b1b1b1b', slug: 'shared-name' };

let B;
before(async () => { B = await legacyBackend(); });
after(async () => { await B?.stop(); cleanupTmp(); });

describe('#23 rule 5 — legacy sessions stay link-editable', () => {
  test('AC-23.4 GET shows access {protected:false, can_edit:true} (full and fields=meta)', async () => {
    for (const qs of ['', '?fields=meta']) {
      const r = await getDoc(B.url, CAFE.id, {}, qs);
      assert.equal(r.status, 200, brief(r));
      assert.equal(r.json.id, CAFE.id, `id on GET${qs}`);
      assert.equal(r.json.access?.protected, false, `access.protected on GET${qs}: ${JSON.stringify(r.json.access)}`);
      assert.equal(r.json.access?.can_edit, true, `access.can_edit on GET${qs}`);
    }
  });

  test('AC-23.4 PUT /markdown, PUT /meta and DELETE without a token all succeed', async () => {
    const m = await putMd(B.url, PRE.id, '# Legacy edit\n');
    assert.equal(m.status, 200, `PUT /markdown: ${brief(m)}`);
    assert.equal(await serverMarkdown(B.url, PRE.id), '# Legacy edit\n');
    const meta = await putMeta(B.url, PRE.id, { sessionName: 'Renamed legacy', mode: 'publish', expiry_days: 90 });
    assert.equal(meta.status, 200, `PUT /meta: ${brief(meta)}`);
    assert.equal((await metaOf(B.url, PRE.id)).sessionName, 'Renamed legacy');
    const del = await http(B.url, 'DELETE', `/paste/${PRE.id}`);
    assert.equal(del.status, 204, `DELETE: ${brief(del)}`);
    assert.equal((await getDoc(B.url, PRE.id)).status, 404);
  });

  test('AC-23.4 (rule 5) files and chunked uploads need no token either; a presented token is ignored', async () => {
    const f = await http(B.url, 'POST', `/paste/${CJK.id}/files`, { body: { name: 'x.txt', content: 'x' } });
    assert.equal(f.status, 201, brief(f));
    assert.equal((await http(B.url, 'DELETE', `/paste/${CJK.id}/files/x.txt`)).status, 204);
    const start = await http(B.url, 'POST', `/paste/${CJK.id}/upload/start`, { body: { totalChunks: 1, target: 'markdown' } });
    assert.equal(start.status, 200, brief(start));
    assert.equal((await http(B.url, 'POST', `/paste/${CJK.id}/upload/chunk`, { body: { uploadId: start.json.uploadId, index: 0, data: 'UP' } })).status, 200);
    assert.equal((await http(B.url, 'POST', `/paste/${CJK.id}/upload/complete`, { body: { uploadId: start.json.uploadId } })).status, 200);
    assert.equal(await serverMarkdown(B.url, CJK.id), 'UP');
    // A bogus token on a legacy doc is ignored (not 403).
    const r = await putMd(B.url, CJK.id, 'with bogus token', tok('mre_bogus'));
    assert.equal(r.status, 200, `bogus X-Edit-Token on legacy: ${brief(r)}`);
    const r2 = await putMd(B.url, CJK.id, 'with bogus bearer', tok('mre_bogus', 'bearer'));
    assert.equal(r2.status, 200, `bogus Bearer on legacy: ${brief(r2)}`);
    assert.equal((await getDoc(B.url, CJK.id, tok('mre_bogus'))).json.access?.can_edit, true, 'legacy can_edit regardless of token');
  });
});

describe('#23 rule 7 — claim', () => {
  test('AC-23.6 claim on a legacy doc: 200 {editToken, editUrl}; token-less writes then 401; the token writes', async () => {
    const c = await rotate(B.url, SEEDED.id);
    assert.equal(c.status, 200, `claim: ${brief(c)}`);
    assert.match(String(c.json.editToken), TOKEN_RE);
    assert.ok(String(c.json.editUrl).endsWith(`/d/${SEEDED.id}?edit=${c.json.editToken}`), `editUrl: ${c.json.editUrl}`);
    const meta = await metaOf(B.url, SEEDED.id);
    assert.equal(meta.access?.protected, true, 'protected after claim');
    assert.equal(meta.access?.can_edit, false);
    const r = await putMd(B.url, SEEDED.id, 'after claim');
    assert.equal(r.status, 401, `token-less write after claim: ${brief(r)}`);
    assert.equal(r.json?.code, 'edit_token_required');
    assert.equal((await putMeta(B.url, SEEDED.id, { expiry_days: 7 })).status, 401, 'token-less meta after claim');
    assert.equal((await http(B.url, 'DELETE', `/paste/${SEEDED.id}`)).status, 401, 'token-less delete after claim');
    assert.equal((await putMd(B.url, SEEDED.id, 'claimed write', tok(c.json.editToken))).status, 200);
    assert.equal(await serverMarkdown(B.url, SEEDED.id), 'claimed write');
  });

  test('AC-23.6 a second token-less claim is refused (401): anyone may claim only once', async () => {
    const first = await rotate(B.url, SHARED.slug);
    assert.equal(first.status, 200, brief(first));
    const second = await rotate(B.url, SHARED.slug);
    assert.equal(second.status, 401, `second claim: ${brief(second)}`);
    assert.equal(second.json?.code, 'edit_token_required');
    assert.equal((await putMd(B.url, SHARED.id, 'still first', tok(first.json.editToken))).status, 200, 'the first token still works');
  });

  test('EDGE-23 two claims at once: exactly one returned token works', async () => {
    const results = await Promise.all([rotate(B.url, CAFE.id), rotate(B.url, CAFE.id), rotate(B.url, CAFE.id)]);
    for (const r of results) assert.ok([200, 401, 403].includes(r.status), `claim race response: ${brief(r)}`);
    const tokens = results.filter((r) => r.status === 200).map((r) => r.json.editToken);
    assert.ok(tokens.length >= 1, 'at least one claim succeeds');
    let working = 0;
    for (const t of tokens) {
      const r = await putMd(B.url, CAFE.id, `race ${t.slice(-6)}`, tok(t));
      if (r.status === 200) working++;
      else assert.equal(r.status, 403, `a losing claim token is invalid: ${brief(r)}`);
    }
    assert.equal(working, 1, `exactly one of ${tokens.length} claimed token(s) works`);
    assert.equal((await putMd(B.url, CAFE.id, 'x')).status, 401, 'protected after the race');
  });
});
