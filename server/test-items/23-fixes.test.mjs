// Item #23 — review-round fixes (server / MCP / CLI half).
//   - the MCP token store is keyed `${pasteApiUrl}|${idOrSlug}`, reads pre-scoping bare keys, and
//     concurrent MCP processes never lose each other's entries (lock + re-read before the rename);
//   - GET /paste/:id carries `Vary: Authorization, X-Edit-Token`; responses with a raw token are
//     `Cache-Control: no-store`;
//   - CLI help: MDREVIEW_EDIT_TOKEN before --token, --expiry lists 1/7/30/90/none (and they work);
//   - MCP shell commands use the configured PASTE_API_URL / PASTE_PUBLIC_URL, never a hard-coded host.
// Every MCP spawn sets MCP_TOKEN_STORE to a temp path.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  sharedBackend, tmpDir, cleanupTmp, http, TOKEN_RE, DAY, uniq, tok, create, metaOf, rotate, runCli,
  startMcpHttp, mcpConnect, mcpStdio, SERVER_DIR, brief,
} from './23-helpers.mjs';
import { createTokenStore } from '../mcp-token-store.js';

let B;
const procs = [];
before(async () => { B = await sharedBackend(); });
after(async () => {
  for (const p of procs) await p.stop();
  await B?.stop();
  cleanupTmp();
});

const storeFile = () => path.join(tmpDir('md-review-23-fixes'), 'state', 'edit-tokens.json');
const readStore = (f) => JSON.parse(fs.readFileSync(f, 'utf-8'));
const scope = () => B.url.replace(/\/+$/, '');

describe('#23 fix — MCP token store keys are scoped by the paste API URL', () => {
  test('create_session stores `${api}|${id}` and `${api}|${slug}`', async () => {
    const store = storeFile();
    const s = await mcpStdio({ apiUrl: `${B.url}/`, storePath: store });
    try {
      const c = await s.call('create_session', { markdown: '# scoped\n', filename: 's.md', sessionName: `Scoped ${uniq()}` });
      assert.match(String(c.editToken), TOKEN_RE, JSON.stringify(c));
      const map = readStore(store);
      assert.equal(map[`${scope()}|${c.id}`], c.editToken, `scoped id key: ${JSON.stringify(Object.keys(map))}`);
      assert.equal(map[`${scope()}|${c.slug}`], c.editToken, 'scoped slug key');
      assert.ok(!(c.id in map) && !(c.slug in map), 'no bare keys are written');
    } finally { await s.close(); }
  });

  test('a token stored for another API URL is not used for this one', () => {
    const file = storeFile();
    const a = createTokenStore(file, { scope: 'http://a.test:1/' });
    const b = createTokenStore(file, { scope: 'http://b.test:2' });
    a.save(['doc1', 'slug-1'], 'mre_A');
    assert.equal(a.get('doc1'), 'mre_A');
    assert.equal(a.get('slug-1'), 'mre_A');
    assert.equal(b.get('doc1'), null, 'scopes do not leak');
    assert.equal(readStore(file)['http://a.test:1|doc1'], 'mre_A', 'trailing slash normalised');
  });

  test('pre-scoping bare keys are read as a fallback and replaced by scoped keys on the next save', async () => {
    const d = await create(B.url, { markdown: 'legacy store entry' });
    const store = storeFile();
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ [d.id]: d.editToken }), { mode: 0o600 });
    const s = await mcpStdio({ apiUrl: B.url, storePath: store });
    try {
      const r = await s.call('update_markdown', { sessionId: d.id, markdown: 'via bare key' });
      assert.ok(r && !r.error && !r.__toolError, `update via the bare key: ${JSON.stringify(r)}`);
      const r2 = await s.call('update_markdown', { sessionId: d.id, markdown: 'explicit', editToken: d.editToken });
      assert.ok(r2 && !r2.error, JSON.stringify(r2));
      const map = readStore(store);
      assert.equal(map[`${scope()}|${d.id}`], d.editToken, 'migrated to the scoped key');
      assert.ok(!(d.id in map), 'bare key removed after the save');
    } finally { await s.close(); }
  });

  test('two processes saving at once lose no entries (lock + re-read before the rename)', async () => {
    const file = storeFile();
    const script = `
      import { createTokenStore } from ${JSON.stringify(path.join(SERVER_DIR, 'mcp-token-store.js'))};
      const [file, who, n] = process.argv.slice(1);
      const s = createTokenStore(file, { scope: 'http://race.test' });
      for (let i = 0; i < Number(n); i++) s.save([who + '-' + i], 'mre_' + who + '_' + i);
    `;
    const run = (who) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script, file, who, '60'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${who} exited ${code}: ${err}`))));
    });
    await Promise.all([run('a'), run('b'), run('c')]);
    const map = readStore(file);
    for (const who of ['a', 'b', 'c']) {
      for (let i = 0; i < 60; i++) assert.equal(map[`http://race.test|${who}-${i}`], `mre_${who}_${i}`, `entry ${who}-${i} kept`);
    }
    assert.ok(!fs.existsSync(`${file}.lock`), 'lock released');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'still 0600');
  });

  test('a stale lock (crashed writer) is broken', () => {
    const file = storeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, '');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(`${file}.lock`, old, old);
    const s = createTokenStore(file, { scope: 'http://stale.test' });
    s.save(['x'], 'mre_x');
    assert.equal(s.get('x'), 'mre_x');
  });
});

