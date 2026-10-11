'use strict';
// Library (#26): collections, tags, per-reader pins and bulk actions. The list
// and search endpoint itself is routes/library-docs.cjs (00 §8).
//
//   GET    /library/collections            → [{id, name, slug, doc_count}] (by name, case-insensitive)
//   POST   /library/collections {name}     → 201 {id, name, slug, doc_count:0}; 400 name rules; 409 duplicate
//   PATCH  /library/collections/:id {name} → 200 same shape; 404 unknown
//   DELETE /library/collections/:id        → 204 (its docs become unfiled)
//   GET    /library/tags                   → [{tag, count}] (non-expired docs, count > 0, by tag)
//   PUT    /paste/:id/tags {tags}          → {tags}            (edit capability)
//   PUT    /paste/:id/collection {collectionId|null} → {collection} (edit capability)
//   GET    /library/pins                   → [{docId, pinnedAt}] most recent first
//   PUT    /library/pins/:docId            → {docId, pinnedAt} (idempotent; 409 past PIN_LIMIT)
//   DELETE /library/pins/:docId            → 204 (idempotent)
//   POST   /library/pins/merge {from}      → {merged}
//   POST   /library/bulk {action, ids, tag?, collectionId?, editTokens?} → {results}
//
// Pins are keyed by the reader_key in X-MdReview-Reader (00 §7). Collections and
// pins need no edit capability; tags, moves and deletes do (#23). Tag and
// collection changes bump the doc's `version`, so GET /paste/:id's ETag moves
// with ?fields=library. Returns NEXT when the request is not one of its own.
const crypto = require('crypto');
const { NEXT, readJsonBody } = require('../http-util.cjs');
const {
  db, tx, resolveId, loadMeta, isExpired, generateSlug, deleteSession, getEditTokenHash,
} = require('../storage.cjs');
const { requireEdit, tokenMatches } = require('./edit-tokens.cjs');
const { normalizeTag, normalizeTags, compareTags, MAX_TAGS_PER_DOC } = require('../../shared/tags.mjs');
const { READER_ID_RE } = require('../../shared/reactions.mjs');

const PIN_LIMIT = 50;
const COLLECTION_NAME_MAX = 60;
const BULK_MAX = 500;
const BULK_ACTIONS = new Set(['add-tag', 'move', 'delete']);
const READER_KEY_RE = /^(name:.{1,80}|[A-Za-z0-9_-]{8,64})$/u;

const send = (res, status, body) => {
  if (body === undefined) { res.writeHead(status); return res.end(); }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify(body));
};

/** SQL condition: session `s` is not expired (unparseable expires_at counts as not expired, like 00 §8 lists). */
const LIVE = '(s.expires_at IS NULL OR COALESCE(julianday(s.expires_at) >= julianday(?), 1))';
const nowIso = () => new Date().toISOString();
/** A decoded path segment, or null when its percent-encoding is malformed. */
const decodeSeg = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

// ── reader key (00 §7) ──────────────────────────────────────────────────────

/**
 * The reader_key the request names in X-MdReview-Reader (percent-encoded):
 * { key } (null when absent) or { error: true }. A `name:` key is compared
 * lower-cased and trimmed, so `name:Asha` and `name:asha` are one reader.
 */
function readerKeyOf(req) {
  const raw = req.headers['x-mdreview-reader'];
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { key: null };
  if (typeof raw !== 'string') return { error: true };
  let key;
  try { key = decodeURIComponent(raw.trim()); } catch { return { error: true }; }
  if (key.startsWith('name:')) {
    // length is checked before lower-casing: a few letters grow when lower-cased (İ → i̇)
    const name = key.slice(5).trim();
    if (!READER_KEY_RE.test(`name:${name}`)) return { error: true };
    return { key: `name:${name.toLowerCase()}` };
  }
  return READER_KEY_RE.test(key) ? { key } : { error: true };
}

// ── shared lookups ──────────────────────────────────────────────────────────

/** The live (existing, unexpired) session an id or slug names: { id, meta } or null; `expired` set when it exists but expired. */
function liveDoc(x) {
  const id = resolveId(x);
  const meta = id ? loadMeta(id) : null;
  if (!meta) return null;
  return { id, meta, expired: isExpired(meta) };
}

const bumpVersion = (id) => db.prepare('UPDATE sessions SET version = version + 1 WHERE id = ?').run(id);
const bumpCollectionDocs = (cid) => db.prepare('UPDATE sessions SET version = version + 1 WHERE id IN (SELECT session_id FROM collection_items WHERE collection_id = ?)').run(cid);

