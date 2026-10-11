'use strict';
// Route (#28): GET /d/:x.md — a doc's raw source for agents (rule 16), and
// GET /llms.txt — a static guide for agents (rule 20). Returns NEXT for
// anything else. Registered before meta.cjs (00 §6: /d/:x.md comes first) and
// the hosted-site asset fallback.
const crypto = require('crypto');
const { NEXT } = require('../http-util.cjs');
const { isExpired, resolveId, loadContent, loadMeta, readRevisionBlob } = require('../storage.cjs');
const { effectiveContentType } = require('../doc-text.cjs');
const { PUBLIC_BASE_URL, PUBLIC_BASE_URL_SET } = require('../config.cjs');
const { readView, viewEtag, viewOf } = require('../agent-view.cjs');

// Slugs are [a-z0-9-], ids hex: the `.md` suffix is unambiguous (and case-sensitive).
// `@<hash>` pins one stored revision.
const RAW_PATH = /^\/d\/([a-zA-Z0-9][a-zA-Z0-9-]*)(?:@([a-f0-9]{32}))?\.md$/;

/** Does If-None-Match name `etag` (or `*`)? */
function notModified(req, etag) {
  const inm = String(req.headers['if-none-match'] || '').split(',').map((t) => t.trim());
  return inm.includes('*') || inm.includes(etag) || inm.includes(`W/${etag}`);
}

