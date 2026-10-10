'use strict';
// Route: comments, replies, resolve/unresolve. Returns NEXT when the request is not one of its own.
const crypto = require('crypto');
const { NEXT, readJsonBody } = require('../http-util.cjs');
const {
  resolveId, loadPaste, savePaste,
} = require('../storage.cjs');

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
    const data = loadPaste(pasteId);
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

      res.writeHead(201, { 'Content-Type': 'application/json' });
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
    const data = loadPaste(pasteId);
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
    const data = loadPaste(pasteId);
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

      res.writeHead(201, { 'Content-Type': 'application/json' });
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
