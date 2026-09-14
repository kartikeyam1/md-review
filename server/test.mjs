import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.PASTE_API || 'http://localhost:3100';

async function json(res) {
  const text = await res.text();
  return JSON.parse(text);
}

// Helper to create a paste and return its id
async function createPaste(content = { markdown: '# Hello\nLine 2\nLine 3', filename: 'test.md' }) {
  const res = await fetch(`${BASE}/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(content),
  });
  assert.equal(res.status, 200);
  const data = await json(res);
  assert.ok(data.id, 'should return an id');
  return data.id;
}

// ── POST /paste/:id/comments ──────────────────────────────────────────────────

test('POST /paste/:id/comments — adds a comment with server-generated id and createdAt', async () => {
  const pasteId = await createPaste();

  const res = await fetch(`${BASE}/paste/${pasteId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 1,
      endLine: 2,
      selectedText: 'Hello',
      body: 'Great content',
      category: 'praise',
    }),
  });

  assert.equal(res.status, 201);
  const comment = await json(res);

  assert.ok(typeof comment.id === 'string' && comment.id.length > 0, 'id should be a non-empty string');
  assert.ok(typeof comment.createdAt === 'number', 'createdAt should be a number');
  assert.equal(comment.startLine, 1);
  assert.equal(comment.endLine, 2);
  assert.equal(comment.selectedText, 'Hello');
  assert.equal(comment.body, 'Great content');
  assert.equal(comment.category, 'praise');
  assert.equal(comment.author, undefined, 'author should not be present when not provided');
});

test('POST /paste/:id/comments — includes author when provided', async () => {
  const pasteId = await createPaste();

  const res = await fetch(`${BASE}/paste/${pasteId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 1,
      endLine: 1,
      selectedText: 'Hello',
      body: 'Nice',
      category: 'praise',
      author: 'alice',
    }),
  });

  assert.equal(res.status, 201);
  const comment = await json(res);
  assert.equal(comment.author, 'alice');
});

test('POST /paste/:id/comments — returns 404 for nonexistent paste', async () => {
  const res = await fetch(`${BASE}/paste/000000000000/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 1,
      endLine: 1,
      selectedText: 'x',
      body: 'y',
      category: 'issue',
    }),
  });

  assert.equal(res.status, 404);
  const data = await json(res);
  assert.equal(data.error, 'not found');
});

test('POST /paste/:id/comments — returns 400 for missing required fields', async () => {
  const pasteId = await createPaste();

  const res = await fetch(`${BASE}/paste/${pasteId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 1,
      // missing endLine, selectedText, body, category
    }),
  });

  assert.equal(res.status, 400);
  const data = await json(res);
  assert.equal(data.error, 'Missing required fields');
});

test('POST /paste/:id/comments — returns 400 for invalid JSON', async () => {
  const pasteId = await createPaste();

  const res = await fetch(`${BASE}/paste/${pasteId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json at all {',
  });

  assert.equal(res.status, 400);
  const data = await json(res);
  assert.equal(data.error, 'Invalid JSON');
});

// ── PUT /paste/:id/comments/:commentId ───────────────────────────────────────

test('PUT /paste/:id/comments/:commentId — updates body and category', async () => {
  const pasteId = await createPaste();

  // First add a comment
  const postRes = await fetch(`${BASE}/paste/${pasteId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 1,
      endLine: 2,
      selectedText: 'Hello',
      body: 'Original body',
      category: 'praise',
    }),
  });
  const created = await json(postRes);
  const commentId = created.id;

  // Now update it
  const putRes = await fetch(`${BASE}/paste/${pasteId}/comments/${commentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'Updated body', category: 'issue' }),
  });

  assert.equal(putRes.status, 200);
  const updated = await json(putRes);
  assert.equal(updated.id, commentId);
  assert.equal(updated.body, 'Updated body');
  assert.equal(updated.category, 'issue');
  // Other fields should be preserved
  assert.equal(updated.startLine, 1);
  assert.equal(updated.endLine, 2);
  assert.equal(updated.selectedText, 'Hello');
});

test('PUT /paste/:id/comments/:commentId — partial update (body only)', async () => {
  const pasteId = await createPaste();

  const postRes = await fetch(`${BASE}/paste/${pasteId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 1,
      endLine: 1,
      selectedText: 'x',
      body: 'Original',
      category: 'praise',
    }),
  });
  const created = await json(postRes);

  const putRes = await fetch(`${BASE}/paste/${pasteId}/comments/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'Only body updated' }),
  });

  assert.equal(putRes.status, 200);
  const updated = await json(putRes);
  assert.equal(updated.body, 'Only body updated');
  assert.equal(updated.category, 'praise'); // unchanged
});

