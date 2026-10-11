'use strict';
// Route: hosted sites. Returns NEXT when the request is not one of its own.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MAX_SITE_BYTES } = require('../config.cjs');
const { NEXT, getMime, readBodyRaw } = require('../http-util.cjs');
const {
  SITES_DIR, generateSlug, uniqueSlug, resolveSiteId, getSite, listSites, createSite, deleteSite,
} = require('../storage.cjs');

module.exports = async function sites(req, res) {
  // ── Site hosting ──────────────────────────────────────────────────────────

  // POST /site — create a new hosted site
  if (req.method === 'POST' && req.url === '/site') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
    }

    let rawBody;
    try { rawBody = await readBodyRaw(req, MAX_SITE_BYTES); }
    catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large (max 50 MB)' }));
    }

    let parsed;
    try { parsed = JSON.parse(rawBody.toString('utf-8')); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    if (!parsed.name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing required field: name' }));
    }
    if (!parsed.files && !parsed.archive) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Provide either "files" object or "archive" (base64)' }));
    }

    const id = crypto.randomBytes(6).toString('hex');
    const siteDir = path.join(SITES_DIR, id);
    fs.mkdirSync(siteDir, { recursive: true });

    try {
      if (parsed.files) {
        // files mode: { "index.html": "<content>", "css/style.css": "<content>" }
        for (const [filePath, content] of Object.entries(parsed.files)) {
          // Prevent directory traversal
          const resolved = path.resolve(siteDir, filePath);
          if (!resolved.startsWith(siteDir + path.sep) && resolved !== siteDir) {
            throw new Error(`Invalid file path: ${filePath}`);
          }
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, content);
        }
      } else if (parsed.archive) {
        // archive mode: base64-encoded zip or tar.gz
        const format = parsed.format || 'zip';
        const buf = Buffer.from(parsed.archive, 'base64');
        const tmpFile = path.join(SITES_DIR, `_tmp_${id}.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`);
        fs.writeFileSync(tmpFile, buf);

        try {
          if (format === 'tar.gz' || format === 'tgz') {
            require('child_process').execSync(`tar xzf "${tmpFile}" -C "${siteDir}"`, { timeout: 30000 });
          } else {
            require('child_process').execSync(`unzip -o -q "${tmpFile}" -d "${siteDir}"`, { timeout: 30000 });
          }
        } finally {
          try { fs.unlinkSync(tmpFile); } catch {}
        }

        // If the archive extracted into a single subdirectory, hoist its contents up
        const entries = fs.readdirSync(siteDir);
        if (entries.length === 1) {
          const sub = path.join(siteDir, entries[0]);
          if (fs.statSync(sub).isDirectory()) {
            const subEntries = fs.readdirSync(sub);
            for (const e of subEntries) {
              fs.renameSync(path.join(sub, e), path.join(siteDir, e));
            }
            fs.rmdirSync(sub);
          }
        }
      }
    } catch (err) {
      // Cleanup on failure
      try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch {}
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Failed to create site: ${err.message}` }));
    }

    // Slug
    let slug = null;
    if (parsed.slug) {
      slug = uniqueSlug(generateSlug(parsed.slug));
    } else if (parsed.name) {
      slug = uniqueSlug(generateSlug(parsed.name));
    }

    // Expiry
    let expires_at = null;
    if (parsed.expiry_days !== null && parsed.expiry_days !== undefined) {
      const days = [7, 30].includes(parsed.expiry_days) ? parsed.expiry_days : 30;
      expires_at = new Date(Date.now() + days * 86400000).toISOString();
    } else if (parsed.expiry_days === null) {
      // infinite
    } else {
      expires_at = new Date(Date.now() + 30 * 86400000).toISOString();
    }

    // Count files
    let fileCount = 0;
    const countFiles = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) countFiles(path.join(dir, e.name));
        else fileCount++;
      }
    };
    countFiles(siteDir);

    createSite(id, {
      slug,
      name: parsed.name,
      created_at: new Date().toISOString(),
      expires_at,
      file_count: fileCount,
      spa: parsed.spa !== false, // default true — SPA fallback to index.html
    });

    const result = { id, url: `/site/${slug || id}/` };
    if (slug) result.slug = slug;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // GET /site/list — list all hosted sites
  if (req.method === 'GET' && req.url === '/site/list') {
    const results = [];
    for (const { id, meta } of listSites()) {
      if (meta.expires_at && new Date(meta.expires_at) < new Date()) continue;
      results.push({ id, ...meta, url: `/site/${meta.slug || id}/` });
    }
    results.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(results));
  }

  // DELETE /site/:idOrSlug — remove a hosted site
  const siteDeleteMatch = req.url.match(/^\/site\/([a-zA-Z0-9][a-zA-Z0-9-]*)$/);
  if (req.method === 'DELETE' && siteDeleteMatch) {
    const siteId = resolveSiteId(siteDeleteMatch[1]);
    if (!siteId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'site not found' }));
    }
    const meta = getSite(siteId);
    // Remove files, then the index row and the site's slug
    const siteDir = path.join(SITES_DIR, siteId);
    try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch {}
    deleteSite(siteId, meta);

    res.writeHead(204);
    return res.end();
  }

  // GET /site/:idOrSlug/* — serve static files
  const siteMatch = req.url.match(/^\/site\/([a-zA-Z0-9][a-zA-Z0-9-]*)(\/.*)?$/);
  if (req.method === 'GET' && siteMatch) {
    const siteId = resolveSiteId(siteMatch[1]);
    if (!siteId) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Site not found');
    }
    const meta = getSite(siteId);
    if (meta && meta.expires_at && new Date(meta.expires_at) < new Date()) {
      res.writeHead(410, { 'Content-Type': 'text/plain' });
      return res.end('Site expired');
    }

    const siteDir = path.join(SITES_DIR, siteId);
    let reqPath = decodeURIComponent(siteMatch[2] || '/');

    // Resolve the file path safely
    let filePath = path.resolve(siteDir, '.' + reqPath);
    if (!filePath.startsWith(siteDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }

    // If it's a directory, look for index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    // If file doesn't exist and SPA mode is on, fall back to index.html
    if (!fs.existsSync(filePath) && meta && meta.spa) {
      filePath = path.join(siteDir, 'index.html');
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    const mime = getMime(filePath);
    const content = fs.readFileSync(filePath);
    const etag = `"${crypto.createHash('md5').update(content).digest('hex')}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }

    // Cache static assets aggressively, HTML not at all
    const cacheControl = mime === 'text/html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': content.length,
      'ETag': etag,
      'Cache-Control': cacheControl,
    });
    return res.end(content);
  }

  return NEXT;
};
