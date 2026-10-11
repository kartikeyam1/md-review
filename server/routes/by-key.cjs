'use strict';
// Upsert by key (#21): one stable URL per recurring doc.
//
//   PUT /paste/by-key/:key — create the doc the first time (201, with an edit
//     token), otherwise publish the new content as a revision of the same doc
//     (200; a protected write per #23). Upsert revisions never coalesce and
//     carry the optional `changeNote` as their `note`.
//   GET /paste/by-key/:key — where the keyed doc lives and its current revision.
//
// Keys are exact-match, lowercase-only and validated (never normalised), unique
// across sessions (sessions.upsert_key) and never shown in URLs. Registered
// before every /paste/:id route: `by-key` is a reserved slug (00 §6), and
// /paste/by-key/markdown would otherwise reach PUT /paste/:id/markdown.
//
// Concurrency (rule 8): after the body is read, the key lookup and the insert
// or update run synchronously in one transaction, so two first upserts for one
// key make exactly one doc — the loser is an update of the winner's doc and
// needs its token, which it does not have (401).
const crypto = require('crypto');
const { NEXT, readJsonBody, clientOf } = require('../http-util.cjs');
const {
  generateSlug, uniqueSlug, isExpired, loadPaste, savePaste, currentContentHash, contentHashMismatch,
  hashContent, sessionByKey, tx,
} = require('../storage.cjs');
const { readMode, defaultMode, modeOf } = require('../mode.cjs');
const { handedOutUrl, appUrl } = require('../links.cjs');
const { newToken, hashToken, editUrlFor, editAccess } = require('./edit-tokens.cjs');
const { normalizeExpiryDays, expiresAtFor, DEFAULT_EXPIRY_DAYS } = require('../../shared/expiry.mjs');

/** Rule 1: lowercase, 1–128 chars, starting with a letter or digit. */
const KEY_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const CHANGE_NOTE_MAX = 500;
/** Meta fields an update replaces when given (rule 4). */
const UPDATABLE = ['filename', 'contentType', 'sessionName'];

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
/** A response to send once the transaction has committed. */
const reply = (status, body, headers = {}) => ({ status, body, headers });
const INVALID_KEY = { error: 'Invalid key', code: 'invalid_key' };

/** The key from the URL path segment (percent-decoded), or null when it is not a valid key. */
function keyFrom(segment) {
  let key;
  try { key = decodeURIComponent(segment); } catch { return null; }
  return KEY_RE.test(key) ? key : null;
}

/** Body validation shared by create and update. Returns an error message, or null. */
function bodyError(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'Body must be a JSON object';
  if (typeof b.markdown !== 'string') return 'markdown (string) is required';
  for (const k of ['filename', 'sessionName', 'slug', 'author']) {
    if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') return `${k} must be a string`;
  }
  if (b.contentType !== undefined && b.contentType !== null && typeof b.contentType !== 'string') return 'contentType must be a string';
  if (b.changeNote !== undefined && b.changeNote !== null) {
    if (typeof b.changeNote !== 'string') return 'changeNote must be a string';
    if (b.changeNote.trim().length > CHANGE_NOTE_MAX) return `changeNote is longer than ${CHANGE_NOTE_MAX} characters`;
  }
  return null;
}

const links = (id, slug) => ({ url: handedOutUrl(slug || id), app_url: appUrl(slug || id) });
const authorOf = (b) => (typeof b.author === 'string' && b.author.trim() ? b.author.trim().slice(0, 80) : null);
const noteOf = (b) => (typeof b.changeNote === 'string' && b.changeNote.trim() ? b.changeNote.trim() : null);

function create(req, key, body) {
  const m = readMode(body);
  if (m.error) return reply(400, m.error);
  const data = {
    markdown: body.markdown,
    approval_status: 'pending',
    sharedAt: new Date().toISOString(),
    comments: [],
  };
  for (const k of UPDATABLE) if (typeof body[k] === 'string') data[k] = body[k];
  // Rule 3: expiry as POST /paste (absent → 30 days, null → never).
  const days = body.expiry_days === undefined ? DEFAULT_EXPIRY_DAYS : normalizeExpiryDays(body.expiry_days);
  if (days !== null) data.expires_at = expiresAtFor(days);
  data.mode = m.mode || defaultMode(data);
  // Slug: slug → sessionName → the key with ':' / '.' as '-' (never a reserved slug, 00 §6).
  const base = [body.slug, body.sessionName, key.replace(/[:.]/g, '-')]
    .map((s) => (typeof s === 'string' ? generateSlug(s) : ''))
    .find(Boolean);
  const slug = uniqueSlug(base);
  data.slug = slug;

  const id = crypto.randomBytes(6).toString('hex');
  const by = authorOf(body);
  const editToken = newToken();
  const saved = savePaste(id, data, { by, client: clientOf(req), note: noteOf(body), noCoalesce: true },
    { claimSlugs: [slug], createdBy: by, editTokenHash: hashToken(editToken), upsertKey: key });
  return reply(201, {
    id, slug, key, created: true, changed: true, revision: saved.content_hash, mode: data.mode,
    ...links(id, slug), editToken, editUrl: editUrlFor(slug, editToken),
  }, { ETag: `"${saved.content_hash}"`, 'Cache-Control': 'no-store' }); // the body carries the raw token
}

