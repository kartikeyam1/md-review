// Persona-QA fixes (agent persona, area: api) — REST, meta page, /llms.txt and
// CLI side. Each test failed before the fix. Findings: docs/build/reports/fix-api.md.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http_ from 'node:http';
import {
  sharedBackend, tmpDir, cleanupTmp, http, create, serverMarkdown, metaOf, uniq, runCli,
} from './23-helpers.mjs';

let B;
before(async () => { B = await sharedBackend(); });
after(async () => { await B?.stop(); cleanupTmp(); });

const SLACK = { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' };
const metaContent = (html, prop) => {
  const m = new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)">`).exec(html);
  return m ? m[1] : null;
};
const cli = (args, env = {}) => runCli(['--api', B.url, ...args], { env: { FRONTEND_URL: 'https://frontend.test/md-review', ...env } });

describe('agent #13 — og/twitter description has no directive syntax', () => {
  test(':rag-green[On track] reads as "On track"; a [!NOTE] marker is dropped', async () => {
    const d = await create(B.url, { markdown: '# Status\n\nSummary: all three tenants green. :rag-green[On track]\n' });
    const page = await http(B.url, 'GET', `/d/${d.slug || d.id}`, { headers: SLACK });
    assert.equal(metaContent(page.text, 'og:description'), 'Summary: all three tenants green. On track');
    assert.equal(metaContent(page.text, 'twitter:description'), 'Summary: all three tenants green. On track');
    const n = await create(B.url, { markdown: '# Alert\n\n> [!WARNING]\n> Capacity is tight.\n' });
    const p2 = await http(B.url, 'GET', `/d/${n.id}`, { headers: SLACK });
    assert.equal(metaContent(p2.text, 'og:description'), 'Capacity is tight.');
  });
});

describe('agent #15 — /llms.txt is a complete agent entry point', () => {
  test('mentions upsert, edit tokens, MDREVIEW_EDIT_TOKEN, CLI publish, reactions/views, files, the MCP endpoint', async () => {
    const r = await http(B.url, 'GET', '/llms.txt');
    for (const s of ['upsert_session', '/paste/by-key/', 'editToken', 'X-Edit-Token', 'MDREVIEW_EDIT_TOKEN', 'publish <key> <file>',
      'get_reactions', 'get_views', 'add_file', 'get_file', '/mcp', 'create_via_shell', 'isError', 'mode']) {
      assert.ok(r.text.includes(s), `llms.txt mentions ${s}`);
    }
  });
});

describe('agent #23 — pinned revisions', () => {
  test('/d/x@rev page says "earlier revision" in its title and links /d/x@rev.md, which serves that revision', async () => {
    const d = await create(B.url, { markdown: '# Same title\n\nOld body.\n', slug: `pin-${uniq()}`, author: 'a' });
    const rev = (await http(B.url, 'GET', `/paste/${d.id}/revisions`)).json.current;
    await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { headers: { 'X-Edit-Token': d.editToken }, body: { markdown: '# Same title\n\nNew body.\n', author: 'b' } });
    const page = await http(B.url, 'GET', `/d/${d.slug}@${rev}`, { headers: SLACK });
    assert.match(page.text, /<title>Same title \(earlier revision\) · md-review<\/title>/);
    assert.equal(metaContent(page.text, 'og:title'), 'Same title', 'og:title stays the revision title');
    assert.match(page.text, new RegExp(`<link rel="alternate" type="text/markdown" href="[^"]*/d/${d.slug}@${rev}\\.md">`));
    const raw = await http(B.url, 'GET', `/d/${d.slug}@${rev}.md`);
    assert.equal(raw.status, 200);
    assert.equal(raw.text, '# Same title\n\nOld body.\n');
    assert.equal((await http(B.url, 'GET', `/d/${d.slug}@${'f'.repeat(32)}.md`)).status, 404);
  });
});

describe('agent #7 — approval reset over REST', () => {
  test('a content write to an approved doc → pending; the approval webhook hears it', async () => {
    const events = [];
    const hook = http_.createServer((q, s) => { let b = ''; q.on('data', (x) => { b += x; }); q.on('end', () => { events.push(JSON.parse(b)); s.end(); }); });
    await new Promise((r) => hook.listen(0, '127.0.0.1', r));
    try {
      const d = await create(B.url, { markdown: '# W\n\nv1\n', callback_url: `http://127.0.0.1:${hook.address().port}/h` });
      await http(B.url, 'PUT', `/paste/${d.id}/approval`, { body: { status: 'approved', approved_by: 'Lead' } });
      await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { headers: { 'X-Edit-Token': d.editToken }, body: { markdown: '# W\n\nv2\n' } });
      const a = (await http(B.url, 'GET', `/paste/${d.id}/approval`)).json;
      assert.equal(a.approval_status, 'pending');
      const deadline = Date.now() + 3000;
      while (events.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(events.map((e) => e.approval_status), ['approved', 'pending']);
      assert.equal(events[1].reason, 'content_changed');
      // Same content again changes nothing.
      await http(B.url, 'PUT', `/paste/${d.id}/approval`, { body: { status: 'approved' } });
      await http(B.url, 'PUT', `/paste/${d.id}/markdown`, { headers: { 'X-Edit-Token': d.editToken }, body: { markdown: '# W\n\nv2\n' } });
      assert.equal((await http(B.url, 'GET', `/paste/${d.id}/approval`)).json.approval_status, 'approved');
    } finally { hook.close(); }
  });
});

