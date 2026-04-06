import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createHandlers } from './mcp-server.js';

const PASTE_API_URL = process.env.PASTE_API_URL || 'http://localhost:3100';
// Public URL that clients use in shell commands (curl). Falls back to PASTE_API_URL.
const PASTE_PUBLIC_URL = process.env.PASTE_PUBLIC_URL || 'http://localhost:3100';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://kartikeyam1.github.io/md-review';
const MCP_PORT = parseInt(process.env.MCP_PORT || '3200', 10);

const CATEGORY_ENUM = z.enum(['suggestion', 'question', 'must-fix', 'nit']);

function registerTools(server, handlers) {
  server.registerTool('create_session', {
    title: 'Create Review Session',
    description: 'Create a review session from markdown content or a local file path. For LARGE files (>10KB), use create_via_shell instead — it streams directly from disk without bloating conversation context.',
    inputSchema: z.object({
      markdown: z.string().optional().describe('The markdown content (provide this OR filePath)'),
      filePath: z.string().optional().describe('Absolute path to a markdown file to read (provide this OR markdown)'),
      filename: z.string().optional().describe('Display name for the file (defaults to basename of filePath if provided)'),
      comments: z.array(z.any()).optional().describe('Pre-existing comments'),
      sessionName: z.string().optional().describe('Custom human-readable name for the session'),
      callbackUrl: z.string().optional().describe('Webhook URL to POST approval status changes to'),
      slug: z.string().optional().describe('Custom URL-safe slug (auto-generated from sessionName if omitted)'),
      expiryDays: z.number().nullable().optional().describe('Session expiry in days (7, 30, or null for infinite). Default: 30'),
    }).refine(data => data.markdown || data.filePath, {
      message: 'Either markdown or filePath must be provided',
    }),
  }, async (args) => {
    const result = await handlers.create_session(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('get_session', {
    title: 'Get Review Session',
    description: "Get a session's full state. Use 'fields' to load only specific parts for large sessions.",
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      fields: z.string().optional().describe('Comma-separated fields to load: meta,content,comments,files. Omit for full response.'),
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

  server.registerTool('add_reply', {
    title: 'Add Reply',
    description: 'Reply to an existing comment. Replies are plain text, single-level (no nesting).',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      commentId: z.string().describe('The parent comment ID'),
      body: z.string().describe('The reply text'),
      author: z.string().optional().describe('Agent identifier, e.g. "claude-code"'),
    }),
  }, async (args) => {
    const result = await handlers.add_reply(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('edit_reply', {
    title: 'Edit Reply',
    description: 'Update the body of an existing reply.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      commentId: z.string().describe('The parent comment ID'),
      replyId: z.string().describe('The reply ID'),
      body: z.string().describe('New reply body'),
    }),
  }, async (args) => {
    const result = await handlers.edit_reply(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('delete_reply', {
    title: 'Delete Reply',
    description: 'Remove a reply from a comment.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      commentId: z.string().describe('The parent comment ID'),
      replyId: z.string().describe('The reply ID'),
    }),
  }, async (args) => {
    const result = await handlers.delete_reply(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('update_markdown', {
    title: 'Update Markdown',
    description: 'Update the markdown content of a session. Provide markdown, filePath, or patch (unified diff). For large files (>1MB), content is automatically uploaded in chunks.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      markdown: z.string().optional().describe('New markdown content (provide this OR filePath OR patch)'),
      filePath: z.string().optional().describe('Absolute path to a markdown file to read (provide this OR markdown OR patch)'),
      patch: z.string().optional().describe('Unified diff to apply as a delta update (provide this OR markdown OR filePath)'),
      filename: z.string().optional().describe('New filename (preserved if omitted)'),
    }).refine(data => data.markdown || data.filePath || data.patch, {
      message: 'Either markdown, filePath, or patch must be provided',
    }),
  }, async (args) => {
    const result = await handlers.update_markdown(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('get_approval_status', {
    title: 'Get Approval Status',
    description: 'Get the approval status of a review session.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
    }),
  }, async (args) => {
    const result = await handlers.get_approval_status(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('resolve_comment', {
    title: 'Resolve Comment',
    description: 'Mark a comment as resolved.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
      commentId: z.string().describe('The comment ID'),
      resolvedBy: z.string().optional().describe('Who resolved it'),
    }),
  }, async (args) => {
    const result = await handlers.resolve_comment(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('unresolve_comment', {
    title: 'Unresolve Comment',
    description: 'Mark a comment as unresolved.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
      commentId: z.string().describe('The comment ID'),
    }),
  }, async (args) => {
    const result = await handlers.unresolve_comment(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // ── Session management tools ─────────────────────────────────────────────

  server.registerTool('list_sessions', {
    title: 'List Sessions',
    description: 'List all review sessions. Filter by approval status, session/file name pattern, or limit results.',
    inputSchema: z.object({
      status: z.enum(['pending', 'approved', 'changes_requested']).optional().describe('Filter by approval status'),
      namePattern: z.string().optional().describe('Regex to match against sessionName or filename (case-insensitive)'),
      limit: z.number().optional().describe('Max number of results to return'),
    }),
  }, async (args) => {
    const result = await handlers.list_sessions(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('delete_session', {
    title: 'Delete Session',
    description: 'Permanently delete a review session and all its files.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
    }),
  }, async (args) => {
    const result = await handlers.delete_session(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('update_session_meta', {
    title: 'Update Session Metadata',
    description: 'Update session name, slug, or expiry.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
      sessionName: z.string().optional().describe('New session name'),
      slug: z.string().optional().describe('New URL slug'),
      expiryDays: z.number().nullable().optional().describe('New expiry in days (7, 30, 90, or null for infinite)'),
    }),
  }, async (args) => {
    const result = await handlers.update_session_meta(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // ── Content tools ───────────────────────────────────────────────────────

  server.registerTool('patch_markdown', {
    title: 'Patch Markdown',
    description: 'Apply a unified diff patch to the session markdown. Much more efficient than re-sending the entire file for small changes.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      patch: z.string().describe('Unified diff format patch to apply'),
      filename: z.string().optional().describe('New filename (preserved if omitted)'),
    }),
  }, async (args) => {
    const result = await handlers.patch_markdown(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('add_file', {
    title: 'Add File to Session',
    description: 'Add a file to the session file collection. Read the file yourself and pass content — filePath is not available over HTTP.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      name: z.string().describe('File name/path within the collection (e.g. "src/main.ts")'),
      content: z.string().describe('File content (text or base64-encoded)'),
      encoding: z.enum(['utf-8', 'base64']).optional().describe('"utf-8" for text, "base64" for binary. Default: utf-8'),
    }),
  }, async (args) => {
    const result = await handlers.add_file(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('list_files', {
    title: 'List Session Files',
    description: 'List all files in a session file collection.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
    }),
  }, async (args) => {
    const result = await handlers.list_files(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('remove_file', {
    title: 'Remove File from Session',
    description: 'Remove a file from the session file collection.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      name: z.string().describe('File name/path to remove'),
    }),
  }, async (args) => {
    const result = await handlers.remove_file(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('get_file', {
    title: 'Get File Content',
    description: 'Get the content of a file from the session file collection.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      name: z.string().describe('File name/path to retrieve'),
    }),
  }, async (args) => {
    const result = await handlers.get_file(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // ── Shell command tools (file content never enters conversation) ──────────

  server.registerTool('create_via_shell', {
    title: 'Create Session via Shell',
    description: 'Returns a shell command that creates a review session from a local file. Run the returned command — file content streams directly to the server.',
    inputSchema: z.object({
      filePath: z.string().describe('Absolute path to the file on your machine'),
      sessionName: z.string().optional().describe('Human-readable session name'),
      slug: z.string().optional().describe('Custom URL slug'),
      expiryDays: z.number().nullable().optional().describe('Expiry in days (7, 30, or null for infinite)'),
      callbackUrl: z.string().optional().describe('Webhook URL for approval changes'),
    }),
  }, async (args) => {
    const result = await handlers.create_via_shell(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('upload_via_shell', {
    title: 'Upload File via Shell',
    description: 'Returns a shell command that uploads a local file to an existing session. Content streams directly — never enters this conversation.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      filePath: z.string().describe('Absolute path to the file'),
      filename: z.string().optional().describe('Override display filename'),
    }),
  }, async (args) => {
    const result = await handlers.upload_via_shell(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('add_file_via_shell', {
    title: 'Add File via Shell',
    description: 'Returns a shell command that adds a local file to a session file collection. Streams directly — never enters conversation.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      filePath: z.string().describe('Absolute path to the file'),
      encoding: z.enum(['utf-8', 'base64']).optional().describe('"utf-8" for text (default), "base64" for binary'),
    }),
  }, async (args) => {
    const result = await handlers.add_file_via_shell(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

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

// Track transports per session
const transports = {};

async function createTransport() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const server = new McpServer({ name: 'md-review', version: '1.0.0' });
  registerTools(server, handlers);
  await server.connect(transport);
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && transports[sid]) delete transports[sid];
  };
  return transport;
}

// HTTP transport: agents connect remotely, so filePath would read from server, not agent.
// Disable local file access — agents must send content directly.
// pasteApiUrl = internal (server-to-server), pastePublicUrl = for shell commands (client-side curl).
const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, pastePublicUrl: PASTE_PUBLIC_URL, frontendUrl: FRONTEND_URL, allowLocalFiles: false });

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
    return res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http' }));
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
      transports[transport.sessionId] = transport;
    }
    return;
  }

  if (sessionId && transports[sessionId]) {
    // Existing session — route to its transport
    return transports[sessionId].handleRequest(req, res);
  }

  if (sessionId && req.method === 'POST') {
    // Stale/unknown session — auto-reinitialize instead of rejecting.
    // This server is stateless (every tool call just hits the paste API),
    // so there's no session state to lose.
    const transport = await createTransport();
    await transport.handleRequest(req, res);
    if (transport.sessionId) {
      transports[transport.sessionId] = transport;
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
