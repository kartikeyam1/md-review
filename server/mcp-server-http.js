import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createHandlers } from './mcp-server.js';

const PASTE_API_URL = process.env.PASTE_API_URL || 'http://localhost:3100';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://kartikeyam1.github.io/md-review';
const MCP_PORT = parseInt(process.env.MCP_PORT || '3200', 10);

const CATEGORY_ENUM = z.enum(['suggestion', 'question', 'must-fix', 'nit']);

function registerTools(server, handlers) {
  server.registerTool('create_session', {
    title: 'Create Review Session',
    description: 'Create a new review session from markdown content or a file path. Provide either markdown or filePath.',
    inputSchema: z.object({
      markdown: z.string().optional().describe('The markdown content (provide this OR filePath)'),
      filePath: z.string().optional().describe('Absolute path to a markdown file to read (provide this OR markdown)'),
      filename: z.string().optional().describe('Display name for the file (defaults to basename of filePath if provided)'),
      comments: z.array(z.any()).optional().describe('Pre-existing comments'),
      sessionName: z.string().optional().describe('Custom human-readable name for the session'),
    }).refine(data => data.markdown || data.filePath, {
      message: 'Either markdown or filePath must be provided',
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
    description: 'Update the markdown content of a session. Provide either markdown or filePath.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      markdown: z.string().optional().describe('New markdown content (provide this OR filePath)'),
      filePath: z.string().optional().describe('Absolute path to a markdown file to read (provide this OR markdown)'),
      filename: z.string().optional().describe('New filename (preserved if omitted)'),
    }).refine(data => data.markdown || data.filePath, {
      message: 'Either markdown or filePath must be provided',
    }),
  }, async (args) => {
    const result = await handlers.update_markdown(args);
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

// Track transports per session for stateful mode
const transports = {};

const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL });

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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    const server = new McpServer({ name: 'md-review', version: '1.0.0' });
    registerTools(server, handlers);
    await server.connect(transport);

    // Store for subsequent requests
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) {
        delete transports[sid];
      }
    };

    // Handle the initialize request — sessionId gets set after this
    await transport.handleRequest(req, res);

    // Now store by session ID
    if (transport.sessionId) {
      transports[transport.sessionId] = transport;
    }
    return;
  }

  if (sessionId && transports[sessionId]) {
    // Existing session — route to its transport
    return transports[sessionId].handleRequest(req, res);
  }

  // Unknown session
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Invalid or missing session. Send a POST to /mcp without mcp-session-id to initialize.' }));
});

httpServer.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`MCP HTTP server running on http://0.0.0.0:${MCP_PORT}/mcp`);
});