test('PUT /paste/:id/comments/:commentId — returns 404 for nonexistent comment', async () => {
  const pasteId = await createPaste();

  const res = await fetch(`${BASE}/paste/${pasteId}/comments/nonexistent-id`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'update' }),
  });

  assert.equal(res.status, 404);
  const data = await json(res);
  assert.equal(data.error, 'comment not found');
});

// ── DELETE /paste/:id/comments/:commentId ────────────────────────────────────

test('DELETE /paste/:id/comments/:commentId — removes comment, returns 204', async () => {
  const pasteId = await createPaste();

  // Add a comment
  const postRes = await fetch(`${BASE}/paste/${pasteId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 1,
      endLine: 1,
      selectedText: 'x',
      body: 'to be deleted',
      category: 'issue',
    }),
  });
  const created = await json(postRes);

  // Delete it
  const delRes = await fetch(`${BASE}/paste/${pasteId}/comments/${created.id}`, {
    method: 'DELETE',
  });

  assert.equal(delRes.status, 204);

  // Verify it's gone by fetching the comments
  const getRes = await fetch(`${BASE}/paste/${pasteId}/comments`);
  const data = await json(getRes);
  const found = data.comments.find(c => c.id === created.id);
  assert.equal(found, undefined, 'deleted comment should not appear in comments list');
});

test('DELETE /paste/:id/comments/:commentId — returns 404 for nonexistent paste', async () => {
  const res = await fetch(`${BASE}/paste/000000000000/comments/some-id`, {
    method: 'DELETE',
  });

  assert.equal(res.status, 404);
  const data = await json(res);
  assert.equal(data.error, 'not found');
});

test('DELETE /paste/:id/comments/:commentId — returns 404 for nonexistent comment', async () => {
  const pasteId = await createPaste();

  const res = await fetch(`${BASE}/paste/${pasteId}/comments/nonexistent-id`, {
    method: 'DELETE',
  });

  assert.equal(res.status, 404);
  const data = await json(res);
  assert.equal(data.error, 'comment not found');
});

// ── PUT /paste/:id/markdown ───────────────────────────────────────────────────

test('PUT /paste/:id/markdown — updates markdown content, preserves filename', async () => {
  const pasteId = await createPaste({ markdown: '# Original', filename: 'orig.md' });

  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: '# Updated' }),
  });

  assert.equal(res.status, 200);
  const data = await json(res);
  assert.equal(data.ok, true);
  assert.ok(typeof data.content_hash === 'string', 'response carries the new content_hash');

  // Verify the content was updated and filename preserved
  const getRes = await fetch(`${BASE}/paste/${pasteId}/markdown`);
  const updated = await json(getRes);
  assert.equal(updated.markdown, '# Updated');
  assert.equal(updated.filename, 'orig.md');
});

test('PUT /paste/:id/markdown — updates filename when provided', async () => {
  const pasteId = await createPaste({ markdown: '# Hello', filename: 'old.md' });

  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: '# Hello', filename: 'new.md' }),
  });

  assert.equal(res.status, 200);
  const data = await json(res);
  assert.equal(data.ok, true);
  assert.ok(typeof data.content_hash === 'string', 'response carries the new content_hash');

  const getRes = await fetch(`${BASE}/paste/${pasteId}/markdown`);
  const updated = await json(getRes);
  assert.equal(updated.filename, 'new.md');
});

test('PUT /paste/:id/markdown — returns 404 for nonexistent paste', async () => {
  const res = await fetch(`${BASE}/paste/000000000000/markdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: '# Hi' }),
  });

  assert.equal(res.status, 404);
  const data = await json(res);
  assert.equal(data.error, 'not found');
});

// ── ETag ──────────────────────────────────────────────────────────────────────

test('ETag — GET returns ETag header', async () => {
  const pasteId = await createPaste();

  const res = await fetch(`${BASE}/paste/${pasteId}`);
  assert.equal(res.status, 200);

  const etag = res.headers.get('etag');
  assert.ok(etag, 'ETag header should be present');
  assert.match(etag, /^"[a-f0-9]+"$/, 'ETag should be a quoted hex string');
});