function docCollection(id) {
  const r = db.prepare('SELECT co.id, co.name FROM collection_items ci JOIN collections co ON co.id = ci.collection_id WHERE ci.session_id = ?').get(id);
  return r ? { id: r.id, name: r.name } : null;
}
function docTags(id) {
  return db.prepare('SELECT t.name FROM session_tags st JOIN tags t ON t.id = st.tag_id WHERE st.session_id = ?').all(id)
    .map((r) => r.name).sort(compareTags);
}

/** `?fields=library` of GET /paste/:id: { title, collection, tags }. */
function libraryFields(id) {
  const r = db.prepare('SELECT title FROM sessions WHERE id = ?').get(id);
  return { title: (r && r.title) || 'Untitled', collection: docCollection(id), tags: docTags(id) };
}

function tagId(name) {
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
  return db.prepare('SELECT id FROM tags WHERE name = ?').get(name).id;
}
const dropOrphanTags = () => db.prepare('DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM session_tags st WHERE st.tag_id = tags.id)').run();

function setDocTags(id, tags) {
  db.prepare('DELETE FROM session_tags WHERE session_id = ?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)');
  for (const t of tags) ins.run(id, tagId(t));
  dropOrphanTags();
  bumpVersion(id);
}

function setDocCollection(id, collectionId) {
  if (collectionId === null) db.prepare('DELETE FROM collection_items WHERE session_id = ?').run(id);
  else {
    db.prepare(`INSERT INTO collection_items (session_id, collection_id, added_at) VALUES (?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET collection_id = excluded.collection_id, added_at = excluded.added_at`)
      .run(id, collectionId, nowIso());
  }
  bumpVersion(id);
}

// ── collections ─────────────────────────────────────────────────────────────

const findCollection = (x) => db.prepare('SELECT id, name, slug FROM collections WHERE id = ? OR slug = ? ORDER BY id = ? DESC LIMIT 1').get(x, x, x);
const collectionCount = (cid) => db.prepare(`SELECT count(*) AS c FROM collection_items ci JOIN sessions s ON s.id = ci.session_id
                                              WHERE ci.collection_id = ? AND ${LIVE}`).get(cid, nowIso()).c;
const collectionOut = (c) => ({ id: c.id, name: c.name, slug: c.slug, doc_count: collectionCount(c.id) });
const byName = (a, b) => compareTags(a.name.toLowerCase(), b.name.toLowerCase()) || compareTags(a.id, b.id);

/** A valid collection name (trimmed, 1–60 characters): { name } or { error }. */
function collectionName(v) {
  if (typeof v !== 'string') return { error: 'name is required' };
  const name = v.trim();
  const n = [...name].length;
  if (n < 1 || n > COLLECTION_NAME_MAX) return { error: `A collection name is 1–${COLLECTION_NAME_MAX} characters` };
  return { name };
}
const nameTaken = (name, exceptId = null) => {
  const lower = name.toLowerCase();
  return db.prepare('SELECT id, name FROM collections').all().some((c) => c.id !== exceptId && c.name.toLowerCase() === lower);
};
/** Slug for a collection name: unique among collections, never an existing id or `none` (the unfiled filter). */
function collectionSlug(name, selfId) {
  const base = generateSlug(name) || selfId;
  const taken = (s) => s === 'none' || !!db.prepare('SELECT 1 FROM collections WHERE (slug = ? OR id = ?) AND id <> ?').get(s, s, selfId);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}
const DUPLICATE = { error: 'A collection with that name already exists' };

