// Item #22 — PUBLIC_BASE_URL / FRONTEND_URL config and the canonical share-URL rule.
// Spec: docs/build/specs/22-og-meta-route.md rule 1, AC-22.13 (+ 00 §6).
// Boots its own backends (it needs specific env) and drives the stdio MCP server
// (server/mcp-server.js) through the MCP SDK client. Helpers + gating: 22-helpers.mjs.
//
// The MCP process gets the same FRONTEND_URL / PUBLIC_BASE_URL as the backend, so
// the result does not depend on which of the two builds the link.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  SKIP, startServer, cleanupTmp, request, createDoc, getMeta, one, pathOf, refreshTarget, scriptNavigations,
  readPng, UA, uniq, escapeRe, MCP_SERVER_FILE, DEFAULT_FRONTEND_URL,
} from './22-helpers.mjs';

/** Call an MCP tool on a fresh stdio server process; returns the parsed JSON text result. */
async function mcpCall(env, tool, args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_FILE],
    // #23: keep the MCP edit-token store where verify.sh puts it, never in the repo.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.MCP_TOKEN_STORE ? { MCP_TOKEN_STORE: process.env.MCP_TOKEN_STORE } : {}), ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'md-review-test-22', version: '1.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = res.content?.find((c) => c.type === 'text')?.text;
    assert.ok(text, `${tool} returned text content: ${JSON.stringify(res).slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    await client.close();
  }
}

describe('#22 PUBLIC_BASE_URL set', { skip: SKIP }, () => {
  const PUBLIC = 'https://mdr.example.com';
  const FRONT = 'https://fe.example.com/app';
  let B;
  // Trailing slashes in the env must be ignored (rule 1).
  before(async () => { B = await startServer({ env: { PUBLIC_BASE_URL: `${PUBLIC}/`, FRONTEND_URL: `${FRONT}/` } }); });
  after(async () => { await B?.stop(); cleanupTmp(); });

  test('AC-22.13 og:url, canonical, og:image and twitter:image are absolute URLs on PUBLIC_BASE_URL (trailing slash ignored)', async () => {
    const d = await createDoc(B.url, { sessionName: `Public base ${uniq()}`, filename: 'p.md', markdown: '# P\n\nBody.' });
    const r = await getMeta(B.url, `/d/${d.slug}`, UA.slack);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(one(r.doc, 'og:url'), `${PUBLIC}/d/${d.slug}`);
    assert.deepEqual(r.doc.canonical, [`${PUBLIC}/d/${d.slug}`]);
    const img = one(r.doc, 'og:image');
    assert.match(img, new RegExp(`^${escapeRe(PUBLIC)}/d/${escapeRe(d.slug)}/cover\\.png\\?v=[0-9a-f]{12}$`));
    assert.equal(one(r.doc, 'twitter:image'), img);
    assert.ok(!r.text.includes('localhost') && !r.text.includes('127.0.0.1'), 'no backend-internal origin leaks into the page');
    const cover = await request(B.url, 'GET', pathOf(img));
    assert.equal(cover.status, 200);
    assert.equal(readPng(cover.buf).width, 1200);
  });

  test('AC-22.13 (rule 1) humans are sent to FRONTEND_URL/d/<x> (trailing slash ignored), also from the 404 page', async () => {
    const d = await createDoc(B.url, { sessionName: `Front ${uniq()}`, filename: 'f.md', markdown: 'Body.' });
    const r = await getMeta(B.url, `/d/${d.slug}`, UA.chrome);
    assert.equal(refreshTarget(r.doc.refreshes[0]), `${FRONT}/d/${d.slug}`);
    assert.deepEqual(scriptNavigations(r.doc, '#x'), [`${FRONT}/d/${d.slug}#x`]);
    const a = r.doc.anchors.map((x) => x.href);
    assert.ok(a.includes(`${FRONT}/d/${d.slug}`), `body link to the app URL (${JSON.stringify(a)})`);
    const missing = `missing-${uniq()}`;
    const nf = await getMeta(B.url, `/d/${missing}`, UA.chrome);
    assert.equal(nf.status, 404);
    assert.equal(refreshTarget(nf.doc.refreshes[0]), `${FRONT}/d/${missing}`);
  });

  test('AC-22.13 MCP create_session returns shareUrl https://mdr.example.com/d/<slug>', async () => {
    const res = await mcpCall({ PASTE_API_URL: B.url, PUBLIC_BASE_URL: `${PUBLIC}/`, FRONTEND_URL: `${FRONT}/` },
      'create_session', { markdown: '# MCP\n\nBody.', filename: 'mcp.md', sessionName: `MCP share ${uniq()}` });
    assert.ok(res.slug, `create_session returned a slug: ${JSON.stringify(res)}`);
    assert.equal(res.shareUrl, `${PUBLIC}/d/${res.slug}`);
  });
});

describe('#22 PUBLIC_BASE_URL unset', { skip: SKIP }, () => {
  const FRONT = 'https://fe.example.com/app';
  let B;
  before(async () => { B = await startServer({ env: { FRONTEND_URL: FRONT } }); });
  after(async () => { await B?.stop(); cleanupTmp(); });

  test('AC-22.13 MCP create_session shareUrl is {FRONTEND_URL}/d/<slug> when PUBLIC_BASE_URL is unset', async () => {
    const res = await mcpCall({ PASTE_API_URL: B.url, FRONTEND_URL: FRONT },
      'create_session', { markdown: '# MCP\n\nBody.', filename: 'mcp.md', sessionName: `MCP default ${uniq()}` });
    assert.ok(res.slug, JSON.stringify(res));
    assert.equal(res.shareUrl, `${FRONT}/d/${res.slug}`);
  });

  test('rule 1: the meta page itself uses the default PUBLIC_BASE_URL http://localhost:PORT for og:url / canonical / og:image', async () => {
    const d = await createDoc(B.url, { sessionName: `Default base ${uniq()}`, filename: 'd.md', markdown: 'Body.' });
    const r = await getMeta(B.url, `/d/${d.slug}`, UA.slack);
    assert.equal(r.status, 200);
    const base = `http://localhost:${B.port}`;
    assert.equal(one(r.doc, 'og:url'), `${base}/d/${d.slug}`);
    assert.deepEqual(r.doc.canonical, [`${base}/d/${d.slug}`]);
    assert.ok(one(r.doc, 'og:image').startsWith(`${base}/d/${d.slug}/cover.png?v=`));
  });
});

describe('#22 FRONTEND_URL unset', { skip: SKIP }, () => {
  let B;
  before(async () => { B = await startServer(); });
  after(async () => { await B?.stop(); cleanupTmp(); });

  test(`rule 1: FRONTEND_URL defaults to ${DEFAULT_FRONTEND_URL}`, async () => {
    const d = await createDoc(B.url, { sessionName: `Default front ${uniq()}`, filename: 'd.md', markdown: 'Body.' });
    const r = await getMeta(B.url, `/d/${d.slug}`, UA.chrome);
    assert.equal(r.status, 200);
    assert.equal(refreshTarget(r.doc.refreshes[0]), `${DEFAULT_FRONTEND_URL}/d/${d.slug}`);
  });
});
