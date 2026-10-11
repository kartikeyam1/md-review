import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createTokenStore, checkTokenStore } from './mcp-token-store.js';
import { stripAgentSections } from '../shared/agentSections.mjs';

const PASTE_API_URL = process.env.PASTE_API_URL || 'http://localhost:3100';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://kartikeyam1.github.io/md-review';
// The backend's public origin (#22): when set, handed-out links are its /d/ meta pages (link unfurls).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const CHUNK_SIZE = 512 * 1024; // 512 KB chunks for large files
/** #21 rule 10: upsert_session sends the content in one request; larger docs go through the CLI / shell. */
const UPSERT_MAX_BYTES = 10 * 1024 * 1024;

/** #23 rule 11: what a write tool returns on 401/403. */
export const EDIT_PROTECTED_MESSAGE = 'This document is edit-protected. Pass editToken (returned when it was created) or ask the owner for its edit link.';
/** A token was given (or remembered) but it belongs to another doc, or was rotated. */
export const WRONG_TOKEN_MESSAGE = 'The edit token does not match this document: edit tokens are per document, and the one given (or remembered for it) is not this document\'s (or was rotated). Pass the editToken returned when this document was created, or ask the owner for its edit link.';

/** Upsert keys (#21 rule 1): ids and slugs never contain ':', '.' or '_', so a key is unambiguous. */
const KEY_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const ID_OR_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
/** The `sessionId` argument's description (every tool that takes one). */
export const SESSION_ID_DESC = 'The document: its id or slug (as returned by create_session / upsert_session / list_sessions; an old slug of a renamed doc works too), or its upsert key (e.g. "team:weekly-status").';

/** add_comment's description (both servers). */
export const ADD_COMMENT_DESC = 'Add a review comment anchored to a line range of the document source. Lines follow the app: startLine is the 0-based first line, '
  + 'endLine the line after the last (exclusive), so the 5th line alone is startLine 4, endLine 5. Lines outside the document are refused; '
  + 'a selectedText that is not in the source is accepted with a warning. On a publish-mode doc the comment is stored but nobody can see it '
  + '(the result says visible:false with a warning) until the doc is switched to review with update_session_meta mode "review".';

/** add_comment's line arguments (both servers). */
export const LINE_ARGS = () => ({
  startLine: z.number().int().describe('0-based first line of the commented range'),
  endLine: z.number().int().describe('The line after the last commented line (exclusive; startLine + 1 for one line)'),
});

/** MCP result for a handler result: errors are flagged isError (scripted clients branch on it). */
export const toolResult = (result) => {
  const out = { content: [{ type: 'text', text: JSON.stringify(result) }] };
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.error === 'string') out.isError = true;
  return out;
};

/** Split a string into chunks of at most `size` UTF-16 units, never inside a surrogate pair. */
export function splitChunks(content, size) {
  const chunks = [];
  for (let i = 0; i < content.length;) {
    let end = Math.min(i + size, content.length);
    const c = content.charCodeAt(end - 1);
    if (end < content.length && end - i > 1 && c >= 0xd800 && c <= 0xdbff) end--;
    chunks.push(content.slice(i, end));
    i = end;
  }
  return chunks.length ? chunks : [''];
}

/** curl flags for the generated shell commands: quiet, but errors shown and HTTP errors exit non-zero (with the error body). */
const CURL_FLAGS = '-sS --fail-with-body';

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh)\b)|\+(json|xml)\b|^image\/svg\+xml/i;

/**
 * #28 rule 19: the agent-only marker syntax, appended to the descriptions of
 * the tools that write a document (both MCP servers).
 */
export const AGENT_MARKER_HINT = ' Agent-only sections: wrap supporting evidence that human readers do not need '
  + '(raw data, queries, logs) in a `<!-- agent -->` … `<!-- /agent -->` marker pair (optional label: '
  + '`<!-- agent: Raw SQL -->`), each marker on a line of its own at the top level. Human readers see a concise view '
  + 'without them; agents get the full source (get_session, GET /d/<slug>.md). They are hidden, not secret.';

