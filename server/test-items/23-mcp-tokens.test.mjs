// Item #23 — MCP token plumbing: persistent token store, editToken on write tools, guidance on
// 401/403, shell commands, access on get_session.
// Spec: docs/build/specs/23-view-edit-links.md rule 11 (+ 00 §10.5).
//
// Real servers end to end: a paste backend (verify.sh's, or a throwaway one), the HTTP MCP server
// (server/mcp-server-http.js) spawned on a free port with MCP_TOKEN_STORE in a temp dir, and the
// MCP SDK client. "A new MCP connection" = a fresh initialize (new mcp-session-id); "after restart"
// = the MCP process is killed and spawned again on the same store. The repo's default store path
// (server/mcp-state/) is never written: every spawn sets MCP_TOKEN_STORE.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  sharedBackend, tmpDir, cleanupTmp, http, TOKEN_RE, MCP_GUIDANCE, uniq, tok, create, serverMarkdown, metaOf,
  startMcpHttp, mcpConnect, mcpStdio,
} from './23-helpers.mjs';

let B;
const procs = [];
before(async () => { B = await sharedBackend(); });
after(async () => {
  for (const p of procs) await p.stop();
  await B?.stop();
  cleanupTmp();
});

const storeFile = () => path.join(tmpDir('md-review-23-mcp'), 'state', 'edit-tokens.json');
async function mcpServer(storePath) {
  const m = await startMcpHttp({ apiUrl: B.url, storePath });
  procs.push(m);
  return m;
}
/** One call on a brand-new connection, then close it. */
async function once(m, name, args) {
  const c = await mcpConnect(m.url);
  try { return await c.call(name, args); } finally { await c.close(); }
}
const okResult = (r, what) => assert.ok(r && !r.error && !r.__toolError, `${what}: ${JSON.stringify(r)?.slice(0, 300)}`);
/** Precondition: the doc really is edit-protected (a token-less REST write is refused). */
async function assertProtected(id) {
  const r = await http(B.url, 'PUT', `/paste/${id}/markdown`, { body: { markdown: 'token-less probe' } });
  assert.equal(r.status, 401, `precondition: ${id} must be edit-protected (token-less PUT → ${r.status})`);
}
function protectedError(r, code, status, what) {
  assert.equal(r?.code, code, `${what}: code (got ${JSON.stringify(r)?.slice(0, 300)})`);
  assert.equal(r?.status, status, `${what}: status`);
  assert.ok(JSON.stringify(r).includes(MCP_GUIDANCE), `${what}: guidance message`);
}

