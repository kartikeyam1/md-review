import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createTokenStore } from './mcp-token-store.js';

const PASTE_API_URL = process.env.PASTE_API_URL || 'http://localhost:3100';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://kartikeyam1.github.io/md-review';
// The backend's public origin (#22): when set, handed-out links are its /d/ meta pages (link unfurls).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const CHUNK_SIZE = 512 * 1024; // 512 KB chunks for large files
/** #21 rule 10: upsert_session sends the content in one request; larger docs go through the CLI / shell. */
const UPSERT_MAX_BYTES = 10 * 1024 * 1024;

/** #23 rule 11: what a write tool returns on 401/403. */
export const EDIT_PROTECTED_MESSAGE = 'This document is edit-protected. Pass editToken (returned when it was created) or ask the owner for its edit link.';

/** The optional `editToken` argument every write tool accepts (#23 rule 11). */
export const editTokenArg = () => z.string().optional().describe(
  'Edit token for an edit-protected document (returned as editToken when it was created, or the ?edit= part of its edit link). '
  + 'Optional: tokens of docs created or edited through this MCP server are remembered.');

/**
 * #24 rule 10: GET /reactions → {total, doc: {"👍": {count, names}}, sections: [{section, reactions}]}
 * (sections sorted by their total, most reacted first).
 */
export function reactionsForAgent(summary) {
  const byEmoji = (groups) => Object.fromEntries((groups || []).map((g) => [g.emoji, { count: g.count, names: g.names }]));
  const sections = Object.entries(summary.sections || {})
    .map(([section, groups]) => ({ section, total: groups.reduce((n, g) => n + g.count, 0), reactions: byEmoji(groups) }))
    .sort((a, b) => b.total - a.total || a.section.localeCompare(b.section))
    .map(({ section, reactions }) => ({ section, reactions }));
  return { total: summary.total ?? 0, doc: byEmoji(summary.doc), sections };
}

// ── Handler factory (exported for testing) ──────────────────────────────────

/** Handed-out doc link (spec #4 rule 17, 00 §6): `<frontendUrl>/d/<slug||id>`, exactly one slash between. */
export function docUrl(frontendUrl, key) {
  return `${String(frontendUrl || '').replace(/\/+$/, '')}/d/${key}`;
}

