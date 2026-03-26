# MCP Server for md-review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a stdio-based MCP server that wraps the paste service HTTP API, enabling Claude Code and other MCP-capable agents to create review sessions, manage comments, and update markdown through native tool calls.

**Architecture:** A single Node.js file (`mcp-server.js`) uses the `@modelcontextprotocol/sdk` to define 7 tools and 1 resource. Each tool translates its parameters into one HTTP request against the paste service at `PASTE_API_URL`. The server runs over stdio transport. Tool handler logic is exported for direct unit testing without spinning up the transport.

**Tech Stack:** Node.js (ESM), `@modelcontextprotocol/sdk` + `zod`, Node built-in test runner

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `/home/ubuntu/paste-service/package.json` | Project metadata, dependencies (`@modelcontextprotocol/sdk`, `zod`) |
| Create | `/home/ubuntu/paste-service/mcp-server.js` | MCP server — tool definitions, HTTP translation, stdio transport |
| Create | `/home/ubuntu/paste-service/test-mcp.mjs` | Unit tests for tool handler functions (mocked fetch) |
| Modify | `/home/ubuntu/.mcp.json` | Register `md-review` MCP server |

---

### Task 1: Initialize package.json and install dependencies

**Files:**
- Create: `/home/ubuntu/paste-service/package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "md-review-mcp-server",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd /home/ubuntu/paste-service && npm install @modelcontextprotocol/sdk zod`
Expected: `node_modules` created, `package.json` updated with dependencies

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add package.json package-lock.json
git commit -m "chore: add package.json with MCP SDK and zod dependencies"
```

---

### Task 2: Write failing tests for create_session and get_session

**Files:**
- Create: `/home/ubuntu/paste-service/test-mcp.mjs`

The test file imports handler functions directly and mocks `fetch` globally so no HTTP server or stdio transport is needed.

- [ ] **Step 1: Write the test file with create_session and get_session tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

// We'll import the handlers once they exist
// import { createHandlers } from './mcp-server.js';

const PASTE_API_URL = 'http://localhost:3100';
const FRONTEND_URL = 'http://localhost:58747';

// Mock fetch helper — returns a function that captures the last call and returns a canned response
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

test('create_session — returns id and shareUrl', async () => {
  const fetchMock = mockFetch(200, { id: 'abc123' });

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  const result = await handlers.create_session({ markdown: '# Hello', filename: 'test.md' });

  assert.equal(result.id, 'abc123');
  assert.equal(result.shareUrl, `${FRONTEND_URL}/#shared=abc123`);

  // Verify fetch was called correctly
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

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  await handlers.create_session({ markdown: '# Hi', filename: 'f.md' });

  const sentBody = JSON.parse(fetchMock.calls[0].opts.body);
  // sharedAt should be a valid ISO 8601 string
  const parsed = new Date(sentBody.sharedAt);
  assert.ok(!isNaN(parsed.getTime()), 'sharedAt should be a valid date');
});

test('get_session — returns full state with appended shareUrl', async () => {
  const sessionData = {
    markdown: '# Test',
    filename: 'test.md',
    comments: [],
    sharedAt: '2026-03-26T00:00:00.000Z',
  };
  const fetchMock = mockFetch(200, sessionData);

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  const result = await handlers.get_session({ sessionId: 'abc123' });

  assert.equal(result.markdown, '# Test');
  assert.equal(result.filename, 'test.md');
  assert.deepEqual(result.comments, []);
  assert.equal(result.sharedAt, '2026-03-26T00:00:00.000Z');
  assert.equal(result.shareUrl, `${FRONTEND_URL}/#shared=abc123`);

  assert.equal(fetchMock.calls[0].url, `${PASTE_API_URL}/paste/abc123`);
});