describe('#23 fix — cache headers', () => {
  test('GET /paste/:id (full, fields=meta, 304) varies on Authorization and X-Edit-Token', async () => {
    const d = await create(B.url, { markdown: 'vary' });
    for (const qs of ['', '?fields=meta']) {
      for (const h of [{}, tok(d.editToken), tok(d.editToken, 'bearer')]) {
        const r = await http(B.url, 'GET', `/paste/${d.id}${qs}`, { headers: h });
        assert.equal(r.status, 200);
        const vary = (r.headers.get('vary') || '').toLowerCase();
        assert.ok(vary.includes('authorization') && vary.includes('x-edit-token'), `Vary on GET${qs}: ${vary}`);
        const again = await http(B.url, 'GET', `/paste/${d.id}${qs}`, { headers: { ...h, 'If-None-Match': r.headers.get('etag') } });
        assert.equal(again.status, 304);
        assert.ok((again.headers.get('vary') || '').toLowerCase().includes('x-edit-token'), 'Vary on 304');
      }
    }
  });

  test('responses carrying a raw token are Cache-Control: no-store (create, rotate)', async () => {
    const c = await http(B.url, 'POST', '/paste', { body: { markdown: 'no-store' } });
    assert.equal(c.status, 200);
    assert.match(c.headers.get('cache-control') || '', /no-store/, 'create');
    const r = await rotate(B.url, c.json.id, tok(c.json.editToken));
    assert.equal(r.status, 200, brief(r));
    assert.match(r.headers.get('cache-control') || '', /no-store/, 'rotate');
  });
});

describe('#23 fix — CLI help and expiry', () => {
  test('help lists MDREVIEW_EDIT_TOKEN before --token and --expiry 1/7/30/90/none', async () => {
    const r = await runCli(['--help']);
    const text = r.stdout + r.stderr;
    const env = text.indexOf('MDREVIEW_EDIT_TOKEN');
    const flag = text.indexOf('--token');
    assert.ok(env >= 0 && flag >= 0 && env < flag, `MDREVIEW_EDIT_TOKEN (${env}) before --token (${flag})`);
    const expiryLine = text.split('\n').find((l) => l.includes('--expiry')) || '';
    for (const v of ['1', '7', '30', '90', 'none']) assert.match(expiryLine, new RegExp(`\\b${v}\\b`), `--expiry help lists ${v}: ${expiryLine}`);
  });

  test('create --expiry 1 / 90 / none apply', async () => {
    const dir = tmpDir('md-review-23-fixes-cli');
    const f = path.join(dir, 'e.md');
    fs.writeFileSync(f, '# expiry\n');
    const near = (iso, ms) => Math.abs(Date.parse(iso) - (Date.now() + ms)) < 60000;
    for (const [arg, ms] of [['1', DAY], ['90', 90 * DAY]]) {
      const r = await runCli(['create', f, '--expiry', arg, '--api', B.url]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(near((await metaOf(B.url, r.json.id)).expires_at, ms), `--expiry ${arg}`);
    }
    const n = await runCli(['create', f, '--expiry', 'none', '--api', B.url]);
    assert.equal(n.code, 0, n.stderr);
    assert.equal((await metaOf(B.url, n.json.id)).expires_at ?? null, null, '--expiry none = never');
  });
});

describe('#23 fix — MCP shell commands use the configured URL', () => {
  test('HTTP MCP without PASTE_PUBLIC_URL: commands target PASTE_API_URL, never 10.0.99.151', async () => {
    const m = await startMcpHttp({ apiUrl: B.url, storePath: storeFile(), env: { PASTE_PUBLIC_URL: '' } });
    procs.push(m);
    const c = await mcpConnect(m.url);
    try {
      const d = await create(B.url, { markdown: 'shell' });
      for (const [name, args] of [
        ['upload_via_shell', { sessionId: d.id, filePath: '/tmp/x.md' }],
        ['add_file_via_shell', { sessionId: d.id, filePath: '/tmp/x.md' }],
        ['create_via_shell', { filePath: '/tmp/x.md' }],
      ]) {
        const r = await c.call(name, args);
        assert.ok(r?.command, `${name}: ${JSON.stringify(r)}`);
        assert.ok(!r.command.includes('10.0.99.151'), `${name} has no hard-coded host: ${r.command}`);
        assert.ok(r.command.includes(`${B.url}/paste`), `${name} uses PASTE_API_URL: ${r.command}`);
      }
    } finally { await c.close(); }
  });

  test('PASTE_PUBLIC_URL wins for shell commands (HTTP and stdio)', async () => {
    const pub = 'https://paste.public.test';
    const m = await startMcpHttp({ apiUrl: B.url, storePath: storeFile(), env: { PASTE_PUBLIC_URL: pub } });
    procs.push(m);
    const c = await mcpConnect(m.url);
    try {
      const r = await c.call('create_via_shell', { filePath: '/tmp/x.md' });
      assert.ok(r.command.includes(`${pub}/paste`), r.command);
    } finally { await c.close(); }
    const s = await mcpStdio({ apiUrl: B.url, storePath: storeFile(), env: { PASTE_PUBLIC_URL: pub } });
    try {
      const r = await s.call('create_via_shell', { filePath: '/tmp/x.md' });
      assert.ok(r.command.includes(`${pub}/paste`), `stdio: ${r.command}`);
      const r2 = await s.call('create_via_shell', { filePath: '/tmp/x.md' });
      assert.ok(!r2.command.includes('10.0.99.151'));
    } finally { await s.close(); }
  });
});