test('ETag — GET with matching If-None-Match returns 304', async () => {
  const pasteId = await createPaste();

  const firstRes = await fetch(`${BASE}/paste/${pasteId}`);
  const etag = firstRes.headers.get('etag');
  assert.ok(etag, 'ETag header should be present');

  const secondRes = await fetch(`${BASE}/paste/${pasteId}`, {
    headers: { 'If-None-Match': etag },
  });
  assert.equal(secondRes.status, 304);
});

test('ETag — returns 200 with new ETag after data changes', async () => {
  const pasteId = await createPaste();

  const firstRes = await fetch(`${BASE}/paste/${pasteId}`);
  const etag1 = firstRes.headers.get('etag');

  // Update the markdown to change the data
  await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: '# Changed content' }),
  });

  // Old ETag should now return 200 with new ETag
  const secondRes = await fetch(`${BASE}/paste/${pasteId}`, {
    headers: { 'If-None-Match': etag1 },
  });
  assert.equal(secondRes.status, 200);

  const etag2 = secondRes.headers.get('etag');
  assert.ok(etag2, 'New ETag should be present');
  assert.notEqual(etag1, etag2, 'ETag should change after data changes');
});

// ── CORS ──────────────────────────────────────────────────────────────────────

test('CORS — allows PUT and DELETE methods', async () => {
  const res = await fetch(`${BASE}/paste/abc123`, { method: 'OPTIONS' });
  const methods = res.headers.get('access-control-allow-methods');
  assert.ok(methods, 'Access-Control-Allow-Methods header should be present');
  assert.ok(methods.includes('PUT'), 'PUT should be allowed');
  assert.ok(methods.includes('DELETE'), 'DELETE should be allowed');
});

test('CORS — allows If-None-Match header', async () => {
  const res = await fetch(`${BASE}/paste/abc123`, { method: 'OPTIONS' });
  const allowedHeaders = res.headers.get('access-control-allow-headers');
  assert.ok(allowedHeaders, 'Access-Control-Allow-Headers header should be present');
  assert.ok(allowedHeaders.includes('If-None-Match'), 'If-None-Match should be in allowed headers');
});

test('CORS — exposes ETag header', async () => {
  const res = await fetch(`${BASE}/paste/abc123`, { method: 'OPTIONS' });
  const exposeHeaders = res.headers.get('access-control-expose-headers');
  assert.ok(exposeHeaders, 'Access-Control-Expose-Headers header should be present');
  assert.ok(exposeHeaders.includes('ETag'), 'ETag should be in exposed headers');
});

// ── Durability: optimistic concurrency, validated patches, slug resolution ──

test('PUT /paste/:id/markdown — returns content_hash that matches the stored hash', async () => {
  const pasteId = await createPaste();
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: '# New' }),
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.ok(typeof body.content_hash === 'string' && body.content_hash.length === 32);
  assert.equal(res.headers.get('etag'), `"${body.content_hash}"`);

  const full = await json(await fetch(`${BASE}/paste/${pasteId}`));
  assert.equal(full.content_hash, body.content_hash);
  assert.equal(full.markdown, '# New');
});

test('PUT /paste/:id/markdown — If-Match with the current hash succeeds', async () => {
  const pasteId = await createPaste();
  const { content_hash } = await json(await fetch(`${BASE}/paste/${pasteId}`));
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': `"${content_hash}"` },
    body: JSON.stringify({ markdown: '# Updated with If-Match' }),
  });
  assert.equal(res.status, 200);
});

test('PUT /paste/:id/markdown — stale If-Match is rejected with 412 and the current content', async () => {
  const pasteId = await createPaste({ markdown: 'v1', filename: 'a.md' });
  const { content_hash: staleHash } = await json(await fetch(`${BASE}/paste/${pasteId}`));

  // Someone else writes in between.
  await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: 'v2' }),
  });

  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': staleHash },
    body: JSON.stringify({ markdown: 'v1 + my edits' }),
  });
  assert.equal(res.status, 412);
  const body = await json(res);
  assert.equal(body.markdown, 'v2');
  assert.ok(body.content_hash && body.content_hash !== staleHash);

  // Nothing was written.
  const after = await json(await fetch(`${BASE}/paste/${pasteId}/markdown`));
  assert.equal(after.markdown, 'v2');
});