function update(req, key, id, body) {
  const m = readMode(body); // validated for a uniform 400; an update never changes the mode
  if (m.error) return reply(400, m.error);
  const data = loadPaste(id);
  const mismatch = contentHashMismatch(req.headers['if-match'] || body.base_hash, data, data.markdown);
  if (mismatch) {
    return reply(412, {
      error: 'Content changed on server since your last read',
      content_hash: mismatch, markdown: data.markdown, filename: data.filename,
    }, { ETag: `"${mismatch}"` });
  }

  const contentChanged = hashContent(Buffer.from(body.markdown, 'utf-8')) !== currentContentHash(data, data.markdown);
  let metaChanged = false;
  for (const k of UPDATABLE) {
    if (typeof body[k] === 'string' && body[k] !== data[k]) { data[k] = body[k]; metaChanged = true; }
  }
  // Rule 4: expiry_days recomputes from now; without it an expired keyed doc is revived for 30 days.
  let expiryChanged = false;
  if (body.expiry_days !== undefined) {
    const days = normalizeExpiryDays(body.expiry_days);
    if (days === null) delete data.expires_at;
    else data.expires_at = expiresAtFor(days);
    expiryChanged = true;
  } else if (isExpired(data)) {
    data.expires_at = expiresAtFor(DEFAULT_EXPIRY_DAYS);
    expiryChanged = true;
  }

  let revision = currentContentHash(data, data.markdown);
  if (contentChanged || metaChanged || expiryChanged) {
    data.markdown = body.markdown;
    revision = savePaste(id, data, { by: authorOf(body), client: clientOf(req), note: noteOf(body), noCoalesce: true }).content_hash;
  }
  return reply(200, {
    id, slug: data.slug || null, key, created: false, changed: contentChanged || metaChanged, revision, mode: modeOf(data),
    ...links(id, data.slug),
  }, { ETag: `"${revision}"` });
}

module.exports = async function byKey(req, res) {
  const match = req.url.match(/^\/paste\/by-key\/([^/?]+)(?:\?.*)?$/);
  if (!match || (req.method !== 'PUT' && req.method !== 'GET')) return NEXT;

  if (req.method === 'GET') {
    const key = keyFrom(match[1]);
    if (!key) return send(res, 400, INVALID_KEY);
    const row = sessionByKey(key);
    const meta = row && loadPaste(row.id);
    if (!meta) return send(res, 404, { error: 'not found' });
    const out = {
      id: row.id, slug: meta.slug || null, key, revision: currentContentHash(meta, meta.markdown), mode: modeOf(meta),
      updated_at: row.updated_at, ...links(row.id, meta.slug),
    };
    if (isExpired(meta)) out.expired = true; // rule 6: the next upsert revives it
    return send(res, 200, out);
  }

  const key = keyFrom(match[1]);
  if (!key) return send(res, 400, INVALID_KEY);
  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  // Everything below is synchronous (no await): lookup + write are one transaction,
  // and the response goes out only after it committed.
  const out = tx(() => {
    const row = sessionByKey(key);
    const err = bodyError(body);
    if (!row) return err ? reply(400, { error: err }) : create(req, key, body);
    // #23 rule 3 order: token (401 edit_token_required / 403 edit_token_invalid) before validation.
    const access = editAccess(req, row.id);
    if (access === 'missing') return reply(401, { error: 'Edit token required', code: 'edit_token_required' });
    if (access === 'invalid') return reply(403, { error: 'Invalid edit token', code: 'edit_token_invalid' });
    return err ? reply(400, { error: err }) : update(req, key, row.id, body);
  });
  return send(res, out.status, out.body, out.headers);
};
