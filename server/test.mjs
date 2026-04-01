import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://localhost:3100';

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
  assert.deepEqual(data, { ok: true });

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
  assert.deepEqual(data, { ok: true });

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