test('PUT /paste/:id/markdown — base_hash in the body works like If-Match', async () => {
  const pasteId = await createPaste({ markdown: 'v1', filename: 'a.md' });
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: 'x', base_hash: 'deadbeefdeadbeefdeadbeefdeadbeef' }),
  });
  assert.equal(res.status, 412);
});

test('PUT /paste/:id/markdown — rejects a body with neither markdown, patch nor filename', async () => {
  const pasteId = await createPaste();
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nope: 1 }),
  });
  assert.equal(res.status, 400);
});

test('PUT /paste/:id/markdown — applies a clean unified diff', async () => {
  const pasteId = await createPaste({ markdown: '# Test\nLine 2\nLine 3\nLine 4', filename: 't.md' });
  const patch = '@@ -1,2 +1,3 @@\n # Test\n+Inserted via patch\n Line 2\n';
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch }),
  });
  assert.equal(res.status, 200);
  const { markdown } = await json(await fetch(`${BASE}/paste/${pasteId}/markdown`));
  assert.equal(markdown, '# Test\nInserted via patch\nLine 2\nLine 3\nLine 4');
});

test('PUT /paste/:id/markdown — a patch whose context does not match is rejected with 409, document untouched', async () => {
  const original = '# Test\nLine 2\nLine 3';
  const pasteId = await createPaste({ markdown: original, filename: 't.md' });
  const patch = '@@ -1,2 +1,2 @@\n # Test\n-Line TWO (wrong)\n+Line 2 changed\n';
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch }),
  });
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.match(body.error, /mismatch/i);
  const { markdown } = await json(await fetch(`${BASE}/paste/${pasteId}/markdown`));
  assert.equal(markdown, original);
});

test('PUT /paste/:id/markdown — a patch with no hunk headers is rejected', async () => {
  const pasteId = await createPaste();
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: 'just some text' }),
  });
  assert.equal(res.status, 409);
});

test('slug resolution — an all-hex slug like "cafe" still resolves to its session', async () => {
  const suffix = Math.random().toString(16).slice(2, 8);
  const res = await fetch(`${BASE}/paste`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: 'hex slug', filename: 'h.md', slug: `cafe${suffix}` }),
  });
  const { id, slug } = await json(res);
  assert.match(slug, /^[a-f0-9]+$/, 'test needs an all-hex slug');
  const bySlug = await fetch(`${BASE}/paste/${slug}`);
  assert.equal(bySlug.status, 200);
  assert.equal((await json(bySlug)).markdown, 'hex slug');
  await fetch(`${BASE}/paste/${id}`, { method: 'DELETE' });
});

test('concurrency — a slow PUT /markdown does not drop a comment posted while its body was in flight', async () => {
  const net = await import('node:net');
  const pasteId = await createPaste();
  const port = parseInt(new URL(BASE).port, 10);

  const body = JSON.stringify({ markdown: '# replaced by slow agent\n' + 'x'.repeat(2000) });
  const head = `PUT /paste/${pasteId}/markdown HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`;
  const sock = net.connect(port, 'localhost');
  const closed = new Promise(r => { sock.on('close', r); setTimeout(r, 3000); });
  sock.on('data', () => {});
  await new Promise(r => sock.once('connect', r));
  sock.write(head + body.slice(0, 100));
  await new Promise(r => setTimeout(r, 200));

  const c = await fetch(`${BASE}/paste/${pasteId}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startLine: 0, endLine: 1, selectedText: 'x', body: 'UI comment', category: 'nit' }),
  });
  assert.equal(c.status, 201);

  sock.write(body.slice(100)); sock.end();
  await closed;

  const final = await json(await fetch(`${BASE}/paste/${pasteId}`));
  assert.equal((final.comments || []).length, 1, 'comment must survive the overlapping markdown write');
  assert.ok(final.markdown.startsWith('# replaced'), 'markdown write must also land');
});

// ── Robustness: corrupt files, delta writes, count-based patches ────────────

test('a corrupt session file yields 404 and the server keeps serving', async (t) => {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) { t.skip('set DATA_DIR to the test server\'s data dir to run'); return; }
  const fs = await import('node:fs');
  const path = await import('node:path');
  const id = 'c0ffeec0ffee';
  fs.writeFileSync(path.join(dataDir, `${id}.json`), '{ definitely not json');
  const res = await fetch(`${BASE}/paste/${id}`);
  assert.equal(res.status, 404);
  const res2 = await fetch(`${BASE}/paste/${id}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startLine: 0, endLine: 1, selectedText: 'x', body: 'y', category: 'nit' }),
  });
  assert.equal(res2.status, 404);
  // Still alive.
  const health = await fetch(`${BASE}/`);
  assert.equal(health.status, 200);
  fs.unlinkSync(path.join(dataDir, `${id}.json`));
});

