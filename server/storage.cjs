'use strict';
// Session / slug / site / file storage (JSON + gzip files under DATA_DIR).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const {
  DATA_DIR, SITES_DIR, FILES_DIR, CHUNKS_DIR, REVISIONS_DIR, REVISIONS_MAX, REVISION_COALESCE_MS,
} = require('./config.cjs');
const { HttpError, getMime } = require('./http-util.cjs');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SITES_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(CHUNKS_DIR, { recursive: true });
fs.mkdirSync(REVISIONS_DIR, { recursive: true });

// ── Slug index ───────────────────────────────────────────────────────────────
const SLUG_INDEX_PATH = path.join(DATA_DIR, '_slug-index.json');
let slugIndex = {};
if (fs.existsSync(SLUG_INDEX_PATH)) {
  try { slugIndex = JSON.parse(fs.readFileSync(SLUG_INDEX_PATH, 'utf-8')); } catch { slugIndex = {}; }
}
// Write via temp file + rename so a crash mid-write can never leave a
// truncated/corrupt JSON or gzip on disk (rename is atomic on POSIX).
function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function saveSlugIndex() {
  writeFileAtomic(SLUG_INDEX_PATH, JSON.stringify(slugIndex));
}
function generateSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
function uniqueSlug(base) {
  if (!slugIndex[base]) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!slugIndex[candidate]) return candidate;
  }
}
function isExpired(data) {
  if (!data.expires_at) return false;
  return new Date(data.expires_at) < new Date();
}

function resolveId(idOrSlug) {
  const looksLikeId = /^[a-f0-9]+$/.test(idOrSlug);
  // A slug can itself be all-hex ("cafe", "bad", "1234"); prefer a real id
  // file, then the slug index, and only then treat it as an (unknown) id.
  if (looksLikeId && fs.existsSync(metaPath(idOrSlug))) return idOrSlug;
  if (slugIndex[idOrSlug]) return slugIndex[idOrSlug];
  return looksLikeId ? idOrSlug : null;
}

// ── Site index ───────────────────────────────────────────────────────────────
const SITE_INDEX_PATH = path.join(DATA_DIR, '_site-index.json');
let siteIndex = {};
if (fs.existsSync(SITE_INDEX_PATH)) {
  try { siteIndex = JSON.parse(fs.readFileSync(SITE_INDEX_PATH, 'utf-8')); } catch { siteIndex = {}; }
}
function saveSiteIndex() {
  writeFileAtomic(SITE_INDEX_PATH, JSON.stringify(siteIndex));
}

function resolveSiteId(idOrSlug) {
  // Check if it's a direct site ID (directory exists)
  if (/^[a-f0-9]+$/.test(idOrSlug) && fs.existsSync(path.join(SITES_DIR, idOrSlug))) return idOrSlug;
  // Check slug index
  for (const [id, meta] of Object.entries(siteIndex)) {
    if (meta.slug === idOrSlug) return id;
  }
  return null;
}

// ── Content storage (separate .content.gz files) ────────────────────────────

function contentPath(id) { return path.join(DATA_DIR, `${id}.content.gz`); }
function metaPath(id)    { return path.join(DATA_DIR, `${id}.json`); }
function filesDir(id)    { return path.join(FILES_DIR, id); }

function hashContent(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function saveContent(id, markdown) {
  const buf = Buffer.from(markdown, 'utf-8');
  const gz = zlib.gzipSync(buf);
  writeFileAtomic(contentPath(id), gz);
  return hashContent(buf);
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

function loadContent(id) {
  const cp = contentPath(id);
  if (!fs.existsSync(cp)) return null;
  const gz = fs.readFileSync(cp);
  try {
    return zlib.gunzipSync(gz).toString('utf-8');
  } catch (e) {
    console.error(`[md-review] corrupt content file for ${id}: ${e.message}`);
    // Never hand back '' for a document that exists — a client would treat
    // that as the real content and could save it back.
    throw new HttpError(500, 'Session content is unreadable (corrupt content file)');
  }
}

// Parse a session's meta JSON. A corrupt or non-object file is treated as
// "no such session" (404) rather than taking the whole process down.
function readMetaFile(id) {
  const mp = metaPath(id);
  if (!fs.existsSync(mp)) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(mp, 'utf-8')); }
  catch (e) {
    console.error(`[md-review] corrupt session meta ${id}: ${e.message}`);
    return null;
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    console.error(`[md-review] session meta ${id} is not an object`);
    return null;
  }
  return meta;
}