describe('#23 rule 11 — create_session and the persistent token store', () => {
  let store, m, created;
  before(async () => {
    store = storeFile();
    m = await mcpServer(store);
    created = await once(m, 'create_session', { markdown: '# MCP doc\n\nv1\n', filename: 'mcp.md', sessionName: `MCP doc ${uniq()}` });
  });

  test('AC-23.12 (rule 11) create_session returns id, slug, editToken, url, app_url, editUrl; shareUrl = url', async () => {
    okResult(created, 'create_session');
    assert.ok(created.id && created.slug, 'id and slug kept');
    assert.match(String(created.editToken), TOKEN_RE, `editToken: ${JSON.stringify(created)}`);
    for (const k of ['url', 'app_url', 'editUrl']) assert.equal(typeof created[k], 'string', `${k}`);
    assert.equal(created.shareUrl, created.url, 'shareUrl = url');
    assert.ok(!created.url.includes(created.editToken), 'url carries no token');
    assert.equal(created.editUrl, `${created.app_url}?edit=${created.editToken}`);
    assert.ok(created.app_url.endsWith(`/d/${created.slug}`), created.app_url);
  });

  test('AC-23.12 (rule 11) the store file exists with mode 0600 and maps the id and the slug to the token', () => {
    assert.ok(fs.existsSync(store), `MCP_TOKEN_STORE ${store} was written`);
    assert.equal(fs.statSync(store).mode & 0o777, 0o600, `file mode ${(fs.statSync(store).mode & 0o777).toString(8)}`);
    const text = fs.readFileSync(store, 'utf-8');
    const parsed = JSON.parse(text);
    const flat = JSON.stringify(parsed);
    assert.ok(flat.includes(created.editToken), 'token stored');
    assert.ok(flat.includes(created.id), 'id stored');
    assert.ok(flat.includes(created.slug), 'slug stored');
  });

  test('AC-23.12 update_markdown without editToken on a NEW connection (same process) succeeds via the store', async () => {
    await assertProtected(created.id);
    const r = await once(m, 'update_markdown', { sessionId: created.id, markdown: '# MCP doc\n\nv2 new connection\n' });
    okResult(r, 'update_markdown on a new connection');
    assert.equal(await serverMarkdown(B.url, created.id), '# MCP doc\n\nv2 new connection\n');
    const bySlug = await once(m, 'update_markdown', { sessionId: created.slug, markdown: 'v3 by slug' });
    okResult(bySlug, 'update_markdown by slug');
    assert.equal(await serverMarkdown(B.url, created.id), 'v3 by slug');
  });

  test('AC-23.12 update_markdown without editToken AFTER an MCP restart (same store) succeeds', async () => {
    await assertProtected(created.id);
    await m.stop();
    const m2 = await mcpServer(store);
    const r = await once(m2, 'update_markdown', { sessionId: created.id, markdown: 'v4 after restart' });
    okResult(r, 'update_markdown after restart');
    assert.equal(await serverMarkdown(B.url, created.id), 'v4 after restart');
    m = m2;
  });

  test('AC-23.12 (rule 11) get_session exposes access', async () => {
    const r = await once(m, 'get_session', { sessionId: created.id, fields: 'meta' });
    okResult(r, 'get_session');
    assert.equal(typeof r.access, 'object', `access in get_session: ${JSON.stringify(r).slice(0, 300)}`);
    assert.equal(r.access.protected, true);
    assert.ok(!JSON.stringify(r).includes('edit_token_hash'), 'no hash in get_session');
  });

  test('AC-23.12 (rule 11) the stdio server shares the same store (MCP_TOKEN_STORE)', async () => {
    await assertProtected(created.id);
    const s = await mcpStdio({ apiUrl: B.url, storePath: store });
    try {
      okResult(await s.call('update_markdown', { sessionId: created.id, markdown: 'v6 via stdio' }), 'stdio update_markdown');
      assert.equal(await serverMarkdown(B.url, created.id), 'v6 via stdio');
      const c2 = await s.call('create_session', { markdown: '# stdio\n', filename: 's.md' });
      okResult(c2, 'stdio create_session');
      assert.match(String(c2.editToken), TOKEN_RE);
      assert.ok(fs.readFileSync(store, 'utf-8').includes(c2.editToken), 'stdio create saved its token to the store');
      assert.equal(fs.statSync(store).mode & 0o777, 0o600, 'still 0600 after a rewrite');
    } finally { await s.close(); }
  });
});