test('a corrupt content file yields 500 (never empty content) and the server keeps serving', async (t) => {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) { t.skip('set DATA_DIR to run'); return; }
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pasteId = await createPaste({ markdown: 'real content', filename: 'r.md' });
  fs.writeFileSync(path.join(dataDir, `${pasteId}.content.gz`), Buffer.from('not gzip'));
  const res = await fetch(`${BASE}/paste/${pasteId}`);
  assert.equal(res.status, 500);
  assert.match((await json(res)).error, /unreadable/);
  assert.equal((await fetch(`${BASE}/`)).status, 200);
  await fetch(`${BASE}/paste/${pasteId}`, { method: 'DELETE' });
});

test('PUT /paste/:id/markdown — delta splice applies against the exact base and returns content_hash', async () => {
  const base = 'Hello world.\nSecond line.\n';
  const pasteId = await createPaste({ markdown: base, filename: 'd.md' });
  const { content_hash } = await json(await fetch(`${BASE}/paste/${pasteId}`));
  // Replace "world" with "there": keep "Hello " (6) and ".\nSecond line.\n" (15).
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': content_hash },
    body: JSON.stringify({ delta: { keepStart: 6, keepEnd: 15, insert: 'there' } }),
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.ok, true);
  assert.ok(body.content_hash && body.content_hash !== content_hash);
  const { markdown } = await json(await fetch(`${BASE}/paste/${pasteId}/markdown`));
  assert.equal(markdown, 'Hello there.\nSecond line.\n');
});

test('PUT /paste/:id/markdown — delta without If-Match/base_hash is rejected (400)', async () => {
  const pasteId = await createPaste({ markdown: 'abc', filename: 'd.md' });
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta: { keepStart: 1, keepEnd: 1, insert: 'X' } }),
  });
  assert.equal(res.status, 400);
  assert.equal((await json(await fetch(`${BASE}/paste/${pasteId}/markdown`))).markdown, 'abc');
});

test('PUT /paste/:id/markdown — delta against a stale base is rejected (412), content untouched', async () => {
  const pasteId = await createPaste({ markdown: 'abc', filename: 'd.md' });
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta: { keepStart: 1, keepEnd: 1, insert: 'X' }, base_hash: '00000000000000000000000000000000' }),
  });
  assert.equal(res.status, 412);
  assert.equal((await json(await fetch(`${BASE}/paste/${pasteId}/markdown`))).markdown, 'abc');
});

test('PUT /paste/:id/markdown — delta that does not fit the content is rejected (409); bad shape is 400', async () => {
  const pasteId = await createPaste({ markdown: 'abc', filename: 'd.md' });
  const { content_hash } = await json(await fetch(`${BASE}/paste/${pasteId}`));
  const tooBig = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': content_hash },
    body: JSON.stringify({ delta: { keepStart: 2, keepEnd: 2, insert: '' } }),
  });
  assert.equal(tooBig.status, 409);
  const badShape = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': content_hash },
    body: JSON.stringify({ delta: { keepStart: -1, keepEnd: 'x', insert: 3 } }),
  });
  assert.equal(badShape.status, 400);
  assert.equal((await json(await fetch(`${BASE}/paste/${pasteId}/markdown`))).markdown, 'abc');
});

test('PUT /paste/:id/markdown — patch lines that look like headers ("--- ", "@@") inside a hunk are handled by line counts', async () => {
  const original = '# T\n-- dash line\n@@ at line\nend';
  const pasteId = await createPaste({ markdown: original, filename: 'p.md' });
  // Remove the "-- dash line" (patch line "--- dash line") and the "@@ at line" (patch line "-@@ at line").
  const patch = '@@ -1,4 +1,2 @@\n # T\n--- dash line\n-@@ at line\n end\n';
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch }),
  });
  assert.equal(res.status, 200);
  assert.equal((await json(await fetch(`${BASE}/paste/${pasteId}/markdown`))).markdown, '# T\nend');
});

