'use strict';
// Route: comments, replies, resolve/unresolve. Returns NEXT when the request is not one of its own.
const crypto = require('crypto');
const { NEXT, readJsonBody, clientOf } = require('../http-util.cjs');
const {
  resolveId, loadMeta, loadContent, savePaste,
} = require('../storage.cjs');
const { modeOf } = require('../mode.cjs');

/**
 * Comments on a publish-mode doc are stored (switching the doc to review shows
 * them) but no reader sees them meanwhile, so the write says so instead of
 * looking like a normal success (DECISIONS: accept + warn). Warnings travel in
 * the X-MdReview-Warning response header (the JSON bodies keep their legacy
 * shape, #20 rule 5); the MCP tools copy them into the tool result.
 */
const PUBLISH_WARNING = 'This doc is in publish mode: readers see no comments or review UI, so nobody can see this until the doc is switched to review (update_session_meta mode=review, or PUT /paste/:id/meta {"mode":"review"}).';

/** Response headers for a comment/reply write: the warnings (if any) and whether readers can see it. */
function warningHeaders(meta, warnings = []) {
  const all = [...(modeOf(meta) === 'publish' ? [PUBLISH_WARNING] : []), ...warnings];
  const h = { 'Content-Type': 'application/json' };
  if (modeOf(meta) === 'publish') h['X-MdReview-Visible'] = 'false';
  // Header values must be latin-1: the messages above are plain ASCII.
  if (all.length) h['X-MdReview-Warning'] = all.join(' ');
  return h;
}

/**
 * Anchor checks for comments written by agents and scripts (not the UI, whose
 * editor may hold unsaved lines the server has not seen yet). Lines follow the
 * UI's convention: startLine 0-based, endLine exclusive (the line after the
 * last); 1-based inclusive ranges also fit. Lines past the end are a 400; a quote that is not in the
 * source is accepted with a warning (a reader view may quote rendered text).
 * Returns { error } or { warnings }.
 */
function checkAnchor(req, id, { startLine, endLine, selectedText }) {
  if (clientOf(req) === 'ui') return { warnings: [] };
  const source = loadContent(id) || '';
  const lineCount = source.split('\n').length;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 0 || endLine < startLine) {
    return { error: `startLine/endLine must be integers with 0 <= startLine <= endLine (got ${JSON.stringify(startLine)}, ${JSON.stringify(endLine)})` };
  }
  // One line of slack: clients counting 1-based inclusive lines (1..N) stay accepted.
  if (startLine > lineCount || endLine > lineCount) {
    return { error: `Lines ${startLine}-${endLine} are outside the document: it has ${lineCount} line(s) (startLine 0-${lineCount - 1}, endLine exclusive, at most ${lineCount}). Re-read it (get_session) and anchor the comment to existing lines.` };
  }
  const squash = (t) => String(t).replace(/\s+/g, ' ').trim();
  if (typeof selectedText === 'string' && !squash(source).includes(squash(selectedText))) {
    return { warnings: ['selectedText does not occur in the document source; readers will see it quoted as written.'] };
  }
  return { warnings: [] };
}

