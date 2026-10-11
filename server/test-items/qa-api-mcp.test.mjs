// Persona-QA fixes (agent persona, area: api) — MCP side, against the real
// stdio/HTTP MCP servers and a real backend. One test per finding; each one
// failed before the fix. Findings: docs/build/reports/fix-api.md.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  sharedBackend, tmpDir, cleanupTmp, http, create, serverMarkdown, metaOf, uniq,
  startMcpHttp, mcpConnect, mcpStdio, MCP_HTTP_FILE, MCP_STDIO_FILE, SERVER_DIR,
} from './23-helpers.mjs';

let B; let m; let c; let s;
const storeDir = () => tmpDir('md-review-qa-api-store');

before(async () => {
  B = await sharedBackend();
  m = await startMcpHttp({ apiUrl: B.url, storePath: path.join(storeDir(), 'tokens.json') });
  c = await mcpConnect(m.url);
  s = await mcpStdio({ apiUrl: B.url, storePath: path.join(storeDir(), 'tokens.json') });
});
after(async () => {
  await c?.close(); await s?.close(); await m?.stop(); await B?.stop();
  cleanupTmp();
});

/** Raw tool call: { isError, json } (the SDK result as the client sees it). */
async function raw(client, name, args) {
  const r = await client.client.callTool({ name, arguments: args });
  const text = r.content?.find((x) => x.type === 'text')?.text;
  let json; try { json = JSON.parse(text); } catch { json = { __text: text }; }
  return { isError: r.isError === true, json };
}
const big = (n, fill = 'x') => `# Big\n\n${fill.repeat(n)}\nDone.\n`;
const contentHash = async (x) => (await http(B.url, 'GET', `/paste/${x}/revisions`)).json.current;

describe('agent #1 — backend errors are isError results with actionable messages', () => {
  test('401 / 403 / 404 (doc, comment, reply, file, revision) / 409 / 412 all set isError (HTTP and stdio)', async () => {
    const d = await create(B.url, { markdown: '# E\n\nline\n' });
    for (const client of [c, s]) {
      const r401 = await raw(client, 'update_markdown', { sessionId: d.id, markdown: 'x' });
      assert.equal(r401.isError, true, JSON.stringify(r401));
      assert.equal(r401.json.code, 'edit_token_required');
      const r403 = await raw(client, 'update_markdown', { sessionId: d.id, markdown: 'x', editToken: 'mre_wrong' });
      assert.equal(r403.isError, true);
      assert.match(r403.json.error, /does not match this document/, 'a wrong token gets its own message');
      const nf = await raw(client, 'get_session', { sessionId: `nope-${uniq()}` });
      assert.equal(nf.isError, true);
      assert.match(nf.json.error, /^Session not found: .*list_sessions/);
      const cm = await raw(client, 'edit_comment', { sessionId: d.id, commentId: 'nope', body: 'x' });
      assert.equal(cm.isError, true);
      assert.match(cm.json.error, /^Comment not found: .*list_comments/);
      const fl = await raw(client, 'get_file', { sessionId: d.id, name: 'missing.txt' });
      assert.equal(fl.isError, true);
      assert.match(fl.json.error, /^File not found: .*list_files/);
      for (const hash of ['ffffffffffffffffffffffffffffffff', 'abc']) {
        const rv = await raw(client, 'get_revision', { sessionId: d.id, hash });
        assert.equal(rv.isError, true);
        assert.match(rv.json.error, /^Revision not found: .*list_revisions/, `hash ${hash}: ${rv.json.error}`);
      }
      const p409 = await raw(client, 'patch_markdown', { sessionId: d.id, editToken: d.editToken, patch: '@@ -1 +1 @@\n-not there\n+y\n' });
      assert.equal(p409.isError, true);
      assert.equal(p409.json.status, 409);
      assert.match(p409.json.hint, /Re-read/);
      const p412 = await raw(client, 'update_markdown', { sessionId: d.id, editToken: d.editToken, markdown: 'y', expectedContentHash: '0'.repeat(32) });
      assert.equal(p412.isError, true);
      assert.equal(p412.json.status, 412);
      assert.match(p412.json.content_hash, /^[0-9a-f]{32}$/);
      const ok = await raw(client, 'get_session', { sessionId: d.id, fields: 'meta' });
      assert.equal(ok.isError, false, 'a success is not an error');
    }
    // A reply that does not exist is a reply error, not "Session not found".
    const withC = await create(B.url, { markdown: '# R\n\nline\n', mode: 'review' });
    const cmt = await c.call('add_comment', { sessionId: withC.id, startLine: 2, endLine: 3, selectedText: 'line', body: 'b', category: 'nit' });
    const rp = await raw(c, 'edit_reply', { sessionId: withC.id, commentId: cmt.id, replyId: 'nope', body: 'x' });
    assert.equal(rp.isError, true);
    assert.match(rp.json.error, /^Reply not found/);
  });
});