test('PUT /paste/:id/markdown — a hunk whose body disagrees with its @@ counts is rejected (409)', async () => {
  const pasteId = await createPaste({ markdown: 'a\nb\nc', filename: 'p.md' });
  const res = await fetch(`${BASE}/paste/${pasteId}/markdown`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: '@@ -1,3 +1,3 @@\n a\n-b\n+B\n' }), // header claims 3 source lines, body has 2
  });
  assert.equal(res.status, 409);
  assert.equal((await json(await fetch(`${BASE}/paste/${pasteId}/markdown`))).markdown, 'a\nb\nc');
});

// ── Revision history ────────────────────────────────────────────────────────

const J = { 'Content-Type': 'application/json' };
const revisions = async (id) => json(await fetch(`${BASE}/paste/${id}/revisions`));
const putMd = (id, body, headers = {}) => fetch(`${BASE}/paste/${id}/markdown`, { method: 'PUT', headers: { ...J, ...headers }, body: JSON.stringify(body) });

test('revisions — creating a session records revision 1 with author and client', async () => {
  const res = await fetch(`${BASE}/paste`, {
    method: 'POST', headers: { ...J, 'X-MdReview-Client': 'ui' },
    body: JSON.stringify({ markdown: 'v1', filename: 'r.md', author: 'Alice' }),
  });
  const { id } = await json(res);
  const list = await revisions(id);
  assert.equal(list.revisions.length, 1);
  assert.equal(list.revisions[0].by, 'Alice');
  assert.equal(list.revisions[0].client, 'ui');
  assert.equal(list.revisions[0].parent, null);
  assert.equal(list.current, list.revisions[0].hash);
  const full = await json(await fetch(`${BASE}/paste/${id}`));
  assert.equal(full.author, undefined, 'author is attribution, not session metadata');
  assert.equal(full.revision_count, 1);
  assert.equal(full.latest_revision.by, 'Alice');
  assert.equal(full.revisions, undefined, 'the list is not inlined in the full response');
});

test('revisions — content writes by different authors each add a revision; comment edits do not', async () => {
  const id = await createPaste({ markdown: 'v1', filename: 'r.md' });
  await putMd(id, { markdown: 'v2', author: 'agent' }, { 'X-MdReview-Client': 'mcp' });
  await putMd(id, { markdown: 'v3', author: 'Bob' });
  await fetch(`${BASE}/paste/${id}/comments`, { method: 'POST', headers: J,
    body: JSON.stringify({ startLine: 0, endLine: 1, selectedText: 'v3', body: 'c', category: 'nit' }) });
  const list = await revisions(id);
  assert.deepEqual(list.revisions.map(r => [r.by, r.client]), [[null, 'api'], ['agent', 'mcp'], ['Bob', 'api']]);
  assert.equal(list.revisions[2].parent, list.revisions[1].hash);
  // Unchanged content is not a revision either.
  await putMd(id, { markdown: 'v3', author: 'Bob' });
  assert.equal((await revisions(id)).revisions.length, 3);
});

test('revisions — an older revision can be fetched; "current" aliases the live content', async () => {
  const id = await createPaste({ markdown: 'first draft', filename: 'r.md' });
  const v1 = (await revisions(id)).current;
  await putMd(id, { markdown: 'second draft', author: 'Cara' });
  const old = await json(await fetch(`${BASE}/paste/${id}/revisions/${v1}`));
  assert.equal(old.markdown, 'first draft');
  assert.equal(old.is_current, false);
  const cur = await json(await fetch(`${BASE}/paste/${id}/revisions/current`));
  assert.equal(cur.markdown, 'second draft');
  assert.equal(cur.by, 'Cara');
  assert.equal(cur.is_current, true);
  const unknown = await fetch(`${BASE}/paste/${id}/revisions/${'0'.repeat(32)}`);
  assert.equal(unknown.status, 404);
});

