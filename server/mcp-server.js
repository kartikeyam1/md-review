import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const PASTE_API_URL = process.env.PASTE_API_URL || 'http://localhost:3100';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://kartikeyam1.github.io/md-review';

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
    if (res.status === 204) return {};
    return res.json();
  }

  return {
    async create_session({ markdown, filePath, filename, comments, sessionName, callbackUrl, slug, expiryDays }) {
      const resolvedMarkdown = markdown ?? await readFile(filePath, 'utf-8');
      const resolvedFilename = filename ?? (filePath ? basename(filePath) : 'untitled.md');
      const payload = {
        markdown: resolvedMarkdown,
        filename: resolvedFilename,
        sharedAt: new Date().toISOString(),
        comments: comments || [],
      };
      if (sessionName !== undefined) payload.sessionName = sessionName;
      if (callbackUrl !== undefined) payload.callback_url = callbackUrl;
      if (slug !== undefined) payload.slug = slug;
      if (expiryDays !== undefined) payload.expiry_days = expiryDays;
      const result = await apiCall('/paste', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.error) return result;
      const shareId = result.slug || result.id;
      return { id: result.id, slug: result.slug || null, shareUrl: `${frontendUrl}/#shared=${shareId}` };
    },

    async get_session({ sessionId }) {
      const result = await apiCall(`/paste/${sessionId}`);
      if (result.error) return result;
      return { ...result, shareUrl: `${frontendUrl}/#shared=${sessionId}` };
    },

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
      const result = await apiCall(`/paste/${sessionId}/comments/${commentId}`, {
        method: 'DELETE',
      });
      if (result.error) return result;
      return { ok: true };
    },

    async add_reply({ sessionId, commentId, body, author }) {
      const payload = { body };
      if (author !== undefined) payload.author = author;
      return apiCall(`/paste/${sessionId}/comments/${commentId}/replies`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    async edit_reply({ sessionId, commentId, replyId, body }) {
      return apiCall(`/paste/${sessionId}/comments/${commentId}/replies/${replyId}`, {
        method: 'PUT',
        body: JSON.stringify({ body }),
      });
    },

    async delete_reply({ sessionId, commentId, replyId }) {
      const result = await apiCall(`/paste/${sessionId}/comments/${commentId}/replies/${replyId}`, {
        method: 'DELETE',
      });
      if (result.error) return result;
      return { ok: true };
    },

    async update_markdown({ sessionId, markdown, filePath, filename }) {
      const resolvedMarkdown = markdown ?? await readFile(filePath, 'utf-8');
      const payload = { markdown: resolvedMarkdown };
      if (filename !== undefined) payload.filename = filename;
      return apiCall(`/paste/${sessionId}/markdown`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },

    async get_approval_status({ sessionId }) {
      return apiCall(`/paste/${sessionId}/approval`);
    },

    async resolve_comment({ sessionId, commentId, resolvedBy }) {
      const payload = {};
      if (resolvedBy !== undefined) payload.resolved_by = resolvedBy;
      return apiCall(`/paste/${sessionId}/comments/${commentId}/resolve`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },

    async unresolve_comment({ sessionId, commentId }) {
      return apiCall(`/paste/${sessionId}/comments/${commentId}/unresolve`, {
        method: 'PUT',
        body: JSON.stringify({}),
      });
    },
  };
}

// ── MCP Server Setup (only when run directly) ───────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, frontendUrl: FRONTEND_URL });

  const server = new McpServer({ name: 'md-review', version: '1.0.0' });

  const CATEGORY_ENUM = z.enum(['suggestion', 'question', 'must-fix', 'nit']);

  server.registerTool('create_session', {
    title: 'Create Review Session',
    description: 'Create a new review session from markdown content or a file path. Provide either markdown or filePath.',
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
      resolvedBy: z.string().optional().describe('Who resolved it (e.g. "claude-code")'),
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

  // ── Resource ──────────────────────────────────────────────────────────────

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

  // ── Start ─────────────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