describe('#23 rule 11 — docs not in the store', () => {
  let store, m;
  before(async () => { store = storeFile(); m = await mcpServer(store); });

  test('AC-23.13 update_markdown on a protected doc not in the store, no editToken → edit_token_required + guidance', async () => {
    const d = await create(B.url, { markdown: 'rest-created' });
    assert.match(String(d.editToken), TOKEN_RE, 'REST create returns a token');
    const r = await once(m, 'update_markdown', { sessionId: d.id, markdown: 'should not land' });
    protectedError(r, 'edit_token_required', 401, 'update_markdown without token');
    assert.equal(await serverMarkdown(B.url, d.id), 'rest-created');
  });

  test('AC-23.13 (rule 11) every write tool refuses without a token (401 + guidance), then accepts editToken', async () => {
    const d = await create(B.url, { markdown: '# T\nBody\n', sessionName: `Tools ${uniq()}` });
    const seed = await http(B.url, 'POST', `/paste/${d.id}/files`, { body: { name: 'keep.txt', content: 'k' }, headers: tok(d.editToken) });
    assert.equal(seed.status, 201, 'setup file');
    const c = await mcpConnect(m.url);
    try {
      const tools = await c.tools();
      const calls = [
        ['update_markdown', { sessionId: d.id, markdown: '# T\nBody\n' }],
        ['patch_markdown', { sessionId: d.id, patch: '@@ -2 +2 @@\n-Body\n+Body\n' }],
        ['update_session_meta', { sessionId: d.id, sessionName: 'Renamed by tool' }],
        ['add_file', { sessionId: d.id, name: 'tool.txt', content: 'from tool' }],
        ['remove_file', { sessionId: d.id, name: 'keep.txt' }],
        ['upload_chunk', { sessionId: d.id, markdown: '# T\nBody\n', filename: 'doc.md' }],
        ['delete_session', { sessionId: d.id }],
      ].filter(([name]) => tools.includes(name));
      assert.ok(calls.length >= 6, `write tools registered: ${tools.join(', ')}`);
      const nameBefore = (await metaOf(B.url, d.id)).sessionName;
      for (const [name, args] of calls) {
        protectedError(await c.call(name, args), 'edit_token_required', 401, `${name} without editToken`);
        protectedError(await c.call(name, { ...args, editToken: 'mre_wrong' }), 'edit_token_invalid', 403, `${name} with a wrong editToken`);
      }
      // Nothing the refused calls asked for happened.
      assert.equal((await metaOf(B.url, d.id)).sessionName, nameBefore, 'sessionName unchanged');
      assert.equal(await serverMarkdown(B.url, d.id), '# T\nBody\n', 'markdown unchanged');
      const files = (await http(B.url, 'GET', `/paste/${d.id}/files`)).json.map((f) => f.name);
      assert.deepEqual(files, ['keep.txt'], 'files unchanged');
      for (const [name, args] of calls) {
        okResult(await c.call(name, { ...args, editToken: d.editToken }), `${name} with editToken`);
      }
      assert.equal((await http(B.url, 'GET', `/paste/${d.id}`)).status, 404, 'delete_session with editToken deleted the doc');
    } finally { await c.close(); }
  });

  test('AC-23.12 (rule 11) a successful call with an explicit editToken saves it: later calls need none', async () => {
    const d = await create(B.url, { markdown: 'explicit' });
    okResult(await once(m, 'update_markdown', { sessionId: d.id, markdown: 'explicit v2', editToken: d.editToken }), 'explicit token');
    assert.ok(fs.readFileSync(store, 'utf-8').includes(d.editToken), 'explicit token saved to the store');
    okResult(await once(m, 'update_markdown', { sessionId: d.id, markdown: 'explicit v3' }), 'store token on a new connection');
    assert.equal(await serverMarkdown(B.url, d.id), 'explicit v3');
  });

  test('AC-23.12 (rule 11) precedence: the editToken argument wins over the store', async () => {
    const created = await once(m, 'create_session', { markdown: 'prec', filename: 'p.md' });
    okResult(created, 'create_session');
    const r = await once(m, 'update_markdown', { sessionId: created.id, markdown: 'nope', editToken: 'mre_not_the_stored_one' });
    protectedError(r, 'edit_token_invalid', 403, 'wrong explicit token despite a stored one');
    assert.equal(await serverMarkdown(B.url, created.id), 'prec');
    okResult(await once(m, 'update_markdown', { sessionId: created.id, markdown: 'stored still works' }), 'store intact after a failed explicit token');
  });

  test('AC-23.12 (rule 11) large update_markdown (>1 MB, chunked upload) uses the stored token', async () => {
    const created = await once(m, 'create_session', { markdown: 'small', filename: 'big.md' });
    okResult(created, 'create_session');
    await assertProtected(created.id);
    const big = `# Big\n\n${'lorem ipsum dolor sit amet '.repeat(45000)}\n`;
    assert.ok(big.length > 1024 * 1024);
    okResult(await once(m, 'update_markdown', { sessionId: created.id, markdown: big }), 'chunked update with stored token');
    assert.equal((await serverMarkdown(B.url, created.id)).length, big.length);
  });

  test('AC-23.12 (rule 11) upsert_session (#21) saves and reuses the token across connections', async (t) => {
    const c = await mcpConnect(m.url);
    const has = (await c.tools()).includes('upsert_session');
    await c.close();
    if (!has) { t.skip('#21 upsert_session not registered yet'); return; }
    const key = `t23:${uniq()}`;
    const a = await once(m, 'upsert_session', { key, markdown: 'u1' });
    okResult(a, 'upsert create');
    assert.match(String(a.editToken), TOKEN_RE);
    for (const k of ['url', 'app_url', 'editUrl']) assert.equal(typeof a[k], 'string', k);
    const b = await once(m, 'upsert_session', { key, markdown: 'u2' });
    okResult(b, 'upsert update via store');
    assert.equal(b.created, false);
  });
});

