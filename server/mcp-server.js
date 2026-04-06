import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const PASTE_API_URL = process.env.PASTE_API_URL || 'http://localhost:3100';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://kartikeyam1.github.io/md-review';
const CHUNK_SIZE = 512 * 1024; // 512 KB chunks for large files

// ── Handler factory (exported for testing) ──────────────────────────────────

export function createHandlers({ pasteApiUrl, pastePublicUrl, frontendUrl, fetchFn = fetch, allowLocalFiles = true }) {
  // pastePublicUrl = URL clients use in shell commands (curl). Defaults to pasteApiUrl.
  const shellApiUrl = pastePublicUrl || pasteApiUrl;

  function escapeShell(s) {
    // Wrap in single quotes, escape existing single quotes
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

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

  async function resolveFile(markdown, filePath, defaultName) {
    if (markdown) return { content: markdown, name: defaultName || 'untitled.md' };
    if (!filePath) throw new Error('Either markdown or filePath must be provided');
    if (!allowLocalFiles) {
      throw new Error(
        'filePath is not supported over HTTP transport — the MCP server cannot access your local filesystem. ' +
        'Please read the file yourself and pass the content via the "markdown" parameter instead.'
      );
    }
    const content = await readFile(filePath, 'utf-8');
    return { content, name: basename(filePath) };
  }

  // Chunked upload for large content (>1MB)
  async function uploadLargeContent(sessionId, content, filename, target = 'markdown') {
    // Start upload
    const startResult = await apiCall(`/paste/${sessionId}/upload/start`, {
      method: 'POST',
      body: JSON.stringify({ totalChunks: Math.ceil(content.length / CHUNK_SIZE), filename, target }),
    });
    if (startResult.error) return startResult;

    // Send chunks
    for (let i = 0; i * CHUNK_SIZE < content.length; i++) {
      const chunk = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const chunkResult = await apiCall(`/paste/${sessionId}/upload/chunk`, {
        method: 'POST',
        body: JSON.stringify({ uploadId: startResult.uploadId, index: i, data: chunk }),
      });
      if (chunkResult.error) return chunkResult;
    }

    // Complete
    return apiCall(`/paste/${sessionId}/upload/complete`, {
      method: 'POST',
      body: JSON.stringify({ uploadId: startResult.uploadId }),
    });
  }

  return {
    async create_session({ markdown, filePath, filename, comments, sessionName, callbackUrl, slug, expiryDays }) {
      const resolved = await resolveFile(markdown, filePath, filename);
      const resolvedFilename = filename ?? resolved.name;
      const payload = {
        markdown: resolved.content,
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

    async get_session({ sessionId, fields }) {
      const qs = fields ? `?fields=${fields}` : '';
      const result = await apiCall(`/paste/${sessionId}${qs}`);
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

    async update_markdown({ sessionId, markdown, filePath, filename, patch }) {
      // Delta update via patch
      if (patch) {
        const payload = { patch };
        if (filename !== undefined) payload.filename = filename;
        return apiCall(`/paste/${sessionId}/markdown`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      }
      const resolved = await resolveFile(markdown, filePath, filename);
      const content = resolved.content;
      // Use chunked upload for large content (>1 MB)
      if (content.length > 1024 * 1024) {
        return uploadLargeContent(sessionId, content, filename || resolved.name);
      }
      const payload = { markdown: content };
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

    async list_sessions({ status, namePattern, limit }) {
      let url = '/paste/list';
      const params = [];
      if (status) params.push(`status=${encodeURIComponent(status)}`);
      if (namePattern) params.push(`name=${encodeURIComponent(namePattern)}`);
      if (limit) params.push(`limit=${limit}`);
      if (params.length) url += '?' + params.join('&');
      return apiCall(url);
    },

    async delete_session({ sessionId }) {
      const result = await apiCall(`/paste/${sessionId}`, { method: 'DELETE' });
      if (result.error) return result;
      return { ok: true };
    },

    async update_session_meta({ sessionId, sessionName, expiryDays, slug }) {
      const payload = {};
      if (sessionName !== undefined) payload.sessionName = sessionName;
      if (expiryDays !== undefined) payload.expiry_days = expiryDays;
      if (slug !== undefined) payload.slug = slug;
      return apiCall(`/paste/${sessionId}/meta`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },

    // ── New: chunked upload for large files ──────────────────────────────────

    async upload_chunk({ sessionId, filePath, filename, markdown, target }) {
      const resolved = await resolveFile(markdown, filePath, filename);
      const content = resolved.content;
      const resolvedFilename = filename || resolved.name;
      return uploadLargeContent(sessionId, content, resolvedFilename, target || 'markdown');
    },

    // ── New: patch markdown with a unified diff ──────────────────────────────

    async patch_markdown({ sessionId, patch, filename }) {
      const payload = { patch };
      if (filename !== undefined) payload.filename = filename;
      return apiCall(`/paste/${sessionId}/markdown`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },

    // ── New: file collection management ──────────────────────────────────────

    async add_file({ sessionId, name, content, filePath, encoding }) {
      let fileContent = content;
      if (!fileContent && filePath) {
        if (!allowLocalFiles) {
          return { error: 'filePath not supported over HTTP — read the file and pass content directly.' };
        }
        const buf = await readFile(filePath);
        fileContent = encoding === 'base64' ? buf.toString('base64') : buf.toString('utf-8');
        if (!name) name = basename(filePath);
      }
      if (!name || !fileContent) return { error: 'Missing name or content' };

      // Use chunked upload for large files
      if (fileContent.length > 1024 * 1024) {
        return uploadLargeContent(sessionId, fileContent, name, 'file');
      }

      return apiCall(`/paste/${sessionId}/files`, {
        method: 'POST',
        body: JSON.stringify({ name, content: fileContent, encoding }),
      });
    },

    async list_files({ sessionId }) {
      return apiCall(`/paste/${sessionId}/files`);
    },

    async remove_file({ sessionId, name }) {
      const result = await apiCall(`/paste/${sessionId}/files/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      if (result.error) return result;
      return { ok: true };
    },

    async get_file({ sessionId, name }) {
      const res = await fetchFn(`${pasteApiUrl}/paste/${sessionId}/files/${encodeURIComponent(name)}`);
      if (!res.ok) return { error: `File not found or error: ${res.status}` };
      const text = await res.text();
      return { name, content: text };
    },

    // ── Shell command generators (curl — runs on any client machine) ──────────

    async create_via_shell({ filePath, sessionName, slug, expiryDays, callbackUrl }) {
      // Build a JSON payload using jq to read the file, so the content never enters the conversation
      const jqParts = [`.markdown = $content`, `.filename = "${basename(filePath)}"`, `.sharedAt = (now | todate)`, `.comments = []`];
      if (sessionName) jqParts.push(`.sessionName = ${JSON.stringify(sessionName)}`);
      if (slug) jqParts.push(`.slug = ${JSON.stringify(slug)}`);
      if (callbackUrl) jqParts.push(`.callback_url = ${JSON.stringify(callbackUrl)}`);
      if (expiryDays !== undefined) jqParts.push(`.expiry_days = ${expiryDays === null ? 'null' : expiryDays}`);
      const jqExpr = `{} | ${jqParts.join(' | ')}`;

      const cmd = `jq -n --rawfile content ${escapeShell(filePath)} '${jqExpr}' | curl -s -X POST ${shellApiUrl}/paste -H 'Content-Type: application/json' -d @-`;
      return {
        command: cmd,
        instruction: `Run this command in your shell. It reads ${basename(filePath)} and uploads it directly to the paste service — the file content never enters this conversation. Returns JSON with {id, slug}. View at: ${frontendUrl}/#shared=<slug-or-id>`,
      };
    },

    async upload_via_shell({ sessionId, filePath, filename }) {
      const fname = filename || basename(filePath);
      const cmd = `jq -n --rawfile content ${escapeShell(filePath)} '{markdown: $content, filename: ${JSON.stringify(fname)}}' | curl -s -X PUT ${shellApiUrl}/paste/${sessionId}/markdown -H 'Content-Type: application/json' -d @-`;
      return {
        command: cmd,
        instruction: 'Run this command to replace the session content with the file. Returns JSON {ok: true}.',
      };
    },

    async add_file_via_shell({ sessionId, filePath, encoding }) {
      const fname = basename(filePath);
      let cmd;
      if (encoding === 'base64') {
        cmd = `jq -n --arg content "$(base64 -w0 ${escapeShell(filePath)})" '{name: ${JSON.stringify(fname)}, content: $content, encoding: "base64"}' | curl -s -X POST ${shellApiUrl}/paste/${sessionId}/files -H 'Content-Type: application/json' -d @-`;
      } else {
        cmd = `jq -n --rawfile content ${escapeShell(filePath)} '{name: ${JSON.stringify(fname)}, content: $content}' | curl -s -X POST ${shellApiUrl}/paste/${sessionId}/files -H 'Content-Type: application/json' -d @-`;
      }
      return {
        command: cmd,
        instruction: 'Run this command to add the file to the session collection. Returns JSON {name, size, type}.',
      };
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

  // ── Session management tools ─────────────────────────────────────────────

  server.registerTool('list_sessions', {
    title: 'List Sessions',
    description: 'List all review sessions. Filter by approval status, session/file name pattern, or limit results. Use this to find sessions created earlier.',
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
    description: 'Update session name, slug, or expiry. Use this to rename sessions or extend their lifetime.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
      sessionName: z.string().optional().describe('New session name'),
      slug: z.string().optional().describe('New URL slug (set to "" to remove)'),
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
    description: 'Add a file to the session file collection. Supports text and binary (base64-encoded) files. For files >1MB, automatically uses chunked upload.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      name: z.string().optional().describe('File name/path within the collection (e.g. "src/main.ts")'),
      content: z.string().optional().describe('File content (text or base64-encoded). Provide this OR filePath.'),
      filePath: z.string().optional().describe('Absolute path to the file. Provide this OR content.'),
      encoding: z.enum(['utf-8', 'base64']).optional().describe('"utf-8" for text, "base64" for binary. Default: utf-8'),
    }).refine(data => data.content || data.filePath, {
      message: 'Either content or filePath must be provided',
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
    description: 'Returns a shell command that creates a review session from a local file. Run the returned command in your terminal — the file content is streamed directly to the server and never enters this conversation. Ideal for large files (60KB, 100KB+).',
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
    description: 'Returns a shell command that uploads a local file to an existing session. The file content is streamed directly — never enters this conversation.',
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
    description: 'Returns a shell command that adds a local file to a session\'s file collection. The file is uploaded directly — never enters this conversation. Use --encoding base64 for binary files (images, PDFs).',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      filePath: z.string().describe('Absolute path to the file'),
      encoding: z.enum(['utf-8', 'base64']).optional().describe('"utf-8" for text (default), "base64" for binary'),
    }),
  }, async (args) => {
    const result = await handlers.add_file_via_shell(args);
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