export function createHandlers({ pasteApiUrl, pastePublicUrl, frontendUrl, publicBaseUrl, fetchFn = fetch, allowLocalFiles = true, tokenStore = createTokenStore(undefined, { scope: pasteApiUrl }) }) {
  // Trailing slashes in the configured URLs are ignored (no `//paste` paths).
  pasteApiUrl = String(pasteApiUrl || '').replace(/\/+$/, '');
  if (pastePublicUrl) pastePublicUrl = String(pastePublicUrl).replace(/\/+$/, '');
  // pastePublicUrl = URL clients use in shell commands (curl). Defaults to pasteApiUrl.
  const shellApiUrl = pastePublicUrl || pasteApiUrl;
  // Share links (#22 rule 1, 00 §6): the backend hands out the canonical `url`
  // (its /d/ meta page when PUBLIC_BASE_URL is set, else the SPA route); an
  // older backend without it falls back to the same rule from this env.
  const shareBase = publicBaseUrl || frontendUrl;

  function escapeShell(s) {
    // Wrap in single quotes, escape existing single quotes
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  async function apiCall(path, opts = {}) {
    let res;
    try {
      const { headers: extraHeaders, ...rest } = opts;
      res = await fetchFn(`${pasteApiUrl}${path}`, {
        ...rest,
        // Identify agent writes in the revision history.
        headers: { 'Content-Type': 'application/json', 'X-MdReview-Client': 'mcp', ...(extraHeaders || {}) },
      });
    } catch {
      return { error: `Could not reach paste service at ${pasteApiUrl}` };
    }
    if (res.status === 404) {
      const body = await res.json().catch(() => ({}));
      if (body.error?.includes('comment')) return { error: 'Comment not found' };
      return { error: 'Session not found' };
    }
    if ((res.status === 401 || res.status === 403)) {
      // #23: an edit-protected doc refused the write (no token / wrong token).
      const body = await res.json().catch(() => ({}));
      if (body.code === 'edit_token_required' || body.code === 'edit_token_invalid') {
        return { error: EDIT_PROTECTED_MESSAGE, status: res.status, code: body.code };
      }
      return { error: body.error || `Paste service returned ${res.status}`, status: res.status };
    }
    if (!res.ok) {
      // Surface the service's own message (e.g. 412 "Content changed on server",
      // 409 "Patch failed: context mismatch") plus the current content_hash so
      // the caller can re-read and retry instead of guessing.
      const body = await res.json().catch(() => ({}));
      const out = { error: body.error || `Paste service returned ${res.status}`, status: res.status };
      if (body.content_hash) out.content_hash = body.content_hash;
      if (typeof body.code === 'string') out.code = body.code; // e.g. invalid_key (#21)
      return out;
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

  // ── Edit tokens (#23 rule 11): tool argument → persistent store → none ─────
  const tokenFor = (sessionId, editToken) => editToken || tokenStore.get(sessionId);
  const tokenHeaders = (token, headers) => (token ? { ...(headers || {}), 'X-Edit-Token': token } : headers);
  /**
   * Run a protected write with the token for `sessionId`; a successful call
   * with an explicit editToken remembers it (a refused one never overwrites
   * the stored token).
   */
  async function withToken(sessionId, editToken, run) {
    const token = tokenFor(sessionId, editToken);
    const result = await run(token);
    if (editToken && result && !result.error) tokenStore.save([sessionId], editToken);
    return result;
  }

  // Chunked upload for large content (>1MB)
  async function uploadLargeContent(sessionId, content, filename, target = 'markdown', token = null) {
    // Start upload
    const startResult = await apiCall(`/paste/${sessionId}/upload/start`, {
      method: 'POST',
      headers: tokenHeaders(token),
      body: JSON.stringify({ totalChunks: Math.ceil(content.length / CHUNK_SIZE), filename, target }),
    });
    if (startResult.error) return startResult;

    // Send chunks
    for (let i = 0; i * CHUNK_SIZE < content.length; i++) {
      const chunk = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const chunkResult = await apiCall(`/paste/${sessionId}/upload/chunk`, {
        method: 'POST',
        headers: tokenHeaders(token),
        body: JSON.stringify({ uploadId: startResult.uploadId, index: i, data: chunk }),
      });
      if (chunkResult.error) return chunkResult;
    }

    // Complete
    return apiCall(`/paste/${sessionId}/upload/complete`, {
      method: 'POST',
      headers: tokenHeaders(token),
      body: JSON.stringify({ uploadId: startResult.uploadId }),
    });
  }

  async function updateMarkdown({ sessionId, markdown, filePath, filename, patch, expectedContentHash, author }, token) {
    // Optimistic concurrency: only write if the stored content still has this hash.
    const headers = tokenHeaders(token, expectedContentHash ? { 'If-Match': expectedContentHash } : undefined);
    const by = author || 'agent';
    // Delta update via patch
    if (patch) {
      const payload = { patch, author: by };
      if (filename !== undefined) payload.filename = filename;
      return apiCall(`/paste/${sessionId}/markdown`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      });
    }
    const resolved = await resolveFile(markdown, filePath, filename);
    const content = resolved.content;
    // Use chunked upload for large content (>1 MB)
    if (content.length > 1024 * 1024) {
      return uploadLargeContent(sessionId, content, filename || resolved.name, 'markdown', token);
    }
    const payload = { markdown: content, author: by };
    if (filename !== undefined) payload.filename = filename;
    return apiCall(`/paste/${sessionId}/markdown`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });
  }

  /** The X-Edit-Token curl flag for a shell command: the known token, else $MDREVIEW_EDIT_TOKEN. */
  function shellTokenHeader(sessionId, editToken) {
    const token = tokenFor(sessionId, editToken);
    if (token) return { header: `-H ${escapeShell(`X-Edit-Token: ${token}`)}`, note: '' };
    return {
      header: '-H "X-Edit-Token: $MDREVIEW_EDIT_TOKEN"',
      note: ' No edit token is known for this document here: if it is edit-protected, export MDREVIEW_EDIT_TOKEN=<its edit token> before running the command (legacy link-editable docs need none).',
    };
  }

  return {
    async create_session({ markdown, filePath, filename, comments, sessionName, callbackUrl, slug, expiryDays, contentType, author, mode }) {
      const resolved = await resolveFile(markdown, filePath, filename);
      const resolvedFilename = filename ?? resolved.name;
      const payload = {
        ...(author ? { author } : {}),
        markdown: resolved.content,
        filename: resolvedFilename,
        sharedAt: new Date().toISOString(),
        comments: comments || [],
      };
      if (sessionName !== undefined) payload.sessionName = sessionName;
      if (callbackUrl !== undefined) payload.callback_url = callbackUrl;
      if (slug !== undefined) payload.slug = slug;
      if (expiryDays !== undefined) payload.expiry_days = expiryDays;
      if (mode !== undefined) payload.mode = mode;
      // Content type ('markdown' | 'html'). When omitted, the frontend infers it
      // from the filename extension / body, so passing it is optional but makes
      // HTML sessions render correctly regardless of filename.
      payload.contentType = contentType || (/\.html?$/i.test(resolvedFilename) ? 'html' : 'markdown');
      const result = await apiCall('/paste', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.error) return result;
      const shareId = result.slug || result.id;
      const url = result.url || docUrl(shareBase, shareId);
      const out = { id: result.id, slug: result.slug || null, mode: result.mode ?? null, shareUrl: url, url };
      if (result.editToken) {
        // #23 rule 11: remember the token for every later call (any connection, any restart).
        tokenStore.save([result.id, result.slug], result.editToken);
        const appUrl = result.app_url || docUrl(frontendUrl, shareId);
        Object.assign(out, { app_url: appUrl, editToken: result.editToken, editUrl: result.editUrl || `${appUrl}?edit=${result.editToken}` });
      }
      return out;
    },

    async get_session({ sessionId, fields, editToken }) {
      const qs = fields ? `?fields=${fields}` : '';
      // The token only makes `access.can_edit` accurate; reads never need one.
      const result = await apiCall(`/paste/${sessionId}${qs}`, { headers: tokenHeaders(tokenFor(sessionId, editToken)) });
      if (result.error) return result;
      return { ...result, shareUrl: result.url || docUrl(shareBase, result.slug || sessionId) };
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

    async update_markdown({ sessionId, markdown, filePath, filename, patch, expectedContentHash, author, editToken }) {
      return withToken(sessionId, editToken, (token) => updateMarkdown({ sessionId, markdown, filePath, filename, patch, expectedContentHash, author }, token));
    },

    // ── Revision history ────────────────────────────────────────────────────
    async list_revisions({ sessionId }) {
      return apiCall(`/paste/${sessionId}/revisions`);
    },

    async get_revision({ sessionId, hash }) {
      return apiCall(`/paste/${sessionId}/revisions/${hash || 'current'}`);
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

    async delete_session({ sessionId, editToken }) {
      const token = tokenFor(sessionId, editToken);
      const result = await apiCall(`/paste/${sessionId}`, { method: 'DELETE', headers: tokenHeaders(token) });
      if (result.error) return result;
      // A deleted doc's slug may be reused by a new doc: drop its keys.
      tokenStore.forget(token);
      return { ok: true };
    },

    async update_session_meta({ sessionId, sessionName, expiryDays, slug, mode, editToken }) {
      const payload = {};
      if (mode !== undefined) payload.mode = mode;
      if (sessionName !== undefined) payload.sessionName = sessionName;
      if (expiryDays !== undefined) payload.expiry_days = expiryDays;
      if (slug !== undefined) payload.slug = slug;
      return withToken(sessionId, editToken, async (token) => {
        const result = await apiCall(`/paste/${sessionId}/meta`, {
          method: 'PUT',
          headers: tokenHeaders(token),
          body: JSON.stringify(payload),
        });
        // A new slug keeps working without a token too.
        if (token && result && !result.error && result.slug) tokenStore.save([result.slug], token);
        return result;
      });
    },

    // ── New: chunked upload for large files ──────────────────────────────────

    async upload_chunk({ sessionId, filePath, filename, markdown, target, editToken }) {
      const resolved = await resolveFile(markdown, filePath, filename);
      const content = resolved.content;
      const resolvedFilename = filename || resolved.name;
      return withToken(sessionId, editToken, (token) => uploadLargeContent(sessionId, content, resolvedFilename, target || 'markdown', token));
    },

    // ── New: patch markdown with a unified diff ──────────────────────────────

    async patch_markdown({ sessionId, patch, filename, expectedContentHash, author, editToken }) {
      const payload = { patch, author: author || 'agent' };
      if (filename !== undefined) payload.filename = filename;
      return withToken(sessionId, editToken, (token) => apiCall(`/paste/${sessionId}/markdown`, {
        method: 'PUT',
        headers: tokenHeaders(token, expectedContentHash ? { 'If-Match': expectedContentHash } : undefined),
        body: JSON.stringify(payload),
      }));
    },

    // ── New: file collection management ──────────────────────────────────────

    async add_file({ sessionId, name, content, filePath, encoding, editToken }) {
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

      return withToken(sessionId, editToken, (token) => {
        // Use chunked upload for large files
        if (fileContent.length > 1024 * 1024) {
          return uploadLargeContent(sessionId, fileContent, name, 'file', token);
        }
        return apiCall(`/paste/${sessionId}/files`, {
          method: 'POST',
          headers: tokenHeaders(token),
          body: JSON.stringify({ name, content: fileContent, encoding }),
        });
      });
    },

    async list_files({ sessionId }) {
      return apiCall(`/paste/${sessionId}/files`);
    },

    async remove_file({ sessionId, name, editToken }) {
      return withToken(sessionId, editToken, async (token) => {
        const result = await apiCall(`/paste/${sessionId}/files/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: tokenHeaders(token),
        });
        if (result.error) return result;
        return { ok: true };
      });
    },

    async get_file({ sessionId, name }) {
      const res = await fetchFn(`${pasteApiUrl}/paste/${sessionId}/files/${encodeURIComponent(name)}`);
      if (!res.ok) return { error: `File not found or error: ${res.status}` };
      const text = await res.text();
      return { name, content: text };
    },

    // ── Upsert by key (#21): one stable URL per recurring doc ────────────────
    async upsert_session({ key, markdown, filename, contentType, sessionName, slug, expiryDays, changeNote, author, expectedContentHash, editToken }) {
      if (typeof markdown !== 'string') return { error: 'markdown (string) is required' };
      if (Buffer.byteLength(markdown, 'utf-8') > UPSERT_MAX_BYTES) {
        return { error: 'Content is larger than 10 MB. Publish it from disk instead: md-review publish <key> <file> (CLI), or create_via_shell.' };
      }
      // Token: argument → the store (saved under `key:<key>` when this server created it) → none.
      const storeKey = `key:${key}`;
      const token = editToken || tokenStore.get(storeKey);
      const payload = { markdown, author: author || 'agent' };
      if (filename !== undefined) payload.filename = filename;
      if (contentType !== undefined) payload.contentType = contentType;
      if (sessionName !== undefined) payload.sessionName = sessionName;
      if (slug !== undefined) payload.slug = slug;
      if (expiryDays !== undefined) payload.expiry_days = expiryDays;
      if (changeNote !== undefined) payload.changeNote = changeNote;
      const result = await apiCall(`/paste/by-key/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: tokenHeaders(token, expectedContentHash ? { 'If-Match': expectedContentHash } : undefined),
        body: JSON.stringify(payload),
      });
      if (result.error) {
        if (result.code === 'edit_token_invalid' && !editToken && token) {
          return { ...result, error: 'The edit token this server remembers for this key is no longer valid (the doc was deleted and re-created elsewhere, or its token was rotated). Pass editToken.' };
        }
        return result;
      }
      const known = result.editToken || (editToken ? editToken : null);
      if (known) tokenStore.save([storeKey, result.id, result.slug], known);
      return { ...result, shareUrl: result.url };
    },

    // ── Reactions (#24): an agent-friendly summary keyed by emoji ────────────
    async get_reactions({ sessionId }) {
      const r = await apiCall(`/paste/${sessionId}/reactions`);
      if (r.error) return r;
      return reactionsForAgent(r);
    },

    // ── View counts (#25): readers too when this server holds the edit token ──
    async get_views({ sessionId, editToken }) {
      const token = tokenFor(sessionId, editToken);
      const result = await apiCall(`/paste/${sessionId}/views`, { headers: tokenHeaders(token) });
      // Reads never fail on a token; say so when the one given (or remembered) did not unlock the reader list.
      if (!result.error && token && !Array.isArray(result.readers)) {
        result.warning = 'The edit token was not accepted for this document, so only the counts are shown (named readers need its valid edit token).';
      }
      return result;
    },

    // ── Shell command generators (curl — runs on any client machine) ──────────

    async create_via_shell({ filePath, sessionName, slug, expiryDays, callbackUrl, contentType, mode }) {
      // Build a JSON payload using jq to read the file, so the content never enters the conversation
      const fname = basename(filePath);
      const ctype = contentType || (/\.html?$/i.test(fname) ? 'html' : 'markdown');
      const jqParts = [`.markdown = $content`, `.filename = "${fname}"`, `.contentType = ${JSON.stringify(ctype)}`, `.sharedAt = (now | todate)`, `.comments = []`];
      if (sessionName) jqParts.push(`.sessionName = ${JSON.stringify(sessionName)}`);
      if (slug) jqParts.push(`.slug = ${JSON.stringify(slug)}`);
      if (callbackUrl) jqParts.push(`.callback_url = ${JSON.stringify(callbackUrl)}`);
      if (mode !== undefined) jqParts.push(`.mode = ${JSON.stringify(mode)}`);
      if (expiryDays !== undefined) jqParts.push(`.expiry_days = ${expiryDays === null ? 'null' : expiryDays}`);
      const jqExpr = `{} | ${jqParts.join(' | ')}`;

      const cmd = `jq -n --rawfile content ${escapeShell(filePath)} '${jqExpr}' | curl -s -X POST ${shellApiUrl}/paste -H 'Content-Type: application/json' -d @-`;
      return {
        command: cmd,
        instruction: `Run this command in your shell. It reads ${basename(filePath)} and uploads it directly to the paste service — the file content never enters this conversation. Returns JSON with {id, slug, url, editToken, editUrl}. View at: ${docUrl(shareBase, '<slug-or-id>')}. `
          + 'Keep the editToken from the JSON output: the document is edit-protected, and later writes need it (pass it as editToken to the write tools, or export MDREVIEW_EDIT_TOKEN for the shell commands). Share url for read-only access; editUrl lets anyone edit.',
      };
    },

    async upload_via_shell({ sessionId, filePath, filename, editToken }) {
      const fname = filename || basename(filePath);
      const auth = shellTokenHeader(sessionId, editToken);
      const cmd = `jq -n --rawfile content ${escapeShell(filePath)} '{markdown: $content, filename: ${JSON.stringify(fname)}}' | curl -s -X PUT ${shellApiUrl}/paste/${sessionId}/markdown -H 'Content-Type: application/json' ${auth.header} -d @-`;
      return {
        command: cmd,
        instruction: `Run this command to replace the session content with the file. Returns JSON {ok: true}.${auth.note}`,
      };
    },

    async add_file_via_shell({ sessionId, filePath, encoding, editToken }) {
      const auth = shellTokenHeader(sessionId, editToken);
      const fname = basename(filePath);
      let cmd;
      if (encoding === 'base64') {
        cmd = `jq -n --arg content "$(base64 -w0 ${escapeShell(filePath)})" '{name: ${JSON.stringify(fname)}, content: $content, encoding: "base64"}' | curl -s -X POST ${shellApiUrl}/paste/${sessionId}/files -H 'Content-Type: application/json' ${auth.header} -d @-`;
      } else {
        cmd = `jq -n --rawfile content ${escapeShell(filePath)} '{name: ${JSON.stringify(fname)}, content: $content}' | curl -s -X POST ${shellApiUrl}/paste/${sessionId}/files -H 'Content-Type: application/json' ${auth.header} -d @-`;
      }
      return {
        command: cmd,
        instruction: `Run this command to add the file to the session collection. Returns JSON {name, size, type}.${auth.note}`,
      };
    },
  };
}

// ── Tools registered identically by both servers (stdio here, HTTP in mcp-server-http.js) ──

const toolResult = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] });

/** Register the tools added by the view-and-share items: #21 upsert_session, #24 get_reactions, #25 get_views. */
export function registerSharedTools(server, handlers) {
  server.registerTool('upsert_session', {
    title: 'Upsert Session by Key',
    description: 'Publish a recurring doc under a stable key: creates it the first time, otherwise adds a new revision; the URL never changes. '
      + 'Use a key like "<owner-or-tool>:<doc-name>" (lowercase letters, digits, . _ : -). Each call with changed content is its own revision, '
      + 'with changeNote as its note. The edit token is remembered by this server; pass editToken when the doc was created elsewhere. Content over 10 MB: use the CLI (md-review publish) or create_via_shell.',
    inputSchema: z.object({
      key: z.string().describe('Stable key, e.g. "factory:dp-weekly-status" (lowercase, 1-128 chars: a-z 0-9 . _ : -)'),
      markdown: z.string().describe('The full document content (Markdown or HTML)'),
      filename: z.string().optional().describe('Display filename (updated when given)'),
      contentType: z.enum(['markdown', 'html']).optional().describe('Document type (updated when given)'),
      sessionName: z.string().optional().describe('Human-readable name (updated when given)'),
      slug: z.string().optional().describe('URL slug, used only when the doc is created'),
      expiryDays: z.number().nullable().optional().describe('Expiry in days (1, 7, 30, 90, or null for never); recomputed from now when given'),
      changeNote: z.string().optional().describe('What changed in this run (shown in the revision history, max 500 chars)'),
      author: z.string().optional().describe('Who is writing (recorded on the revision). Default "agent"'),
      expectedContentHash: z.string().optional().describe('Only update if the current content still has this hash (412 otherwise)'),
      editToken: editTokenArg(),
    }),
  }, async (args) => toolResult(await handlers.upsert_session(args)));

  server.registerTool('get_reactions', {
    title: 'Get Reactions',
    description: 'Who reacted to a doc and to which sections: emoji counts with reader names for the whole doc, '
      + 'and per section (heading id), most reacted section first. Read-only.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
    }),
  }, async (args) => toolResult(await handlers.get_reactions(args)));

  server.registerTool('get_views', {
    title: 'Get Views',
    description: 'How many times a doc was viewed (one view = one reader per UTC day) and by how many readers. '
      + "With the doc's edit token (remembered for docs this server created) it also lists the named readers: "
      + 'when each last looked and whether they saw the latest version. The author\'s own views are not counted. Read-only.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
      editToken: editTokenArg(),
    }),
  }, async (args) => toolResult(await handlers.get_views(args)));
}

