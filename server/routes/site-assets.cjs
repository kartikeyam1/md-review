'use strict';
// Route: root-level asset fallback for hosted sites. Returns NEXT when the request is not one of its own.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NEXT, getMime } = require('../http-util.cjs');
const {
  SITES_DIR, resolveSiteId, listSites,
} = require('../storage.cjs');

module.exports = async function siteAssets(req, res) {
  // ── Root-level asset fallback for hosted sites ───────────────────────────
  // React/Vite builds use absolute paths like /assets/index-abc.js.
  // When a site is hosted at /site/<slug>/, the browser requests /assets/...
  // instead of /site/<slug>/assets/... — resolve it here.
  if (req.method === 'GET') {
    const reqPath = decodeURIComponent(req.url.split('?')[0]);

    // Try Referer header first — most reliable since the browser sends it
    const referer = req.headers['referer'] || '';
    const refMatch = referer.match(/\/site\/([a-zA-Z0-9][a-zA-Z0-9-]*)/);
    if (refMatch) {
      const siteId = resolveSiteId(refMatch[1]);
      if (siteId) {
        const candidate = path.resolve(path.join(SITES_DIR, siteId), '.' + reqPath);
        if (candidate.startsWith(path.join(SITES_DIR, siteId)) && fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
          const mime = getMime(candidate);
          const content = fs.readFileSync(candidate);
          const etag = `"${crypto.createHash('md5').update(content).digest('hex')}"`;
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
          const cacheControl = mime === 'text/html' ? 'no-cache' : 'public, max-age=31536000, immutable';
          res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length, 'ETag': etag, 'Cache-Control': cacheControl });
          return res.end(content);
        }
      }
    }

    // Fallback: scan all sites for the file
    for (const { id, meta } of listSites()) {
      if (meta.expires_at && new Date(meta.expires_at) < new Date()) continue;
      const candidate = path.resolve(path.join(SITES_DIR, id), '.' + reqPath);
      if (candidate.startsWith(path.join(SITES_DIR, id)) && fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
        const mime = getMime(candidate);
        const content = fs.readFileSync(candidate);
        const etag = `"${crypto.createHash('md5').update(content).digest('hex')}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
        const cacheControl = mime === 'text/html' ? 'no-cache' : 'public, max-age=31536000, immutable';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length, 'ETag': etag, 'Cache-Control': cacheControl });
        return res.end(content);
      }
    }
  }

  return NEXT;
};