test('get_session — returns error for nonexistent session', async () => {
  const fetchMock = mockFetch(404, { error: 'not found' });

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  const result = await handlers.get_session({ sessionId: 'nonexistent' });

  assert.equal(result.error, 'Session not found');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ubuntu/paste-service && node --test test-mcp.mjs`
Expected: FAIL — `mcp-server.js` does not export `createHandlers`

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add test-mcp.mjs
git commit -m "test: add failing tests for create_session and get_session handlers"
```

---

### Task 3: Implement mcp-server.js with create_session and get_session

**Files:**
- Create: `/home/ubuntu/paste-service/mcp-server.js`

The server exports a `createHandlers` factory (for testability) and, when run directly, starts the MCP server with stdio transport.

- [ ] **Step 1: Implement the server skeleton with create_session and get_session**

```js
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PASTE_API_URL = process.env.PASTE_API_URL || 'http://localhost:3100';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:58747';

// ── Handler factory (exported for testing) ──────────────────────────────────

export function createHandlers({ pasteApiUrl, frontendUrl, fetchFn = fetch }) {
  async function apiCall(path, opts = {}) {
    let res;
    try {
      res = await fetchFn(`${pasteApiUrl}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
      });
    } catch {
      return { error: `Could not reach paste service at ${pasteApiUrl}` };
    }
    if (res.status === 404) {
      const body = await res.json().catch(() => ({}));
      if (body.error?.includes('comment')) return { error: 'Comment not found' };
      return { error: 'Session not found' };
    }
    if (!res.ok) {
      return { error: `Paste service returned ${res.status}` };
    }
    return res.json();
  }

  return {
    async create_session({ markdown, filename, comments }) {
      const payload = {
        markdown,
        filename,
        sharedAt: new Date().toISOString(),
        comments: comments || [],
      };
      const result = await apiCall('/paste', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.error) return result;
      return { id: result.id, shareUrl: `${frontendUrl}/#shared=${result.id}` };
    },

    async get_session({ sessionId }) {
      const result = await apiCall(`/paste/${sessionId}`);
      if (result.error) return result;
      return { ...result, shareUrl: `${frontendUrl}/#shared=${sessionId}` };
    },
  };
}
```

- [ ] **Step 2: Run tests to verify create_session and get_session pass**

Run: `cd /home/ubuntu/paste-service && node --test test-mcp.mjs`
Expected: All 4 tests PASS

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add mcp-server.js
git commit -m "feat: implement create_session and get_session handlers"
```

---

### Task 4: Write failing tests for list_comments, add_comment, edit_comment, delete_comment

**Files:**
- Modify: `/home/ubuntu/paste-service/test-mcp.mjs`

- [ ] **Step 1: Append comment operation tests**

Add the following tests to the end of `test-mcp.mjs`:

```js
test('list_comments — returns filename and comments', async () => {
  const responseData = { filename: 'test.md', comments: [{ id: 'c1', body: 'hello' }] };
  const fetchMock = mockFetch(200, responseData);

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  const result = await handlers.list_comments({ sessionId: 'abc123' });

  assert.equal(result.filename, 'test.md');
  assert.deepEqual(result.comments, [{ id: 'c1', body: 'hello' }]);
  assert.equal(fetchMock.calls[0].url, `${PASTE_API_URL}/paste/abc123/comments`);
});

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

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  const result = await handlers.add_comment({
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

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  // With author
  await handlers.add_comment({
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
  await handlers.add_comment({
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

test('edit_comment — sends partial update', async () => {
  const updatedComment = { id: 'c1', body: 'New body', category: 'nit' };
  const fetchMock = mockFetch(200, updatedComment);

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  const result = await handlers.edit_comment({
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

test('delete_comment — returns ok', async () => {
  const fetchMock = mockFetch(204, null);
  // Override json() for 204 (no content)
  fetchMock.calls; // just reference
  const originalFn = fetchMock;
  const wrappedFetch = async (url, opts) => {
    const result = await originalFn(url, opts);
    return { ...result, ok: true, status: 204, json: async () => ({}) };
  };
  wrappedFetch.calls = originalFn.calls;

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: wrappedFetch });

  const result = await handlers.delete_comment({ sessionId: 'abc123', commentId: 'c1' });

  assert.deepEqual(result, { ok: true });

  const call = wrappedFetch.calls[0];
  assert.equal(call.url, `${PASTE_API_URL}/paste/abc123/comments/c1`);
  assert.equal(call.opts.method, 'DELETE');
});
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `cd /home/ubuntu/paste-service && node --test test-mcp.mjs`
Expected: New tests FAIL — handlers `list_comments`, `add_comment`, `edit_comment`, `delete_comment` don't exist yet

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add test-mcp.mjs
git commit -m "test: add failing tests for comment CRUD handlers"
```

---

### Task 5: Implement list_comments, add_comment, edit_comment, delete_comment handlers

**Files:**
- Modify: `/home/ubuntu/paste-service/mcp-server.js`

- [ ] **Step 1: Add comment handlers to the returned object in createHandlers**

Add these methods to the object returned by `createHandlers`, after `get_session`:

