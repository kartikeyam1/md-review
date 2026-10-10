'use strict';
// Row codec for sessions: how a legacy meta object (the JSON the old server
// kept per session) maps onto the SQLite rows, and back. Used by the server's
// storage layer and by the migration script, so both write identical rows.
//
// Round-trip rule: decodeMeta(encode(meta)) deep-equals meta (minus
// `markdown`, `content_hash`, `revisions`; `mode` normalised per 00 §1.4).
// A known key goes to its column only when its value has the column's type
// (a string); null, non-string or otherwise unusual values stay in extra_json
// verbatim, so absent vs null vs odd values all survive.
const crypto = require('crypto');
const { docTitle, searchContent } = require('./doc-text.cjs');

const VALID_MODES = new Set(['publish', 'review']);

/** meta key → sessions column (string-valued). `slug` is special-cased. */
const META_COLUMNS = [
  ['slug', 'slug'],
  ['sessionName', 'session_name'],
  ['filename', 'filename'],
  ['contentType', 'content_type'],
  ['approval_status', 'approval_status'],
  ['approved_by', 'approved_by'],
  ['approved_at', 'approved_at'],
  ['sharedAt', 'shared_at'],
  ['expires_at', 'expires_at'],
  ['callback_url', 'callback_url'],
];
/** Meta keys that never go to extra_json (own tables / derived / mode column). */
const NOT_EXTRA = new Set(['markdown', 'content_hash', 'revisions', 'comments', 'mode']);
/**
 * Names owned by server-managed sessions columns. A client-supplied meta key
 * with one of these names is dropped, never stored in extra_json — otherwise it
 * would round-trip into responses (e.g. a forged `edit_token_hash`).
 */
const COLUMN_OWNED = new Set(['id', 'upsert_key', 'edit_token_hash', 'created_by', 'from_template_json', 'extra_json',
  'version', 'created_at', 'updated_at', 'title', 'fts_rowid', 'comments_sig', 'source_sig']);

/**
 * Split a meta object into sessions-column values and extra_json.
 * `slugOwned(slug)` says whether the slug index maps that slug to this session
 * (only then is it stored in the UNIQUE `slug` column).
 */
function encodeMeta(meta, { slugOwned = () => true } = {}) {
  const cols = {};
  const extra = {};
  const mapped = new Map(META_COLUMNS);
  for (const [key, col] of META_COLUMNS) {
    cols[col] = null;
    if (!Object.hasOwn(meta, key)) continue;
    const v = meta[key];
    if (typeof v === 'string' && (key !== 'slug' || slugOwned(v))) cols[col] = v;
    else extra[key] = v;
  }
  for (const [k, v] of Object.entries(meta)) {
    if (mapped.has(k) || NOT_EXTRA.has(k) || COLUMN_OWNED.has(k) || v === undefined) continue;
    extra[k] = v;
  }
  // comments that are not an array cannot become rows: keep them verbatim
  if (Object.hasOwn(meta, 'comments') && !Array.isArray(meta.comments) && meta.comments !== undefined) extra.comments = meta.comments;
  return { cols, extra };
}

/** Rebuild the meta object from a sessions row (+ contents row). Comments are added by the caller. */
function decodeMeta(row, contentRow) {
  const meta = JSON.parse(row.extra_json || '{}');
  for (const [key, col] of META_COLUMNS) if (row[col] !== null && row[col] !== undefined) meta[key] = row[col];
  meta.mode = row.mode;
  if (contentRow && !contentRow.hashless) meta.content_hash = contentRow.content_hash;
  return meta;
}

const validMode = (m) => (VALID_MODES.has(m) ? m : null);

// ── comments ────────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Order-independent JSON (sorted keys) — for change fingerprints. */
function canonicalJson(v) {
  const canon = (x) => {
    if (Array.isArray(x)) return x.map(canon);
    if (isObj(x)) return Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])]));
    return x;
  };
  return JSON.stringify(canon(v === undefined ? null : v));
}
const commentsSig = (comments) => crypto.createHash('md5').update(canonicalJson(Array.isArray(comments) ? comments : [])).digest('hex');

/**
 * Replace the session's comment + reply rows — only when the list differs from
 * what was last written (a content-only save leaves the rows alone).
 * Returns the number of replies written, or null when nothing changed.
 */
