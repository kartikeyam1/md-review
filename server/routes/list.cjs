'use strict';
// Route: GET /paste/list. Returns NEXT when the request is not one of its own.
const fs = require('fs');
const { NEXT } = require('../http-util.cjs');
const {
  DATA_DIR, isExpired, loadMeta, revisionSummary, listSessionFiles,
} = require('../storage.cjs');

module.exports = async function list(req, res) {
  // GET /paste/list — list sessions (filter by status, name pattern, limit)
  if (req.method === 'GET' && req.url.startsWith('/paste/list')) {
    const params = new URL(req.url, `http://${req.headers.host}`);
    const statusFilter = params.searchParams.get('status');
    const nameFilter = params.searchParams.get('name');
    const limitParam = params.searchParams.get('limit');
    const nameRe = nameFilter ? new RegExp(nameFilter, 'i') : null;
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    const results = [];
    for (const f of files) {
      try {
        // Use loadMeta — doesn't read content file, much faster for listings
        const id = f.replace('.json', '');
        const data = loadMeta(id);
        if (!data) continue;
        if (isExpired(data)) continue;
        if (statusFilter && data.approval_status !== statusFilter) continue;
        if (nameRe && !nameRe.test(data.sessionName || '') && !nameRe.test(data.filename || '')) continue;
        const sessionFiles = listSessionFiles(id);
        results.push({
          id,
          slug: data.slug || null,
          sessionName: data.sessionName || null,
          filename: data.filename || null,
          approval_status: data.approval_status || 'pending',
          comment_count: (data.comments || []).length,
          must_fix_unresolved: (data.comments || []).filter(c => c.category === 'must-fix' && c.resolved !== true).length,
          file_count: sessionFiles.length,
          created_at: data.sharedAt || null,
          expires_at: data.expires_at || null,
          updated_at: revisionSummary(data).latest_revision?.at || data.sharedAt || null,
          revision_count: (data.revisions || []).length,
        });
      } catch { /* skip corrupt files */ }
    }
    results.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const limit = limitParam ? parseInt(limitParam, 10) : results.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(results.slice(0, limit)));
  }

  return NEXT;
};
