'use strict';
// Session / slug / site / file storage on SQLite (server/db.cjs). Session file
// blobs and hosted-site files stay on disk under DATA_DIR; everything else —
// meta, content, revisions, comments, file metadata, slugs, the site index and
// the search index — lives in the database.
//
// Every write is one BEGIN IMMEDIATE … COMMIT transaction, and the handlers
// keep the "no await between load and save" rule (see readJsonBody).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const {
  DATA_DIR, SITES_DIR, FILES_DIR, CHUNKS_DIR, COVERS_DIR, DB_PATH, REVISIONS_MAX, REVISION_COALESCE_MS,
} = require('./config.cjs');
const { HttpError, getMime, fireWebhook } = require('./http-util.cjs');
const { openDb, tx } = require('./db.cjs');
const rows = require('./session-rows.cjs');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SITES_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(CHUNKS_DIR, { recursive: true });

const db = openDb(DB_PATH);

// ── Slugs ────────────────────────────────────────────────────────────────────

function generateSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
// One namespace for sessions and sites (the slugs table), as the old index was.
// `releasing` is a slug the caller (`selfId`) is about to free: it counts as
// available only when it belongs to that caller. `selfId`'s own stored slug
// never blocks it either.
// 00 §6: never assigned (they collide with /paste/list and /paste/by-key/:key).
const RESERVED_SLUGS = new Set(['list', 'by-key']);
function slugTaken(slug, { releasing = null, selfId = null } = {}) {
  // A legacy session that already owns a reserved slug may keep it (PUT /meta re-submitting it).
  if (RESERVED_SLUGS.has(slug)) return !(selfId && db.prepare('SELECT 1 FROM sessions WHERE id = ? AND slug = ?').get(selfId, slug));
  const row = db.prepare('SELECT target_id, kind FROM slugs WHERE slug = ?').get(slug);
  // The caller's own slug rows (its current slug, or an alias kept from a rename) never block it.
  const own = row && selfId && row.kind === 'session' && row.target_id === selfId;
  if (row && !own && !(slug === releasing && row.target_id === selfId)) return true;
  return !!db.prepare('SELECT 1 FROM sessions WHERE slug = ? AND id IS NOT ?').get(slug, selfId);
}
function uniqueSlug(base, opts = {}) {
  if (!slugTaken(base, opts)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!slugTaken(candidate, opts)) return candidate;
  }
}
function isExpired(data) {
  if (!data.expires_at) return false;
  return new Date(data.expires_at) < new Date();
}

function sessionExists(id) {
  return !!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id);
}

function resolveId(idOrSlug) {
  const looksLikeId = /^[a-f0-9]+$/.test(idOrSlug);
  // A slug can itself be all-hex ("cafe", "bad", "1234"); prefer a real id,
  // then the slug table, and only then treat it as an (unknown) id.
  if (looksLikeId && sessionExists(idOrSlug)) return idOrSlug;
  const row = db.prepare('SELECT target_id FROM slugs WHERE slug = ?').get(idOrSlug);
  if (row) return row.target_id;
  return looksLikeId ? idOrSlug : null;
}

// ── Sites (files stay in sites/<id>/; the index is the sites table) ─────────

function siteFromRow(r) { return JSON.parse(r.meta_json); }