describe('agent #2 — the chunked (>1 MB) write path honours expectedContentHash and returns the normal result', () => {
  test('stale hash → 412 isError and nothing written; right hash → ok with content_hash, byte size, author agent', async () => {
    const d = await c.call('create_session', { markdown: '# Start\n', filename: 'big.md' });
    const before = await contentHash(d.id);
    const content = big(1_300_000);
    const stale = await raw(c, 'update_markdown', { sessionId: d.id, markdown: content, expectedContentHash: '0000' });
    assert.equal(stale.isError, true, JSON.stringify(stale.json).slice(0, 200));
    assert.equal(stale.json.status, 412);
    assert.equal(await serverMarkdown(B.url, d.id), '# Start\n', 'nothing was overwritten');

    const okr = await c.call('update_markdown', { sessionId: d.id, markdown: content, expectedContentHash: before });
    assert.ok(okr.ok && !okr.error, JSON.stringify(okr).slice(0, 200));
    assert.equal(okr.content_hash, await contentHash(d.id), 'content_hash chains the next guarded write');
    assert.equal(okr.size, Buffer.byteLength(content), 'size is in bytes');
    const revs = (await http(B.url, 'GET', `/paste/${d.id}/revisions`)).json.revisions;
    assert.equal(revs.at(-1).by, 'agent');
    assert.equal((await metaOf(B.url, d.id)).filename, 'big.md', 'filename unchanged when not given');
    // Chain: the returned hash guards the next large write.
    const again = await c.call('update_markdown', { sessionId: d.id, markdown: `${content}more\n`, expectedContentHash: okr.content_hash });
    assert.ok(again.ok, JSON.stringify(again).slice(0, 200));
  });

  test('multi-byte characters across chunk boundaries arrive byte-identical', async () => {
    const d = await c.call('create_session', { markdown: '# U\n' });
    // 512 Ki UTF-16 units per chunk: put an emoji (surrogate pair) on the boundary.
    const head = 'a'.repeat(512 * 1024 - 1);
    const content = `${head}😀${'é漢😀'.repeat(200_000)}\n`;
    const r = await c.call('update_markdown', { sessionId: d.id, markdown: content });
    assert.ok(r.ok, JSON.stringify(r).slice(0, 200));
    const back = await http(B.url, 'GET', `/d/${d.id}.md`);
    assert.equal(back.buf.equals(Buffer.from(content, 'utf-8')), true, 'raw .md is byte-identical');
  });
});

