'use strict';
// Edit tokens (#23): issue, present, verify, rotate/claim.
//
// A new doc gets a secret `mre_…` token; only sha256(token) is stored
// (sessions.edit_token_hash). Protected writes call requireEdit() — after the
// 404 and body-parse checks, before any other validation (rule 3 order).
// Legacy sessions (no hash) stay link-editable: every write passes and a
// presented token is ignored (rule 5). Reads stay open; they only report
// `access` (rule 6).
//
// Route: POST /paste/:id/edit-token — rotate (protected doc, needs the current
// token) or claim (legacy doc, anyone, once). Returns NEXT otherwise.
const crypto = require('crypto');
const { NEXT, readJsonBody } = require('../http-util.cjs');
const { resolveId, loadMeta, getEditTokenHash, setEditTokenHash } = require('../storage.cjs');
const { appUrl } = require('../links.cjs');

/** `mre_` + 32 random bytes, base64url (43 chars). */
const newToken = () => `mre_${crypto.randomBytes(32).toString('base64url')}`;
/** What is stored: hex sha256 of the token. */
const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf-8').digest('hex');

/**
 * The token the request presents: `X-Edit-Token: <t>` or `Authorization: Bearer <t>`
 * (scheme case-insensitive, whitespace trimmed). { token: null } when none;
 * { conflict: true } when both are present and disagree.
 */
function presentedToken(req) {
  const x = typeof req.headers['x-edit-token'] === 'string' ? req.headers['x-edit-token'].trim() : '';
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  const b = m ? m[1] : '';
  if (x && b && x !== b) return { token: null, conflict: true };
  return { token: x || b || null, conflict: false };
}

/** Constant-time comparison of a presented token against the stored hex hash. */
function tokenMatches(token, storedHash) {
  if (!token || !storedHash) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(String(storedHash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The caller's edit access: 'none' (unknown doc), 'legacy' (no hash: anyone
 * edits), 'ok' (valid token), 'missing' (no token), 'invalid' (wrong token or
 * disagreeing headers).
 */
function editAccess(req, id) {
  const stored = getEditTokenHash(id);
  if (stored === undefined) return 'none';
  if (stored === null) return 'legacy';
  const p = presentedToken(req);
  if (p.conflict) return 'invalid';
  if (!p.token) return 'missing';
  return tokenMatches(p.token, stored) ? 'ok' : 'invalid';
}

/** `access` for GET responses (rule 6). */
function accessInfo(req, id) {
  const a = editAccess(req, id);
  return { protected: a !== 'legacy', can_edit: a === 'legacy' || a === 'ok' };
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/**
 * The write guard. True when the caller may write `id`; otherwise it has sent
 * 404 (unknown doc), 401 edit_token_required or 403 edit_token_invalid.
 */
function requireEdit(req, res, id) {
  const a = editAccess(req, id);
  if (a === 'legacy' || a === 'ok') return true;
  if (a === 'none') send(res, 404, { error: 'not found' });
  else if (a === 'missing') send(res, 401, { error: 'Edit token required', code: 'edit_token_required' });
  else send(res, 403, { error: 'Invalid edit token', code: 'edit_token_invalid' });
  return false;
}

/** The edit link handed out with a raw token: app_url(x) + "?edit=" + token (00 §6). */
const editUrlFor = (x, token) => `${appUrl(x)}?edit=${token}`;

async function editTokens(req, res) {
  // POST /paste/:id/edit-token — rotate or claim (rule 7)
  const m = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/edit-token$/);
  if (req.method !== 'POST' || !m) return NEXT;
  const id = resolveId(m[1]);
  if (!id || getEditTokenHash(id) === undefined) return send(res, 404, { error: 'not found' });
  if ((await readJsonBody(req, res, { optional: true, lenient: true })) === undefined) return;
  // Re-read after the await: a concurrent claim may have protected the doc meanwhile.
  const stored = getEditTokenHash(id);
  if (stored === undefined) return send(res, 404, { error: 'not found' });
  if (!requireEdit(req, res, id)) return;
  const token = newToken();
  if (!setEditTokenHash(id, hashToken(token), stored)) {
    // Lost a race (no await sits between the read and the write, so this is defensive).
    return send(res, 409, { error: 'Edit token changed concurrently, retry' });
  }
  const slug = loadMeta(id)?.slug;
  // The body carries the raw edit token: never cache it.
  return send(res, 200, { editToken: token, editUrl: editUrlFor(slug || id, token) }, { 'Cache-Control': 'no-store' });
}

module.exports = editTokens;
Object.assign(module.exports, { newToken, hashToken, presentedToken, tokenMatches, editAccess, accessInfo, requireEdit, editUrlFor });