function syncComments(db, sessionId, comments) {
  const sig = commentsSig(comments);
  const prev = db.prepare('SELECT comments_sig FROM sessions WHERE id = ?').get(sessionId);
  if (prev && prev.comments_sig === sig) return null;
  const replies = writeComments(db, sessionId, comments);
  db.prepare('UPDATE sessions SET comments_sig = ? WHERE id = ?').run(sig, sessionId);
  return replies;
}

function writeComments(db, sessionId, comments) {
  db.prepare('DELETE FROM comments WHERE session_id = ?').run(sessionId);
  if (!Array.isArray(comments)) return 0;
  const insC = db.prepare('INSERT INTO comments (session_id, ord, id, data_json, has_replies, must_fix_open) VALUES (?, ?, ?, ?, ?, ?)');
  const insR = db.prepare('INSERT INTO replies (comment_pk, ord, id, data_json) VALUES (?, ?, ?, ?)');
  let replies = 0;
  comments.forEach((c, ord) => {
    const hasReplies = isObj(c) && Array.isArray(c.replies);
    let data = c;
    if (hasReplies) { data = { ...c }; delete data.replies; }
    const mustFix = isObj(c) && c.category === 'must-fix' && c.resolved !== true ? 1 : 0;
    const id = isObj(c) && typeof c.id === 'string' ? c.id : null;
    const { lastInsertRowid: pk } = insC.run(sessionId, ord, id, JSON.stringify(data === undefined ? null : data), hasReplies ? 1 : 0, mustFix);
    if (hasReplies) {
      c.replies.forEach((r, rord) => {
        insR.run(pk, rord, isObj(r) && typeof r.id === 'string' ? r.id : null, JSON.stringify(r === undefined ? null : r));
        replies++;
      });
    }
  });
  return replies;
}

function readComments(db, sessionId) {
  const rows = db.prepare('SELECT pk, data_json, has_replies FROM comments WHERE session_id = ? ORDER BY ord').all(sessionId);
  if (rows.length === 0) return [];
  const reps = db.prepare('SELECT r.comment_pk, r.data_json FROM replies r JOIN comments c ON c.pk = r.comment_pk WHERE c.session_id = ? ORDER BY r.comment_pk, r.ord').all(sessionId);
  const byComment = new Map();
  for (const r of reps) {
    if (!byComment.has(r.comment_pk)) byComment.set(r.comment_pk, []);
    byComment.get(r.comment_pk).push(JSON.parse(r.data_json));
  }
  return rows.map((row) => {
    const c = JSON.parse(row.data_json);
    if (row.has_replies) c.replies = byComment.get(row.pk) || [];
    return c;
  });
}

// ── revisions ───────────────────────────────────────────────────────────────

const NULLABLE_REV = ['by', 'client', 'parent'];

/** Revision entry (legacy list item) → column values (+ extra for anything unusual). */
function encodeRevision(r) {
  const extra = {};
  const absent = [];
  const out = { hash: '', at: null, at_end: null, by: null, client: null, size: null, parent: null, writes: null, seeded: null, note: null };
  for (const [k, v] of Object.entries(r)) {
    if (k === 'hash' && typeof v === 'string') out.hash = v;
    else if ((k === 'at' || k === 'at_end' || k === 'note') && typeof v === 'string') out[k] = v;
    else if (NULLABLE_REV.includes(k) && (typeof v === 'string' || v === null)) out[k] = v;
    else if ((k === 'size' || k === 'writes') && Number.isInteger(v)) out[k] = v;
    else if (k === 'seeded' && v === true) out.seeded = 1;
    else extra[k] = v;
  }
  for (const k of NULLABLE_REV) if (!Object.hasOwn(r, k)) absent.push(k);
  if (absent.length) extra['\u0000absent'] = absent;
  return { ...out, extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null };
}

/** Every revisions column except the content blob (read the blob only to serve a revision body). */
const REVISION_META_COLUMNS = 'session_id, seq, hash, at, at_end, by, client, size, parent, writes, seeded, note, extra_json';

/** Revisions row → legacy list entry ({hash, at, at_end?, by, client, size, parent, writes?, seeded?}). */
function decodeRevision(row) {
  const e = { hash: row.hash, at: row.at, by: row.by, client: row.client, size: row.size, parent: row.parent };
  if (row.at === null) delete e.at;
  if (row.size === null) delete e.size;
  if (row.at_end !== null) e.at_end = row.at_end;
  if (row.writes !== null) e.writes = row.writes;
  if (row.seeded) e.seeded = true;
  if (row.note !== null) e.note = row.note;
  if (row.extra_json) {
    const extra = JSON.parse(row.extra_json);
    for (const k of extra['\u0000absent'] || []) delete e[k];
    delete extra['\u0000absent'];
    Object.assign(e, extra);
  }
  return e;
}