function loadPaste(id) {
  const mp = metaPath(id);
  const meta = readMetaFile(id);
  if (!meta) return null;

  // Auto-migrate: if markdown is still inline in JSON, split it out
  if (meta.markdown !== undefined) {
    const hash = saveContent(id, meta.markdown);
    delete meta.markdown;
    meta.content_hash = hash;
    writeFileAtomic(mp, JSON.stringify(meta));
  }

  // Load content from separate file
  const markdown = loadContent(id);
  return { ...meta, markdown: markdown || '' };
}

function loadMeta(id) {
  const mp = metaPath(id);
  const meta = readMetaFile(id);
  if (!meta) return null;
  // Auto-migrate if needed
  if (meta.markdown !== undefined) {
    const hash = saveContent(id, meta.markdown);
    delete meta.markdown;
    meta.content_hash = hash;
    writeFileAtomic(mp, JSON.stringify(meta));
  }
  return meta;
}

// ── Revision history ─────────────────────────────────────────────────────────

function revisionsDir(id) { return path.join(REVISIONS_DIR, id); }
function revisionPath(id, hash) { return path.join(revisionsDir(id), `${hash}.gz`); }

function writeRevisionBlob(id, hash, gz) {
  const p = revisionPath(id, hash);
  if (fs.existsSync(p)) return;
  fs.mkdirSync(revisionsDir(id), { recursive: true });
  writeFileAtomic(p, gz);
}

function dropRevisionBlobIfUnreferenced(id, meta, hash) {
  if (!hash) return;
  if ((meta.revisions || []).some(r => r.hash === hash)) return;
  if (meta.content_hash === hash) return;
  try { fs.unlinkSync(revisionPath(id, hash)); } catch { /* already gone */ }
}

function readRevisionBlob(id, hash) {
  const p = revisionPath(id, hash);
  if (!fs.existsSync(p)) return null;
  try { return zlib.gunzipSync(fs.readFileSync(p)).toString('utf-8'); }
  catch (e) {
    console.error(`[md-review] corrupt revision blob ${id}/${hash}: ${e.message}`);
    throw new HttpError(500, 'Revision content is unreadable');
  }
}

/**
 * Record that `id`'s content is about to change from prevHash to newHash.
 * Must run BEFORE the new content file is written (it may need the old one to
 * seed the history of a session created before revisions existed).
 */
function recordRevision(id, meta, { prevHash, newHash, gz, size, ctx }) {
  const now = new Date().toISOString();
  const by = ctx.by ?? null;
  const client = ctx.client ?? 'api';

  if (!Array.isArray(meta.revisions)) {
    meta.revisions = [];
    // Seed with the content this write replaces so the first diff has a "before".
    if (prevHash && fs.existsSync(contentPath(id))) {
      try {
        const oldGz = fs.readFileSync(contentPath(id));
        const oldSize = zlib.gunzipSync(oldGz).length;
        writeRevisionBlob(id, prevHash, oldGz);
        meta.revisions.push({ hash: prevHash, at: meta.sharedAt || now, by: null, client: null, size: oldSize, parent: null, seeded: true });
      } catch (e) {
        console.error(`[md-review] could not seed revision history for ${id}: ${e.message}`);
      }
    }
  }

  writeRevisionBlob(id, newHash, gz);

  const last = meta.revisions[meta.revisions.length - 1];
  const lastAt = last ? Date.parse(last.at_end || last.at) : NaN;
  const coalesce = last
    && !last.seeded
    && last.by === by && last.client === client
    && last.hash === prevHash
    && Number.isFinite(lastAt) && (Date.now() - lastAt) < REVISION_COALESCE_MS;

  if (coalesce) {
    const superseded = last.hash;
    last.hash = newHash;
    last.at_end = now;
    last.size = size;
    last.writes = (last.writes || 1) + 1;
    dropRevisionBlobIfUnreferenced(id, { ...meta, content_hash: newHash }, superseded);
  } else {
    meta.revisions.push({ hash: newHash, at: now, by, client, size, parent: prevHash || null });
  }

  while (meta.revisions.length > REVISIONS_MAX) {
    const dropped = meta.revisions.shift();
    dropRevisionBlobIfUnreferenced(id, { ...meta, content_hash: newHash }, dropped.hash);
  }
}

