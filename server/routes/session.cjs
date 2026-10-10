'use strict';
// Route: DELETE /paste/:id, PUT /paste/:id/meta, GET /paste/:id[/comments|/markdown]. Returns NEXT when the request is not one of its own.
const { NEXT, readJsonBody } = require('../http-util.cjs');
const {
  generateSlug, uniqueSlug, isExpired, resolveId, loadContent, loadMeta, savePaste, deleteSession, sessionEtag,
  revisionSummary, listSessionFiles,
} = require('../storage.cjs');
const { handedOutUrl } = require('../links.cjs');
const { readMode, modeOf } = require('../mode.cjs');
const { requireEdit, accessInfo } = require('./edit-tokens.cjs');
const { normalizeExpiryDays, expiresAtFor } = require('../../shared/expiry.mjs');

module.exports = async function session(req, res) {
  // DELETE /paste/:id — delete a session and all its data
  const deleteMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const pasteId = resolveId(deleteMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const meta = loadMeta(pasteId);
    if (!meta) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    if (!requireEdit(req, res, pasteId)) return;
    // Rows (content, history, comments, file metadata), search row, slug, then files/<id>/
    deleteSession(pasteId, meta);
    res.writeHead(204);
    return res.end();
  }

  // PUT /paste/:id/meta — update session metadata (name, expiry, slug)
  const metaPutMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/meta$/);
  if (req.method === 'PUT' && metaPutMatch) {
    const pasteId = resolveId(metaPutMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = await readJsonBody(req, res);
    if (parsed === undefined) return;
    const meta = loadMeta(pasteId);
    if (!meta) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    if (!requireEdit(req, res, pasteId)) return; // #23: every meta change (incl. mode, expiry) is a protected write
    const m = readMode(parsed);
    if (m.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(m.error));
    }

    if (m.mode) meta.mode = m.mode;
    if (parsed.sessionName !== undefined) meta.sessionName = parsed.sessionName;
    if (parsed.filename !== undefined) meta.filename = parsed.filename;

    // Update expiry (#23 rule 8): 1/7/30/90 days from now, null = never, anything else → 30
    let expiryDays;
    if (parsed.expiry_days !== undefined) {
      expiryDays = normalizeExpiryDays(parsed.expiry_days);
      if (expiryDays === null) delete meta.expires_at;
      else meta.expires_at = expiresAtFor(expiryDays);
    }

    // Update slug (the old one is released first, so it may be chosen again)
    const slugs = { releaseSlugs: [], claimSlugs: [] };
    if (parsed.slug !== undefined) {
      if (meta.slug) slugs.releaseSlugs.push(meta.slug);
      if (parsed.slug) {
        const newSlug = uniqueSlug(generateSlug(parsed.slug), { releasing: meta.slug, selfId: pasteId });
        meta.slug = newSlug;
        slugs.claimSlugs.push(newSlug);
      } else {
        delete meta.slug;
      }
    }

    savePaste(pasteId, meta, {}, slugs);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      sessionName: meta.sessionName || null,
      slug: meta.slug || null,
      expires_at: meta.expires_at || null,
      mode: modeOf(meta),
      ...(expiryDays !== undefined ? { expiry_days: expiryDays } : {}),
    }));
  }

  // GET /paste/:id — read full paste (supports ?fields=meta,content,comments,files)
  // GET /paste/:id/comments — read comments only
  // GET /paste/:id/markdown — read markdown only
  const match = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)(\/comments|\/markdown)?(\?.*)?$/);
  if (req.method === 'GET' && match) {
    const resolvedId = resolveId(match[1]);
    if (!resolvedId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }

    // Load metadata (lightweight — no content read yet)
    const meta = loadMeta(resolvedId);
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    if (isExpired(meta)) {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Session expired' }));
    }

    // ETag from the session's write version + content hash, and (#23) the caller's access
    const access = accessInfo(req, resolvedId);
    const etag = sessionEtag(resolvedId, access.protected ? (access.can_edit ? 'edit' : 'view') : '');

    // The body (access.can_edit) and the ETag depend on the presented token (#23).
    const VARY = 'Authorization, X-Edit-Token';
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag, Vary: VARY });
      return res.end();
    }

    const sub = match[2];
    const params = new URL(req.url, `http://${req.headers.host}`);
    const fields = params.searchParams.get('fields');

    let result;
    if (sub === '/comments') {
      result = { filename: meta.filename, comments: meta.comments || [] };
    } else if (sub === '/markdown') {
      const markdown = loadContent(resolvedId) || '';
      result = { filename: meta.filename, markdown };
    } else if (fields) {
      // Selective field loading: ?fields=meta,content,comments,files
      const wanted = new Set(fields.split(',').map(f => f.trim()));
      result = {};
      if (wanted.has('meta')) {
        const { comments, content_hash, revisions, ...rest } = meta;
        Object.assign(result, rest, revisionSummary(resolvedId), { url: handedOutUrl(meta.slug || resolvedId), mode: modeOf(meta), id: resolvedId, access });
      }
      if (wanted.has('content')) {
        result.markdown = loadContent(resolvedId) || '';
      }
      if (wanted.has('comments')) {
        result.comments = meta.comments || [];
      }
      if (wanted.has('files')) {
        result.files = listSessionFiles(resolvedId);
      }
    } else {
      // Full response (backward compatible) — includes file list if any
      const markdown = loadContent(resolvedId) || '';
      const { revisions, ...metaRest } = meta;
      result = { ...metaRest, markdown, ...revisionSummary(resolvedId), url: handedOutUrl(meta.slug || resolvedId), mode: modeOf(meta), id: resolvedId, access };
      const sessionFiles = listSessionFiles(resolvedId);
      if (sessionFiles.length > 0) result.files = sessionFiles;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag, Vary: VARY });
    res.end(JSON.stringify(result));
    return;
  }

  return NEXT;
};
