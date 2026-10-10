'use strict';
// Route: GET /paste/:id/revisions[/:hash|current]. Returns NEXT when the request is not one of its own.
const { NEXT } = require('../http-util.cjs');
const {
  isExpired, resolveId, loadContent, loadMeta, readRevisionBlob, listRevisions,
} = require('../storage.cjs');
const { modeOf } = require('../mode.cjs');

module.exports = async function revisions(req, res) {
  // GET /paste/:id/revisions — content history (oldest first)
  // GET /paste/:id/revisions/:hash — one stored revision ('current' = live content)
  const revisionsMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/revisions(?:\/([a-f0-9]{32}|current))?$/);
  if (req.method === 'GET' && revisionsMatch) {
    const pasteId = resolveId(revisionsMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const meta = loadMeta(pasteId);
    if (!meta) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    if (isExpired(meta)) { res.writeHead(410, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Session expired' })); }
    const revisions = listRevisions(pasteId);
    const which = revisionsMatch[2];

    if (!which) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ current: meta.content_hash || null, revisions }));
    }

    const hash = which === 'current' ? (meta.content_hash || null) : which;
    const entry = revisions.find(r => r.hash === hash) || null;
    if (!hash || (!entry && hash !== meta.content_hash)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unknown revision' }));
    }
    let markdown = readRevisionBlob(pasteId, hash);
    if (markdown === null && hash === meta.content_hash) markdown = loadContent(pasteId);
    if (markdown === null) {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Revision no longer stored' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      hash, markdown,
      at: entry ? entry.at : null, at_end: entry ? (entry.at_end || null) : null,
      by: entry ? (entry.by ?? null) : null, client: entry ? (entry.client ?? null) : null,
      size: entry ? entry.size : markdown.length, parent: entry ? (entry.parent ?? null) : null,
      is_current: hash === meta.content_hash,
      // #2/#4 ruling: a pinned revision never GETs /paste/<id>, so the doc's
      // mode and name (for the reader header title) come with the revision.
      mode: modeOf(meta),
      sessionName: meta.sessionName || null,
      filename: meta.filename || null,
    }));
  }

  return NEXT;
};