function getSite(id) {
  const r = db.prepare('SELECT meta_json FROM sites WHERE id = ?').get(id);
  return r ? siteFromRow(r) : undefined;
}
/** All indexed sites, oldest registration first: [{ id, meta }]. */
function listSites() {
  return db.prepare('SELECT id, meta_json FROM sites ORDER BY rowid').all().map((r) => ({ id: r.id, meta: siteFromRow(r) }));
}
function resolveSiteId(idOrSlug) {
  // Check if it's a direct site ID (directory exists)
  if (/^[a-f0-9]+$/.test(idOrSlug) && fs.existsSync(path.join(SITES_DIR, idOrSlug))) return idOrSlug;
  const r = db.prepare('SELECT id FROM sites WHERE slug = ? ORDER BY rowid LIMIT 1').get(idOrSlug);
  return r ? r.id : null;
}
function siteColumns(meta) {
  const str = (v) => (typeof v === 'string' ? v : null);
  return [str(meta.slug), str(meta.name), str(meta.created_at), str(meta.expires_at),
    Number.isInteger(meta.file_count) ? meta.file_count : null, meta.spa === undefined ? null : (meta.spa ? 1 : 0)];
}
function createSite(id, meta) {
  tx(db, () => {
    db.prepare('INSERT INTO sites (id, slug, name, created_at, expires_at, file_count, spa, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ...siteColumns(meta), JSON.stringify(meta));
    if (meta.slug) db.prepare("INSERT OR REPLACE INTO slugs (slug, kind, target_id) VALUES (?, 'site', ?)").run(meta.slug, id);
  });
}
function deleteSite(id, meta) {
  tx(db, () => {
    // Only the site's own slug row: a site-index slug that the slug table gives
    // to a session (legacy data) keeps resolving to that session.
    if (meta && meta.slug) db.prepare('DELETE FROM slugs WHERE slug = ? AND target_id = ?').run(meta.slug, id);
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  });
}

// ── Content ─────────────────────────────────────────────────────────────────

function filesDir(id) { return path.join(FILES_DIR, id); }

function hashContent(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

// Hash of the stored content — what If-Match / content_hash compare against.
function currentContentHash(meta, markdown) {
  if (meta && meta.content_hash) return meta.content_hash;
  return hashContent(Buffer.from(markdown || '', 'utf-8'));
}

// Optimistic-concurrency check for content writes. `expected` comes from the
// If-Match header (quoted ETag form allowed) or a base_hash body field. Returns
// null when the write may proceed, else the current hash the caller must use.
function contentHashMismatch(expected, meta, markdown) {
  if (!expected) return null;
  const normalized = String(expected).trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (normalized === '*') return null;
  const current = currentContentHash(meta, markdown);
  return normalized === current ? null : current;
}

/** The session's current content, or null when it has none stored. */
function loadContent(id) {
  const r = db.prepare('SELECT markdown FROM contents WHERE session_id = ?').get(id);
  return r ? r.markdown : null;
}

/** Session meta (every stored key except `revisions`; `comments` always an array). */
function loadMeta(id) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  const content = db.prepare('SELECT content_hash, hashless FROM contents WHERE session_id = ?').get(id);
  const meta = rows.decodeMeta(row, content);
  if (!Object.hasOwn(meta, 'comments')) meta.comments = rows.readComments(db, id);
  return meta;
}

function loadPaste(id) {
  const meta = loadMeta(id);
  if (!meta) return null;
  return { ...meta, markdown: loadContent(id) || '' };
}

/**
 * ETag of the full session (changes on every write: version + content hash).
 * `variant` (#23) separates responses that differ per caller (access.can_edit).
 */
function sessionEtag(id, variant = '') {
  const r = db.prepare('SELECT s.version, c.content_hash FROM sessions s LEFT JOIN contents c ON c.session_id = s.id WHERE s.id = ?').get(id);
  return `"${crypto.createHash('md5').update(`${id}:${r ? r.version : 0}:${r ? r.content_hash || '' : ''}${variant ? `:${variant}` : ''}`).digest('hex')}"`;
}

// ── Edit tokens (#23) — only sha256(token) is ever stored ───────────────────

/** The session's edit-token hash: undefined when there is no such session, null for a legacy (link-editable) one. */
function getEditTokenHash(id) {
  const r = db.prepare('SELECT edit_token_hash FROM sessions WHERE id = ?').get(id);
  return r ? r.edit_token_hash : undefined;
}

/**
 * Replace the hash only while it still equals `expected` (compare-and-set, so
 * two concurrent claims cannot both win). Bumps `version` so cached GETs
 * (ETag) see the new access. Returns true when the row was updated.
 */
function setEditTokenHash(id, hash, expected) {
  const r = db.prepare('UPDATE sessions SET edit_token_hash = ?, version = version + 1 WHERE id = ? AND edit_token_hash IS ?')
    .run(hash, id, expected);
  return r.changes === 1;
}

// ── Upsert keys (#21) ───────────────────────────────────────────────────────

/** The session holding upsert key `key` (expired ones included): { id, updated_at }, else null. */
function sessionByKey(key) {
  return db.prepare('SELECT id, updated_at FROM sessions WHERE upsert_key = ?').get(key) || null;
}

/** The session's upsert key, or null. */
function upsertKeyOf(id) {
  const r = db.prepare('SELECT upsert_key FROM sessions WHERE id = ?').get(id);
  return r ? r.upsert_key : null;
}

// ── Revision history ─────────────────────────────────────────────────────────

/** The revision list (oldest first), as the JSON-file server kept it in meta.revisions. */
function listRevisions(id) {
  return db.prepare(`SELECT ${rows.REVISION_META_COLUMNS} FROM revisions WHERE session_id = ? ORDER BY seq`).all(id).map(rows.decodeRevision);
}

/** Content of a stored revision (by hash), or null when no revision blob has it. */
function readRevisionBlob(id, hash) {
  const r = db.prepare('SELECT blob FROM revisions WHERE session_id = ? AND hash = ? AND blob IS NOT NULL ORDER BY seq LIMIT 1').get(id, hash);
  if (!r) return null;
  try { return zlib.gunzipSync(Buffer.from(r.blob)).toString('utf-8'); }
  catch (e) {
    console.error(`[md-review] corrupt revision blob ${id}/${hash}: ${e.message}`);
    throw new HttpError(500, 'Revision content is unreadable');
  }
}

/**
 * Record that `id`'s content changes from prevHash to newHash (inside the
 * write transaction). Same rules as the JSON-file server: a session with no
 * history is first seeded with the content this write replaces; consecutive
 * writes by the same author/client within REVISION_COALESCE_MS fold into one
 * revision; at most REVISIONS_MAX are kept (older rows are deleted).
 */
function recordRevision(id, { prevHash, prevMarkdown, sharedAt, newHash, gz, size, ctx }) {
  const now = new Date().toISOString();
  const by = ctx.by ?? null;
  const client = ctx.client ?? 'api';

  const count = db.prepare('SELECT count(*) AS c FROM revisions WHERE session_id = ?').get(id).c;
  if (count === 0 && prevHash && prevMarkdown !== null) {
    // Seed with the content this write replaces so the first diff has a "before".
    const oldBuf = Buffer.from(prevMarkdown, 'utf-8');
    rows.insertRevision(db, id, 1, { hash: prevHash, at: sharedAt || now, by: null, client: null, size: oldBuf.length, parent: null, seeded: true }, zlib.gzipSync(oldBuf));
  }

  const lastRow = db.prepare(`SELECT ${rows.REVISION_META_COLUMNS} FROM revisions WHERE session_id = ? ORDER BY seq DESC LIMIT 1`).get(id);
  const last = lastRow ? rows.decodeRevision(lastRow) : null;
  const lastAt = last ? Date.parse(last.at_end || last.at) : NaN;
  // #21: an upsert run is always its own revision, and a later write never folds into a noted one.
  const coalesce = !ctx.noCoalesce
    && last
    && !last.seeded
    && !last.note
    && last.by === by && last.client === client
    && last.hash === prevHash
    && Number.isFinite(lastAt) && (Date.now() - lastAt) < REVISION_COALESCE_MS;

  if (coalesce) {
    db.prepare('UPDATE revisions SET hash = ?, at_end = ?, size = ?, writes = ?, blob = ? WHERE session_id = ? AND seq = ?')
      .run(newHash, now, size, (last.writes || 1) + 1, gz, id, lastRow.seq);
  } else {
    const entry = { hash: newHash, at: now, by, client, size, parent: prevHash || null };
    if (ctx.note) entry.note = ctx.note; // #21 rule 5
    rows.insertRevision(db, id, (lastRow ? lastRow.seq : 0) + 1, entry, gz);
  }

  db.prepare(`DELETE FROM revisions WHERE session_id = ? AND seq IN (
                SELECT seq FROM revisions WHERE session_id = ? ORDER BY seq
                LIMIT max(0, (SELECT count(*) FROM revisions WHERE session_id = ?) - ?))`)
    .run(id, id, id, REVISIONS_MAX);
}

/** Light summary for list/GET responses (the full list lives behind /revisions). */
function revisionSummary(id) {
  const n = db.prepare('SELECT count(*) AS c FROM revisions WHERE session_id = ?').get(id).c;
  const lastRow = n ? db.prepare(`SELECT ${rows.REVISION_META_COLUMNS} FROM revisions WHERE session_id = ? ORDER BY seq DESC LIMIT 1`).get(id) : null;
  const last = lastRow ? rows.decodeRevision(lastRow) : null;
  return {
    revision_count: n,
    latest_revision: last ? { hash: last.hash, at: last.at_end || last.at, by: last.by ?? null, client: last.client ?? null } : null,
  };
}

const strOrNull = (v) => (typeof v === 'string' ? v : null);

/**
 * Persist a session (insert or update) in one transaction. `data` is the full
 * meta object as loaded and mutated by the handler, optionally with
 * `markdown`. `ctx` = { by, client } describes who is writing (for the
 * revision entry). Content (and history) is only rewritten when it changed.
 * `opts`: { releaseSlugs, claimSlugs, createdBy, editTokenHash (#23, set on create) }.
 */
function savePaste(id, data, ctx = {}, opts = {}) {
  const { markdown, revisions: _legacyRevisions, ...meta } = data;
  let approvalReset = false;
  const saved = tx(db, () => {
    for (const s of opts.releaseSlugs || []) db.prepare('DELETE FROM slugs WHERE slug = ? AND target_id = ?').run(s, id);
    for (const s of opts.claimSlugs || []) db.prepare("INSERT OR REPLACE INTO slugs (slug, kind, target_id) VALUES (?, 'session', ?)").run(s, id);
    const slugOwned = (s) => !!db.prepare("SELECT 1 FROM slugs WHERE slug = ? AND kind = 'session' AND target_id = ?").get(s, id)
      && !db.prepare('SELECT 1 FROM sessions WHERE slug = ? AND id <> ?').get(s, id);

    const prevRow = db.prepare('SELECT session_name, filename, content_type, fts_rowid FROM sessions WHERE id = ?').get(id);
    const prevContent = db.prepare('SELECT markdown, content_hash, hashless FROM contents WHERE session_id = ?').get(id);
    const prevHash = prevContent && !prevContent.hashless ? prevContent.content_hash : null;

    // Approval follows the content (review-tool semantics): changing an approved
    // doc's content puts it back to pending, so an approval never covers
    // changes nobody reviewed. The reset is recorded as approval_reset_at.
    if (markdown !== undefined && prevContent && meta.approval_status === 'approved'
      && hashContent(Buffer.from(markdown, 'utf-8')) !== prevHash) {
      approvalReset = true;
      meta.approval_status = 'pending';
      meta.approved_by = null;
      meta.approved_at = null;
      delete meta.approved_revision;
      meta.approval_reset_at = new Date().toISOString();
    }

    rows.upsertSessionRow(db, id, meta, { mode: meta.mode, slugOwned, createdBy: opts.createdBy ?? null });
    if (opts.editTokenHash) db.prepare('UPDATE sessions SET edit_token_hash = ? WHERE id = ?').run(opts.editTokenHash, id);
    if (opts.upsertKey) db.prepare('UPDATE sessions SET upsert_key = ? WHERE id = ?').run(opts.upsertKey, id);
    delete meta.content_hash;
    if (prevHash) meta.content_hash = prevHash;

    let contentChanged = false;
    if (markdown !== undefined) {
      const buf = Buffer.from(markdown, 'utf-8');
      const newHash = hashContent(buf);
      if (newHash !== prevHash || !prevContent) {
        const gz = zlib.gzipSync(buf);
        recordRevision(id, {
          prevHash, prevMarkdown: prevContent ? prevContent.markdown : null, sharedAt: meta.sharedAt,
          newHash, gz, size: buf.length, ctx,
        });
        db.prepare(`INSERT INTO contents (session_id, markdown, content_hash, hashless) VALUES (?, ?, ?, 0)
                    ON CONFLICT(session_id) DO UPDATE SET markdown = excluded.markdown, content_hash = excluded.content_hash, hashless = 0`)
          .run(id, markdown, newHash);
        meta.content_hash = newHash;
        contentChanged = true;
      }
    }

    rows.syncComments(db, id, meta.comments);

    const titleInputsChanged = !prevRow || prevRow.fts_rowid === null
      || prevRow.session_name !== strOrNull(meta.sessionName)
      || prevRow.filename !== strOrNull(meta.filename)
      || prevRow.content_type !== strOrNull(meta.contentType);
    if (contentChanged || titleInputsChanged) {
      rows.syncSearchRow(db, id, meta, markdown !== undefined ? markdown : (prevContent ? prevContent.markdown : ''));
    }
    rows.refreshUpdatedAt(db, id);
    return meta;
  });
  // An approval webhook hears about the reset like any other status change.
  if (approvalReset && saved.callback_url) {
    try {
      fireWebhook(saved.callback_url, {
        sessionId: id, approval_status: 'pending', approved_by: null, approved_at: null, reason: 'content_changed',
      });
    } catch (e) { console.error(`[md-review] approval webhook for ${id} failed: ${e.message}`); }
  }
  return saved;
}

/** Delete a session: rows (cascade), search row, its slug, then its files and cached covers on disk. */
function deleteSession(id, meta) {
  tx(db, () => {
    rows.deleteSearchRow(db, id);
    db.prepare('DELETE FROM slugs WHERE target_id = ? AND kind = ?').run(id, 'session');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });
  const fdir = filesDir(id);
  if (fs.existsSync(fdir)) { try { fs.rmSync(fdir, { recursive: true, force: true }); } catch {} }
  removeCovers(id);
}

/** Delete DATA_DIR/covers/{id}-*.png (#22), except `keep` (a file name). */
function removeCovers(id, keep = null) {
  let names;
  try { names = fs.readdirSync(COVERS_DIR); } catch { return; }
  for (const n of names) {
    if (n !== keep && n.startsWith(`${id}-`) && n.endsWith('.png')) {
      try { fs.unlinkSync(path.join(COVERS_DIR, n)); } catch {}
    }
  }
}

/** Every session with the per-session counts /paste/list reports. */
function listSessionsForList() {
  return db.prepare(`
    SELECT s.*, c.content_hash AS _content_hash, c.hashless AS _hashless,
           COALESCE(cm.n, 0) AS comment_count, COALESCE(cm.mf, 0) AS must_fix_unresolved,
           COALESCE(fl.n, 0) AS file_count, COALESCE(rv.n, 0) AS revision_count
    FROM sessions s
    LEFT JOIN contents c ON c.session_id = s.id
    LEFT JOIN (SELECT session_id, count(*) AS n, sum(must_fix_open) AS mf FROM comments GROUP BY session_id) cm ON cm.session_id = s.id
    LEFT JOIN (SELECT session_id, count(*) AS n FROM files GROUP BY session_id) fl ON fl.session_id = s.id
    LEFT JOIN (SELECT session_id, count(*) AS n FROM revisions GROUP BY session_id) rv ON rv.session_id = s.id
  `).all().map((r) => {
    const meta = rows.decodeMeta(r, r._content_hash ? { content_hash: r._content_hash, hashless: r._hashless } : null);
    const extraComments = Object.hasOwn(meta, 'comments') && !Array.isArray(meta.comments);
    return {
      id: r.id, meta,
      comment_count: extraComments ? (meta.comments || []).length : r.comment_count,
      must_fix_unresolved: extraComments ? 0 : r.must_fix_unresolved,
      file_count: r.file_count, revision_count: r.revision_count, updated_at: r.updated_at,
      upsert_key: r.upsert_key ?? null,
    };
  });
}

// ── File collections (blobs on disk, metadata rows in `files`) ──────────────

function ensureFilesDir(id) {
  const dir = filesDir(id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listSessionFiles(id) {
  return db.prepare('SELECT name, size, type FROM files WHERE session_id = ? ORDER BY name').all(id)
    .map((r) => ({ name: r.name, size: r.size, type: r.type }));
}

/** A file write is a session write: its metadata row and the session version change together. */
function touchFileRow(id, rel, stat) {
  tx(db, () => {
    if (stat) {
      db.prepare(`INSERT INTO files (session_id, name, size, type, updated_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(session_id, name) DO UPDATE SET size = excluded.size, type = excluded.type, updated_at = excluded.updated_at`)
        .run(id, rel, stat.size, getMime(rel), new Date(stat.mtimeMs).toISOString());
    } else {
      db.prepare('DELETE FROM files WHERE session_id = ? AND name = ?').run(id, rel);
    }
    db.prepare('UPDATE sessions SET version = version + 1 WHERE id = ?').run(id);
  });
}

const relName = (dir, target) => path.relative(dir, target).split(path.sep).join('/');

function saveSessionFile(id, filename, content, encoding) {
  const dir = filesDir(id);
  const dest = path.resolve(dir, filename);
  // Prevent directory traversal
  if (!dest.startsWith(dir + path.sep) && dest !== dir) {
    throw new Error(`Invalid file path: ${filename}`);
  }
  ensureFilesDir(id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (encoding === 'base64') {
    fs.writeFileSync(dest, Buffer.from(content, 'base64'));
  } else {
    fs.writeFileSync(dest, content);
  }
  const stat = fs.statSync(dest);
  touchFileRow(id, relName(dir, dest), stat);
  return { name: filename, size: stat.size, type: getMime(filename) };
}

function deleteSessionFile(id, filename) {
  const dir = filesDir(id);
  const target = path.resolve(dir, filename);
  if (!target.startsWith(dir + path.sep) && target !== dir) return false;
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  touchFileRow(id, relName(dir, target), null);
  return true;
}

function getSessionFile(id, filename) {
  const dir = filesDir(id);
  const target = path.resolve(dir, filename);
  if (!target.startsWith(dir + path.sep) && target !== dir) return null;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;
  return { path: target, mime: getMime(filename) };
}

// ── Chunked upload helpers ──────────────────────────────────────────────────

function chunkDir(uploadId) { return path.join(CHUNKS_DIR, uploadId); }

function saveChunk(uploadId, index, data) {
  const dir = chunkDir(uploadId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(index).padStart(6, '0')), data);
}

function assembleChunks(uploadId) {
  const dir = chunkDir(uploadId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => !f.startsWith('_')).sort();
  if (files.length === 0) return null;
  const bufs = files.map(f => fs.readFileSync(path.join(dir, f)));
  // Cleanup
  fs.rmSync(dir, { recursive: true, force: true });
  return Buffer.concat(bufs).toString('utf-8');
}

module.exports = {
  db, DATA_DIR, SITES_DIR,
  generateSlug, uniqueSlug, isExpired, resolveId, sessionExists,
  getSite, listSites, resolveSiteId, createSite, deleteSite,
  filesDir, hashContent, currentContentHash, contentHashMismatch, loadContent, loadMeta, loadPaste, sessionEtag,
  getEditTokenHash, setEditTokenHash, sessionByKey, upsertKeyOf, tx: (fn) => tx(db, fn),
  listRevisions, readRevisionBlob, revisionSummary, savePaste, deleteSession, removeCovers, listSessionsForList,
  listSessionFiles, saveSessionFile, deleteSessionFile, getSessionFile,
  chunkDir, saveChunk, assembleChunks,
};