module.exports = async function comments(req, res) {
  // POST /paste/:id/comments/:commentId/replies — add a reply
  // PUT  /paste/:id/comments/:commentId/replies/:replyId — update a reply
  // DELETE /paste/:id/comments/:commentId/replies/:replyId — remove a reply
  const replyMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/comments\/([a-zA-Z0-9-]+)\/replies(?:\/([a-zA-Z0-9-]+))?$/);
  if (replyMatch && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
    const pasteId = resolveId(replyMatch[1]);
    const commentId = replyMatch[2];
    const replyId = replyMatch[3];
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = req.method === 'DELETE' ? null : await readJsonBody(req, res);
    if (parsed === undefined) return;
    const data = loadMeta(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (!data.comments) data.comments = [];
    const comment = data.comments.find(c => c.id === commentId);
    if (!comment) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'comment not found' }));
    }
    if (!comment.replies) comment.replies = [];

    if (req.method === 'POST' && !replyId) {
      if (!parsed.body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing required field: body' }));
      }

      const reply = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        body: parsed.body,
      };
      if (parsed.author !== undefined) reply.author = parsed.author;

      comment.replies.push(reply);
      savePaste(pasteId, data);

      res.writeHead(201, warningHeaders(data));
      return res.end(JSON.stringify(reply));
    }

    if (req.method === 'PUT' && replyId) {
      const ridx = comment.replies.findIndex(r => r.id === replyId);
      if (ridx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'reply not found' }));
      }

      if (parsed.body !== undefined) comment.replies[ridx].body = parsed.body;
      savePaste(pasteId, data);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(comment.replies[ridx]));
    }

    if (req.method === 'DELETE' && replyId) {
      const ridx = comment.replies.findIndex(r => r.id === replyId);
      if (ridx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'reply not found' }));
      }

      comment.replies.splice(ridx, 1);
      savePaste(pasteId, data);

      res.writeHead(204);
      return res.end();
    }
  }

  // PUT /paste/:id/comments/:commentId/resolve — resolve a comment
  // PUT /paste/:id/comments/:commentId/unresolve — unresolve a comment
  const resolveMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/comments\/([a-zA-Z0-9-]+)\/(resolve|unresolve)$/);
  if (resolveMatch && req.method === 'PUT') {
    const pasteId = resolveId(resolveMatch[1]);
    const commentId = resolveMatch[2];
    const action = resolveMatch[3];
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = await readJsonBody(req, res, { optional: true, lenient: true });
    if (parsed === undefined) return;
    const data = loadMeta(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (!data.comments) data.comments = [];
    const comment = data.comments.find(c => c.id === commentId);
    if (!comment) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'comment not found' }));
    }

    if (action === 'resolve') {
      comment.resolved = true;
      comment.resolved_by = parsed.resolved_by || null;
      comment.resolved_at = Date.now();
    } else {
      comment.resolved = false;
      comment.resolved_by = null;
      comment.resolved_at = null;
    }

    savePaste(pasteId, data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(comment));
  }

  // POST /paste/:id/comments — add a comment
  // PUT  /paste/:id/comments/:commentId — update a comment
  // DELETE /paste/:id/comments/:commentId — remove a comment
  const commentMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/comments(?:\/([a-zA-Z0-9-]+))?$/);
  if (commentMatch && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
    const pasteId = resolveId(commentMatch[1]);
    const commentId = commentMatch[2];
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = req.method === 'DELETE' ? null : await readJsonBody(req, res);
    if (parsed === undefined) return;
    const data = loadMeta(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (!data.comments) data.comments = [];

    if (req.method === 'POST' && !commentId) {
      const { startLine, endLine, selectedText, body: commentBody, category, author } = parsed;
      if (startLine == null || endLine == null || !selectedText || !commentBody || !category) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing required fields' }));
      }
      const anchor = checkAnchor(req, pasteId, parsed);
      if (anchor.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: anchor.error, code: 'invalid_anchor' }));
      }

      const comment = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        startLine,
        endLine,
        selectedText,
        body: commentBody,
        category,
      };
      if (author !== undefined) comment.author = author;

      data.comments.push(comment);
      savePaste(pasteId, data);

      res.writeHead(201, warningHeaders(data, anchor.warnings));
      return res.end(JSON.stringify(comment));
    }

    if (req.method === 'PUT' && commentId) {
      const idx = data.comments.findIndex(c => c.id === commentId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'comment not found' }));
      }

      if (parsed.body !== undefined) data.comments[idx].body = parsed.body;
      if (parsed.category !== undefined) data.comments[idx].category = parsed.category;
      savePaste(pasteId, data);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data.comments[idx]));
    }

    if (req.method === 'DELETE' && commentId) {
      const idx = data.comments.findIndex(c => c.id === commentId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'comment not found' }));
      }

      data.comments.splice(idx, 1);
      savePaste(pasteId, data);

      res.writeHead(204);
      return res.end();
    }
  }

  return NEXT;
};
