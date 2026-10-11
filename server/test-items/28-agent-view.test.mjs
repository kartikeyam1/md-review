// Item #28 — human view vs agent view (server/MCP half).
// Spec: docs/build/specs/28-agent-view.md rules 14 (server part), 15–20; ACs 28.9–28.13,
// the server half of AC-28.19 and AC-28.16's GET /d/<slug>.md for HTML docs. 00 §5, §6, §9, §10.5.
//
// Backend: verify.sh's (E2E_API_URL / MDREVIEW_API / PASTE_API) when given, else a throwaway one.
// MCP: both servers (stdio server/mcp-server.js and HTTP server/mcp-server-http.js) are spawned
// against that backend with the token store in a temp dir.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  sharedBackend, request, createDoc, createExpiredDoc, getMeta, parseHtml, one, UA, uniq, tmpDir, cleanupTmp, SERVER_DIR,
} from './22-helpers.mjs';
import { startMcpHttp, mcpConnect, mcpStdio } from './23-helpers.mjs';
import { AGENT_FIXTURES } from '../../tests/items/28-agent-fixtures.mjs';

// The server loads the shared module with require() (00 §4.8) — test it the same way.
const require = createRequire(import.meta.url);
const { stripAgentSections, findAgentSections, countAgentSections } = require(path.join(SERVER_DIR, '..', 'shared', 'agentSections.mjs'));

const DOC = '# Report\n\nIntro text for humans.\n\n<!-- agent -->\nAGENTSECRET one: raw evidence.\n<!-- /agent -->\n\nMiddle part.\n\n'
  + '<!-- agent: Raw SQL -->\nSELECT agent_only_column FROM t;\n<!-- /agent -->\n\nEnd.\n';
const HUMAN = stripAgentSections(DOC).markdown;
const AGENT_TEXT = ['AGENTSECRET', 'agent_only_column'];

let B;
const procs = [];
before(async () => { B = await sharedBackend(); });
after(async () => {
  for (const p of procs) await p.stop();
  await B?.stop();
  cleanupTmp();
});

const get = (p, headers = {}) => request(B.url, 'GET', p, { headers });
const mdDoc = (extra = {}) => createDoc(B.url, { markdown: DOC, filename: 'report.md', slug: `agent-view-${uniq()}`, ...extra });

describe('#28 rule 15 — the shared strip function (fixture table, same as the FE unit test)', () => {
  for (const f of AGENT_FIXTURES) {
    test(`AC-28.5/28.6 fixture: ${f.name}`, () => {
      const got = findAgentSections(f.src).map((s) => [s.start, s.end, s.label]);
      assert.deepEqual(got, f.sections, 'section ranges');
      const r = stripAgentSections(f.src);
      assert.equal(r.markdown, f.human, 'human markdown');
      assert.equal(r.count, f.sections.length, 'count');
      assert.equal(countAgentSections(f.src), f.sections.length);
    });
  }
});