function insertRevision(db, sessionId, seq, entry, blob) {
  const r = encodeRevision(entry);
  db.prepare(`INSERT INTO revisions (session_id, seq, hash, at, at_end, by, client, size, parent, writes, seeded, note, blob, extra_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, seq, r.hash, r.at, r.at_end, r.by, r.client, r.size, r.parent, r.writes, r.seeded, r.note, blob, r.extra_json);
}

// ── derived columns ─────────────────────────────────────────────────────────

/** updated_at = latest revision (at_end || at), else sharedAt — what /paste/list always reported. */
function refreshUpdatedAt(db, sessionId) {
  const last = db.prepare('SELECT at, at_end FROM revisions WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId);
  const s = db.prepare('SELECT shared_at FROM sessions WHERE id = ?').get(sessionId);
  const at = (last && (last.at_end || last.at)) || (s && s.shared_at) || null;
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(at, sessionId);
  return at;
}

/** Recompute the title and replace the session's doc_fts row (same transaction as the write). */
function syncSearchRow(db, sessionId, meta, markdown) {
  const title = docTitle(meta, markdown);
  const prev = db.prepare('SELECT fts_rowid FROM sessions WHERE id = ?').get(sessionId);
  if (prev && prev.fts_rowid !== null) db.prepare('DELETE FROM doc_fts WHERE rowid = ?').run(prev.fts_rowid);
  const { lastInsertRowid } = db.prepare("INSERT INTO doc_fts (title, filename, content, session_id, file_name) VALUES (?, ?, ?, ?, '')")
    .run(title, typeof meta.filename === 'string' ? meta.filename : '', searchContent(meta.contentType, markdown), sessionId);
  db.prepare('UPDATE sessions SET title = ?, fts_rowid = ? WHERE id = ?').run(title, lastInsertRowid, sessionId);
  return title;
}

function deleteSearchRow(db, sessionId) {
  const prev = db.prepare('SELECT fts_rowid FROM sessions WHERE id = ?').get(sessionId);
  if (prev && prev.fts_rowid !== null) db.prepare('DELETE FROM doc_fts WHERE rowid = ?').run(prev.fts_rowid);
}

/** Write (insert or update) the sessions row from encoded meta. Bumps `version`. */
function upsertSessionRow(db, id, meta, { mode, slugOwned, createdBy = null, now = new Date().toISOString(), sourceSig } = {}) {
  const { cols, extra } = encodeMeta(meta, { slugOwned });
  const prev = db.prepare('SELECT mode FROM sessions WHERE id = ?').get(id);
  const m = validMode(mode) || validMode(meta.mode) || (prev && prev.mode) || 'review';
  const names = META_COLUMNS.map(([, c]) => c);
  const values = names.map((c) => cols[c]);
  if (prev) {
    db.prepare(`UPDATE sessions SET ${names.map((c) => `${c} = ?`).join(', ')}, mode = ?, extra_json = ?, version = version + 1
                ${sourceSig !== undefined ? ', source_sig = ?' : ''} WHERE id = ?`)
      .run(...values, m, JSON.stringify(extra), ...(sourceSig !== undefined ? [sourceSig] : []), id);
  } else {
    db.prepare(`INSERT INTO sessions (id, ${names.join(', ')}, mode, extra_json, version, created_by, created_at, updated_at, source_sig)
                VALUES (?, ${names.map(() => '?').join(', ')}, ?, ?, 1, ?, ?, ?, ?)`)
      .run(id, ...values, m, JSON.stringify(extra), createdBy, cols.shared_at || now, cols.shared_at || now, sourceSig ?? null);
  }
}

module.exports = {
  VALID_MODES, META_COLUMNS, COLUMN_OWNED, encodeMeta, decodeMeta, validMode,
  writeComments, syncComments, readComments, REVISION_META_COLUMNS, encodeRevision, decodeRevision, insertRevision,
  refreshUpdatedAt, syncSearchRow, deleteSearchRow, upsertSessionRow,
};