describe('agent #8 / #14 / #19 / #10 / #18 — CLI', () => {
  const file = (name, body) => { const p = path.join(tmpDir('md-review-qa-api-cli'), name); fs.writeFileSync(p, body); return p; };

  test('create --mode review creates a review doc; the output has the common create shape', async () => {
    const r = await cli(['create', file('r.md', '# R\n'), '--mode', 'review']);
    assert.equal(r.code, 0, r.stderr);
    for (const k of ['id', 'mode', 'url', 'viewUrl', 'app_url', 'editToken', 'editUrl']) assert.ok(r.json[k], `create prints ${k}`);
    assert.equal(r.json.mode, 'review');
    assert.equal((await metaOf(B.url, r.json.id)).mode, 'review');
  });

  test('publish --mode review on create; options may come before the command', async () => {
    const key = `qa:cli-${uniq()}`;
    const r = await runCli(['--api', B.url, '--mode', 'review', 'publish', key, file('p.md', '# P\n')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.mode, 'review');
    assert.ok(r.json.viewUrl && r.json.app_url, 'publish prints the common link fields');
    assert.equal((await metaOf(B.url, r.json.id)).mode, 'review');
  });

  test('unknown options and commands are errors, not silently ignored', async () => {
    const bad = await cli(['create', file('b.md', '# B\n'), '--mdoe', 'review']);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /unknown option --mdoe/);
    const unk = await cli(['crate', 'x.md']);
    assert.notEqual(unk.code, 0);
    assert.match(unk.stderr, /unknown command "crate"/);
    const mode = await cli(['create', file('m.md', '# M\n'), '--mode', 'Review']);
    assert.notEqual(mode.code, 0);
    assert.match(mode.stderr, /--mode must be/);
    const wrongCmd = await cli(['upload', 'abc123', file('w.md', '# W\n'), '--mode', 'review']);
    assert.notEqual(wrongCmd.code, 0);
    assert.match(wrongCmd.stderr, /--mode does not apply to upload/);
  });

  test('a wrong token says so (not "pass --token"); upload keeps the filename unless --filename', async () => {
    const d = await create(B.url, { markdown: '# U\n', filename: 'report.md' });
    const wrong = await cli(['upload', d.id, file('tmp-9.md', '# U2\n'), '--token', 'mre_wrong']);
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.stderr, /does not match this document/);
    const ok = await cli(['upload', d.id, file('tmp-9.md', '# U2\n'), '--token', d.editToken]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.json.content_hash, /^[0-9a-f]{32}$/);
    assert.equal((await metaOf(B.url, d.id)).filename, 'report.md');
    assert.equal(await serverMarkdown(B.url, d.id), '# U2\n');
  });

  test('a chunked upload with multi-byte text on the chunk boundary is byte-identical', async () => {
    const d = await create(B.url, { markdown: '# C\n' });
    const content = `${'a'.repeat(1024 * 1024 - 1)}😀${'é😀'.repeat(300_000)}\n`;
    const r = await cli(['upload', d.id, file('c.md', content), '--token', d.editToken, '--chunk-size', '1024']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await http(B.url, 'GET', `/d/${d.id}.md`)).buf.equals(Buffer.from(content, 'utf-8')), true);
  });
});

describe('agent #21 / #14 — REST list + by-key shapes', () => {
  test('list items carry url (+ upsert_key for keyed docs); by-key responses report mode', async () => {
    const key = `qa:shape-${uniq()}`;
    const p = await http(B.url, 'PUT', `/paste/by-key/${key}`, { body: { markdown: '# K\n', mode: 'review' } });
    assert.equal(p.status, 201);
    assert.equal(p.json.mode, 'review');
    assert.equal((await http(B.url, 'GET', `/paste/by-key/${key}`)).json.mode, 'review');
    const item = (await http(B.url, 'GET', '/paste/list')).json.find((x) => x.id === p.json.id);
    assert.equal(item.upsert_key, key);
    assert.ok(item.url.endsWith(`/d/${p.json.slug}`));
  });
});