describe('agent #3 — get_file returns binary files as base64 (round trip)', () => {
  test('a PNG-like binary and a >1 MB base64 file (chunked) round-trip exactly; text stays text', async () => {
    const d = await c.call('create_session', { markdown: '# F\n' });
    const bin = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]), crypto.randomBytes(2048)]);
    const add = await c.call('add_file', { sessionId: d.id, name: 'chart.png', content: bin.toString('base64'), encoding: 'base64' });
    assert.ok(!add.error, JSON.stringify(add));
    const got = await c.call('get_file', { sessionId: d.id, name: 'chart.png' });
    assert.equal(got.encoding, 'base64');
    assert.equal(got.mime, 'image/png');
    assert.equal(Buffer.from(got.content, 'base64').equals(bin), true);

    const large = crypto.randomBytes(1_200_000);
    const addL = await c.call('add_file', { sessionId: d.id, name: 'blob.bin', content: large.toString('base64'), encoding: 'base64' });
    assert.ok(!addL.error, JSON.stringify(addL));
    const rest = await http(B.url, 'GET', `/paste/${d.id}/files/blob.bin`);
    assert.equal(rest.buf.equals(large), true, 'chunked base64 upload stores the decoded bytes');
    const gotL = await c.call('get_file', { sessionId: d.id, name: 'blob.bin' });
    assert.equal(Buffer.from(gotL.content, 'base64').equals(large), true);

    await c.call('add_file', { sessionId: d.id, name: 'notes.txt', content: 'héllo\n' });
    const t = await c.call('get_file', { sessionId: d.id, name: 'notes.txt' });
    assert.deepEqual([t.encoding, t.content], ['utf-8', 'héllo\n']);
  });
});

describe('agent #4 / #18 — shell commands', () => {
  test('add_file_via_shell base64 works for a 3 MB file; a refused write exits non-zero', async (t) => {
    try { execFileSync('sh', ['-c', 'command -v jq && command -v curl && command -v base64'], { stdio: 'ignore' }); } catch { t.skip('jq/curl/base64 missing'); return; }
    const d = await c.call('create_session', { markdown: '# S\n' });
    const dir = tmpDir('md-review-qa-api-shell');
    const file = path.join(dir, "blob '1'.bin");
    const bytes = crypto.randomBytes(3 * 1024 * 1024);
    fs.writeFileSync(file, bytes);
    const r = await c.call('add_file_via_shell', { sessionId: d.id, filePath: file, encoding: 'base64' });
    const out = execFileSync('sh', ['-c', r.command], { encoding: 'utf-8', timeout: 60000, maxBuffer: 1 << 20 });
    assert.equal(JSON.parse(out).size, bytes.length, out.slice(0, 200));
    assert.equal((await http(B.url, 'GET', `/paste/${d.id}/files/${encodeURIComponent("blob '1'.bin")}`)).buf.equals(bytes), true);

    const other = await create(B.url, { markdown: 'protected' });
    const r2 = await c.call('add_file_via_shell', { sessionId: other.id, filePath: file, encoding: 'base64' });
    const run = spawnSync('sh', ['-c', r2.command], { encoding: 'utf-8', timeout: 60000, env: { ...process.env, MDREVIEW_EDIT_TOKEN: 'mre_wrong' } });
    assert.notEqual(run.status, 0, 'an HTTP error makes the command fail');
    assert.match(run.stdout, /edit_token_invalid/, 'and it prints the error body');
  });

  test('upload_via_shell keeps the display filename unless filename is given', async (t) => {
    try { execFileSync('sh', ['-c', 'command -v jq && command -v curl'], { stdio: 'ignore' }); } catch { t.skip('jq/curl missing'); return; }
    const d = await c.call('create_session', { markdown: '# Keep\n', filename: 'report.md' });
    const file = path.join(tmpDir('md-review-qa-api-up'), 'tmp-1234.md');
    fs.writeFileSync(file, '# New body\n');
    execFileSync('sh', ['-c', (await c.call('upload_via_shell', { sessionId: d.id, filePath: file })).command], { stdio: 'pipe' });
    assert.equal((await metaOf(B.url, d.id)).filename, 'report.md');
    assert.equal(await serverMarkdown(B.url, d.id), '# New body\n');
    execFileSync('sh', ['-c', (await c.call('upload_via_shell', { sessionId: d.id, filePath: file, filename: "it's.md" })).command], { stdio: 'pipe' });
    assert.equal((await metaOf(B.url, d.id)).filename, "it's.md");
  });
});

