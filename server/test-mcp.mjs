import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from './mcp-server.js';

const PASTE_API_URL = 'http://localhost:3100';
const FRONTEND_URL = 'http://localhost:58747';

// Mock fetch — returns a function that records calls and returns a canned response
function mockFetch(status, body) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

function makeHandlers(fetchMock) {
  return createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });
}

// ── create_session ──────────────────────────────────────────────────────────

test('create_session — returns id and shareUrl', async () => {
  const fetchMock = mockFetch(200, { id: 'abc123' });
  const h = makeHandlers(fetchMock);

  const result = await h.create_session({ markdown: '# Hello', filename: 'test.md' });

  assert.equal(result.id, 'abc123');
  assert.equal(result.shareUrl, `${FRONTEND_URL}/#shared=abc123`);

  const call = fetchMock.calls[0];
  assert.equal(call.url, `${PASTE_API_URL}/paste`);
  assert.equal(call.opts.method, 'POST');
  const sentBody = JSON.parse(call.opts.body);
  assert.equal(sentBody.markdown, '# Hello');
  assert.equal(sentBody.filename, 'test.md');
  assert.ok(sentBody.sharedAt, 'sharedAt should be auto-generated');
});

test('create_session — auto-generates sharedAt as ISO string', async () => {
  const fetchMock = mockFetch(200, { id: 'xyz' });
  const h = makeHandlers(fetchMock);

  await h.create_session({ markdown: '# Hi', filename: 'f.md' });

  const sentBody = JSON.parse(fetchMock.calls[0].opts.body);
  const parsed = new Date(sentBody.sharedAt);
  assert.ok(!isNaN(parsed.getTime()), 'sharedAt should be a valid ISO date');
});

// ── get_session ─────────────────────────────────────────────────────────────

test('get_session — returns full state with appended shareUrl', async () => {
  const sessionData = {
    markdown: '# Test',
    filename: 'test.md',
    comments: [],
    sharedAt: '2026-03-26T00:00:00.000Z',
  };
  const fetchMock = mockFetch(200, sessionData);
  const h = makeHandlers(fetchMock);

  const result = await h.get_session({ sessionId: 'abc123' });

  assert.equal(result.markdown, '# Test');
  assert.equal(result.filename, 'test.md');
  assert.deepEqual(result.comments, []);
  assert.equal(result.sharedAt, '2026-03-26T00:00:00.000Z');
  assert.equal(result.shareUrl, `${FRONTEND_URL}/#shared=abc123`);
  assert.equal(fetchMock.calls[0].url, `${PASTE_API_URL}/paste/abc123`);
});

test('get_session — returns error for nonexistent session', async () => {
  const fetchMock = mockFetch(404, { error: 'not found' });
  const h = makeHandlers(fetchMock);

  const result = await h.get_session({ sessionId: 'nonexistent' });

  assert.equal(result.error, 'Session not found');
});

// ── list_comments ───────────────────────────────────────────────────────────

test('list_comments — returns filename and comments', async () => {
  const responseData = { filename: 'test.md', comments: [{ id: 'c1', body: 'hello' }] };
  const fetchMock = mockFetch(200, responseData);
  const h = makeHandlers(fetchMock);

  const result = await h.list_comments({ sessionId: 'abc123' });

  assert.equal(result.filename, 'test.md');
  assert.deepEqual(result.comments, [{ id: 'c1', body: 'hello' }]);
  assert.equal(fetchMock.calls[0].url, `${PASTE_API_URL}/paste/abc123/comments`);
});

// ── add_comment ─────────────────────────────────────────────────────────────

test('add_comment — sends correct payload and returns server response', async () => {
  const serverComment = {
    id: 'c-new',
    createdAt: 1711411200000,
    startLine: 0,
    endLine: 2,
    selectedText: 'Hello',
    body: 'Fix this',
    category: 'must-fix',
  };
  const fetchMock = mockFetch(201, serverComment);
  const h = makeHandlers(fetchMock);

  const result = await h.add_comment({
    sessionId: 'abc123',
    startLine: 0,
    endLine: 2,
    selectedText: 'Hello',
    body: 'Fix this',
    category: 'must-fix',
  });

  assert.equal(result.id, 'c-new');
  assert.equal(result.category, 'must-fix');

  const call = fetchMock.calls[0];
  assert.equal(call.url, `${PASTE_API_URL}/paste/abc123/comments`);
  assert.equal(call.opts.method, 'POST');
  const sentBody = JSON.parse(call.opts.body);
  assert.equal(sentBody.startLine, 0);
  assert.equal(sentBody.endLine, 2);
  assert.equal(sentBody.selectedText, 'Hello');
  assert.equal(sentBody.body, 'Fix this');
  assert.equal(sentBody.category, 'must-fix');
});