describe('#23 rule 11 — shell-command tools', () => {
  let store, m, known;
  before(async () => {
    store = storeFile();
    m = await mcpServer(store);
    known = await once(m, 'create_session', { markdown: 'shell', filename: 'sh.md' });
  });

  test('AC-23.13 (rule 11) upload_via_shell / add_file_via_shell embed the stored token', async () => {
    okResult(known, 'create_session');
    for (const name of ['upload_via_shell', 'add_file_via_shell']) {
      const r = await once(m, name, { sessionId: known.id, filePath: '/tmp/some file.md' });
      assert.ok(r?.command, `${name} returns a command`);
      assert.ok(r.command.includes(`-H 'X-Edit-Token: ${known.editToken}'`), `${name} embeds the token: ${r.command}`);
    }
  });

  test('AC-23.13 (rule 11) unknown token → $MDREVIEW_EDIT_TOKEN in the command and said so in instruction', async () => {
    const d = await create(B.url, { markdown: 'not in store' });
    for (const name of ['upload_via_shell', 'add_file_via_shell']) {
      const r = await once(m, name, { sessionId: d.id, filePath: '/tmp/x.md' });
      assert.ok(r.command.includes('-H "X-Edit-Token: $MDREVIEW_EDIT_TOKEN"'), `${name}: ${r.command}`);
      assert.ok(String(r.instruction).includes('MDREVIEW_EDIT_TOKEN'), `${name} instruction: ${r.instruction}`);
      assert.ok(!r.command.includes(d.editToken));
    }
  });

  test('AC-23.13 (rule 11) create_via_shell tells the agent to keep editToken from the JSON output', async () => {
    const r = await once(m, 'create_via_shell', { filePath: '/tmp/new.md', sessionName: 'Shell create' });
    assert.ok(String(r.instruction).includes('editToken'), `instruction: ${r.instruction}`);
  });

  test('AC-23.12 (rule 11) the generated upload command actually works (jq + curl)', async (t) => {
    try { execFileSync('sh', ['-c', 'command -v jq && command -v curl'], { stdio: 'ignore' }); } catch { t.skip('jq/curl not installed'); return; }
    assert.match(String(known.editToken), TOKEN_RE, 'create_session returned a token');
    await assertProtected(known.id);
    const file = path.join(tmpDir('md-review-23-shell'), 'upload.md');
    fs.writeFileSync(file, '# Uploaded by shell\n');
    const r = await once(m, 'upload_via_shell', { sessionId: known.id, filePath: file });
    execFileSync('sh', ['-c', r.command], { stdio: 'pipe', timeout: 30000 });
    assert.equal(await serverMarkdown(B.url, known.id), '# Uploaded by shell\n');
    // The same command with the env-var form works when MDREVIEW_EDIT_TOKEN is exported.
    const d = await create(B.url, { markdown: 'env' });
    const r2 = await once(m, 'upload_via_shell', { sessionId: d.id, filePath: file });
    execFileSync('sh', ['-c', r2.command], { stdio: 'pipe', timeout: 30000, env: { ...process.env, MDREVIEW_EDIT_TOKEN: d.editToken } });
    assert.equal(await serverMarkdown(B.url, d.id), '# Uploaded by shell\n');
  });
});