describe('#28 rule 16 — GET /d/:x.md', () => {
  let d;
  before(async () => { d = await mdDoc(); });

  test('AC-28.9 default: 200 text/markdown; charset=utf-8, ACAO *, no-cache, X-Agent-Sections 2, ETag, body = stored source byte-for-byte', async () => {
    const r = await get(`/d/${d.slug}.md`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers['content-type'] || '', /^text\/markdown;\s*charset=utf-8$/i);
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.equal(r.headers['x-agent-sections'], '2');
    assert.ok(r.headers.etag, 'ETag present');
    assert.ok(r.buf.equals(Buffer.from(DOC, 'utf-8')), 'body byte-for-byte');
    assert.match(r.headers['access-control-expose-headers'] || '', /X-Agent-Sections/i);
  });

  test('AC-28.9 ?view=human → the rule-15 stripped text; ?view=agent = default', async () => {
    const h = await get(`/d/${d.slug}.md?view=human`);
    assert.equal(h.status, 200);
    assert.match(h.headers['content-type'] || '', /^text\/markdown/i);
    assert.equal(h.text, HUMAN);
    for (const t of AGENT_TEXT) assert.ok(!h.text.includes(t), `no "${t}"`);
    assert.equal(h.headers['x-agent-sections'], '2');
    const a = await get(`/d/${d.slug}.md?view=agent`);
    assert.equal(a.status, 200);
    assert.equal(a.text, DOC);
    assert.equal(a.headers.etag, (await get(`/d/${d.slug}.md`)).headers.etag, 'view=agent has the default ETag');
  });

  test('AC-28.9 ?view=bogus (and ?view=AGENT) → 400 text/plain', async () => {
    for (const v of ['bogus', 'AGENT', '']) {
      const r = await get(`/d/${d.slug}.md?view=${v}`);
      assert.equal(r.status, 400, `view=${v}`);
      assert.match(r.headers['content-type'] || '', /^text\/plain/i);
    }
  });

  test('AC-28.9 unknown → 404 text/plain; expired → 410 text/plain', async () => {
    const u = await get(`/d/no-such-doc-${uniq()}.md`);
    assert.equal(u.status, 404);
    assert.match(u.headers['content-type'] || '', /^text\/plain/i);
    const e = await createExpiredDoc(B.url, { markdown: DOC, filename: 'old.md', slug: `expired-agent-${uniq()}` });
    const r = await get(`/d/${e.x}.md`);
    assert.equal(r.status, 410);
    assert.match(r.headers['content-type'] || '', /^text\/plain/i);
    assert.ok(!r.text.includes('AGENTSECRET'));
  });

  test('AC-28.9 suffix is case-sensitive: /d/<slug>.MD → 404', async () => {
    const r = await get(`/d/${d.slug}.MD`);
    assert.equal(r.status, 404);
  });

  test('AC-28.9 lookup by id works; an all-hex slug works', async () => {
    const byId = await get(`/d/${d.id}.md`);
    assert.equal(byId.status, 200);
    assert.equal(byId.text, DOC);
    const hexSlug = `${uniq()}${uniq()}`; // [0-9a-f] only
    const h = await createDoc(B.url, { markdown: DOC, filename: 'hex.md', slug: hexSlug });
    assert.equal(h.slug, hexSlug, 'precondition: the slug was kept');
    const r = await get(`/d/${hexSlug}.md`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.text, DOC);
  });

  test('AC-28.9 HEAD answers like GET without a body', async () => {
    const r = await request(B.url, 'HEAD', `/d/${d.slug}.md`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-agent-sections'], '2');
    assert.equal(r.buf.length, 0);
  });

  test('AC-28.11 ETags are view-specific: the agent ETag never 304s the human view; the human ETag does', async () => {
    const a = await get(`/d/${d.slug}.md`);
    const h1 = await get(`/d/${d.slug}.md?view=human`, { 'If-None-Match': a.headers.etag });
    assert.equal(h1.status, 200, 'agent ETag on the human view → 200');
    assert.notEqual(h1.headers.etag, a.headers.etag);
    const h2 = await get(`/d/${d.slug}.md?view=human`, { 'If-None-Match': h1.headers.etag });
    assert.equal(h2.status, 304, 'human ETag on the human view → 304');
    const a2 = await get(`/d/${d.slug}.md`, { 'If-None-Match': h1.headers.etag });
    assert.equal(a2.status, 200, 'human ETag on the agent view → 200');
    const a3 = await get(`/d/${d.slug}.md`, { 'If-None-Match': a.headers.etag });
    assert.equal(a3.status, 304, 'agent ETag on the agent view → 304');
  });

  test('AC-28.16 an HTML doc: text/plain; charset=utf-8 with the HTML source, X-Agent-Sections 0, view=human accepted', async () => {
    const html = '<!doctype html><html><head><title>H</title></head><body>\n<!-- agent -->\n<p>kept</p>\n<!-- /agent -->\n</body></html>';
    const h = await createDoc(B.url, { markdown: html, filename: 'page.html', contentType: 'html', slug: `html-agent-${uniq()}` });
    for (const qs of ['', '?view=human', '?view=agent']) {
      const r = await get(`/d/${h.slug}.md${qs}`);
      assert.equal(r.status, 200, qs);
      assert.match(r.headers['content-type'] || '', /^text\/plain;\s*charset=utf-8$/i, qs);
      assert.equal(r.headers['x-agent-sections'], '0', qs);
      assert.equal(r.text, html, `${qs}: HTML source unchanged`);
    }
  });
});

describe('#28 rule 17/18 — view on GET /paste/:id[/markdown]', () => {
  let d;
  before(async () => { d = await mdDoc(); });

  test('AC-28.10 /markdown without view: markdown identical to the stored source, view "agent", agentSections 2', async () => {
    const r = await get(`/paste/${d.id}/markdown`);
    assert.equal(r.status, 200);
    assert.equal(r.json.markdown, DOC);
    assert.equal(r.json.filename, 'report.md');
    assert.equal(r.json.view, 'agent');
    assert.equal(r.json.agentSections, 2);
  });

  test('AC-28.10 /markdown?view=human: no agent text, agentSections 2; ?view=bogus → 400', async () => {
    const r = await get(`/paste/${d.id}/markdown?view=human`);
    assert.equal(r.status, 200);
    assert.equal(r.json.markdown, HUMAN);
    assert.equal(r.json.view, 'human');
    assert.equal(r.json.agentSections, 2);
    const a = await get(`/paste/${d.id}/markdown?view=agent`);
    assert.equal(a.json.markdown, DOC);
    const bad = await get(`/paste/${d.id}/markdown?view=bogus`);
    assert.equal(bad.status, 400);
  });

  test('rule 17 GET /paste/:id?view=human applies to markdown only (full and ?fields=)', async () => {
    const full = await get(`/paste/${d.id}?view=human`);
    assert.equal(full.status, 200);
    assert.equal(full.json.markdown, HUMAN);
    assert.equal(full.json.view, 'human');
    assert.equal(full.json.agentSections, 2);
    assert.equal(full.json.filename, 'report.md', 'other fields untouched');
    const plain = await get(`/paste/${d.id}`);
    assert.equal(plain.json.markdown, DOC, 'default stays the full source');
    const f = await get(`/paste/${d.id}?fields=meta,content&view=human`);
    assert.equal(f.status, 200);
    assert.equal(f.json.markdown, HUMAN);
    assert.equal(f.json.filename, 'report.md');
    const fa = await get(`/paste/${d.id}?view=agent&fields=content`);
    assert.equal(fa.json.markdown, DOC);
  });

  test('AC-28.11 /paste/:id/markdown ETags are view-specific', async () => {
    const a = await get(`/paste/${d.id}/markdown`);
    const h = await get(`/paste/${d.id}/markdown?view=human`, { 'If-None-Match': a.headers.etag });
    assert.equal(h.status, 200);
    assert.notEqual(h.headers.etag, a.headers.etag);
    assert.equal((await get(`/paste/${d.id}/markdown?view=human`, { 'If-None-Match': h.headers.etag })).status, 304);
    assert.equal((await get(`/paste/${d.id}/markdown`, { 'If-None-Match': h.headers.etag })).status, 200);
    assert.equal((await get(`/paste/${d.id}/markdown`, { 'If-None-Match': a.headers.etag })).status, 304);
    assert.equal((await get(`/paste/${d.id}?view=human`, { 'If-None-Match': a.headers.etag })).status, 200);
  });
});

describe('#28 rule 20 — GET /llms.txt', () => {
  test('AC-28.13 200 text/plain guide with /d/, .md, view=human and the marker; lists no documents', async () => {
    const mine = await mdDoc();
    const r = await get('/llms.txt');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] || '', /^text\/plain;\s*charset=utf-8$/i);
    assert.match(r.text, /^# md-review/m);
    for (const s of ['/d/', '.md', 'view=human', '<!-- agent -->', '<!-- /agent -->', 'get_session']) assert.ok(r.text.includes(s), `contains ${s}`);
    const list = await get('/paste/list');
    const slugs = (list.json || []).map((s) => s.slug).filter(Boolean);
    assert.ok(slugs.length >= 1, 'precondition: /paste/list has slugs');
    assert.ok(slugs.includes(mine.slug), 'precondition: this suite\'s doc is listed');
    assert.ok(!r.text.includes(mine.slug) && !r.text.includes(mine.id), 'does not list this suite\'s doc');
    // Every listed slug as a link (a short slug such as "doc" may occur as a plain word in the guide).
    for (const s of slugs) assert.ok(!r.text.includes(`/d/${s}`), `does not link ${s}`);
  });
});