describe('agent #5 — a renamed slug keeps working', () => {
  test('old slug: /paste, /d/<old> meta page (canonical = new), /d/<old>.md, MCP get_session; others cannot take it', async () => {
    const old = `pr-review-${uniq()}`;
    const d = await c.call('create_session', { markdown: '# Old link\n\nBody.\n', slug: old });
    const ren = await c.call('update_session_meta', { sessionId: d.id, slug: `${old}-r2` });
    assert.equal(ren.slug, `${old}-r2`);
    assert.equal((await http(B.url, 'GET', `/paste/${old}?fields=meta`)).json.slug, `${old}-r2`);
    const page = await http(B.url, 'GET', `/d/${old}`, { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0' } });
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`<link rel="canonical" href="[^"]*/d/${old}-r2">`));
    assert.equal((await http(B.url, 'GET', `/d/${old}.md`)).text, '# Old link\n\nBody.\n');
    const g = await c.call('get_session', { sessionId: old, fields: 'meta' });
    assert.equal(g.id, d.id);
    const other = await create(B.url, { slug: old });
    assert.notEqual(other.slug, old, 'an alias is not handed to another doc');
    // The doc can take its old slug back.
    assert.equal((await c.call('update_session_meta', { sessionId: d.id, slug: old })).slug, old);
  });
});

