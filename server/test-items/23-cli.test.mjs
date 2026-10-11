// Item #23 — CLI (server/cli.mjs): editToken/editUrl on create; --token / MDREVIEW_EDIT_TOKEN on
// upload, add-file and patch. Spec: docs/build/specs/23-view-edit-links.md rule 12.
//
// Runs the real CLI as a child process against verify.sh's backend (or a throwaway one).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sharedBackend, tmpDir, cleanupTmp, http, TOKEN_RE, uniq, create, serverMarkdown, runCli,
} from './23-helpers.mjs';

let B, dir;
before(async () => { B = await sharedBackend(); dir = tmpDir('md-review-23-cli'); });
after(async () => { await B?.stop(); cleanupTmp(); });

const file = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };
const cli = (args, env = {}) => runCli([...args, '--api', B.url], { env: { PASTE_API_URL: B.url, ...env } });

describe('#23 rule 12 — CLI', () => {
  test('rule 12 `create` prints editToken and editUrl', async () => {
    const r = await cli(['create', file(`c-${uniq()}.md`, '# CLI\n'), '--name', `CLI ${uniq()}`]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.json?.id, r.stdout);
    assert.match(String(r.json.editToken), TOKEN_RE, `stdout: ${r.stdout}`);
    assert.ok(String(r.json.editUrl).endsWith(`?edit=${r.json.editToken}`), `editUrl: ${r.json.editUrl}`);
    assert.ok(!String(r.json.url).includes(r.json.editToken), 'url carries no token');
    // The printed token edits the doc.
    const put = await http(B.url, 'PUT', `/paste/${r.json.id}/markdown`, { body: { markdown: 'edited' }, headers: { 'X-Edit-Token': r.json.editToken } });
    assert.equal(put.status, 200);
  });

  test('rule 12 `create` of a >1 MB file (empty create + chunked upload) succeeds with the fresh token', async () => {
    const big = `# Big\n\n${'x'.repeat(1100 * 1024)}\n`;
    const r = await cli(['create', file(`big-${uniq()}.md`, big)]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(String(r.json?.editToken), TOKEN_RE, r.stdout);
    assert.equal((await serverMarkdown(B.url, r.json.id)).length, big.length, 'the chunked upload landed');
  });

  test('rule 12 `upload` without a token fails on a protected doc and changes nothing; --token and MDREVIEW_EDIT_TOKEN work', async () => {
    const d = await create(B.url, { markdown: 'orig' });
    assert.match(String(d.editToken), TOKEN_RE);
    const f = file(`u-${uniq()}.md`, 'uploaded');
    const no = await cli(['upload', d.id, f]);
    assert.notEqual(no.code, 0, 'upload without a token exits non-zero');
    assert.match(no.stderr, /401|edit token/i, `stderr: ${no.stderr}`);
    assert.equal(await serverMarkdown(B.url, d.id), 'orig');
    const withFlag = await cli(['upload', d.id, f, '--token', d.editToken]);
    assert.equal(withFlag.code, 0, withFlag.stderr);
    assert.equal(await serverMarkdown(B.url, d.id), 'uploaded');
    const f2 = file(`u2-${uniq()}.md`, 'uploaded via env');
    const withEnv = await cli(['upload', d.id, f2], { MDREVIEW_EDIT_TOKEN: d.editToken });
    assert.equal(withEnv.code, 0, withEnv.stderr);
    assert.equal(await serverMarkdown(B.url, d.id), 'uploaded via env');
  });

  test('rule 12 `upload` of a >1 MB file (chunked) with --token', async () => {
    const d = await create(B.url, { markdown: 'small' });
    const big = 'y'.repeat(1100 * 1024);
    const f = file(`ub-${uniq()}.md`, big);
    const no = await cli(['upload', d.id, f]);
    assert.notEqual(no.code, 0, 'chunked upload without a token exits non-zero');
    assert.equal(await serverMarkdown(B.url, d.id), 'small');
    const r = await cli(['upload', d.id, f, '--token', d.editToken]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await serverMarkdown(B.url, d.id)).length, big.length);
  });

  test('rule 12 `add-file` needs --token (or MDREVIEW_EDIT_TOKEN)', async () => {
    const d = await create(B.url, { markdown: 'files' });
    const f = file(`notes-${uniq()}.txt`, 'notes');
    const no = await cli(['add-file', d.id, f]);
    assert.notEqual(no.code, 0, 'add-file without a token exits non-zero');
    assert.deepEqual((await http(B.url, 'GET', `/paste/${d.id}/files`)).json, [], 'no file added');
    const yes = await cli(['add-file', d.id, f, '--token', d.editToken]);
    assert.equal(yes.code, 0, yes.stderr);
    const env = await cli(['add-file', d.id, file(`more-${uniq()}.txt`, 'more')], { MDREVIEW_EDIT_TOKEN: d.editToken });
    assert.equal(env.code, 0, env.stderr);
    assert.equal((await http(B.url, 'GET', `/paste/${d.id}/files`)).json.length, 2);
  });

  test('rule 12 `patch` needs --token (or MDREVIEW_EDIT_TOKEN)', async () => {
    const d = await create(B.url, { markdown: 'one\ntwo\n' });
    const diff = file(`p-${uniq()}.diff`, '@@ -2 +2 @@\n-two\n+TWO\n');
    const no = await cli(['patch', d.id, diff]);
    assert.notEqual(no.code, 0, 'patch without a token exits non-zero');
    assert.equal(await serverMarkdown(B.url, d.id), 'one\ntwo\n');
    const yes = await cli(['patch', d.id, diff, '--token', d.editToken]);
    assert.equal(yes.code, 0, yes.stderr);
    assert.equal(await serverMarkdown(B.url, d.id), 'one\nTWO\n');
    const diff2 = file(`p2-${uniq()}.diff`, '@@ -1 +1 @@\n-one\n+ONE\n');
    const env = await cli(['patch', d.id, diff2], { MDREVIEW_EDIT_TOKEN: d.editToken });
    assert.equal(env.code, 0, env.stderr);
    assert.equal(await serverMarkdown(B.url, d.id), 'ONE\nTWO\n');
  });
});