test('revisions — consecutive writes by the same author fold into one revision (editing session)', async () => {
  const id = await createPaste({ markdown: 'start', filename: 'r.md' });
  const h0 = (await revisions(id)).current;
  await putMd(id, { markdown: 'start a', author: 'Dee' }, { 'X-MdReview-Client': 'ui' });
  const mid = (await revisions(id)).current;
  await putMd(id, { markdown: 'start ab', author: 'Dee' }, { 'X-MdReview-Client': 'ui' });
  await putMd(id, { markdown: 'start abc', author: 'Dee' }, { 'X-MdReview-Client': 'ui' });
  const list = await revisions(id);
  assert.equal(list.revisions.length, 2, 'create + one coalesced editing session');
  const span = list.revisions[1];
  assert.equal(span.by, 'Dee');
  assert.equal(span.writes, 3);
  assert.ok(span.at_end && span.at_end >= span.at);
  assert.equal(span.parent, h0, 'the span still points at the revision it replaced');
  assert.equal(span.hash, list.current);
  // The intermediate state is not listed (and its blob is gone), the start state is kept.
  assert.equal((await fetch(`${BASE}/paste/${id}/revisions/${mid}`)).status, 404);
  assert.equal((await json(await fetch(`${BASE}/paste/${id}/revisions/${h0}`))).markdown, 'start');
  // A different author breaks the span.
  await putMd(id, { markdown: 'start abcd', author: 'Eve' }, { 'X-MdReview-Client': 'ui' });
  assert.equal((await revisions(id)).revisions.length, 3);
});

test('revisions — delta and patch writes are attributed like full writes', async () => {
  const id = await createPaste({ markdown: 'Hello world.', filename: 'r.md' });
  const { content_hash } = await json(await fetch(`${BASE}/paste/${id}`));
  await putMd(id, { delta: { keepStart: 6, keepEnd: 1, insert: 'there' }, author: 'Fay' }, { 'If-Match': content_hash, 'X-MdReview-Client': 'ui' });
  await putMd(id, { patch: '@@ -1 +1 @@\n-Hello there.\n+Hello patched.\n', author: 'agent' }, { 'X-MdReview-Client': 'mcp' });
  const list = await revisions(id);
  assert.deepEqual(list.revisions.slice(1).map(r => [r.by, r.client]), [['Fay', 'ui'], ['agent', 'mcp']]);
  assert.equal((await json(await fetch(`${BASE}/paste/${id}/revisions/current`))).markdown, 'Hello patched.');
});

test('revisions — a session created before history existed is seeded with its previous content on first change', async (t) => {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) { t.skip('set DATA_DIR to run'); return; }
  const fs = await import('node:fs');
  const path = await import('node:path');
  const id = await createPaste({ markdown: 'legacy content', filename: 'l.md' });
  // Simulate a pre-history session: strip the list and its blobs.
  const mp = path.join(dataDir, `${id}.json`);
  const meta = JSON.parse(fs.readFileSync(mp, 'utf-8'));
  delete meta.revisions;
  fs.writeFileSync(mp, JSON.stringify(meta));
  fs.rmSync(path.join(dataDir, 'revisions', id), { recursive: true, force: true });
  assert.equal((await revisions(id)).revisions.length, 0);

  await putMd(id, { markdown: 'legacy content + agent edit', author: 'agent' }, { 'X-MdReview-Client': 'mcp' });
  const list = await revisions(id);
  assert.equal(list.revisions.length, 2);
  assert.equal(list.revisions[0].seeded, true);
  assert.equal((await json(await fetch(`${BASE}/paste/${id}/revisions/${list.revisions[0].hash}`))).markdown, 'legacy content');
});

test('revisions — retention cap drops the oldest revisions and their blobs', async (t) => {
  const cap = parseInt(process.env.REVISIONS_MAX || '', 10);
  if (!cap || cap > 10) { t.skip('start the test server with a small REVISIONS_MAX to run'); return; }
  const id = await createPaste({ markdown: 'r0', filename: 'r.md' });
  const hashes = [(await revisions(id)).current];
  for (let i = 1; i <= cap + 2; i++) {
    await putMd(id, { markdown: `r${i}`, author: i % 2 ? 'odd' : 'even' }); // alternate authors → no coalescing
    hashes.push((await revisions(id)).current);
  }
  const list = await revisions(id);
  assert.equal(list.revisions.length, cap);
  assert.equal(list.revisions[list.revisions.length - 1].hash, hashes[hashes.length - 1]);
  assert.equal((await fetch(`${BASE}/paste/${id}/revisions/${hashes[0]}`)).status, 404, 'dropped revision is unknown');
});

test('revisions — deleting a session removes its history', async () => {
  const id = await createPaste({ markdown: 'x', filename: 'r.md' });
  await putMd(id, { markdown: 'y', author: 'Gil' });
  await fetch(`${BASE}/paste/${id}`, { method: 'DELETE' });
  assert.equal((await fetch(`${BASE}/paste/${id}/revisions`)).status, 404);
});