describe('agent #6 / #16 — comments on publish docs and comment anchors', () => {
  test('publish doc: stored, but the result says visible:false with a warning; review doc: no warning', async () => {
    const pub = await c.call('create_session', { markdown: '# P\n\nText here.\n', mode: 'publish' });
    const r = await raw(c, 'add_comment', { sessionId: pub.id, startLine: 2, endLine: 3, selectedText: 'Text here.', body: 'b', category: 'nit' });
    assert.equal(r.isError, false);
    assert.equal(r.json.visible, false);
    assert.match(r.json.warning, /publish mode/);
    assert.equal((await c.call('list_comments', { sessionId: pub.id })).comments.length, 1, 'stored');
    const rest = await http(B.url, 'POST', `/paste/${pub.id}/comments`, { body: { startLine: 2, endLine: 3, selectedText: 'Text here.', body: 'b', category: 'nit' } });
    assert.match(rest.headers.get('x-mdreview-warning') || '', /publish mode/, 'REST carries the warning header');
    const rev = await c.call('create_session', { markdown: '# R\n\nText here.\n', mode: 'review' });
    const r2 = await c.call('add_comment', { sessionId: rev.id, startLine: 2, endLine: 3, selectedText: 'Text here.', body: 'b', category: 'nit' });
    assert.equal(r2.warning, undefined);
    assert.equal(r2.visible, undefined);
  });

  test('lines outside the doc are refused (isError); a quote not in the doc is accepted with a warning', async () => {
    const d = await c.call('create_session', { markdown: Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n'), mode: 'review' });
    const bad = await raw(c, 'add_comment', { sessionId: d.id, startLine: 99, endLine: 120, selectedText: 'line 1', body: 'b', category: 'nit' });
    assert.equal(bad.isError, true);
    assert.match(bad.json.error, /outside the document: it has 9 line/);
    const q = await c.call('add_comment', { sessionId: d.id, startLine: 1, endLine: 2, selectedText: 'this text is not in the doc', body: 'b', category: 'nit' });
    assert.ok(q.id);
    assert.match(q.warning, /does not occur/);
    // The UI is never refused (its editor may hold unsaved lines).
    const ui = await http(B.url, 'POST', `/paste/${d.id}/comments`, { headers: { 'X-MdReview-Client': 'ui' }, body: { startLine: 50, endLine: 51, selectedText: 'x', body: 'b', category: 'nit' } });
    assert.equal(ui.status, 201);
  });
});

describe('agent #7 — approval resets when the content changes', () => {
  test('approve → content change → pending (+approval_reset_at); comment-only writes keep it; approved_revision tracks the content', async () => {
    const d = await c.call('create_session', { markdown: '# A\n\nv1\n', mode: 'review' });
    const ap = await http(B.url, 'PUT', `/paste/${d.id}/approval`, { body: { status: 'approved', approved_by: 'Priya' } });
    assert.equal(ap.status, 200);
    let st = await c.call('get_approval_status', { sessionId: d.id });
    assert.equal(st.approval_status, 'approved');
    assert.equal(st.approved_revision, await contentHash(d.id));
    await c.call('add_comment', { sessionId: d.id, startLine: 0, endLine: 1, selectedText: 'A', body: 'later', category: 'nit' });
    assert.equal((await c.call('get_approval_status', { sessionId: d.id })).approval_status, 'approved', 'a comment does not reset');
    await c.call('patch_markdown', { sessionId: d.id, patch: '@@ -3 +3 @@\n-v1\n+v2\n' });
    st = await c.call('get_approval_status', { sessionId: d.id });
    assert.equal(st.approval_status, 'pending');
    assert.equal(st.approved_by, null);
    assert.match(st.approval_reset_at, /^\d{4}-/);
    assert.equal(st.approved_revision, undefined);
  });
});

describe('agent #8 — upsert_session takes mode', () => {
  test('mode: review on create; a later run with another mode warns and keeps the doc mode', async () => {
    const key = `qa:review-${uniq()}`;
    const r = await c.call('upsert_session', { key, markdown: '# R1\n', mode: 'review' });
    assert.equal(r.created, true);
    assert.equal(r.mode, 'review');
    assert.equal((await metaOf(B.url, r.id)).mode, 'review');
    const r2 = await c.call('upsert_session', { key, markdown: '# R2\n', mode: 'publish' });
    assert.equal(r2.mode, 'review');
    assert.match(r2.warning, /only when the doc is created/);
  });
});

describe('agent #9 / #10 / #12 — identifiers and tokens', () => {
  test('a token given with the slug is remembered for the id too', async () => {
    const d = await create(B.url, { markdown: '# T\n', slug: `tok-${uniq()}` });
    const w = await c.call('update_markdown', { sessionId: d.slug, markdown: '# T2\n', editToken: d.editToken });
    assert.ok(w.ok, JSON.stringify(w));
    const byId = await c.call('update_markdown', { sessionId: d.id, markdown: '# T3\n' });
    assert.ok(byId.ok, `by id without a token: ${JSON.stringify(byId)}`);
    const v = await c.call('get_views', { sessionId: d.id });
    assert.ok(Array.isArray(v.readers), 'named readers with the remembered token');
  });

  test('get_views without a token says why readers are missing', async () => {
    const d = await create(B.url, { markdown: '# V\n' });
    const v = await c.call('get_views', { sessionId: d.id });
    assert.equal(v.readers, undefined);
    assert.match(v.note, /edit token/);
  });

  test('sessionId takes an upsert key; an invalid one is refused with guidance', async () => {
    const key = `qa:key-${uniq()}`;
    const u = await c.call('upsert_session', { key, markdown: '# K\n', changeNote: 'run 1' });
    const revs = await c.call('list_revisions', { sessionId: key });
    assert.equal(revs.revisions.at(-1).note, 'run 1');
    assert.equal((await c.call('get_session', { sessionId: key, fields: 'meta' })).id, u.id);
    const bad = await raw(c, 'get_session', { sessionId: 'a/b?c' });
    assert.equal(bad.isError, true);
    assert.match(bad.json.error, /Invalid sessionId/);
    const nf = await raw(c, 'list_revisions', { sessionId: `qa:missing-${uniq()}` });
    assert.equal(nf.isError, true);
    assert.match(nf.json.error, /no document has the upsert key/);
  });
});

describe('agent #14 / #20 / #21 — result shapes', () => {
  test('create_session always returns url, viewUrl, app_url and mode; list_sessions items carry url and upsert_key', async () => {
    const d = await c.call('create_session', { markdown: '# Shape\n', sessionName: `Shape ${uniq()}` });
    for (const k of ['id', 'slug', 'mode', 'url', 'viewUrl', 'shareUrl', 'app_url', 'editToken', 'editUrl']) assert.ok(d[k], `create has ${k}`);
    const key = `qa:list-${uniq()}`;
    const u = await c.call('upsert_session', { key, markdown: '# L\n', sessionName: `Listed ${uniq()}` });
    for (const k of ['id', 'slug', 'mode', 'url', 'viewUrl', 'app_url', 'editToken', 'editUrl']) assert.ok(u[k], `upsert create has ${k}`);
    const list = await c.call('list_sessions', {});
    const item = list.find((x) => x.id === u.id);
    assert.ok(item.url.endsWith(`/d/${u.slug}`), item.url);
    assert.equal(item.upsert_key, key);
    assert.ok(list.find((x) => x.id === d.id).url);
  });

  test('HTTP create_session with filePath points at create_via_shell', async () => {
    const r = await raw(c, 'create_session', { filePath: '/tmp/x.md' });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.json), /create_via_shell/);
  });

  test('get_reactions adds the emoji → code map', async () => {
    const d = await create(B.url);
    await http(B.url, 'POST', `/paste/${d.id}/reactions`, { body: { code: '+1', reader_id: `r${crypto.randomBytes(8).toString('hex')}`, name: 'Ana' } });
    const r = await c.call('get_reactions', { sessionId: d.id });
    assert.deepEqual(r.doc, { '👍': { count: 1, names: ['Ana'] } });
    assert.equal(r.codes['👍'], '+1');
  });
});