async function collections(req, res, path) {
  if (path === '/library/collections' && req.method === 'GET') {
    const all = db.prepare('SELECT id, name, slug FROM collections').all().sort(byName);
    return send(res, 200, all.map(collectionOut));
  }
  if (path === '/library/collections' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const v = collectionName(body && body.name);
    if (v.error) return send(res, 400, { error: v.error });
    if (nameTaken(v.name)) return send(res, 409, DUPLICATE);
    const id = crypto.randomBytes(6).toString('hex');
    const now = nowIso();
    const c = { id, name: v.name, slug: collectionSlug(v.name, id) };
    db.prepare('INSERT INTO collections (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, c.slug, c.name, now, now);
    return send(res, 201, { ...c, doc_count: 0 });
  }
  const m = /^\/library\/collections\/([^/]+)$/.exec(path);
  if (!m || !['PATCH', 'DELETE'].includes(req.method)) return NEXT;
  const cid = decodeSeg(m[1]);
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const c = db.prepare('SELECT id, name, slug FROM collections WHERE id = ?').get(cid);
    if (!c) return send(res, 404, { error: 'collection not found' });
    const v = collectionName(body && body.name);
    if (v.error) return send(res, 400, { error: v.error });
    if (nameTaken(v.name, c.id)) return send(res, 409, DUPLICATE);
    const slug = v.name === c.name ? c.slug : collectionSlug(v.name, c.id);
    tx(() => {
      db.prepare('UPDATE collections SET name = ?, slug = ?, updated_at = ? WHERE id = ?').run(v.name, slug, nowIso(), c.id);
      bumpCollectionDocs(c.id);
    });
    return send(res, 200, collectionOut({ id: c.id, name: v.name, slug }));
  }
  // DELETE: membership rows cascade, so its docs become unfiled
  const c = db.prepare('SELECT id FROM collections WHERE id = ?').get(cid);
  if (!c) return send(res, 404, { error: 'collection not found' });
  tx(() => {
    bumpCollectionDocs(c.id);
    db.prepare('DELETE FROM collections WHERE id = ?').run(c.id);
  });
  return send(res, 204);
}

// ── per-doc tags / collection ───────────────────────────────────────────────

async function docWrites(req, res, path) {
  const m = /^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/(tags|collection)$/.exec(path);
  if (!m || req.method !== 'PUT') return NEXT;
  if (!liveDoc(m[1])) return send(res, 404, { error: 'not found' });
  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  const doc = liveDoc(m[1]); // re-read after the await
  if (!doc) return send(res, 404, { error: 'not found' });
  if (!requireEdit(req, res, doc.id)) return;
  if (doc.expired) return send(res, 410, { error: 'Session expired' });
  if (m[2] === 'tags') {
    const v = normalizeTags(body && body.tags);
    if (v.error) return send(res, 400, { error: v.error });
    tx(() => setDocTags(doc.id, v.tags));
    return send(res, 200, { tags: v.tags });
  }
  const want = body ? body.collectionId : undefined;
  if (want !== null && typeof want !== 'string') return send(res, 400, { error: 'collectionId must be a collection id or null' });
  const c = want === null ? null : findCollection(want);
  if (want !== null && !c) return send(res, 404, { error: 'collection not found' });
  tx(() => setDocCollection(doc.id, c ? c.id : null));
  return send(res, 200, { collection: c ? { id: c.id, name: c.name } : null });
}

// ── tags list ───────────────────────────────────────────────────────────────

function tagsList(res) {
  const list = db.prepare(`SELECT t.name AS tag, count(*) AS count FROM session_tags st
                           JOIN tags t ON t.id = st.tag_id JOIN sessions s ON s.id = st.session_id
                           WHERE ${LIVE} GROUP BY t.id`).all(nowIso());
  return send(res, 200, list.map((r) => ({ tag: r.tag, count: r.count })).sort((a, b) => compareTags(a.tag, b.tag)));
}

// ── pins ────────────────────────────────────────────────────────────────────

/** The reader's visible pins (existing, unexpired docs), most recent first. */
function readerPins(key) {
  return db.prepare(`SELECT p.session_id AS docId, p.pinned_at AS pinnedAt FROM pins p JOIN sessions s ON s.id = p.session_id
                     WHERE p.reader_key = ? AND ${LIVE} ORDER BY p.pinned_at DESC, p.rowid DESC`).all(key, nowIso());
}

