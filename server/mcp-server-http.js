import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createHandlers, editTokenArg, viewArg, AGENT_MARKER_HINT, registerSharedTools, toolResult, SESSION_ID_DESC, ADD_COMMENT_DESC, LINE_ARGS } from './mcp-server.js';
import { createSessionRegistry } from './mcp-sessions.js';
import { checkTokenStore } from './mcp-token-store.js';

const PASTE_API_URL = process.env.PASTE_API_URL || 'http://localhost:3100';
// Public URL that clients use in shell commands (curl). Falls back to PASTE_API_URL
// (never a hard-coded host: the commands must reach the configured backend).
const PASTE_PUBLIC_URL = process.env.PASTE_PUBLIC_URL || PASTE_API_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://kartikeyam1.github.io/md-review';
// The backend's public origin (#22): when set, share links point at its /d/ meta pages.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const MCP_PORT = parseInt(process.env.MCP_PORT || '3200', 10);
// Idle sessions are closed after this long; the registry never holds more than MCP_MAX_SESSIONS.
const MCP_SESSION_TTL_MS = parseInt(process.env.MCP_SESSION_TTL_MS || String(30 * 60 * 1000), 10);
const MCP_MAX_SESSIONS = parseInt(process.env.MCP_MAX_SESSIONS || '200', 10);
const MCP_SWEEP_INTERVAL_MS = parseInt(process.env.MCP_SWEEP_INTERVAL_MS || String(60 * 1000), 10);

const CATEGORY_ENUM = z.enum(['suggestion', 'question', 'must-fix', 'nit']);

