// Item #22 — review-fix round (not frozen): pathological documents, the one
// link rule (`url` from the backend, preferred by MCP + CLI), unparseable /d/
// paths, If-None-Match: *, pinned-revision pages, description/title quality
// and the cover text rules. Helpers + gating: 22-helpers.mjs. Boots its own
// backends (some need specific env).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  SKIP, startServer, cleanupTmp, request, createDoc, putMarkdown, getMeta, one, refreshTarget, scriptNavigations,
  pathOf, readPng, md5, tmpDir, UA, uniq, SERVER_DIR, MCP_SERVER_FILE,
} from './22-helpers.mjs';

const FRONT = 'https://fe.example.com/app';
// #23: spawned MCP/CLI processes keep their edit-token store where verify.sh puts it, never in the repo.
const mcpStoreEnv = process.env.MCP_TOKEN_STORE ? { MCP_TOKEN_STORE: process.env.MCP_TOKEN_STORE } : {};

async function mcpCall(env, tool, args) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [MCP_SERVER_FILE],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...mcpStoreEnv, ...env }, stderr: 'pipe',
  });
  const client = new Client({ name: 'md-review-test-22-fixes', version: '1.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: tool, arguments: args });
    return JSON.parse(res.content.find((c) => c.type === 'text').text);
  } finally { await client.close(); }
}

function cliCreate(env, args) {
  const r = spawnSync(process.execPath, [path.join(SERVER_DIR, 'cli.mjs'), 'create', ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...mcpStoreEnv, ...env }, encoding: 'utf-8', timeout: 30000,
  });
  assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

