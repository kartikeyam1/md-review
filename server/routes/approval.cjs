'use strict';
// Route: GET|PUT /paste/:id/approval. Returns NEXT when the request is not one of its own.
const { NEXT, readJsonBody, fireWebhook } = require('../http-util.cjs');
const {
  resolveId, loadPaste, savePaste,
} = require('../storage.cjs');

module.exports = async function approval(req, res) {
  // GET /paste/:id/approval — get approval status
  // PUT /paste/:id/approval — transition approval status
  const approvalMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/approval$/);
  if (approvalMatch && (req.method === 'GET' || req.method === 'PUT')) {
    const pasteId = resolveId(approvalMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = req.method === 'PUT' ? await readJsonBody(req, res) : null;
    if (parsed === undefined) return;
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        approval_status: data.approval_status || 'pending',
        approved_by: data.approved_by || null,
        approved_at: data.approved_at || null,
      }));
    }

    // PUT — transition approval status
    const current = data.approval_status || 'pending';
    const next = parsed.status;
    const VALID = {
      'pending': ['approved', 'changes_requested'],
      'approved': ['changes_requested'],
      'changes_requested': ['approved'],
    };
    if (!VALID[current] || !VALID[current].includes(next)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Invalid transition: ${current} -> ${next}` }));
    }

    // Must-fix enforcement: block approval if unresolved must-fix comments
    if (next === 'approved') {
      const unresolved = (data.comments || [])
        .filter(c => c.category === 'must-fix' && c.resolved !== true)
        .map(c => c.id);
      if (unresolved.length > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'Cannot approve: unresolved must-fix comments',
          unresolved_comment_ids: unresolved,
        }));
      }
    }

    data.approval_status = next;
    if (next === 'approved') {
      data.approved_by = parsed.approved_by || null;
      data.approved_at = new Date().toISOString();
    } else if (next === 'changes_requested') {
      data.approved_by = null;
      data.approved_at = null;
    }
    savePaste(pasteId, data);

    // Fire webhook if callback_url exists
    if (data.callback_url) {
      fireWebhook(data.callback_url, {
        sessionId: pasteId,
        approval_status: data.approval_status,
        approved_by: data.approved_by,
        approved_at: data.approved_at,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      approval_status: data.approval_status,
      approved_by: data.approved_by,
      approved_at: data.approved_at,
    }));
  }

  return NEXT;
};
