'use strict';
// Route: POST /paste — create a session. Returns NEXT when the request is not one of its own.
const crypto = require('crypto');
const { NEXT, readBody, clientOf } = require('../http-util.cjs');
const {
  generateSlug, uniqueSlug, savePaste,
} = require('../storage.cjs');
const { readMode, defaultMode } = require('../mode.cjs');
const { handedOutUrl, appUrl } = require('../links.cjs');
const { newToken, hashToken, editUrlFor } = require('./edit-tokens.cjs');
const { normalizeExpiryDays, expiresAtFor } = require('../../shared/expiry.mjs');

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

    // Session expiry (#23 rule 8): 1/7/30/90 days; absent or any other number → 30 days;
    // null = never (a client-given expires_at is then kept, as before).
    const days = parsed.expiry_days === undefined ? 30 : normalizeExpiryDays(parsed.expiry_days);
    if (days !== null) parsed.expires_at = expiresAtFor(days);

    const id = crypto.randomBytes(6).toString('hex');

    // Slug support
    let slug = null;
    if (parsed.slug) {
      slug = uniqueSlug(generateSlug(parsed.slug));
    } else if (parsed.sessionName) {
      slug = uniqueSlug(generateSlug(parsed.sessionName));
    }
    if (slug) parsed.slug = slug;

    // Doc mode (#2 rule 12, 00 §1.4): validated when given; else publish — review when a callback is set.
    const m = readMode(parsed);
    if (m.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(m.error));
    }
    parsed.mode = m.mode || defaultMode(parsed);

    // `author` names who created the document (first revision); not stored as metadata.
    const createdBy = typeof parsed.author === 'string' ? parsed.author : null;
    delete parsed.author;
    // #23 rule 1: a fresh edit token; only its hash is stored, the raw token is returned once.
    const editToken = newToken();
    savePaste(id, parsed, { by: createdBy, client: clientOf(req) }, { claimSlugs: slug ? [slug] : [], createdBy, editTokenHash: hashToken(editToken) });
    const result = { id };
    if (slug) result.slug = slug;
    result.url = handedOutUrl(slug || id); // #22 rule 1 / 00 §6
    result.mode = parsed.mode;
    result.editToken = editToken;
    result.viewUrl = result.url;
    result.app_url = appUrl(slug || id);
    result.editUrl = editUrlFor(slug || id, editToken);
    // The body carries the raw edit token: never cache it (#23).
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(result));
  }

  return NEXT;
};