describe('#22 fixes (default env)', { skip: SKIP }, () => {
  let B;
  before(async () => { B = await startServer({ env: { FRONTEND_URL: FRONT } }); });
  after(async () => { await B?.stop(); cleanupTmp(); });

  // Only shapes whose #20 write path (search indexing on POST) is itself fast;
  // the other pathological shapes are covered at unit level (test-meta-units.mjs).
  test('pathological 600 KB HTML / markdown docs: meta page and cover answer quickly', async () => {
    for (const [ct, src] of [['html', '<p>'.repeat(200000)], ['markdown', '[a'.repeat(300000)], ['markdown', '<!--'.repeat(150000)],
      ['markdown', '**a'.repeat(200000)]]) {
      const d = await createDoc(B.url, { filename: `p.${ct === 'html' ? 'html' : 'md'}`, contentType: ct, markdown: src });
      const t0 = Date.now();
      const r = await getMeta(B.url, `/d/${d.x}`, UA.slack);
      const ms = Date.now() - t0;
      assert.equal(r.status, 200);
      assert.ok(ms < 1000, `${JSON.stringify(src.slice(0, 20))}: meta page took ${ms} ms`);
      const c = await request(B.url, 'GET', pathOf(one(r.doc, 'og:image')));
      assert.equal(c.status, 200);
    }
  });

  test('POST /paste and GET /paste/:id return the canonical `url` (FRONTEND_URL/d/<slug|id> while PUBLIC_BASE_URL is unset)', async () => {
    const r = await request(B.url, 'POST', '/paste', { body: { sessionName: `Url field ${uniq()}`, markdown: 'x' } });
    assert.equal(r.json.url, `${FRONT}/d/${r.json.slug}`);
    const g = await request(B.url, 'GET', `/paste/${r.json.id}`);
    assert.equal(g.json.url, `${FRONT}/d/${r.json.slug}`);
    assert.equal((await request(B.url, 'GET', `/paste/${r.json.id}?fields=meta`)).json.url, `${FRONT}/d/${r.json.slug}`);
    assert.equal((await request(B.url, 'GET', `/paste/${r.json.id}?fields=content`)).json.url, undefined);
    const n = await request(B.url, 'POST', '/paste', { body: { markdown: 'no slug' } });
    assert.equal(n.json.url, `${FRONT}/d/${n.json.id}`);
  });

  test('MCP create_session / get_session prefer the backend `url` over their own env', async () => {
    const env = { PASTE_API_URL: B.url, FRONTEND_URL: 'https://mcp-env.example.com' };
    const c = await mcpCall(env, 'create_session', { markdown: '# M', filename: 'm.md', sessionName: `MCP url ${uniq()}` });
    assert.equal(c.shareUrl, `${FRONT}/d/${c.slug}`);
    const g = await mcpCall(env, 'get_session', { sessionId: c.id });
    assert.equal(g.shareUrl, `${FRONT}/d/${c.slug}`);
  });

  test('CLI create: the backend `url` by default; explicit local config (--frontend, or FRONTEND_URL/PUBLIC_BASE_URL set for the CLI) wins', async () => {
    const dir = tmpDir('md-review-22-cli');
    const file = path.join(dir, 'c.md');
    fs.writeFileSync(file, '# CLI\n\nBody.');
    const a = cliCreate({ PASTE_API_URL: B.url, FRONTEND_URL: '', PUBLIC_BASE_URL: '' }, [file, '--name', `CLI ${uniq()}`]);
    assert.equal(a.url, `${FRONT}/d/${a.slug}`);
    const e = cliCreate({ PASTE_API_URL: B.url, FRONTEND_URL: 'https://cli-env.example.com' }, [file, '--name', `CLI ${uniq()}`]);
    assert.equal(e.url, `https://cli-env.example.com/d/${e.slug}`);
    const b = cliCreate({ PASTE_API_URL: B.url, PUBLIC_BASE_URL: 'https://pub.example.com' }, [file, '--name', `CLI ${uniq()}`, '--frontend', 'https://flag.example.com/']);
    assert.equal(b.url, `https://flag.example.com/d/${b.slug}`);
  });

  test('unparseable /d/ paths send humans to the app root and never echo the raw path', async () => {
    for (const p of ['/d/..%2F..%2Fetc%2Fpasswd', '/d/%2e%2e/%2e%2e/server.cjs', '/d/abc/..%2Fx', '/d/abc@0123/x']) {
      const r = await getMeta(B.url, p, UA.chrome);
      assert.equal(r.status, 404, p);
      assert.equal(refreshTarget(r.doc.refreshes[0]), `${FRONT}/d/`, p);
      assert.deepEqual(scriptNavigations(r.doc, ''), [`${FRONT}/d/`]);
      assert.ok(!/%2e|%2f|\.\.|passwd|server\.cjs/i.test(r.text), `${p}: raw path echoed`);
    }
  });

  test('If-None-Match: * → 304 for an existing doc page and cover; unknown docs stay 404', async () => {
    const d = await createDoc(B.url, { sessionName: `Star ${uniq()}`, markdown: 'Body.' });
    assert.equal((await getMeta(B.url, `/d/${d.x}`, UA.slack, { 'If-None-Match': '*' })).status, 304);
    assert.equal((await request(B.url, 'GET', `/d/${d.x}/cover.png`, { headers: { 'If-None-Match': '*' } })).status, 304);
    assert.equal((await getMeta(B.url, `/d/missing-${uniq()}`, UA.slack, { 'If-None-Match': '*' })).status, 404);
  });

  test('pinned /d/<x>@<rev>: the revision\'s own title/description and time, no og:image (summary card)', async () => {
    const d = await createDoc(B.url, { filename: 'v.md', markdown: '# Old title\n\nOld body.' });
    const rev = (await request(B.url, 'GET', `/paste/${d.id}/revisions`)).json.current;
    await new Promise((r) => setTimeout(r, 20));
    await putMarkdown(B.url, d.id, '# New title\n\nNew body.');
    const r = await getMeta(B.url, `/d/${d.x}@${rev}`, UA.slack);
    assert.equal(r.status, 200);
    assert.equal(one(r.doc, 'og:title'), 'Old title');
    assert.equal(one(r.doc, 'og:description'), 'Old body.');
    assert.deepEqual(r.doc.metaAll('og:image'), []);
    assert.equal(one(r.doc, 'twitter:card'), 'summary');
    const live = await getMeta(B.url, `/d/${d.x}`, UA.slack);
    assert.ok(Date.parse(one(r.doc, 'article:modified_time')) < Date.parse(one(live.doc, 'article:modified_time')));
  });

  test('title/description quality over HTTP: .html name without contentType, BOM, H1 entities, lone TL;DR label, control chars', async () => {
    const h = await getMeta(B.url, `/d/${(await createDoc(B.url, { filename: 'r.html', markdown: '<title>Inferred &amp; HTML</title><p>Para.</p>' })).x}`, UA.slack);
    assert.equal(one(h.doc, 'og:title'), 'Inferred & HTML');
    assert.equal(one(h.doc, 'og:description'), 'Para.');
    const m = await getMeta(B.url, `/d/${(await createDoc(B.url, { filename: 'b.md', markdown: '﻿# Fish &amp; chips\n\n**TL;DR**\n\nThe summary.' })).x}`, UA.slack);
    assert.equal(one(m.doc, 'og:title'), 'Fish & chips');
    assert.equal(one(m.doc, 'og:description'), 'The summary.');
    const c = await getMeta(B.url, `/d/${(await createDoc(B.url, { sessionName: `Ctl\u0001\u0007 name ${uniq()}`, markdown: 'Bell\u0007 text.' })).x}`, UA.slack);
    assert.match(one(c.doc, 'og:title'), /^Ctl name [0-9a-f]{8}$/);
    assert.equal(one(c.doc, 'og:description'), 'Bell text.');
    assert.ok(!/[\u0000-\u0008]/.test(c.text));
  });

  test('cover: an emoji-only title falls back to the filename; "by" is left out without an author', async () => {
    const a = await createDoc(B.url, { sessionName: '🚀🎉', filename: 'launch-notes.md', markdown: 'x' }, { author: null });
    const b = await createDoc(B.url, { sessionName: 'launch-notes', filename: 'other.md', markdown: 'y' }, { author: null });
    const ka = new URL(one((await getMeta(B.url, `/d/${a.x}`, UA.slack)).doc, 'og:image')).searchParams.get('v');
    const pb = await getMeta(B.url, `/d/${b.x}`, UA.slack);
    const kb = new URL(one(pb.doc, 'og:image')).searchParams.get('v');
    const day = new Date(one(pb.doc, 'article:modified_time'));
    const line = `Markdown · Updated ${day.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][day.getUTCMonth()]} ${day.getUTCFullYear()}`;
    assert.equal(kb, md5(`cover-v1|launch-notes|${line}`).slice(0, 12), 'cover_key of "launch-notes" with no "by" part');
    assert.equal(ka, kb, 'the emoji-only title draws (and keys) as its filename');
    const png = await request(B.url, 'GET', `/d/${a.x}/cover.png`);
    assert.equal(readPng(png.buf).width, 1200);
  });
});

describe('#22 fixes (PUBLIC_BASE_URL set)', { skip: SKIP }, () => {
  let B;
  before(async () => { B = await startServer({ env: { FRONTEND_URL: FRONT, PUBLIC_BASE_URL: 'https://mdr.example.com/' } }); });
  after(async () => { await B?.stop(); cleanupTmp(); });

  test('the handed-out `url` is the backend meta page', async () => {
    const r = await request(B.url, 'POST', '/paste', { body: { sessionName: `Pub ${uniq()}`, markdown: 'x' } });
    assert.equal(r.json.url, `https://mdr.example.com/d/${r.json.slug}`);
    assert.equal((await request(B.url, 'GET', `/paste/${r.json.slug}`)).json.url, `https://mdr.example.com/d/${r.json.slug}`);
  });
});
