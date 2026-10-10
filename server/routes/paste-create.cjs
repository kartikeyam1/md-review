'use strict';
// Route: POST /paste — create a session. Returns NEXT when the request is not one of its own.
const crypto = require('crypto');
const { NEXT, readBody, clientOf } = require('../http-util.cjs');
const {
  slugIndex, saveSlugIndex, generateSlug, uniqueSlug, savePaste,
} = require('../storage.cjs');

module.exports = async function pasteCreate(req, res) {
  // POST /paste — create
  if (req.method === 'POST' && req.url === '/paste') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
    }

    let rawBody;
    try { rawBody = await readBody(req); }
    catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large (max 50 MB)' }));
    }

    let parsed;
    try { parsed = JSON.parse(rawBody); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    // Auto-set fields on new sessions
    if (!parsed.approval_status) parsed.approval_status = 'pending';
    if (!parsed.sharedAt) parsed.sharedAt = new Date().toISOString();

    // Session expiry: default 30 days, configurable via expiry_days (7, 30, or null for infinite)
    if (parsed.expiry_days !== null && parsed.expiry_days !== undefined) {
      const days = [7, 30].includes(parsed.expiry_days) ? parsed.expiry_days : 30;
      parsed.expires_at = new Date(Date.now() + days * 86400000).toISOString();
    } else if (parsed.expiry_days === null) {
      // Explicitly infinite — no expiry
    } else {
      parsed.expires_at = new Date(Date.now() + 30 * 86400000).toISOString();
    }

    const id = crypto.randomBytes(6).toString('hex');

    // Slug support
    let slug = null;
    if (parsed.slug) {
      slug = uniqueSlug(generateSlug(parsed.slug));
    } else if (parsed.sessionName) {
      slug = uniqueSlug(generateSlug(parsed.sessionName));
    }
    if (slug) {
      parsed.slug = slug;
      slugIndex[slug] = id;
      saveSlugIndex();
    }

    // `author` names who created the document (first revision); not stored as metadata.
    const createdBy = typeof parsed.author === 'string' ? parsed.author : null;
    delete parsed.author;
    savePaste(id, parsed, { by: createdBy, client: clientOf(req) });
    const result = { id };
    if (slug) result.slug = slug;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  return NEXT;
};