test('add_comment — includes author when provided, omits when not', async () => {
  const fetchMock = mockFetch(201, { id: 'c1' });
  const h = makeHandlers(fetchMock);

  // With author
  await h.add_comment({
    sessionId: 's1',
    startLine: 0,
    endLine: 0,
    selectedText: 'x',
    body: 'y',
    category: 'nit',
    author: 'claude-code',
  });
  const withAuthor = JSON.parse(fetchMock.calls[0].opts.body);
  assert.equal(withAuthor.author, 'claude-code');

  // Without author
  await h.add_comment({
    sessionId: 's1',
    startLine: 0,
    endLine: 0,
    selectedText: 'x',
    body: 'y',
    category: 'nit',
  });
  const withoutAuthor = JSON.parse(fetchMock.calls[1].opts.body);
  assert.equal(withoutAuthor.author, undefined);
});

// ── edit_comment ────────────────────────────────────────────────────────────

test('edit_comment — sends partial update', async () => {
  const updatedComment = { id: 'c1', body: 'New body', category: 'nit' };
  const fetchMock = mockFetch(200, updatedComment);
  const h = makeHandlers(fetchMock);

  const result = await h.edit_comment({
    sessionId: 'abc123',
    commentId: 'c1',
    body: 'New body',
  });

  assert.equal(result.body, 'New body');

  const call = fetchMock.calls[0];
  assert.equal(call.url, `${PASTE_API_URL}/paste/abc123/comments/c1`);
  assert.equal(call.opts.method, 'PUT');
  const sentBody = JSON.parse(call.opts.body);
  assert.equal(sentBody.body, 'New body');
  assert.equal(sentBody.category, undefined, 'category should not be sent when not provided');
});

// ── delete_comment ──────────────────────────────────────────────────────────

test('delete_comment — returns ok', async () => {
  // 204 No Content — mock json() to return empty (won't be called for success path)
  const calls = [];
  const fetchMock = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 204, json: async () => ({}) };
  };
  fetchMock.calls = calls;

  const h = makeHandlers(fetchMock);
  const result = await h.delete_comment({ sessionId: 'abc123', commentId: 'c1' });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, `${PASTE_API_URL}/paste/abc123/comments/c1`);
  assert.equal(calls[0].opts.method, 'DELETE');
});

// ── update_markdown ─────────────────────────────────────────────────────────

test('update_markdown — sends markdown and optional filename', async () => {
  const fetchMock = mockFetch(200, { ok: true });
  const h = makeHandlers(fetchMock);

  const result = await h.update_markdown({
    sessionId: 'abc123',
    markdown: '# Updated',
    filename: 'new.md',
  });

  assert.deepEqual(result, { ok: true });

  const call = fetchMock.calls[0];
  assert.equal(call.url, `${PASTE_API_URL}/paste/abc123/markdown`);
  assert.equal(call.opts.method, 'PUT');
  const sentBody = JSON.parse(call.opts.body);
  assert.equal(sentBody.markdown, '# Updated');
  assert.equal(sentBody.filename, 'new.md');
});

test('update_markdown — omits filename when not provided', async () => {
  const fetchMock = mockFetch(200, { ok: true });
  const h = makeHandlers(fetchMock);

  await h.update_markdown({ sessionId: 'abc123', markdown: '# Hi' });

  const sentBody = JSON.parse(fetchMock.calls[0].opts.body);
  assert.equal(sentBody.markdown, '# Hi');
  assert.equal(sentBody.filename, undefined);
});

// ── Error handling ──────────────────────────────────────────────────────────

test('error handling — paste service unreachable returns error object', async () => {
  const fetchMock = async () => { throw new Error('ECONNREFUSED'); };
  const h = makeHandlers(fetchMock);

  const result = await h.get_session({ sessionId: 'abc123' });

  assert.equal(result.error, `Could not reach paste service at ${PASTE_API_URL}`);
});

test('error handling — 404 returns descriptive error', async () => {
  const fetchMock = mockFetch(404, { error: 'not found' });
  const h = makeHandlers(fetchMock);

  const result = await h.list_comments({ sessionId: 'nonexistent' });

  assert.equal(result.error, 'Session not found');
});