```js
    async list_comments({ sessionId }) {
      return apiCall(`/paste/${sessionId}/comments`);
    },

    async add_comment({ sessionId, startLine, endLine, selectedText, body, category, author }) {
      const payload = { startLine, endLine, selectedText, body, category };
      if (author !== undefined) payload.author = author;
      return apiCall(`/paste/${sessionId}/comments`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    async edit_comment({ sessionId, commentId, body, category }) {
      const payload = {};
      if (body !== undefined) payload.body = body;
      if (category !== undefined) payload.category = category;
      return apiCall(`/paste/${sessionId}/comments/${commentId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },

    async delete_comment({ sessionId, commentId }) {
      await apiCall(`/paste/${sessionId}/comments/${commentId}`, {
        method: 'DELETE',
      });
      return { ok: true };
    },
```

- [ ] **Step 2: Run tests to verify all pass**

Run: `cd /home/ubuntu/paste-service && node --test test-mcp.mjs`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add mcp-server.js
git commit -m "feat: implement comment CRUD handlers"
```

---

### Task 6: Write failing tests for update_markdown and error handling

**Files:**
- Modify: `/home/ubuntu/paste-service/test-mcp.mjs`

- [ ] **Step 1: Append update_markdown and error handling tests**

Add to the end of `test-mcp.mjs`:

```js
test('update_markdown — sends markdown and optional filename', async () => {
  const fetchMock = mockFetch(200, { ok: true });

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  const result = await handlers.update_markdown({
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

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  await handlers.update_markdown({ sessionId: 'abc123', markdown: '# Hi' });

  const sentBody = JSON.parse(fetchMock.calls[0].opts.body);
  assert.equal(sentBody.markdown, '# Hi');
  assert.equal(sentBody.filename, undefined);
});

test('error handling — paste service unreachable returns error object', async () => {
  const fetchMock = async () => { throw new Error('ECONNREFUSED'); };

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  const result = await handlers.get_session({ sessionId: 'abc123' });

  assert.equal(result.error, `Could not reach paste service at ${PASTE_API_URL}`);
});

test('error handling — 404 returns descriptive error', async () => {
  const fetchMock = mockFetch(404, { error: 'not found' });

  const { createHandlers } = await import('./mcp-server.js');
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL, fetchFn: fetchMock });

  const result = await handlers.list_comments({ sessionId: 'nonexistent' });

  assert.equal(result.error, 'Session not found');
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd /home/ubuntu/paste-service && node --test test-mcp.mjs`
Expected: `update_markdown` tests FAIL (handler doesn't exist yet)

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add test-mcp.mjs
git commit -m "test: add failing tests for update_markdown and error handling"
```

---

### Task 7: Implement update_markdown handler

**Files:**
- Modify: `/home/ubuntu/paste-service/mcp-server.js`

- [ ] **Step 1: Add update_markdown to createHandlers return object**

Add after `delete_comment`:

```js
    async update_markdown({ sessionId, markdown, filename }) {
      const payload = { markdown };
      if (filename !== undefined) payload.filename = filename;
      return apiCall(`/paste/${sessionId}/markdown`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },
```

- [ ] **Step 2: Run all tests**

Run: `cd /home/ubuntu/paste-service && node --test test-mcp.mjs`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add mcp-server.js
git commit -m "feat: implement update_markdown handler"
```

---

### Task 8: Wire up MCP server with tool registrations, resource, and stdio transport

**Files:**
- Modify: `/home/ubuntu/paste-service/mcp-server.js`

This task adds the MCP server setup code that runs when the file is executed directly. It registers all 7 tools with Zod schemas and the `session://{id}` resource.

- [ ] **Step 1: Add MCP server setup after the createHandlers export**

Append to `mcp-server.js`:

```js
// ── MCP Server Setup (runs when executed directly) ──────────────────────────

const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL });

const server = new McpServer({ name: 'md-review', version: '1.0.0' });

const CATEGORY_ENUM = z.enum(['suggestion', 'question', 'must-fix', 'nit']);

server.registerTool('create_session', {
  title: 'Create Review Session',
  description: 'Create a new review session from markdown content.',
  inputSchema: z.object({
    markdown: z.string().describe('The markdown content'),
    filename: z.string().describe('Display name for the file'),
    comments: z.array(z.any()).optional().describe('Pre-existing comments'),
  }),
}, async (args) => {
  const result = await handlers.create_session(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

server.registerTool('get_session', {
  title: 'Get Review Session',
  description: "Get a session's full state.",
  inputSchema: z.object({
    sessionId: z.string().describe('The session ID'),
  }),
}, async (args) => {
  const result = await handlers.get_session(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

server.registerTool('list_comments', {
  title: 'List Comments',
  description: 'Get just the comments for a session.',
  inputSchema: z.object({
    sessionId: z.string().describe('The session ID'),
  }),
}, async (args) => {
  const result = await handlers.list_comments(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

server.registerTool('add_comment', {
  title: 'Add Comment',
  description: 'Add a comment to a specific line range.',
  inputSchema: z.object({
    sessionId: z.string().describe('The session ID'),
    startLine: z.number().describe('0-indexed line start'),
    endLine: z.number().describe('0-indexed line end'),
    selectedText: z.string().describe('The text being commented on'),
    body: z.string().describe('The comment content'),
    category: CATEGORY_ENUM.describe('Comment category'),
    author: z.string().optional().describe('Agent identifier, e.g. "claude-code"'),
  }),
}, async (args) => {
  const result = await handlers.add_comment(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

server.registerTool('edit_comment', {
  title: 'Edit Comment',
  description: "Update a comment's body or category. At least one must be provided.",
  inputSchema: z.object({
    sessionId: z.string().describe('The session ID'),
    commentId: z.string().describe('The comment ID'),
    body: z.string().optional().describe('New comment body'),
    category: CATEGORY_ENUM.optional().describe('New category'),
  }),
}, async (args) => {
  const result = await handlers.edit_comment(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

server.registerTool('delete_comment', {
  title: 'Delete Comment',
  description: 'Remove a comment.',
  inputSchema: z.object({
    sessionId: z.string().describe('The session ID'),
    commentId: z.string().describe('The comment ID'),
  }),
}, async (args) => {
  const result = await handlers.delete_comment(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

server.registerTool('update_markdown', {
  title: 'Update Markdown',
  description: 'Update the markdown content of a session.',
  inputSchema: z.object({
    sessionId: z.string().describe('The session ID'),
    markdown: z.string().describe('New markdown content'),
    filename: z.string().optional().describe('New filename (preserved if omitted)'),
  }),
}, async (args) => {
  const result = await handlers.update_markdown(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

// ── Resource ────────────────────────────────────────────────────────────────

server.registerResource(
  'session',
  new ResourceTemplate('session://{id}', { list: undefined }),
  {
    title: 'Review Session',
    description: 'Full session JSON for a given session ID',
    mimeType: 'application/json',
  },
  async (uri, { id }) => {
    const result = await handlers.get_session({ sessionId: id });
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(result) }],
    };
  }
);

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Run all tests to ensure nothing broke**

Run: `cd /home/ubuntu/paste-service && node --test test-mcp.mjs`
Expected: All tests still PASS (the MCP server setup runs at import time — the tests import the module, but this is fine because `StdioServerTransport` won't interfere with the test runner since tests use the handlers directly)

NOTE: If tests fail because the MCP server setup runs on import and tries to connect to stdio, we need to guard the server startup behind a check. In that case, wrap the server setup block in:

```js
// Only start the MCP server when run directly (not when imported for tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  // ... all the server setup code ...
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/paste-service
git add mcp-server.js
git commit -m "feat: wire up MCP server with all tools, resource, and stdio transport"
```

---

### Task 9: Register MCP server in .mcp.json

**Files:**
- Modify: `/home/ubuntu/.mcp.json`

- [ ] **Step 1: Add md-review entry to .mcp.json**

Read the current file and add the `md-review` server to the `mcpServers` object:

```json
{
  "mcpServers": {
    "groundcover": {
      "type": "stdio",
      "command": "/home/ubuntu/.local/bin/groundcover-mcp.sh",
      "args": [],
      "env": {}
    },
    "md-review": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/ubuntu/paste-service/mcp-server.js"],
      "env": {
        "PASTE_API_URL": "http://localhost:3100",
        "FRONTEND_URL": "http://localhost:58747"
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/ubuntu
git add .mcp.json
git commit -m "chore: register md-review MCP server in .mcp.json"
```

---

### Task 10: Integration smoke test

No new files. Verify the full chain works with the running paste service.

- [ ] **Step 1: Ensure paste service is running**

Run: `curl -s http://localhost:3100/ | jq .`
Expected: `{ "status": "ok" }`

If not running: `cd /home/ubuntu/paste-service && node server.js &`

- [ ] **Step 2: Run all unit tests one final time**

Run: `cd /home/ubuntu/paste-service && node --test test-mcp.mjs`
Expected: All tests PASS

- [ ] **Step 3: Test MCP server startup**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | node /home/ubuntu/paste-service/mcp-server.js`
Expected: JSON-RPC response with server info (name: "md-review", version: "1.0.0")

- [ ] **Step 4: Commit all remaining changes if any**

```bash
cd /home/ubuntu/paste-service
git add -A
git commit -m "chore: finalize MCP server implementation"
```