describe('agent #17 — MCP_TOKEN_STORE', () => {
  test('a directory is used as <dir>/edit-tokens.json', async () => {
    const dir = storeDir();
    const mm = await startMcpHttp({ apiUrl: B.url, storePath: dir });
    try {
      const cc = await mcpConnect(mm.url);
      const d = await cc.call('create_session', { markdown: '# Dir store\n' });
      await cc.close();
      const store = JSON.parse(fs.readFileSync(path.join(dir, 'edit-tokens.json'), 'utf-8'));
      assert.ok(Object.values(store).includes(d.editToken));
    } finally { await mm.stop(); }
  });

  test('a corrupt store file is copied aside before it is replaced', async () => {
    const dir = storeDir();
    const file = path.join(dir, 'tokens.json');
    fs.writeFileSync(file, '{not json');
    const ss = await mcpStdio({ apiUrl: B.url, storePath: file });
    try { await ss.call('create_session', { markdown: '# Corrupt store\n' }); } finally { await ss.close(); }
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('tokens.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf-8'), '{not json');
    JSON.parse(fs.readFileSync(file, 'utf-8'));
  });

  test('an unusable store stops the server at startup with a clear message (HTTP and stdio)', () => {
    const blocker = path.join(storeDir(), 'a-file');
    fs.writeFileSync(blocker, 'x');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, PASTE_API_URL: B.url, MCP_PORT: '0', MCP_TOKEN_STORE: path.join(blocker, 'sub', 'tokens.json') };
    for (const file of [MCP_HTTP_FILE, MCP_STDIO_FILE]) {
      const r = spawnSync(process.execPath, [file], { cwd: SERVER_DIR, env, encoding: 'utf-8', timeout: 15000, input: '' });
      assert.notEqual(r.status, 0, `${path.basename(file)} refused to start`);
      assert.match(r.stderr, /edit-token store .* is not usable/, r.stderr);
    }
  });
});

describe('agent #11 — REST unknown revision', () => {
  test('a malformed or unknown hash is a JSON 404 "unknown revision"', async () => {
    const d = await create(B.url);
    for (const h of ['abc', 'f'.repeat(32)]) {
      const r = await http(B.url, 'GET', `/paste/${d.id}/revisions/${h}`);
      assert.equal(r.status, 404);
      assert.equal(r.json?.error, 'unknown revision');
    }
  });
});