function registerTools(server, handlers) {
  server.registerTool('create_session', {
    title: 'Create Review Session',
    description: 'Create a review session from Markdown or HTML content, or a local file path. HTML documents are rendered faithfully in a sandboxed preview. For LARGE files (>10KB), use create_via_shell instead — it streams directly from disk without bloating conversation context.' + AGENT_MARKER_HINT,
    inputSchema: z.object({
      author: z.string().optional().describe('Who is writing (recorded on the revision). Defaults to "agent" for updates; use a person\'s name when acting on their behalf.'),
      markdown: z.string().optional().describe('The document content — Markdown or HTML (provide this OR filePath). Markdown extras: GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` on the first quote line, optional title after it) and inline RAG status badges `:rag-green[On track]` / `:rag-amber[At risk]` / `:rag-red[Blocked]`.'),
      filePath: z.string().optional().describe('Not available over HTTP (this server cannot read your files): for a file on disk use create_via_shell.'),
      filename: z.string().optional().describe('Display name for the file, e.g. "report.html" (defaults to basename of filePath if provided)'),
      contentType: z.enum(['markdown', 'html']).optional().describe("Force the document type. Omit to auto-detect from the filename extension (.html/.htm → html)."),
      comments: z.array(z.any()).optional().describe('Pre-existing comments'),
      sessionName: z.string().optional().describe('Custom human-readable name for the session'),
      callbackUrl: z.string().optional().describe('Webhook URL to POST approval status changes to'),
      slug: z.string().optional().describe('Custom URL-safe slug (auto-generated from sessionName if omitted)'),
      expiryDays: z.number().nullable().optional().describe('Session expiry in days (1, 7, 30, 90, or null for never). Default: 30'),
      mode: z.enum(['publish', 'review']).optional().describe('Doc mode. publish = read-only page for humans (default); review = comments and approval.'),
    }).refine(data => data.markdown || data.filePath, {
      message: 'Either markdown or filePath must be provided',
    }),
  }, async (args) => {
    const result = await handlers.create_session(args);
    return toolResult(result);
  });

  server.registerTool('get_session', {
    title: 'Get Review Session',
    description: "Get a session's full state, including its doc `mode` (publish = read-only page for humans, review = comments and approval). Use 'fields' to load only specific parts for large sessions. view: 'human' returns the Markdown without its agent-only sections; the default 'agent' returns the full source. rawUrl is the raw Markdown (GET, no auth).",
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
      fields: z.string().optional().describe('Comma-separated fields to load: meta,content,comments,files. Omit for full response.'),
      view: viewArg(),
    }),
  }, async (args) => {
    const result = await handlers.get_session(args);
    return toolResult(result);
  });

  server.registerTool('list_comments', {
    title: 'List Comments',
    description: 'Get just the comments for a session.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
    }),
  }, async (args) => {
    const result = await handlers.list_comments(args);
    return toolResult(result);
  });

  server.registerTool('add_comment', {
    title: 'Add Comment',
    description: ADD_COMMENT_DESC,
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      ...LINE_ARGS(),
      selectedText: z.string().min(1).describe('The text being commented on (non-empty)'),
      body: z.string().min(1).describe('The comment content (non-empty)'),
      category: CATEGORY_ENUM.describe('Comment category'),
      author: z.string().optional().describe('Agent identifier, e.g. "claude-code"'),
    }),
  }, async (args) => {
    const result = await handlers.add_comment(args);
    return toolResult(result);
  });

  server.registerTool('edit_comment', {
    title: 'Edit Comment',
    description: "Update a comment's body or category. At least one must be provided.",
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      commentId: z.string().describe('The comment ID'),
      body: z.string().optional().describe('New comment body'),
      category: CATEGORY_ENUM.optional().describe('New category'),
    }),
  }, async (args) => {
    const result = await handlers.edit_comment(args);
    return toolResult(result);
  });

  server.registerTool('delete_comment', {
    title: 'Delete Comment',
    description: 'Remove a comment.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      commentId: z.string().describe('The comment ID'),
    }),
  }, async (args) => {
    const result = await handlers.delete_comment(args);
    return toolResult(result);
  });

  server.registerTool('add_reply', {
    title: 'Add Reply',
    description: 'Reply to an existing comment. Replies are plain text, single-level (no nesting).',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      commentId: z.string().describe('The parent comment ID'),
      body: z.string().describe('The reply text'),
      author: z.string().optional().describe('Agent identifier, e.g. "claude-code"'),
    }),
  }, async (args) => {
    const result = await handlers.add_reply(args);
    return toolResult(result);
  });

  server.registerTool('edit_reply', {
    title: 'Edit Reply',
    description: 'Update the body of an existing reply.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      commentId: z.string().describe('The parent comment ID'),
      replyId: z.string().describe('The reply ID'),
      body: z.string().describe('New reply body'),
    }),
  }, async (args) => {
    const result = await handlers.edit_reply(args);
    return toolResult(result);
  });

  server.registerTool('delete_reply', {
    title: 'Delete Reply',
    description: 'Remove a reply from a comment.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      commentId: z.string().describe('The parent comment ID'),
      replyId: z.string().describe('The reply ID'),
    }),
  }, async (args) => {
    const result = await handlers.delete_reply(args);
    return toolResult(result);
  });

  server.registerTool('update_markdown', {
    title: 'Update Markdown',
    description: 'Update the markdown content of a session. Provide markdown, filePath, or patch (unified diff). For large files (>1MB), content is automatically uploaded in chunks.' + AGENT_MARKER_HINT,
    inputSchema: z.object({
      author: z.string().optional().describe('Who is writing (recorded on the revision). Defaults to "agent" for updates; use a person\'s name when acting on their behalf.'),
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
      markdown: z.string().optional().describe('New markdown content (provide this OR filePath OR patch)'),
      filePath: z.string().optional().describe('Not available over HTTP (this server cannot read your files): for a file on disk use upload_via_shell.'),
      patch: z.string().optional().describe('Unified diff to apply as a delta update (provide this OR markdown OR filePath)'),
      expectedContentHash: z.string().optional().describe('Optimistic-concurrency guard: the content_hash you last read (from get_session). The write is rejected with 412 if the document changed since, so you never overwrite someone else\'s edits.'),
      filename: z.string().optional().describe('New filename (preserved if omitted)'),
    }).refine(data => data.markdown || data.filePath || data.patch, {
      message: 'Either markdown, filePath, or patch must be provided',
    }),
  }, async (args) => {
    const result = await handlers.update_markdown(args);
    return toolResult(result);
  });

  server.registerTool('get_approval_status', {
    title: 'Get Approval Status',
    description: 'Get the approval status of a review doc: approval_status (pending|approved|changes_requested), approved_by, approved_at, '
      + 'approved_revision (the content hash the approval covers). Approval follows the content: any content change after an approval puts the doc back to pending (approval_reset_at says when).',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
    }),
  }, async (args) => {
    const result = await handlers.get_approval_status(args);
    return toolResult(result);
  });

  server.registerTool('resolve_comment', {
    title: 'Resolve Comment',
    description: 'Mark a comment as resolved.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      commentId: z.string().describe('The comment ID'),
      resolvedBy: z.string().optional().describe('Who resolved it'),
    }),
  }, async (args) => {
    const result = await handlers.resolve_comment(args);
    return toolResult(result);
  });

  server.registerTool('unresolve_comment', {
    title: 'Unresolve Comment',
    description: 'Mark a comment as unresolved.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      commentId: z.string().describe('The comment ID'),
    }),
  }, async (args) => {
    const result = await handlers.unresolve_comment(args);
    return toolResult(result);
  });

  // ── Session management tools ─────────────────────────────────────────────

  server.registerTool('list_revisions', {
    title: 'List Revisions',
    description: "Content history of a session, oldest first: who changed the document, when, and the content hash of each revision. Consecutive writes by the same author within a few minutes are folded into one revision. Use get_revision to read an older version, or diff two hashes to see what changed since you last read it.",
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
    }),
  }, async (args) => {
    const result = await handlers.list_revisions(args);
    return toolResult(result);
  });

  server.registerTool('get_revision', {
    title: 'Get Revision',
    description: "Read one stored revision of a session's content by hash (from list_revisions), or 'current' for the live content. An unknown hash is a 'Revision not found' error; a known one whose content is no longer stored is a 410 error.",
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      hash: z.string().optional().describe("Revision content hash, or 'current' (default)"),
    }),
  }, async (args) => {
    const result = await handlers.get_revision(args);
    return toolResult(result);
  });

  server.registerTool('list_sessions', {
    title: 'List Sessions',
    description: 'List all sessions, newest first; each item has id, slug, url (the doc link), mode (publish|review), approval status, counts and, for docs published with upsert_session, upsert_key. Filter by approval status, session/file name pattern, or limit results.',
    inputSchema: z.object({
      status: z.enum(['pending', 'approved', 'changes_requested']).optional().describe('Filter by approval status'),
      namePattern: z.string().optional().describe('Regex to match against sessionName or filename (case-insensitive)'),
      limit: z.number().optional().describe('Max number of results to return'),
    }),
  }, async (args) => {
    const result = await handlers.list_sessions(args);
    return toolResult(result);
  });

  server.registerTool('delete_session', {
    title: 'Delete Session',
    description: 'Permanently delete a review session and all its files.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
    }),
  }, async (args) => {
    const result = await handlers.delete_session(args);
    return toolResult(result);
  });

  server.registerTool('update_session_meta', {
    title: 'Update Session Metadata',
    description: 'Update session name, slug, expiry or doc mode (publish|review).',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
      sessionName: z.string().optional().describe('New session name'),
      slug: z.string().optional().describe('New URL slug. The old slug keeps working as an alias (links already shared keep resolving, to the new URL); "" removes the slug (and releases it).'),
      expiryDays: z.number().nullable().optional().describe('New expiry in days (1, 7, 30, 90, or null for never), counted from now'),
      mode: z.enum(['publish', 'review']).optional().describe('Doc mode. publish = read-only page for humans; review = comments and approval.'),
    }),
  }, async (args) => {
    const result = await handlers.update_session_meta(args);
    return toolResult(result);
  });

  // ── Content tools ───────────────────────────────────────────────────────

  server.registerTool('patch_markdown', {
    title: 'Patch Markdown',
    description: 'Apply a unified diff patch to the session markdown. Much more efficient than re-sending the entire file for small changes.' + AGENT_MARKER_HINT,
    inputSchema: z.object({
      author: z.string().optional().describe('Who is writing (recorded on the revision). Defaults to "agent" for updates; use a person\'s name when acting on their behalf.'),
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
      patch: z.string().describe('Unified diff format patch to apply'),
      expectedContentHash: z.string().optional().describe('Optimistic-concurrency guard: the content_hash you last read (from get_session). The write is rejected with 412 if the document changed since, so you never overwrite someone else\'s edits.'),
      filename: z.string().optional().describe('New filename (preserved if omitted)'),
    }),
  }, async (args) => {
    const result = await handlers.patch_markdown(args);
    return toolResult(result);
  });

  server.registerTool('add_file', {
    title: 'Add File to Session',
    description: 'Add a file to the session file collection: text as is, binary files base64-encoded (encoding "base64"). filePath is not available over HTTP: for a file on disk use add_file_via_shell. Files over 1 MB are uploaded in chunks automatically.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
      name: z.string().describe('File name/path within the collection (e.g. "src/main.ts")'),
      content: z.string().describe('File content (text or base64-encoded)'),
      encoding: z.enum(['utf-8', 'base64']).optional().describe('"utf-8" for text, "base64" for binary. Default: utf-8'),
    }),
  }, async (args) => {
    const result = await handlers.add_file(args);
    return toolResult(result);
  });

  server.registerTool('list_files', {
    title: 'List Session Files',
    description: 'List all files in a session file collection.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
    }),
  }, async (args) => {
    const result = await handlers.list_files(args);
    return toolResult(result);
  });

  server.registerTool('remove_file', {
    title: 'Remove File from Session',
    description: 'Remove a file from the session file collection.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
      name: z.string().describe('File name/path to remove'),
    }),
  }, async (args) => {
    const result = await handlers.remove_file(args);
    return toolResult(result);
  });

  server.registerTool('get_file', {
    title: 'Get File Content',
    description: 'Get a file from the session file collection: {name, mime, encoding, size, content}. Text files come back as UTF-8 (encoding "utf-8"); binary files (images, PDFs, …) as base64 (encoding "base64", the same form add_file takes).',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      name: z.string().describe('File name/path to retrieve'),
    }),
  }, async (args) => {
    const result = await handlers.get_file(args);
    return toolResult(result);
  });

  // ── Shell command tools (file content never enters conversation) ──────────

  server.registerTool('create_via_shell', {
    title: 'Create Session via Shell',
    description: 'Returns a shell command that creates a review session from a local file. Run the returned command — file content streams directly to the server.',
    inputSchema: z.object({
      filePath: z.string().describe('Absolute path to the file on your machine (Markdown or HTML)'),
      sessionName: z.string().optional().describe('Human-readable session name'),
      slug: z.string().optional().describe('Custom URL slug'),
      expiryDays: z.number().nullable().optional().describe('Expiry in days (1, 7, 30, 90, or null for never)'),
      callbackUrl: z.string().optional().describe('Webhook URL for approval changes'),
      contentType: z.enum(['markdown', 'html']).optional().describe('Force document type. Omit to auto-detect from the file extension.'),
      mode: z.enum(['publish', 'review']).optional().describe('Doc mode. publish = read-only page for humans (default); review = comments and approval.'),
    }),
  }, async (args) => {
    const result = await handlers.create_via_shell(args);
    return toolResult(result);
  });

  server.registerTool('upload_via_shell', {
    title: 'Upload File via Shell',
    description: 'Returns a shell command that uploads a local file to an existing session. Content streams directly — never enters this conversation.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
      filePath: z.string().describe('Absolute path to the file'),
      filename: z.string().optional().describe('Override display filename'),
    }),
  }, async (args) => {
    const result = await handlers.upload_via_shell(args);
    return toolResult(result);
  });

  server.registerTool('add_file_via_shell', {
    title: 'Add File via Shell',
    description: 'Returns a shell command that adds a local file to a session file collection. Streams directly — never enters conversation.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
      filePath: z.string().describe('Absolute path to the file'),
      encoding: z.enum(['utf-8', 'base64']).optional().describe('"utf-8" for text (default), "base64" for binary'),
    }),
  }, async (args) => {
    const result = await handlers.add_file_via_shell(args);
    return toolResult(result);
  });

  registerSharedTools(server, handlers);

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
}

