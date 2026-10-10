'use strict';
// Route: DELETE /paste/:id, PUT /paste/:id/meta, GET /paste/:id[/comments|/markdown]. Returns NEXT when the request is not one of its own.
const fs = require('fs');
const crypto = require('crypto');
const { NEXT, readJsonBody } = require('../http-util.cjs');
const {
  slugIndex, writeFileAtomic, saveSlugIndex, generateSlug, uniqueSlug, isExpired, resolveId, contentPath, metaPath, filesDir, loadContent, loadMeta, revisionsDir, revisionSummary, listSessionFiles,
} = require('../storage.cjs');

module.exports = async function session(req, res) {
  // DELETE /paste/:id — delete a session and all its data
  const deleteMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const pasteId = resolveId(deleteMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const meta = loadMeta(pasteId);
    if (!meta) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    // Remove slug from index
    if (meta.slug && slugIndex[meta.slug]) {
      delete slugIndex[meta.slug];
      saveSlugIndex();
    }
    // Remove files
    try { fs.unlinkSync(metaPath(pasteId)); } catch {}
    try { fs.unlinkSync(contentPath(pasteId)); } catch {}
    try { fs.rmSync(revisionsDir(pasteId), { recursive: true, force: true }); } catch {}
    const fdir = filesDir(pasteId);
    if (fs.existsSync(fdir)) { try { fs.rmSync(fdir, { recursive: true, force: true }); } catch {} }
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

    if (parsed.sessionName !== undefined) meta.sessionName = parsed.sessionName;
    if (parsed.filename !== undefined) meta.filename = parsed.filename;

    // Update expiry
    if (parsed.expiry_days !== undefined) {
      if (parsed.expiry_days === null) {
        delete meta.expires_at;
      } else {
        const days = [7, 30, 90].includes(parsed.expiry_days) ? parsed.expiry_days : 30;
        meta.expires_at = new Date(Date.now() + days * 86400000).toISOString();
      }
    }

    // Update slug
    if (parsed.slug !== undefined) {
      // Remove old slug
      if (meta.slug && slugIndex[meta.slug]) {
        delete slugIndex[meta.slug];
      }
      if (parsed.slug) {
        const newSlug = uniqueSlug(generateSlug(parsed.slug));
        meta.slug = newSlug;
        slugIndex[newSlug] = pasteId;
      } else {
        delete meta.slug;
      }
      saveSlugIndex();
    }

    writeFileAtomic(metaPath(pasteId), JSON.stringify(meta));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      sessionName: meta.sessionName || null,
      slug: meta.slug || null,
      expires_at: meta.expires_at || null,
    }));
  }

  // GET /paste/:id — read full paste (supports ?fields=meta,content,comments,files)
  // GET /paste/:id/comments — read comments only
  // GET /paste/:id/markdown — read markdown only
  const match = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)(\/comments|\/markdown)?(\?.*)?$/);
  if (req.method === 'GET' && match) {
    const resolvedId = resolveId(match[1]);
    if (!resolvedId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }

    const mp = metaPath(resolvedId);
    if (!fs.existsSync(mp)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

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

    // ETag from stored content_hash + meta hash
    const metaBytes = fs.readFileSync(mp);
    const combinedHash = crypto.createHash('md5')
      .update(meta.content_hash || '')
      .update(metaBytes)
      .digest('hex');
    const etag = `"${combinedHash}"`;

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag });
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
        Object.assign(result, rest, revisionSummary(meta));
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
      result = { ...metaRest, markdown, ...revisionSummary(meta) };
      const sessionFiles = listSessionFiles(resolvedId);
      if (sessionFiles.length > 0) result.files = sessionFiles;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
    res.end(JSON.stringify(result));
    return;
  }

  return NEXT;
};