describe('#28 rule 14 — the #22 meta page uses the human view', () => {
  test('AC-28.19 og:title = first human-visible H1, og:description has no agent text, alternate text/markdown link', async () => {
    const src = '<!-- agent -->\n# Hidden Title\n\nAGENTSECRET paragraph for agents.\n<!-- /agent -->\n\n# Visible\n\nThe human summary paragraph.\n';
    const d = await createDoc(B.url, { markdown: src, filename: 'v.md', slug: `visible-${uniq()}` });
    const r = await getMeta(B.url, `/d/${d.slug}`, UA.slack);
    assert.equal(r.status, 200);
    const doc = parseHtml(r.text);
    assert.equal(one(doc, 'og:title'), 'Visible');
    const desc = one(doc, 'og:description');
    assert.ok(!desc.includes('AGENTSECRET') && !desc.includes('Hidden'), `og:description: ${desc}`);
    assert.match(r.text, /<title>Visible · md-review<\/title>/);
    const alt = r.text.match(/<link rel="alternate" type="text\/markdown" href="([^"]+)">/);
    assert.ok(alt, 'alternate link present');
    assert.ok(alt[1].endsWith(`/d/${d.slug}.md`), alt[1]);
    // The human (non-bot) variant carries it too.
    const human = await getMeta(B.url, `/d/${d.slug}`, UA.chrome);
    assert.ok(human.text.includes(`type="text/markdown" href="`) && human.text.includes(`/d/${d.slug}.md"`));
  });

  test('rule 14 an HTML doc page has no alternate text/markdown link', async () => {
    const h = await createDoc(B.url, { markdown: '<html><head><title>T</title></head><body><p>x</p></body></html>', filename: 'p.html', contentType: 'html', slug: `htmlmeta-${uniq()}` });
    const r = await getMeta(B.url, `/d/${h.slug}`, UA.slack);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('text/markdown'), 'no alternate link for HTML docs');
  });
});