async function pinsRoute(req, res, path) {
  const isMerge = path === '/library/pins/merge';
  const one = /^\/library\/pins\/([^/]+)$/.exec(path);
  const ours = (path === '/library/pins' && req.method === 'GET')
    || (isMerge && req.method === 'POST')
    || (!isMerge && one && (req.method === 'PUT' || req.method === 'DELETE'));
  if (!ours) return NEXT;
  const reader = readerKeyOf(req);
  if (reader.error || !reader.key) return send(res, 400, { error: 'invalid reader' });
  const key = reader.key;

  if (req.method === 'GET') return send(res, 200, readerPins(key));

  if (isMerge) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const from = body ? body.from : undefined;
    if (typeof from !== 'string' || !READER_ID_RE.test(from)) return send(res, 400, { error: 'from must be a reader id' });
    if (from === key) return send(res, 200, { merged: 0 });
    const merged = tx(() => {
      const have = new Set(db.prepare('SELECT session_id FROM pins WHERE reader_key = ?').all(key).map((r) => r.session_id));
      let room = PIN_LIMIT - readerPins(key).length;
      let n = 0;
      const ins = db.prepare('INSERT OR IGNORE INTO pins (reader_key, session_id, pinned_at) VALUES (?, ?, ?)');
      for (const p of readerPins(from)) { // most recently pinned first: those win when room runs out
        if (room <= 0) break;
        if (have.has(p.docId)) continue;
        ins.run(key, p.docId, p.pinnedAt);
        room--; n++;
      }
      return n;
    });
    return send(res, 200, { merged });
  }

  const x = decodeSeg(one[1]);
  if (req.method === 'DELETE') {
    const id = x === null ? null : resolveId(x);
    if (id) db.prepare('DELETE FROM pins WHERE reader_key = ? AND session_id = ?').run(key, id);
    return send(res, 204);
  }
  // PUT
  const doc = x === null ? null : liveDoc(x);
  if (!doc) return send(res, 404, { error: 'not found' });
  if (doc.expired) return send(res, 410, { error: 'Session expired' });
  const result = tx(() => {
    const existing = db.prepare('SELECT pinned_at FROM pins WHERE reader_key = ? AND session_id = ?').get(key, doc.id);
    if (existing) return { docId: doc.id, pinnedAt: existing.pinned_at };
    if (readerPins(key).length >= PIN_LIMIT) return null;
    const at = nowIso();
    // any existing row (even one for a doc that has since expired and been extended) returned above
    db.prepare('INSERT INTO pins (reader_key, session_id, pinned_at) VALUES (?, ?, ?)').run(key, doc.id, at);
    return { docId: doc.id, pinnedAt: at };
  });
  if (!result) return send(res, 409, { error: `Pin limit reached (${PIN_LIMIT})`, code: 'pin_limit' });
  return send(res, 200, result);
}

// ── bulk ────────────────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function bulkRoute(req, res) {
  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  const { action, ids, editTokens = {} } = isPlainObject(body) ? body : {};
  if (!BULK_ACTIONS.has(action)) return send(res, 400, { error: 'action must be add-tag, move or delete' });
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > BULK_MAX || !ids.every((x) => typeof x === 'string')) {
    return send(res, 400, { error: `ids must be 1–${BULK_MAX} document ids` });
  }
  if (!isPlainObject(editTokens)) return send(res, 400, { error: 'editTokens must be an object' });
  let tag = null;
  let target = null;
  if (action === 'add-tag') {
    const v = normalizeTag(body.tag);
    if (v.error) return send(res, 400, { error: v.error });
    tag = v.tag;
  } else if (action === 'move') {
    if (body.collectionId !== null && typeof body.collectionId !== 'string') return send(res, 400, { error: 'collectionId must be a collection id or null' });
    if (body.collectionId !== null) {
      target = findCollection(body.collectionId);
      if (!target) return send(res, 400, { error: 'collection not found' });
    }
  }

  const results = ids.map((x) => {
    const doc = liveDoc(x);
    if (!doc || doc.expired) return { id: x, ok: false, error: 'not_found' };
    const stored = getEditTokenHash(doc.id);
    if (stored) {
      const t = editTokens[x];
      if (typeof t !== 'string' || !t) return { id: x, ok: false, error: 'edit_token_required' };
      if (!tokenMatches(t, stored)) return { id: x, ok: false, error: 'edit_token_invalid' };
    }
    if (action === 'delete') {
      deleteSession(doc.id, doc.meta);
      return { id: x, ok: true };
    }
    if (action === 'move') {
      tx(() => setDocCollection(doc.id, target ? target.id : null));
      return { id: x, ok: true };
    }
    // add-tag
    const current = docTags(doc.id);
    if (current.includes(tag)) return { id: x, ok: true };
    if (current.length >= MAX_TAGS_PER_DOC) return { id: x, ok: false, error: 'tag_limit' };
    tx(() => {
      db.prepare('INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)').run(doc.id, tagId(tag));
      bumpVersion(doc.id);
    });
    return { id: x, ok: true };
  });
  return send(res, 200, { results });
}

// ── router ──────────────────────────────────────────────────────────────────

async function library(req, res) {
  const path = req.url.split('?')[0];
  if (path.startsWith('/paste/')) return docWrites(req, res, path);
  if (!path.startsWith('/library/')) return NEXT;
  if (path === '/library/tags' && req.method === 'GET') return tagsList(res);
  if (path === '/library/bulk' && req.method === 'POST') return bulkRoute(req, res);
  if (path.startsWith('/library/collections')) return collections(req, res, path);
  if (path.startsWith('/library/pins')) return pinsRoute(req, res, path);
  return NEXT;
}

module.exports = library;
Object.assign(module.exports, { readerKeyOf, libraryFields, PIN_LIMIT });