// ── MCP Server Setup (only when run directly) ───────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  // Shell commands (curl) use PASTE_PUBLIC_URL when set, else PASTE_API_URL — never a hard-coded host.
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, pastePublicUrl: process.env.PASTE_PUBLIC_URL || PASTE_API_URL, frontendUrl: FRONTEND_URL, publicBaseUrl: PUBLIC_BASE_URL });

  const server = new McpServer({ name: 'md-review', version: '1.0.0' });

  const CATEGORY_ENUM = z.enum(['suggestion', 'question', 'must-fix', 'nit']);

  server.registerTool('create_session', {
    title: 'Create Review Session',
    description: 'Create a review session from Markdown or HTML content, or a local file path. HTML documents are rendered faithfully in a sandboxed preview; Markdown is rendered as before. For LARGE files (>10KB), use create_via_shell instead — it streams directly from disk without bloating conversation context.',
    inputSchema: z.object({
      author: z.string().optional().describe('Who is writing (recorded on the revision). Defaults to "agent" for updates; use a person\'s name when acting on their behalf.'),
      markdown: z.string().optional().describe('The document content — Markdown or HTML (provide this OR filePath)'),
      filePath: z.string().optional().describe('Absolute path to a .md/.markdown/.txt/.html file to read (provide this OR markdown)'),
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
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('get_session', {
    title: 'Get Review Session',
    description: "Get a session's full state, including its doc `mode` (publish = read-only page for humans, review = comments and approval). Use 'fields' to load only specific parts for large sessions.",
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      editToken: editTokenArg(),
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
      author: z.string().optional().describe('Who is writing (recorded on the revision). Defaults to "agent" for updates; use a person\'s name when acting on their behalf.'),
      sessionId: z.string().describe('The session ID'),
      editToken: editTokenArg(),
      markdown: z.string().optional().describe('New markdown content (provide this OR filePath OR patch)'),
      filePath: z.string().optional().describe('Absolute path to a markdown file to read (provide this OR markdown OR patch)'),
      patch: z.string().optional().describe('Unified diff to apply as a delta update (provide this OR markdown OR filePath)'),
      expectedContentHash: z.string().optional().describe('Optimistic-concurrency guard: the content_hash you last read (from get_session). The write is rejected with 412 if the document changed since, so you never overwrite someone else\'s edits.'),
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

  server.registerTool('list_revisions', {
    title: 'List Revisions',
    description: "Content history of a session, oldest first: who changed the document, when, and the content hash of each revision. Consecutive writes by the same author within a few minutes are folded into one revision. Use get_revision to read an older version, or diff two hashes to see what changed since you last read it.",
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
    }),
  }, async (args) => {
    const result = await handlers.list_revisions(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('get_revision', {
    title: 'Get Revision',
    description: "Read one stored revision of a session's content by hash (from list_revisions), or 'current' for the live content. Returns 410 if that version is no longer stored.",
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
      hash: z.string().optional().describe("Revision content hash, or 'current' (default)"),
    }),
  }, async (args) => {
    const result = await handlers.get_revision(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('list_sessions', {
    title: 'List Sessions',
    description: 'List all sessions; each item carries its doc `mode` (publish|review). Filter by approval status, session/file name pattern, or limit results. Use this to find sessions created earlier.',
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
      editToken: editTokenArg(),
    }),
  }, async (args) => {
    const result = await handlers.delete_session(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('update_session_meta', {
    title: 'Update Session Metadata',
    description: 'Update session name, slug, expiry or doc mode (publish|review). Use this to rename sessions, extend their lifetime or switch a doc between a reading page and a review.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID or slug'),
      editToken: editTokenArg(),
      sessionName: z.string().optional().describe('New session name'),
      slug: z.string().optional().describe('New URL slug (set to "" to remove)'),
      expiryDays: z.number().nullable().optional().describe('New expiry in days (1, 7, 30, 90, or null for never), counted from now'),
      mode: z.enum(['publish', 'review']).optional().describe('Doc mode. publish = read-only page for humans; review = comments and approval.'),
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
      author: z.string().optional().describe('Who is writing (recorded on the revision). Defaults to "agent" for updates; use a person\'s name when acting on their behalf.'),
      sessionId: z.string().describe('The session ID'),
      editToken: editTokenArg(),
      patch: z.string().describe('Unified diff format patch to apply'),
      expectedContentHash: z.string().optional().describe('Optimistic-concurrency guard: the content_hash you last read (from get_session). The write is rejected with 412 if the document changed since, so you never overwrite someone else\'s edits.'),
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
      editToken: editTokenArg(),
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
      editToken: editTokenArg(),
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
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('upload_via_shell', {
    title: 'Upload File via Shell',
    description: 'Returns a shell command that uploads a local file to an existing session. The file content is streamed directly — never enters this conversation.',
    inputSchema: z.object({
      sessionId: z.string().describe('The session ID'),
      editToken: editTokenArg(),
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
      editToken: editTokenArg(),
      filePath: z.string().describe('Absolute path to the file'),
      encoding: z.enum(['utf-8', 'base64']).optional().describe('"utf-8" for text (default), "base64" for binary'),
    }),
  }, async (args) => {
    const result = await handlers.add_file_via_shell(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  registerSharedTools(server, handlers);

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