// A token store that cannot be written would silently forget every edit token: refuse to start.
try { checkTokenStore(); } catch (e) { console.error(`[md-review mcp] ${e.message}`); process.exit(1); }

// Live sessions, expired after an idle TTL and capped (see mcp-sessions.js).
const sessions = createSessionRegistry({
  ttlMs: MCP_SESSION_TTL_MS,
  maxSessions: MCP_MAX_SESSIONS,
  onEvict: (id, transport, reason) => {
    console.log(`[mcp] closing session ${id} (${reason}); active=${sessions.size()}`);
    Promise.resolve(transport.close()).catch(() => {});
  },
});
const sweeper = setInterval(() => {
  const n = sessions.sweep();
  if (n > 0) console.log(`[mcp] swept ${n} idle session(s); active=${sessions.size()}`);
}, MCP_SWEEP_INTERVAL_MS);
sweeper.unref();

async function createTransport() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const server = new McpServer({ name: 'md-review', version: '1.0.0' });
  registerTools(server, handlers);
  await server.connect(transport);
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) sessions.remove(sid);
  };
  return transport;
}

// HTTP transport: agents connect remotely, so filePath would read from server, not agent.
// Disable local file access — agents must send content directly.
// pasteApiUrl = internal (server-to-server), pastePublicUrl = for shell commands (client-side curl).
const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, pastePublicUrl: PASTE_PUBLIC_URL, frontendUrl: FRONTEND_URL, publicBaseUrl: PUBLIC_BASE_URL, allowLocalFiles: false });

const httpServer = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http', sessions: sessions.stats() }));
  }

  // Only handle /mcp path
  if (req.url !== '/mcp') {
    res.writeHead(404);
    return res.end('Not found');
  }

  const sessionId = req.headers['mcp-session-id'];

  if (req.method === 'POST' && !sessionId) {
    // New session — create a fresh McpServer + transport
    const transport = await createTransport();
    await transport.handleRequest(req, res);
    if (transport.sessionId) {
      sessions.add(transport.sessionId, transport);
    }
    return;
  }

  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    // Existing session — route to its transport (get() also refreshes its idle timer)
    return existing.handleRequest(req, res);
  }

  if (sessionId && req.method === 'POST') {
    // Stale/unknown session — auto-reinitialize instead of rejecting.
    // This server is stateless (every tool call just hits the paste API),
    // so there's no session state to lose.
    const transport = await createTransport();
    await transport.handleRequest(req, res);
    if (transport.sessionId) {
      sessions.add(transport.sessionId, transport);
    }
    return;
  }

  // No session and not POST
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Send a POST to /mcp without mcp-session-id to initialize.' }));
});

httpServer.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`MCP HTTP server running on http://0.0.0.0:${MCP_PORT}/mcp`);
});
