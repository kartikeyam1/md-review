'use strict';
// Route: GET /paste/list. Returns NEXT when the request is not one of its own.
const { NEXT } = require('../http-util.cjs');
const {
  isExpired, listSessionsForList,
} = require('../storage.cjs');
const { modeOf } = require('../mode.cjs');
const { handedOutUrl } = require('../links.cjs');

module.exports = async function list(req, res) {
  // GET /paste/list — list sessions (filter by status, name pattern, limit)
  if (req.method === 'GET' && req.url.startsWith('/paste/list')) {
    const params = new URL(req.url, `http://${req.headers.host}`);
    const statusFilter = params.searchParams.get('status');
    const nameFilter = params.searchParams.get('name');
    const limitParam = params.searchParams.get('limit');
    let nameRe = null;
    if (nameFilter) {
      try { nameRe = new RegExp(nameFilter, 'i'); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid name pattern' }));
      }
    }
    const results = [];
    for (const s of listSessionsForList()) {
      const data = s.meta;
      if (isExpired(data)) continue;
      if (statusFilter && data.approval_status !== statusFilter) continue;
      if (nameRe && !nameRe.test(data.sessionName || '') && !nameRe.test(data.filename || '')) continue;
      results.push({
        id: s.id,
        slug: data.slug || null,
        sessionName: data.sessionName || null,
        filename: data.filename || null,
        approval_status: data.approval_status || 'pending',
        comment_count: s.comment_count,
        must_fix_unresolved: s.must_fix_unresolved,
        file_count: s.file_count,
        created_at: data.sharedAt || null,
        expires_at: data.expires_at || null,
        updated_at: s.updated_at || data.sharedAt || null,
        revision_count: s.revision_count,
        mode: modeOf(data),
        // The doc's link (00 §6), and its upsert key (#21) when it was published by key.
        url: handedOutUrl(data.slug || s.id),
        ...(s.upsert_key ? { upsert_key: s.upsert_key } : {}),
      });
    }
    results.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const limit = limitParam ? parseInt(limitParam, 10) : results.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(results.slice(0, limit)));
  }

  return NEXT;
};