describe('#28 rule 19 — MCP get_session view + tool descriptions', () => {
  const MCP_ENV = {};
  let httpMcp, stdio;
  before(async () => {
    const store = path.join(tmpDir('md-review-28-mcp'), 'state', 'edit-tokens.json');
    httpMcp = await startMcpHttp({ apiUrl: B.url, storePath: store, env: MCP_ENV });
    procs.push(httpMcp);
    stdio = await mcpStdio({ apiUrl: B.url, storePath: store, env: MCP_ENV });
    procs.push({ stop: () => stdio.close() });
  });

  async function checkGetSession(c, label) {
    const d = await mdDoc();
    const h = await c.call('get_session', { sessionId: d.slug, view: 'human' });
    assert.ok(h && !h.error && !h.__toolError, `${label}: ${JSON.stringify(h)?.slice(0, 300)}`);
    assert.equal(h.markdown, HUMAN, `${label}: human markdown`);
    for (const t of AGENT_TEXT) assert.ok(!h.markdown.includes(t), `${label}: no ${t}`);
    assert.equal(h.view, 'human');
    assert.equal(h.agentSections, 2);
    assert.ok(String(h.rawUrl).endsWith(`/d/${d.slug}.md`), `${label}: rawUrl ${h.rawUrl}`);
    const a = await c.call('get_session', { sessionId: d.slug });
    assert.equal(a.markdown, DOC, `${label}: default = full source`);
    assert.equal(a.view, 'agent');
    assert.equal(a.agentSections, 2);
    assert.ok(String(a.rawUrl).endsWith(`/d/${d.slug}.md`));
    // rawUrl is fetchable on the configured API.
    const raw = await fetch(a.rawUrl);
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), DOC);
    // An id without a slug → rawUrl ends /d/<id>.md
    const n = await createDoc(B.url, { markdown: DOC, filename: 'noslug.md' });
    const byId = await c.call('get_session', { sessionId: n.id, view: 'agent', fields: 'meta,content' });
    assert.ok(String(byId.rawUrl).endsWith(`/d/${n.x}.md`), `${label}: ${byId.rawUrl}`);
    assert.equal(byId.markdown, DOC);
  }

  async function checkDescriptions(c, label) {
    const { tools } = await c.client.listTools();
    for (const name of ['create_session', 'update_markdown', 'patch_markdown']) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${label}: ${name} listed`);
      assert.ok(t.description.includes('<!-- agent -->'), `${label}: ${name} description mentions <!-- agent -->`);
      assert.ok(t.description.includes('<!-- /agent -->'), `${label}: ${name} description mentions <!-- /agent -->`);
    }
    const gs = tools.find((x) => x.name === 'get_session');
    assert.ok(gs.inputSchema?.properties?.view, `${label}: get_session has a view argument`);
  }

  test('AC-28.12 HTTP MCP: get_session view human/agent, agentSections, rawUrl', async () => {
    const c = await mcpConnect(httpMcp.url);
    try { await checkGetSession(c, 'http'); } finally { await c.close(); }
  });

  test('AC-28.12 stdio MCP: get_session view human/agent, agentSections, rawUrl', async () => {
    await checkGetSession(stdio, 'stdio');
  });

  test('AC-28.12 tools/list descriptions contain <!-- agent --> (both servers)', async () => {
    const c = await mcpConnect(httpMcp.url);
    try { await checkDescriptions(c, 'http'); } finally { await c.close(); }
    await checkDescriptions(stdio, 'stdio');
  });

  test('AC-28.12 get_session view rejects other values', async () => {
    const r = await stdio.call('get_session', { sessionId: 'whatever', view: 'bogus' });
    assert.ok(r && (r.__toolError || r.error), `bogus view refused: ${JSON.stringify(r)?.slice(0, 200)}`);
  });
});

describe('#28 — pathological marker input stays linear (the server strips on every write and read)', () => {
  test('rule 15 a long unterminated opener line, many markers and many openers: strip < 50 ms each', () => {
    const cases = [
      ['long opener line, no -->', `<!-- agent: ${' '.repeat(3000)}`],
      ['long opener label with spaces', `<!-- agent:${' x'.repeat(20000)}`],
      ['many sections', '<!-- agent -->\na\n<!-- /agent -->\n'.repeat(20000)],
      ['many unclosed-looking openers', '<!-- agent -->\n'.repeat(60000)],
      ['markers in list items', '- <!-- agent -->\n  x\n'.repeat(40000)],
    ];
    for (const [name, src] of cases) {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = process.hrtime.bigint();
        stripAgentSections(src);
        best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
      }
      assert.ok(best < 50, `${name}: ${best.toFixed(1)} ms`);
    }
  });
});

describe('#28 fix round — review/QA findings (server)', () => {
  const agentView = require(path.join(SERVER_DIR, 'agent-view.cjs'));

  test('QA N1: ?fields=meta&view=human (no markdown in the response) adds no view/agentSections; ETag = the plain one', async () => {
    const d = await mdDoc();
    const plain = await get(`/paste/${d.id}?fields=meta`);
    const r = await get(`/paste/${d.id}?fields=meta&view=human`);
    assert.equal(r.status, 200);
    assert.equal(r.json.markdown, undefined);
    assert.ok(!('view' in r.json) && !('agentSections' in r.json), JSON.stringify(Object.keys(r.json)));
    assert.equal(r.headers.etag, plain.headers.etag, 'same body → same ETag');
    for (const f of ['comments', 'files', 'meta,comments']) {
      const x = await get(`/paste/${d.id}?fields=${f}&view=agent`);
      assert.ok(!('view' in x.json), `fields=${f}`);
    }
    // ?view=bogus is still refused even when the content is not requested.
    assert.equal((await get(`/paste/${d.id}?fields=meta&view=bogus`)).status, 400);
  });

  test('Review SF3: viewOf short-circuits a source without an opener (count 0, text unchanged) in both views', () => {
    for (const view of ['agent', 'human']) {
      const src = '# Plain\n\n<!-- a comment -->\n\n<!-- /agent -->\n';
      assert.deepEqual(agentView.viewOf(src, view), { markdown: src, count: 0 }, view);
      assert.equal(agentView.viewOf('a\n<!--AGENT-->\nx\n<!-- /agent -->\nb\n', view).count, 1, `${view}: uppercase opener still found`);
    }
    assert.equal(agentView.viewOf(DOC, 'human').markdown, HUMAN);
    assert.equal(agentView.viewOf(DOC, 'agent').count, 2);
  });

  test('NIT2: the raw ETag covers the content type (same source as markdown and as HTML → different ETags)', async () => {
    const src = `<p>same bytes ${uniq()}</p>\n`;
    const md = await createDoc(B.url, { markdown: src, filename: 'same.md', contentType: 'markdown' });
    const html = await createDoc(B.url, { markdown: src, filename: 'same.html', contentType: 'html' });
    const a = await get(`/d/${md.x}.md`);
    const b = await get(`/d/${html.x}.md`);
    assert.equal(a.text, b.text, 'precondition: identical bodies');
    assert.notEqual(a.headers['content-type'], b.headers['content-type']);
    assert.notEqual(a.headers.etag, b.headers.etag);
    assert.equal((await get(`/d/${html.x}.md`, { 'If-None-Match': a.headers.etag })).status, 200);
    assert.equal((await get(`/d/${html.x}.md`, { 'If-None-Match': b.headers.etag })).status, 304);
  });

  test('NIT3: GET /paste/:id?view=agent has its own ETag (its body adds view/agentSections); each variant 304s only itself', async () => {
    const d = await mdDoc();
    const plain = await get(`/paste/${d.id}`);
    const agent = await get(`/paste/${d.id}?view=agent`);
    const human = await get(`/paste/${d.id}?view=human`);
    assert.ok(!('view' in plain.json));
    assert.equal(agent.json.view, 'agent');
    const tags = [plain.headers.etag, agent.headers.etag, human.headers.etag];
    assert.equal(new Set(tags).size, 3, `distinct ETags: ${tags.join(' ')}`);
    const paths = [`/paste/${d.id}`, `/paste/${d.id}?view=agent`, `/paste/${d.id}?view=human`];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const r = await get(paths[i], { 'If-None-Match': tags[j] });
        assert.equal(r.status, i === j ? 304 : 200, `${paths[i]} with ETag of ${paths[j]}`);
      }
    }
    // /markdown (always viewed) keeps the session ETag for its default agent body; human differs.
    const m = await get(`/paste/${d.id}/markdown`);
    assert.equal((await get(`/paste/${d.id}/markdown`, { 'If-None-Match': m.headers.etag })).status, 304);
    assert.equal((await get(`/paste/${d.id}/markdown?view=human`, { 'If-None-Match': m.headers.etag })).status, 200);
  });
});
