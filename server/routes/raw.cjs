'use strict';
// Route (#28): GET /d/:x.md — a doc's raw source for agents (rule 16), and
// GET /llms.txt — a static guide for agents (rule 20). Returns NEXT for
// anything else. Registered before meta.cjs (00 §6: /d/:x.md comes first) and
// the hosted-site asset fallback.
const crypto = require('crypto');
const { NEXT } = require('../http-util.cjs');
const { isExpired, resolveId, loadContent, loadMeta } = require('../storage.cjs');
const { effectiveContentType } = require('../doc-text.cjs');
const { PUBLIC_BASE_URL, PUBLIC_BASE_URL_SET } = require('../config.cjs');
const { readView, viewEtag, viewOf } = require('../agent-view.cjs');

// Slugs are [a-z0-9-], ids hex: the `.md` suffix is unambiguous (and case-sensitive).
const RAW_PATH = /^\/d\/([a-zA-Z0-9][a-zA-Z0-9-]*)\.md$/;

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
  segment of a shared link (\`/d/<slug>\`); the document id works too.
- \`GET ${API}/d/<slug>.md?view=human\` returns the human view: every
  agent-only section removed. \`?view=agent\` is the default.
- The \`X-Agent-Sections\` response header counts the agent-only sections.
- HTML documents come back as \`text/plain\` with their HTML source.
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

## MCP tools

- \`get_session\` reads a document; \`view: "human"\` returns the human view.
  The result includes \`view\`, \`agentSections\` and \`rawUrl\` (\`/d/<slug>.md\`).
- \`create_session\`, \`update_markdown\` and \`patch_markdown\` write documents;
  use the agent marker syntax above for agent-only material.
- \`list_comments\`, \`add_comment\` and \`add_reply\` work with review comments.

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

  const source = loadContent(id) || '';
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