function sendText(req, res, status, text, headers = {}) {
  const body = Buffer.from(text, 'utf-8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ...headers });
  return res.end(req.method === 'HEAD' ? undefined : body);
}

// The configured public origin when set explicitly; otherwise paths are relative to this server.
const API = PUBLIC_BASE_URL_SET ? PUBLIC_BASE_URL : '';

const LLMS_TXT = `# md-review

> md-review shares Markdown and HTML documents by link. Humans read a concise
> view; agents can fetch the full source, including agent-only sections.

## Reading a document

- \`GET ${API}/d/<slug>.md\` returns the stored source as \`text/markdown\`
  (byte-for-byte, agent-only sections included). \`<slug>\` is the last path
  segment of a shared link (\`/d/<slug>\`); the document id works too, and so
  does an old slug of a renamed document.
- \`GET ${API}/d/<slug>.md?view=human\` returns the human view: every
  agent-only section removed. \`?view=agent\` is the default.
- \`GET ${API}/d/<slug>@<revision hash>.md\` returns one earlier revision.
- The \`X-Agent-Sections\` response header counts the agent-only sections.
- HTML documents come back as \`text/plain\` with their HTML source.
- Files attached to a document: \`GET ${API}/paste/<slug>/files/<name>\` (exact bytes).
- Expired documents answer 410, unknown ones 404.

## Agent-only sections

Wrap supporting material (raw data, queries, logs, long evidence) that human
readers do not need in a marker pair, each marker on a line of its own at the
top level of the document:

    <!-- agent -->
    …full evidence, any Markdown (tables, code, diagrams)…
    <!-- /agent -->

An optional label names the section: \`<!-- agent: Raw SQL -->\`. The default
reader view hides these sections; \`?view=agent\` in the app shows them.
Agent-only sections are not secret: anyone with the link can read the source.

## Publishing

- Doc modes: \`publish\` (default) is a read-only page for humans; \`review\`
  adds comments and approval. Comments on a publish doc are stored but nobody
  sees them until the doc is switched to review.
- Every new document gets an edit token (\`editToken\`, \`mre_…\`). Reads never
  need it; every write to the document does: send \`X-Edit-Token: <token>\`
  (or \`Authorization: Bearer <token>\`). Keep it from the create response.
- Recurring documents: \`PUT ${API}/paste/by-key/<key>\` (key like
  \`team:weekly-status\`) creates the doc once, then adds a revision per run at
  the same URL (\`changeNote\` labels the run; \`mode\` applies on create).
- Optimistic concurrency: send \`If-Match: <content_hash>\` on writes; a
  changed document answers 412 with the current \`content_hash\`.
- Approval follows the content: changing an approved document puts it back to
  \`pending\`.

## MCP server

The md-review MCP server (stdio: \`server/mcp-server.js\`; streamable HTTP:
\`/mcp\` on the MCP port, 3200 by default) wraps this API. Tool errors come back
with \`isError: true\` and an \`error\` message saying what to do next.

- Documents: \`create_session\`, \`get_session\` (\`view: "human"\` = the human
  view; the result has \`view\`, \`agentSections\`, \`rawUrl\`), \`list_sessions\`,
  \`update_markdown\`, \`patch_markdown\`, \`update_session_meta\` (name, slug,
  expiry, mode), \`delete_session\`, \`upsert_session\` (recurring docs by key).
- History: \`list_revisions\`, \`get_revision\`.
- Review: \`list_comments\`, \`add_comment\`, \`edit_comment\`, \`delete_comment\`,
  \`resolve_comment\`, \`unresolve_comment\`, \`add_reply\`, \`edit_reply\`,
  \`delete_reply\`, \`get_approval_status\`.
- Readers: \`get_reactions\`, \`get_views\` (named readers need the edit token).
- Files: \`add_file\`, \`list_files\`, \`get_file\` (binary files come back as
  base64), \`remove_file\`.
- Large files without reading them into the conversation: \`create_via_shell\`,
  \`upload_via_shell\`, \`add_file_via_shell\` return a shell command (jq + curl)
  to run; export \`MDREVIEW_EDIT_TOKEN\` for documents whose token the MCP
  server does not know.
- Write tools take \`editToken\`; tokens of documents created or edited through
  an MCP server are remembered in its token store (\`MCP_TOKEN_STORE\`).

## CLI

\`node server/cli.mjs\` (\`md-review\`): \`create\`, \`upload\`, \`add-file\`, \`patch\`
and \`publish <key> <file>\` (recurring docs). The edit token comes from
\`--token\` or \`MDREVIEW_EDIT_TOKEN\`.

This file lists no documents: shared links are unlisted.
`;

module.exports = async function raw(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return NEXT;
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/llms.txt') {
    return sendText(req, res, 200, LLMS_TXT, { 'Cache-Control': 'public, max-age=300' });
  }

  const m = RAW_PATH.exec(url.pathname);
  if (!m) return NEXT;
  const view = readView(url.searchParams);
  if (!view) return sendText(req, res, 400, 'Invalid view: use view=agent or view=human\n');
  const id = resolveId(m[1]);
  const meta = id ? loadMeta(id) : null;
  if (!meta) return sendText(req, res, 404, 'Document not found\n');
  if (isExpired(meta)) return sendText(req, res, 410, 'This document has expired\n');

  let source;
  if (m[2]) {
    // A pinned revision: its stored blob (the live content when it is the current hash).
    source = readRevisionBlob(id, m[2]);
    if (source === null && m[2] === meta.content_hash) source = loadContent(id) || '';
    if (source === null) return sendText(req, res, 404, 'Revision not found\n');
  } else {
    source = loadContent(id) || '';
  }
  const html = effectiveContentType(meta) === 'html';
  // HTML docs have no agent sections (rule 21) and are never served as text/html on the API origin.
  const { markdown: body, count } = viewOf(source, view, html);
  // Content-addressed: the body and headers depend only on the source, its type and the view.
  const hash = crypto.createHash('md5').update(`${html ? 'html' : 'markdown'}\n`).update(source).digest('hex');
  const etag = viewEtag(`"raw-${hash}"`, html || view !== 'human' ? 'plain' : 'human');
  const headers = {
    'Cache-Control': 'no-cache',
    'X-Agent-Sections': String(count),
    ETag: etag,
  };
  if (notModified(req, etag)) { res.writeHead(304, headers); return res.end(); }
  headers['Content-Type'] = html ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8';
  return sendText(req, res, 200, body, headers);
};