/** Light summary for list/GET responses (the full list lives behind /revisions). */
function revisionSummary(meta) {
  const revs = meta.revisions || [];
  const last = revs[revs.length - 1];
  return {
    revision_count: revs.length,
    latest_revision: last ? { hash: last.hash, at: last.at_end || last.at, by: last.by ?? null, client: last.client ?? null } : null,
  };
}

/**
 * Persist a session. `ctx` = { by, client } describes who is writing (used for
 * the revision entry). The content file is only rewritten when the content
 * actually changed — comment edits no longer re-gzip the whole document.
 */
function savePaste(id, data, ctx = {}) {
  const { markdown, ...meta } = data;
  if (markdown !== undefined) {
    const buf = Buffer.from(markdown, 'utf-8');
    const newHash = hashContent(buf);
    const prevHash = meta.content_hash || null;
    if (newHash !== prevHash || !fs.existsSync(contentPath(id))) {
      const gz = zlib.gzipSync(buf);
      recordRevision(id, meta, { prevHash, newHash, gz, size: buf.length, ctx });
      writeFileAtomic(contentPath(id), gz);
      meta.content_hash = newHash;
    }
  }
  writeFileAtomic(metaPath(id), JSON.stringify(meta));
  return meta;
}

// ── File collections ────────────────────────────────────────────────────────

function ensureFilesDir(id) {
  const dir = filesDir(id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listSessionFiles(id) {
  const dir = filesDir(id);
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const walk = (d, prefix) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(path.join(d, ent.name), rel); }
      else {
        const stat = fs.statSync(path.join(d, ent.name));
        results.push({ name: rel, size: stat.size, type: getMime(ent.name) });
      }
    }
  };
  walk(dir, '');
  return results;
}

function saveSessionFile(id, filename, content, encoding) {
  const dir = ensureFilesDir(id);
  const dest = path.resolve(dir, filename);
  // Prevent directory traversal
  if (!dest.startsWith(dir + path.sep) && dest !== dir) {
    throw new Error(`Invalid file path: ${filename}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (encoding === 'base64') {
    fs.writeFileSync(dest, Buffer.from(content, 'base64'));
  } else {
    fs.writeFileSync(dest, content);
  }
  const stat = fs.statSync(dest);
  return { name: filename, size: stat.size, type: getMime(filename) };
}

function deleteSessionFile(id, filename) {
  const dir = filesDir(id);
  const target = path.resolve(dir, filename);
  if (!target.startsWith(dir + path.sep) && target !== dir) return false;
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
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
  DATA_DIR, SITES_DIR, slugIndex, siteIndex, writeFileAtomic, saveSlugIndex, generateSlug, uniqueSlug, isExpired, resolveId, saveSiteIndex, resolveSiteId, contentPath, metaPath, filesDir, hashContent, saveContent, currentContentHash, contentHashMismatch, loadContent, readMetaFile, loadPaste, loadMeta, revisionsDir, revisionPath, readRevisionBlob, revisionSummary, savePaste, listSessionFiles, saveSessionFile, deleteSessionFile, getSessionFile, chunkDir, saveChunk, assembleChunks,
};
