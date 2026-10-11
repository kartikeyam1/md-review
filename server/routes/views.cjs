'use strict';
// View counts and named readers (#25). One row per reader browser per doc per
// UTC day (views table); no IP or user agent is stored.
//
//   POST /paste/:id/views {reader_id, name?, revision?} → 204
//     First call of the (doc, reader, UTC day) inserts; later ones update
//     last_viewed_at, revision and (when given) name. Open to anyone; a valid
//     edit token on a protected doc marks the row as the editor's own view
//     (excluded from every count). Only the SPA posts; meta pages, GET /paste/*
//     and MCP tools never record views.
//   GET /paste/:id/views → {total_views, unique_readers, last_viewed_at}, plus
//     {readers, anonymous_readers} for editors (valid token, or a legacy
//     link-editable doc).
//
// The test clock MDREVIEW_NOW (ISO) overrides "now" for day bucketing.
const { NEXT, readJsonBody } = require('../http-util.cjs');
const { db, currentContentHash, loadContent } = require('../storage.cjs');
const { openDoc, validReaderId } = require('./reactions.cjs');
const { editAccess } = require('./edit-tokens.cjs');
const { normalizeReaderName } = require('../../shared/reactions.mjs');

const REVISION_RE = /^[a-f0-9]{32}$/;

const send = (res, status, body, headers = {}) => {
  if (body === undefined) { res.writeHead(status, headers); return res.end(); }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** Now, or the MDREVIEW_NOW test clock. */
function now() {
  const t = process.env.MDREVIEW_NOW ? Date.parse(process.env.MDREVIEW_NOW) : NaN;
  return Number.isFinite(t) ? new Date(t) : new Date();
}

/** Aggregates over non-editor rows: what everyone may see. */
function viewCounts(sessionId) {
  const r = db.prepare(`SELECT count(*) AS total_views, count(DISTINCT reader_id) AS unique_readers, max(last_viewed_at) AS last_viewed_at
                        FROM views WHERE session_id = ? AND is_editor = 0`).get(sessionId);
  return { total_views: r.total_views, unique_readers: r.unique_readers, last_viewed_at: r.last_viewed_at ?? null };
}

/** Editor-only detail: readers grouped by name (case-insensitive) + readers that never sent a name. */
function readerList(sessionId, currentHash) {
  const rows = db.prepare(`SELECT reader_id, name, revision, last_viewed_at FROM views
                           WHERE session_id = ? AND is_editor = 0 ORDER BY last_viewed_at DESC, rowid DESC`).all(sessionId);
  const byName = new Map();
  const named = new Set();
  for (const r of rows) if (r.name) named.add(r.reader_id);
  for (const r of rows) {
    if (!r.name) continue;
    const k = r.name.toLowerCase();
    const g = byName.get(k);
    if (g) { g.views++; continue; }
    // Rows are newest first: the first row of a name decides spelling, time and revision.
    byName.set(k, { name: r.name, last_viewed_at: r.last_viewed_at, revision: r.revision ?? null, is_current: !!r.revision && r.revision === currentHash, views: 1 });
  }
  const anonymous = new Set(rows.filter((r) => !named.has(r.reader_id)).map((r) => r.reader_id));
  return { readers: [...byName.values()], anonymous_readers: anonymous.size };
}

module.exports = async function views(req, res) {
  const m = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/views(?:\?.*)?$/);
  if (!m || (req.method !== 'GET' && req.method !== 'POST')) return NEXT;

  if (req.method === 'GET') {
    const doc = openDoc(res, m[1]);
    if (!doc) return;
    const access = editAccess(req, doc.id);
    const body = viewCounts(doc.id);
    if (access === 'ok' || access === 'legacy') {
      Object.assign(body, readerList(doc.id, currentContentHash(doc.meta, loadContent(doc.id))));
    }
    // The body depends on the presented token: never share a cached copy between callers.
    return send(res, 200, body, { 'Cache-Control': 'no-store', Vary: 'Authorization, X-Edit-Token' });
  }

  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  const doc = openDoc(res, m[1]);
  if (!doc) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Body must be a JSON object' });
  const readerId = validReaderId(body.reader_id);
  if (!readerId) return send(res, 400, { error: 'Invalid reader_id', code: 'invalid_reader' });
  let revision = null;
  if (body.revision !== undefined && body.revision !== null) {
    if (typeof body.revision !== 'string' || !REVISION_RE.test(body.revision)) return send(res, 400, { error: 'Invalid revision', code: 'invalid_revision' });
    revision = body.revision;
  }
  revision ??= currentContentHash(doc.meta, loadContent(doc.id));
  const name = normalizeReaderName(body.name);
  // A valid edit token on a protected doc: the editor's own view (rule 2). Legacy docs have no editors to exclude.
  const isEditor = editAccess(req, doc.id) === 'ok' ? 1 : 0;
  const t = now();
  const at = t.toISOString();
  db.prepare(`INSERT INTO views (session_id, reader_id, day, name, revision, first_viewed_at, last_viewed_at, is_editor)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_id, reader_id, day) DO UPDATE SET
                last_viewed_at = excluded.last_viewed_at,
                revision = excluded.revision,
                name = COALESCE(excluded.name, views.name),
                is_editor = max(views.is_editor, excluded.is_editor)`)
    .run(doc.id, readerId, at.slice(0, 10), name, revision, at, at, isEditor);
  return send(res, 204);
};

Object.assign(module.exports, { viewCounts, readerList });