/** get_session's optional `view` argument (#28 rule 19). */
export const viewArg = () => z.enum(['agent', 'human']).optional().describe(
  "Which view of a Markdown doc's content: 'agent' (default) = the full source including agent-only sections; "
  + "'human' = agent-only sections removed. The result reports view, agentSections (how many there are) and rawUrl.");

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
  // #28: raw markdown links live on the backend's public origin (PUBLIC_BASE_URL),
  // else the URL clients already use for it (PASTE_PUBLIC_URL / PASTE_API_URL).
  const rawBase = String(publicBaseUrl || shellApiUrl).replace(/\/+$/, '');

  function escapeShell(s) {
    // Wrap in single quotes, escape existing single quotes
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  /** The doc segment of an API path (/paste/<x>/…), for error messages. */
  const docOf = (path) => {
    const m = /^\/paste\/(?!by-key\/)([^/?]+)/.exec(path);
    return m ? decodeURIComponent(m[1]) : null;
  };

  /** A 404 body → an actionable not-found result (what is missing, and how to find the right id). */
  function notFound(path, body) {
    const what = String(body.error || '').toLowerCase();
    const x = docOf(path);
    const seg = (re) => { const m = re.exec(path); return m ? decodeURIComponent(m[1]) : '?'; };
    if (what.includes('reply')) return { error: `Reply not found: comment ${seg(/\/comments\/([^/]+)/)} has no reply ${seg(/\/replies\/([^/?]+)/)}. list_comments shows each comment's replies with their ids.`, status: 404, code: 'reply_not_found' };
    if (what.includes('comment')) return { error: `Comment not found: document ${x} has no comment ${seg(/\/comments\/([^/?]+)/)}. list_comments shows the comment ids.`, status: 404, code: 'comment_not_found' };
    if (what.includes('file')) return { error: `File not found: document ${x} has no file ${seg(/\/files\/(.+)$/)}. list_files shows its files.`, status: 404, code: 'file_not_found' };
    if (what.includes('revision')) return { error: `Revision not found: document ${x} has no stored revision ${seg(/\/revisions\/([^/?]+)/)}. list_revisions shows the revision hashes (or pass 'current').`, status: 404, code: 'revision_not_found' };
    if (what.includes('upload')) return { error: 'Upload not found: the chunked upload expired or belongs to another document. Start the upload again.', status: 404, code: 'upload_not_found' };
    return {
      error: `Session not found: no document has the id or slug "${x}". Use the id or slug returned by create_session / upsert_session (list_sessions lists them; an upsert key such as "team:weekly" works too). It may also have been deleted.`,
      status: 404, code: 'not_found',
    };
  }

  /** What to do next, per error status (added as `hint`). */
  const HINTS = {
    409: 'The patch or delta no longer matches the current content. Re-read the document (get_session) and rebuild the patch, or send the full markdown.',
    410: 'The document has expired. update_session_meta with expiryDays (or another upsert_session run) brings it back.',
    412: 'The document changed since you read it. Re-read it (get_session), merge your change, and retry with expectedContentHash set to the content_hash in this result (also in a full get_session).',
    413: 'The request is too large. Publish large files from disk instead: create_via_shell / upload_via_shell (shell command), or the CLI (md-review create/upload/publish).',
  };

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
      return notFound(path, body || {});
    }
    if ((res.status === 401 || res.status === 403)) {
      // #23: an edit-protected doc refused the write (no token / wrong token).
      const body = await res.json().catch(() => ({}));
      if (body.code === 'edit_token_required') return { error: EDIT_PROTECTED_MESSAGE, status: res.status, code: body.code };
      if (body.code === 'edit_token_invalid') return { error: WRONG_TOKEN_MESSAGE, status: res.status, code: body.code, hint: EDIT_PROTECTED_MESSAGE };
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
      if (Array.isArray(body.unresolved_comment_ids)) out.unresolved_comment_ids = body.unresolved_comment_ids;
      if (HINTS[res.status]) out.hint = HINTS[res.status];
      return out;
    }
    // Server-side warnings (e.g. a comment on a publish-mode doc) ride in headers.
    const header = (n) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(n) : null);
    const warning = header('x-mdreview-warning');
    const hidden = header('x-mdreview-visible') === 'false';
    if (res.status === 204) return warning ? { warning } : {};
    const out = await res.json();
    if (out && typeof out === 'object' && !Array.isArray(out)) {
      if (hidden) out.visible = false;
      if (warning) out.warning = warning;
    }
    return out;
  }

  async function resolveFile(markdown, filePath, defaultName) {
    if (markdown) return { content: markdown, name: defaultName || 'untitled.md' };
    if (!filePath) throw new Error('Either markdown or filePath must be provided');
    if (!allowLocalFiles) {
      throw new Error(
        'filePath is not supported over the HTTP transport: this MCP server cannot read files on your machine. '
        + 'For a file on disk use create_via_shell (new document) or upload_via_shell (existing document): they return a shell command '
        + 'that streams the file straight to the service. Or pass the content itself as "markdown".'
      );
    }
    const content = await readFile(filePath, 'utf-8');
    return { content, name: basename(filePath) };
  }

  // ── Edit tokens (#23 rule 11): tool argument → persistent store → none ─────
  const tokenFor = (sessionId, editToken) => editToken || tokenStore.get(sessionId);
  const tokenHeaders = (token, headers) => (token ? { ...(headers || {}), 'X-Edit-Token': token } : headers);

  /**
   * Remember `token` for a doc under every name it answers to: the identifier
   * the caller used, plus its id and slug (one meta read, only when the token
   * is new here), so a later call by id finds a token first given by slug.
   */
  async function rememberToken(sessionId, token) {
    if (!token) return;
    const known = tokenStore.get(sessionId) === token;
    tokenStore.save([sessionId], token); // no write when unchanged; migrates a pre-scoping bare key
    if (known) return;
    const meta = await apiCall(`/paste/${sessionId}?fields=meta`, { headers: tokenHeaders(token) });
    if (meta && !meta.error) tokenStore.save([meta.id, meta.slug], token);
  }

  /**
   * Run a protected write with the token for `sessionId`; a successful call
   * with an explicit editToken remembers it (a refused one never overwrites
   * the stored token).
   */
  async function withToken(sessionId, editToken, run) {
    const token = tokenFor(sessionId, editToken);
    const result = await run(token);
    if (editToken && result && !result.error) await rememberToken(sessionId, editToken);
    return result;
  }

  /**
   * Chunked upload for large content (>1 MB). `expectedContentHash` guards a
   * markdown write exactly like PUT /markdown's If-Match (checked on start and
   * on complete); `author` is recorded on the revision; `encoding` tells the
   * server a file's chunks are base64 text.
   */
  async function uploadLargeContent(sessionId, content, filename, target = 'markdown', token = null, { expectedContentHash, author, encoding } = {}) {
    const chunks = splitChunks(content, CHUNK_SIZE);
    const startHeaders = tokenHeaders(token, expectedContentHash && target === 'markdown' ? { 'If-Match': expectedContentHash } : undefined);
    const startBody = { totalChunks: chunks.length, filename, target };
    if (author) startBody.author = author;
    if (encoding) startBody.encoding = encoding;
    const startResult = await apiCall(`/paste/${sessionId}/upload/start`, {
      method: 'POST',
      headers: startHeaders,
      body: JSON.stringify(startBody),
    });
    if (startResult.error) return startResult;

    // Send chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunkResult = await apiCall(`/paste/${sessionId}/upload/chunk`, {
        method: 'POST',
        headers: tokenHeaders(token),
        body: JSON.stringify({ uploadId: startResult.uploadId, index: i, data: chunks[i] }),
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
    // Use chunked upload for large content (>1 MB): same guard, author and result shape as a direct write.
    if (content.length > 1024 * 1024) {
      // The display filename changes only when given (as for a direct write).
      return uploadLargeContent(sessionId, content, filename ?? null, 'markdown', token, { expectedContentHash, author: by });
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

  const handlers = {
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
      // One shape for every create (MCP / REST / CLI): id, slug, mode, url (+ viewUrl/shareUrl aliases), app_url, editToken, editUrl.
      const appUrl = result.app_url || docUrl(frontendUrl, shareId);
      const out = { id: result.id, slug: result.slug || null, mode: result.mode ?? null, shareUrl: url, url, viewUrl: url, app_url: appUrl };
      if (result.editToken) {
        // #23 rule 11: remember the token for every later call (any connection, any restart).
        tokenStore.save([result.id, result.slug], result.editToken);
        Object.assign(out, { editToken: result.editToken, editUrl: result.editUrl || `${appUrl}?edit=${result.editToken}` });
      }
      return out;
    },

    async get_session({ sessionId, fields, editToken, view = 'agent' }) {
      if (view !== 'agent' && view !== 'human') return { error: "view must be 'agent' or 'human'" };
      // The plain full read keeps its legacy URL (the server's default view is agent).
      const query = [fields ? `fields=${fields}` : '', view === 'human' || fields ? `view=${view}` : ''].filter(Boolean).join('&');
      // The token only makes `access.can_edit` accurate; reads never need one.
      const result = await apiCall(`/paste/${sessionId}${query ? `?${query}` : ''}`, { headers: tokenHeaders(tokenFor(sessionId, editToken)) });
      if (result.error) return result;
      const out = { ...result, shareUrl: result.url || docUrl(shareBase, result.slug || sessionId) };
      if (out.view === undefined) {
        // No view in the request (the plain full read), or a backend without #28:
        // apply the view here (the same shared strip the server uses).
        const isHtml = out.contentType === 'html';
        const v = typeof out.markdown === 'string' && !isHtml ? stripAgentSections(out.markdown) : null;
        if (v && view === 'human') out.markdown = v.markdown;
        out.view = view;
        if (v) out.agentSections = v.count;
      }
      // #28: where agents fetch the raw source (00 §6 x = slug if set, else id).
      out.rawUrl = `${rawBase}/d/${result.slug || result.id || sessionId}.md`;
      return out;
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

    async upload_chunk({ sessionId, filePath, filename, markdown, target, editToken, author }) {
      const resolved = await resolveFile(markdown, filePath, filename);
      const content = resolved.content;
      const resolvedFilename = filename || resolved.name;
      return withToken(sessionId, editToken, (token) => uploadLargeContent(sessionId, content, resolvedFilename, target || 'markdown', token, { author: author || 'agent' }));
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
          return uploadLargeContent(sessionId, fileContent, name, 'file', token, { encoding: encoding === 'base64' ? 'base64' : undefined });
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

    /**
     * A session file: text (UTF-8) files as `content` with encoding "utf-8";
     * anything else (images, PDFs, invalid UTF-8) as base64 with encoding
     * "base64" — the same encoding add_file takes, so files round-trip.
     */
    async get_file({ sessionId, name }) {
      const path = `/paste/${sessionId}/files/${encodeURIComponent(name)}`;
      let res;
      try { res = await fetchFn(`${pasteApiUrl}${path}`, { headers: { 'X-MdReview-Client': 'mcp' } }); }
      catch { return { error: `Could not reach paste service at ${pasteApiUrl}` }; }
      if (res.status === 404) return notFound(path, await res.json().catch(() => ({})) || {});
      if (!res.ok) return { error: `Could not read file ${name}: paste service returned ${res.status}`, status: res.status };
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = String((res.headers && res.headers.get && res.headers.get('content-type')) || 'application/octet-stream').split(';')[0].trim();
      let text = null;
      if (TEXT_MIME.test(mime) || mime === 'application/octet-stream') {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = null; }
        // An "octet-stream" file is text only when it decodes and has no NUL bytes.
        if (text !== null && mime === 'application/octet-stream' && text.includes('\u0000')) text = null;
      }
      if (text !== null) return { name, mime, encoding: 'utf-8', size: buf.length, content: text };
      return { name, mime, encoding: 'base64', size: buf.length, content: buf.toString('base64') };
    },

    // ── Upsert by key (#21): one stable URL per recurring doc ────────────────
    async upsert_session({ key, markdown, filename, contentType, sessionName, slug, expiryDays, changeNote, author, expectedContentHash, editToken, mode }) {
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
      if (mode !== undefined) payload.mode = mode; // #21: applies when the doc is created
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
      const out = { ...result, shareUrl: result.url, viewUrl: result.url };
      if (mode !== undefined && !result.created && result.mode && result.mode !== mode) {
        out.warning = `mode applies only when the doc is created: this doc stays in ${result.mode} mode. Call update_session_meta with mode "${mode}" to switch it.`;
      }
      return out;
    },

    // ── Reactions (#24): an agent-friendly summary keyed by emoji ────────────
    async get_reactions({ sessionId }) {
      const r = await apiCall(`/paste/${sessionId}/reactions`);
      if (r.error) return r;
      const out = reactionsForAgent(r);
      // The emoji → reaction code map (REST GET /reactions is keyed by code).
      const codes = {};
      for (const g of [...(r.doc || []), ...Object.values(r.sections || {}).flat()]) if (g && g.emoji && g.code) codes[g.emoji] = g.code;
      out.codes = codes;
      return out;
    },

    // ── View counts (#25): readers too when this server holds the edit token ──
    async get_views({ sessionId, editToken }) {
      const token = tokenFor(sessionId, editToken);
      const result = await apiCall(`/paste/${sessionId}/views`, { headers: tokenHeaders(token) });
      // Reads never fail on a token; say so when the one given (or remembered) did not unlock the reader list.
      if (!result.error && token && !Array.isArray(result.readers)) {
        result.warning = 'The edit token was not accepted for this document, so only the counts are shown (named readers need its valid edit token).';
      } else if (!result.error && !token && !Array.isArray(result.readers)) {
        result.note = 'Only the counts are shown: named readers (readers, anonymous_readers) are listed with the document\'s edit token (pass editToken).';
      }
      return result;
    },

    // ── Templates (#27) ──────────────────────────────────────────────────────
    async list_templates() {
      const list = await apiCall('/templates');
      if (list.error) return list;
      return list.map((t) => ({
        id: t.id, name: t.name, description: t.description, contentType: t.contentType, mode: t.mode,
        builtin: t.builtin, variables: t.variables, collection: t.collection ?? null,
      }));
    },

    async create_from_template({ template, title, author, variables, collection, slug, expiryDays, timezone }) {
      // `template` is an id or a name (case-insensitive); nothing is created when it is unknown.
      const list = await apiCall('/templates');
      if (list.error) return list;
      const ref = String(template ?? '').trim();
      const t = list.find((x) => x.id === ref) || list.find((x) => x.name.trim().toLowerCase() === ref.toLowerCase());
      if (!t) {
        return { error: `Unknown template "${ref}". Available templates: ${list.map((x) => x.name).join(', ')}.`, available: list.map((x) => ({ id: x.id, name: x.name })) };
      }
      const body = { title };
      if (author !== undefined) body.author = author;
      if (variables !== undefined) body.variables = variables;
      if (collection !== undefined) body.collection = collection; // id, slug or name; resolved by the backend
      if (slug !== undefined) body.slug = slug;
      if (expiryDays !== undefined) body.expiryDays = expiryDays;
      if (timezone !== undefined) body.timezone = timezone;
      const result = await apiCall(`/templates/${encodeURIComponent(t.id)}/instantiate`, { method: 'POST', body: JSON.stringify(body) });
      // apiCall reports every 404 as a missing document; here a 404 means the template went away after the list call.
      if (result && result.status === 404) return { error: `Template "${t.name}" no longer exists. Call list_templates for the current list.` };
      if (result.error) return result;
      const shareId = result.slug || result.id;
      const url = result.url || docUrl(shareBase, shareId);
      const out = { id: result.id, slug: result.slug || null, mode: result.mode ?? null, template: { id: t.id, name: t.name }, collection: result.collection ?? null, shareUrl: url, url };
      if (result.editToken) {
        // #23 rule 11: remember the token for later write tools (any connection, any restart).
        tokenStore.save([result.id, result.slug], result.editToken);
        const appUrl = result.app_url || docUrl(frontendUrl, shareId);
        Object.assign(out, { app_url: appUrl, editToken: result.editToken, editUrl: result.editUrl || `${appUrl}?edit=${result.editToken}` });
      }
      return out;
    },

    // ── Shell command generators (curl — runs on any client machine) ──────────

    async create_via_shell({ filePath, sessionName, slug, expiryDays, callbackUrl, contentType, mode }) {
      // Build a JSON payload using jq to read the file, so the content never enters the conversation
      const fname = basename(filePath);
      const ctype = contentType || (/\.html?$/i.test(fname) ? 'html' : 'markdown');
      const jqParts = [`.markdown = $content`, '.filename = $fname', `.contentType = ${JSON.stringify(ctype)}`, `.sharedAt = (now | todate)`, `.comments = []`];
      if (sessionName) jqParts.push(`.sessionName = ${JSON.stringify(sessionName)}`);
      if (slug) jqParts.push(`.slug = ${JSON.stringify(slug)}`);
      if (callbackUrl) jqParts.push(`.callback_url = ${JSON.stringify(callbackUrl)}`);
      if (mode !== undefined) jqParts.push(`.mode = ${JSON.stringify(mode)}`);
      if (expiryDays !== undefined) jqParts.push(`.expiry_days = ${expiryDays === null ? 'null' : expiryDays}`);
      // The filename goes in as --arg; a ' in any other value is shell-escaped inside the single-quoted jq program.
      const jqExpr = `{} | ${jqParts.join(' | ')}`.replace(/'/g, `'\\''`);

      const cmd = `jq -n --rawfile content ${escapeShell(filePath)} --arg fname ${escapeShell(fname)} '${jqExpr}' | curl ${CURL_FLAGS} -X POST ${shellApiUrl}/paste -H 'Content-Type: application/json' --data-binary @-`;
      return {
        command: cmd,
        instruction: `Run this command in your shell. It reads ${basename(filePath)} and uploads it directly to the paste service — the file content never enters this conversation. Returns JSON with {id, slug, url, editToken, editUrl}. View at: ${docUrl(shareBase, '<slug-or-id>')}. `
          + 'Keep the editToken from the JSON output: the document is edit-protected, and later writes need it (pass it as editToken to the write tools, or export MDREVIEW_EDIT_TOKEN for the shell commands). Share url for read-only access; editUrl lets anyone edit.',
      };
    },

    async upload_via_shell({ sessionId, filePath, filename, editToken }) {
      const auth = shellTokenHeader(sessionId, editToken);
      // The display filename changes only when `filename` is given (a temp file's name must not replace it).
      const jqArgs = filename ? `--arg filename ${escapeShell(filename)} ` : '';
      const body = filename ? '{markdown: $content, filename: $filename, author: "agent"}' : '{markdown: $content, author: "agent"}';
      const cmd = `jq -n --rawfile content ${escapeShell(filePath)} ${jqArgs}'${body}' | curl ${CURL_FLAGS} -X PUT ${shellApiUrl}/paste/${sessionId}/markdown -H 'Content-Type: application/json' -H 'X-MdReview-Client: mcp' ${auth.header} --data-binary @-`;
      return {
        command: cmd,
        instruction: `Run this command to replace the session content with the file. Returns JSON {ok: true, content_hash, filename}; on an HTTP error it prints the error JSON and exits non-zero.${auth.note}`,
      };
    },

    async add_file_via_shell({ sessionId, filePath, encoding, editToken }) {
      const auth = shellTokenHeader(sessionId, editToken);
      const fname = basename(filePath);
      const curl = `curl ${CURL_FLAGS} -X POST ${shellApiUrl}/paste/${sessionId}/files -H 'Content-Type: application/json' ${auth.header} --data-binary @-`;
      let cmd;
      if (encoding === 'base64') {
        // The base64 text streams through a pipe (no argument-length limit), and `base64 < file | tr -d`
        // works with GNU and BSD/macOS base64 alike (GNU wraps lines, BSD does not).
        cmd = `base64 < ${escapeShell(filePath)} | tr -d '\\n\\r' | jq -Rs --arg name ${escapeShell(fname)} '{name: $name, content: ., encoding: "base64"}' | ${curl}`;
      } else {
        cmd = `jq -n --rawfile content ${escapeShell(filePath)} --arg name ${escapeShell(fname)} '{name: $name, content: $content}' | ${curl}`;
      }
      return {
        command: cmd,
        instruction: `Run this command to add the file to the session collection. Returns JSON {name, size, type}; on an HTTP error it prints the error JSON and exits non-zero.${auth.note}`,
      };
    },
  };

  /**
   * A tool's `sessionId` → what the API takes. An id or slug passes through; an
   * upsert key (#21: it contains ':', '.' or '_', which ids and slugs never do)
   * is looked up; anything else is refused with guidance (it would otherwise be
   * spliced into an API path or a shell command).
   */
  async function resolveSessionId(sessionId) {
    if (typeof sessionId !== 'string' || ID_OR_SLUG_RE.test(sessionId)) return { id: sessionId };
    if (KEY_RE.test(sessionId)) {
      const r = await apiCall(`/paste/by-key/${encodeURIComponent(sessionId)}`);
      if (r && !r.error && r.id) return { id: r.id };
      if (r && r.status === 404) {
        return { error: `Session not found: no document has the upsert key "${sessionId}". Use the id or slug returned by create_session / upsert_session (list_sessions lists them).`, status: 404, code: 'not_found' };
      }
      return r && r.error ? r : { error: `Could not look up upsert key "${sessionId}"` };
    }
    return {
      error: `Invalid sessionId "${sessionId}": pass a document id or slug (letters, digits and "-"), or its upsert key (lowercase, e.g. "team:weekly-status").`,
      code: 'invalid_session_id',
    };
  }

  for (const [name, fn] of Object.entries(handlers)) {
    handlers[name] = async (args = {}) => {
      if (args && args.sessionId !== undefined) {
        const r = await resolveSessionId(args.sessionId);
        if (r.error) return r;
        if (r.id !== args.sessionId) args = { ...args, sessionId: r.id };
      }
      return fn(args);
    };
  }
  return handlers;
}

// ── Tools registered identically by both servers (stdio here, HTTP in mcp-server-http.js) ──


/** Register the tools added by the view-and-share items: #21 upsert_session, #24 get_reactions, #25 get_views, #27 list_templates + create_from_template. */
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
      mode: z.enum(['publish', 'review']).optional().describe('Doc mode when the doc is created: publish = read-only page for humans (default); review = comments and approval. Later runs never change it (use update_session_meta).'),
      editToken: editTokenArg(),
    }),
  }, async (args) => toolResult(await handlers.upsert_session(args)));

  server.registerTool('get_reactions', {
    title: 'Get Reactions',
    description: 'Who reacted to a doc and to which sections: emoji counts with reader names for the whole doc, '
      + 'and per section (heading id), most reacted section first. Read-only.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
    }),
  }, async (args) => toolResult(await handlers.get_reactions(args)));

  server.registerTool('get_views', {
    title: 'Get Views',
    description: 'How many times a doc was viewed (one view = one reader per UTC day) and by how many readers. '
      + "With the doc's edit token (remembered for docs this server created) it also lists the named readers: "
      + 'when each last looked and whether they saw the latest version. The author\'s own views are not counted. Read-only.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
      editToken: editTokenArg(),
    }),
  }, async (args) => toolResult(await handlers.get_views(args)));

  // #27 templates
  server.registerTool('list_templates', {
    title: 'List Templates',
    description: 'List document templates (built-in seeds such as "Weekly leadership update", "Design doc", "QA findings", '
      + '"PR review", "Research brief", plus templates people saved): id, name, description, contentType, mode, builtin, '
      + 'the {{variables}} each uses, and its default collection. Read-only. Use create_from_template to start a doc from one.',
    inputSchema: z.object({}),
  }, async () => toolResult(await handlers.list_templates()));

  server.registerTool('create_from_template', {
    title: 'Create Doc from Template',
    description: 'Create a new document from a template (see list_templates) and get its share link. Always pass author (the person or agent '
      + 'the doc is by): it fills {{author}} and is recorded as the creator. Built-in variables: title, date, week (ISO, e.g. 2026-W41), '
      + 'author, collection; date/week use timezone (IANA, default UTC). Placeholders with no value (no author, no collection, '
      + 'unknown names) stay verbatim in the doc, e.g. {{author}}, so fill them in afterwards with update_markdown. '
      + 'The edit token is returned and remembered by this server for later writes. Unknown template or collection: an error listing the options; nothing is created.',
    inputSchema: z.object({
      template: z.string().describe('Template id or name (case-insensitive), e.g. "weekly leadership update"'),
      title: z.string().describe('Title of the new doc (1-200 chars): its name, slug source and {{title}}'),
      author: z.string().optional().describe('Who the doc is by — pass it: fills {{author}} and records the creator'),
      variables: z.record(z.string(), z.string()).optional().describe('Custom {{name}} values (max 20, each ≤ 500 chars); they override built-ins'),
      collection: z.string().optional().describe("Collection id or name to file the doc in (default: the template's collection)"),
      slug: z.string().optional().describe('Custom URL slug (default: derived from the title)'),
      expiryDays: z.number().nullable().optional().describe('Expiry in days (1, 7, 30, 90, or null for never). Default 30'),
      timezone: z.string().optional().describe('IANA timezone for {{date}} / {{week}}, e.g. "Asia/Kolkata" (default UTC)'),
    }),
  }, async (args) => toolResult(await handlers.create_from_template(args)));
}

// ── MCP Server Setup (only when run directly) ───────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  // A token store that cannot be written would silently forget every edit token: refuse to start.
  try { checkTokenStore(); } catch (e) { console.error(`[md-review mcp] ${e.message}`); process.exit(1); }
  // Shell commands (curl) use PASTE_PUBLIC_URL when set, else PASTE_API_URL — never a hard-coded host.
  const handlers = createHandlers({ pasteApiUrl: PASTE_API_URL, pastePublicUrl: process.env.PASTE_PUBLIC_URL || PASTE_API_URL, frontendUrl: FRONTEND_URL, publicBaseUrl: PUBLIC_BASE_URL });

  const server = new McpServer({ name: 'md-review', version: '1.0.0' });

  const CATEGORY_ENUM = z.enum(['suggestion', 'question', 'must-fix', 'nit']);

  server.registerTool('create_session', {
    title: 'Create Review Session',
    description: 'Create a review session from Markdown or HTML content, or a local file path. HTML documents are rendered faithfully in a sandboxed preview; Markdown is rendered as before. For LARGE files (>10KB), use create_via_shell instead — it streams directly from disk without bloating conversation context.' + AGENT_MARKER_HINT,
    inputSchema: z.object({
      author: z.string().optional().describe('Who is writing (recorded on the revision). Defaults to "agent" for updates; use a person\'s name when acting on their behalf.'),
      markdown: z.string().optional().describe('The document content — Markdown or HTML (provide this OR filePath). Markdown extras: GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` on the first quote line, optional title after it) and inline RAG status badges `:rag-green[On track]` / `:rag-amber[At risk]` / `:rag-red[Blocked]`.'),
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
      filePath: z.string().optional().describe('Absolute path to a markdown file to read (provide this OR markdown OR patch)'),
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
      resolvedBy: z.string().optional().describe('Who resolved it (e.g. "claude-code")'),
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
    description: 'List all sessions, newest first; each item has id, slug, url (the doc link), mode (publish|review), approval status, counts and, for docs published with upsert_session, upsert_key. Filter by approval status, session/file name pattern, or limit results. Use this to find sessions created earlier.',
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
    description: 'Update session name, slug, expiry or doc mode (publish|review). Use this to rename sessions, extend their lifetime or switch a doc between a reading page and a review.',
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
    description: 'Add a file to the session file collection. Supports text and binary (base64-encoded, encoding "base64") files; get_file returns binary files in the same base64 form. For files >1MB, automatically uses chunked upload.',
    inputSchema: z.object({
      sessionId: z.string().describe(SESSION_ID_DESC),
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
    return toolResult(result);
  });

  server.registerTool('upload_via_shell', {
    title: 'Upload File via Shell',
    description: 'Returns a shell command that uploads a local file to an existing session. The file content is streamed directly — never enters this conversation.',
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
    description: 'Returns a shell command that adds a local file to a session\'s file collection. The file is uploaded directly — never enters this conversation. Use --encoding base64 for binary files (images, PDFs).',
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
