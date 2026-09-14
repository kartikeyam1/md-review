const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Resolve GITHUB_TOKEN: env var first, fall back to `gh auth token`
if (!process.env.GITHUB_TOKEN) {
  try {
    process.env.GITHUB_TOKEN = execSync('gh auth token', { encoding: 'utf-8' }).trim();
  } catch {
    // gh CLI not available — private repos won't work
  }
}

const zlib = require('zlib');

const PORT = parseInt(process.env.PORT || '3100', 10);
// DATA_DIR is overridable so tests can run against a throwaway directory.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SITES_DIR = path.join(DATA_DIR, 'sites');
const FILES_DIR = path.join(DATA_DIR, 'files');  // per-session file collections
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks'); // temp chunked upload staging
const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB (raised from 10 MB)
const MAX_SITE_BYTES = 50 * 1024 * 1024; // 50 MB for site uploads

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SITES_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(CHUNKS_DIR, { recursive: true });

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

const MIME_TYPES = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.txt': 'text/plain', '.md': 'text/plain', '.map': 'application/json',
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript',
  '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go',
  '.rs': 'text/x-rust', '.c': 'text/x-c', '.cpp': 'text/x-c++',
  '.h': 'text/x-c', '.java': 'text/x-java', '.yml': 'text/yaml', '.yaml': 'text/yaml',
  '.toml': 'text/toml', '.sh': 'text/x-shellscript', '.sql': 'text/x-sql',
  '.wasm': 'application/wasm',
};
function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function readBodyRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); return reject(new Error('Payload too large')); }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fireWebhook(url, payload) {
  const mod = url.startsWith('https') ? require('https') : require('http');
  const body = JSON.stringify(payload);
  const parsed = new URL(url);
  const opts = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const req = mod.request(opts, () => {});
  req.on('error', () => {}); // fire-and-forget
  req.write(body);
  req.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Payload too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// Read + parse a JSON body, writing the 413/400 response itself on failure.
// Returns `undefined` when a response has already been sent.
//
// IMPORTANT: every mutating handler must call this BEFORE loadPaste()/loadMeta()
// so the load → mutate → save section contains no `await`. Node is single-
// threaded, but an await between load and save lets a concurrent request load
// the same paste, and whichever saves last silently drops the other's write.
async function readJsonBody(req, res, { optional = false, lenient = false } = {}) {
  let rawBody;
  try { rawBody = await readBody(req); }
  catch {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payload too large' }));
    return undefined;
  }
  if (optional && !rawBody.trim()) return {};
  try { return JSON.parse(rawBody); }
  catch {
    if (lenient) return {};
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return undefined;
  }
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

// An error the request wrapper turns into a JSON response instead of a crash.
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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

function savePaste(id, data) {
  const { markdown, ...meta } = data;
  if (markdown !== undefined) {
    meta.content_hash = saveContent(id, markdown);
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

// ── Unified-diff patch applier (validating) ─────────────────────────────────
// Applies hunks in order and REFUSES to apply when a removed/context line does
// not match the source (throws PatchError). Silently mis-applying a patch is
// far worse than rejecting it — the caller can re-read and retry.

class PatchError extends Error {}

function applyPatch(original, patch) {
  const lines = original.split('\n');
  // A trailing newline on the patch text is not an (empty) context line.
  const patchLines = patch.replace(/\n$/, '').split('\n');
  const result = [];
  let srcIdx = 0;
  let hunks = 0;

  const expect = (content) => {
    if (srcIdx >= lines.length) {
      throw new PatchError(`Patch refers to source line ${srcIdx + 1} but the document has only ${lines.length} lines`);
    }
    if (lines[srcIdx] !== content) {
      throw new PatchError(`Patch context mismatch at source line ${srcIdx + 1}: expected ${JSON.stringify(content)}, found ${JSON.stringify(lines[srcIdx])}`);
    }
  };

  for (let i = 0; i < patchLines.length; i++) {
    const hunkMatch = patchLines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) continue; // diff/---/+++/index headers between hunks
    hunks++;
    // The header's line counts say exactly how many -/+/context lines follow,
    // so a body line that happens to start with "---" or "@@" is never mistaken
    // for a header.
    let srcCount = hunkMatch[2] === undefined ? 1 : parseInt(hunkMatch[2], 10);
    let dstCount = hunkMatch[4] === undefined ? 1 : parseInt(hunkMatch[4], 10);
    // Hunks with zero source lines (pure insert into an empty region) use the
    // line *before* the insertion point as their start.
    let srcStart = parseInt(hunkMatch[1], 10) - 1;
    if (srcCount === 0) srcStart += 1;
    if (srcStart < srcIdx) throw new PatchError(`Hunk at source line ${srcStart + 1} overlaps a previous hunk`);
    if (srcStart > lines.length) throw new PatchError(`Hunk starts at source line ${srcStart + 1} beyond end of document (${lines.length} lines)`);
    while (srcIdx < srcStart) result.push(lines[srcIdx++]);

    i++;
    while (i < patchLines.length && (srcCount > 0 || dstCount > 0)) {
      const pl = patchLines[i];
      if (pl.startsWith('\\')) { i++; continue; } // "\ No newline at end of file"
      if (pl.startsWith('-')) {
        expect(pl.slice(1));
        srcIdx++;
        srcCount--;
      } else if (pl.startsWith('+')) {
        result.push(pl.slice(1));
        dstCount--;
      } else {
        // context line: " text" (leading space) or "" (some tools strip the space)
        const content = pl.startsWith(' ') ? pl.slice(1) : pl;
        expect(content);
        result.push(lines[srcIdx++]);
        srcCount--;
        dstCount--;
      }
      i++;
    }
    if (srcCount !== 0 || dstCount !== 0) {
      throw new PatchError('Hunk body does not match the line counts in its @@ header');
    }
    if (i < patchLines.length && patchLines[i].startsWith('\\')) i++;
    i--; // the for-loop's i++ moves onto the line after this hunk
  }
  if (hunks === 0) throw new PatchError('No hunks found in patch (expected "@@ -a,b +c,d @@" headers)');
  while (srcIdx < lines.length) result.push(lines[srcIdx++]);
  return result.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match, If-Match');
  res.setHeader('Access-Control-Expose-Headers', 'ETag');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

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

    savePaste(id, parsed);
    const result = { id };
    if (slug) result.slug = slug;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // POST /paste/:id/comments/:commentId/replies — add a reply
  // PUT  /paste/:id/comments/:commentId/replies/:replyId — update a reply
  // DELETE /paste/:id/comments/:commentId/replies/:replyId — remove a reply
  const replyMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/comments\/([a-zA-Z0-9-]+)\/replies(?:\/([a-zA-Z0-9-]+))?$/);
  if (replyMatch && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
    const pasteId = resolveId(replyMatch[1]);
    const commentId = replyMatch[2];
    const replyId = replyMatch[3];
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = req.method === 'DELETE' ? null : await readJsonBody(req, res);
    if (parsed === undefined) return;
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (!data.comments) data.comments = [];
    const comment = data.comments.find(c => c.id === commentId);
    if (!comment) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'comment not found' }));
    }
    if (!comment.replies) comment.replies = [];

    if (req.method === 'POST' && !replyId) {
      if (!parsed.body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing required field: body' }));
      }

      const reply = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        body: parsed.body,
      };
      if (parsed.author !== undefined) reply.author = parsed.author;

      comment.replies.push(reply);
      savePaste(pasteId, data);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(reply));
    }

    if (req.method === 'PUT' && replyId) {
      const ridx = comment.replies.findIndex(r => r.id === replyId);
      if (ridx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'reply not found' }));
      }

      if (parsed.body !== undefined) comment.replies[ridx].body = parsed.body;
      savePaste(pasteId, data);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(comment.replies[ridx]));
    }

    if (req.method === 'DELETE' && replyId) {
      const ridx = comment.replies.findIndex(r => r.id === replyId);
      if (ridx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'reply not found' }));
      }

      comment.replies.splice(ridx, 1);
      savePaste(pasteId, data);

      res.writeHead(204);
      return res.end();
    }
  }

  // PUT /paste/:id/comments/:commentId/resolve — resolve a comment
  // PUT /paste/:id/comments/:commentId/unresolve — unresolve a comment
  const resolveMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/comments\/([a-zA-Z0-9-]+)\/(resolve|unresolve)$/);
  if (resolveMatch && req.method === 'PUT') {
    const pasteId = resolveId(resolveMatch[1]);
    const commentId = resolveMatch[2];
    const action = resolveMatch[3];
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = await readJsonBody(req, res, { optional: true, lenient: true });
    if (parsed === undefined) return;
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (!data.comments) data.comments = [];
    const comment = data.comments.find(c => c.id === commentId);
    if (!comment) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'comment not found' }));
    }

    if (action === 'resolve') {
      comment.resolved = true;
      comment.resolved_by = parsed.resolved_by || null;
      comment.resolved_at = Date.now();
    } else {
      comment.resolved = false;
      comment.resolved_by = null;
      comment.resolved_at = null;
    }

    savePaste(pasteId, data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(comment));
  }

  // POST /paste/:id/comments — add a comment
  // PUT  /paste/:id/comments/:commentId — update a comment
  // DELETE /paste/:id/comments/:commentId — remove a comment
  const commentMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/comments(?:\/([a-zA-Z0-9-]+))?$/);
  if (commentMatch && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
    const pasteId = resolveId(commentMatch[1]);
    const commentId = commentMatch[2];
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = req.method === 'DELETE' ? null : await readJsonBody(req, res);
    if (parsed === undefined) return;
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (!data.comments) data.comments = [];

    if (req.method === 'POST' && !commentId) {
      const { startLine, endLine, selectedText, body: commentBody, category, author } = parsed;
      if (startLine == null || endLine == null || !selectedText || !commentBody || !category) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing required fields' }));
      }

      const comment = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        startLine,
        endLine,
        selectedText,
        body: commentBody,
        category,
      };
      if (author !== undefined) comment.author = author;

      data.comments.push(comment);
      savePaste(pasteId, data);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(comment));
    }

    if (req.method === 'PUT' && commentId) {
      const idx = data.comments.findIndex(c => c.id === commentId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'comment not found' }));
      }

      if (parsed.body !== undefined) data.comments[idx].body = parsed.body;
      if (parsed.category !== undefined) data.comments[idx].category = parsed.category;
      savePaste(pasteId, data);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data.comments[idx]));
    }

    if (req.method === 'DELETE' && commentId) {
      const idx = data.comments.findIndex(c => c.id === commentId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'comment not found' }));
      }

      data.comments.splice(idx, 1);
      savePaste(pasteId, data);

      res.writeHead(204);
      return res.end();
    }
  }

  // GET /paste/:id/approval — get approval status
  // PUT /paste/:id/approval — transition approval status
  const approvalMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/approval$/);
  if (approvalMatch && (req.method === 'GET' || req.method === 'PUT')) {
    const pasteId = resolveId(approvalMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = req.method === 'PUT' ? await readJsonBody(req, res) : null;
    if (parsed === undefined) return;
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        approval_status: data.approval_status || 'pending',
        approved_by: data.approved_by || null,
        approved_at: data.approved_at || null,
      }));
    }

    // PUT — transition approval status
    const current = data.approval_status || 'pending';
    const next = parsed.status;
    const VALID = {
      'pending': ['approved', 'changes_requested'],
      'approved': ['changes_requested'],
      'changes_requested': ['approved'],
    };
    if (!VALID[current] || !VALID[current].includes(next)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Invalid transition: ${current} -> ${next}` }));
    }

    // Must-fix enforcement: block approval if unresolved must-fix comments
    if (next === 'approved') {
      const unresolved = (data.comments || [])
        .filter(c => c.category === 'must-fix' && c.resolved !== true)
        .map(c => c.id);
      if (unresolved.length > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'Cannot approve: unresolved must-fix comments',
          unresolved_comment_ids: unresolved,
        }));
      }
    }

    data.approval_status = next;
    if (next === 'approved') {
      data.approved_by = parsed.approved_by || null;
      data.approved_at = new Date().toISOString();
    } else if (next === 'changes_requested') {
      data.approved_by = null;
      data.approved_at = null;
    }
    savePaste(pasteId, data);

    // Fire webhook if callback_url exists
    if (data.callback_url) {
      fireWebhook(data.callback_url, {
        sessionId: pasteId,
        approval_status: data.approval_status,
        approved_by: data.approved_by,
        approved_at: data.approved_at,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      approval_status: data.approval_status,
      approved_by: data.approved_by,
      approved_at: data.approved_at,
    }));
  }

  // PUT /paste/:id/markdown — update markdown (full replace or patch)
  //   Body: { markdown } | { patch: "<unified diff>" }, optional filename, optional base_hash
  //   Optimistic concurrency: send If-Match: <content_hash> (or base_hash in the
  //   body). If the stored content has changed since, responds 412 with the
  //   current content_hash + markdown so the client can merge instead of clobber.
  //   Patches that do not apply cleanly respond 409.
  const markdownPutMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/markdown$/);
  if (req.method === 'PUT' && markdownPutMatch) {
    const pasteId = resolveId(markdownPutMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = await readJsonBody(req, res);
    if (parsed === undefined) return;
    if (parsed.patch === undefined && parsed.markdown === undefined && parsed.delta === undefined && parsed.filename === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Provide markdown, patch, delta, or filename' }));
    }
    // { delta: { keepStart, keepEnd, insert } } replaces base[keepStart .. len-keepEnd)
    // with `insert`. It is only meaningful against one exact base, so it
    // REQUIRES If-Match / base_hash (a stale base is rejected with 412 below).
    const delta = parsed.delta;
    if (delta !== undefined) {
      const validShape = delta && typeof delta === 'object'
        && Number.isInteger(delta.keepStart) && delta.keepStart >= 0
        && Number.isInteger(delta.keepEnd) && delta.keepEnd >= 0
        && typeof delta.insert === 'string';
      if (!validShape) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'delta must be { keepStart: int, keepEnd: int, insert: string }' }));
      }
      if (!req.headers['if-match'] && !parsed.base_hash) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'delta requires If-Match (or base_hash) naming the content it applies to' }));
      }
    }
    if (parsed.markdown !== undefined && typeof parsed.markdown !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'markdown must be a string' }));
    }
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    const mismatch = contentHashMismatch(req.headers['if-match'] || parsed.base_hash, data, data.markdown);
    if (mismatch) {
      res.writeHead(412, { 'Content-Type': 'application/json', ETag: `"${mismatch}"` });
      return res.end(JSON.stringify({
        error: 'Content changed on server since your last read',
        content_hash: mismatch,
        markdown: data.markdown,
        filename: data.filename,
      }));
    }

    if (delta !== undefined) {
      const base = data.markdown || '';
      if (delta.keepStart + delta.keepEnd > base.length) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Delta does not fit the current content', content_hash: currentContentHash(data, base) }));
      }
      data.markdown = base.slice(0, delta.keepStart) + delta.insert + base.slice(base.length - delta.keepEnd);
    } else if (parsed.patch !== undefined) {
      try {
        data.markdown = applyPatch(data.markdown || '', parsed.patch);
      } catch (e) {
        const status = e instanceof PatchError ? 409 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Patch failed: ${e.message}`, content_hash: currentContentHash(data, data.markdown) }));
      }
    } else if (parsed.markdown !== undefined) {
      data.markdown = parsed.markdown;
    }
    if (parsed.filename !== undefined) data.filename = parsed.filename;
    const saved = savePaste(pasteId, data);

    res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"${saved.content_hash}"` });
    return res.end(JSON.stringify({ ok: true, content_hash: saved.content_hash, filename: saved.filename }));
  }

  // GET /paste/list — list sessions (filter by status, name pattern, limit)
  if (req.method === 'GET' && req.url.startsWith('/paste/list')) {
    const params = new URL(req.url, `http://${req.headers.host}`);
    const statusFilter = params.searchParams.get('status');
    const nameFilter = params.searchParams.get('name');
    const limitParam = params.searchParams.get('limit');
    const nameRe = nameFilter ? new RegExp(nameFilter, 'i') : null;
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    const results = [];
    for (const f of files) {
      try {
        // Use loadMeta — doesn't read content file, much faster for listings
        const id = f.replace('.json', '');
        const data = loadMeta(id);
        if (!data) continue;
        if (isExpired(data)) continue;
        if (statusFilter && data.approval_status !== statusFilter) continue;
        if (nameRe && !nameRe.test(data.sessionName || '') && !nameRe.test(data.filename || '')) continue;
        const sessionFiles = listSessionFiles(id);
        results.push({
          id,
          slug: data.slug || null,
          sessionName: data.sessionName || null,
          filename: data.filename || null,
          approval_status: data.approval_status || 'pending',
          comment_count: (data.comments || []).length,
          must_fix_unresolved: (data.comments || []).filter(c => c.category === 'must-fix' && c.resolved !== true).length,
          file_count: sessionFiles.length,
          created_at: data.sharedAt || null,
          expires_at: data.expires_at || null,
        });
      } catch { /* skip corrupt files */ }
    }
    results.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const limit = limitParam ? parseInt(limitParam, 10) : results.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(results.slice(0, limit)));
  }

  // DELETE /paste/:id — delete a session and all its data
  const deleteMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const pasteId = resolveId(deleteMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const meta = loadMeta(pasteId);
    if (!meta) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    // Remove slug from index
    if (meta.slug && slugIndex[meta.slug]) {
      delete slugIndex[meta.slug];
      saveSlugIndex();
    }
    // Remove files
    try { fs.unlinkSync(metaPath(pasteId)); } catch {}
    try { fs.unlinkSync(contentPath(pasteId)); } catch {}
    const fdir = filesDir(pasteId);
    if (fs.existsSync(fdir)) { try { fs.rmSync(fdir, { recursive: true, force: true }); } catch {} }
    res.writeHead(204);
    return res.end();
  }

  // PUT /paste/:id/meta — update session metadata (name, expiry, slug)
  const metaPutMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/meta$/);
  if (req.method === 'PUT' && metaPutMatch) {
    const pasteId = resolveId(metaPutMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const parsed = await readJsonBody(req, res);
    if (parsed === undefined) return;
    const meta = loadMeta(pasteId);
    if (!meta) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }

    if (parsed.sessionName !== undefined) meta.sessionName = parsed.sessionName;
    if (parsed.filename !== undefined) meta.filename = parsed.filename;

    // Update expiry
    if (parsed.expiry_days !== undefined) {
      if (parsed.expiry_days === null) {
        delete meta.expires_at;
      } else {
        const days = [7, 30, 90].includes(parsed.expiry_days) ? parsed.expiry_days : 30;
        meta.expires_at = new Date(Date.now() + days * 86400000).toISOString();
      }
    }

    // Update slug
    if (parsed.slug !== undefined) {
      // Remove old slug
      if (meta.slug && slugIndex[meta.slug]) {
        delete slugIndex[meta.slug];
      }
      if (parsed.slug) {
        const newSlug = uniqueSlug(generateSlug(parsed.slug));
        meta.slug = newSlug;
        slugIndex[newSlug] = pasteId;
      } else {
        delete meta.slug;
      }
      saveSlugIndex();
    }

    writeFileAtomic(metaPath(pasteId), JSON.stringify(meta));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      sessionName: meta.sessionName || null,
      slug: meta.slug || null,
      expires_at: meta.expires_at || null,
    }));
  }

  // GET /paste/:id — read full paste (supports ?fields=meta,content,comments,files)
  // GET /paste/:id/comments — read comments only
  // GET /paste/:id/markdown — read markdown only
  const match = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)(\/comments|\/markdown)?(\?.*)?$/);
  if (req.method === 'GET' && match) {
    const resolvedId = resolveId(match[1]);
    if (!resolvedId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }

    const mp = metaPath(resolvedId);
    if (!fs.existsSync(mp)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    // Load metadata (lightweight — no content read yet)
    const meta = loadMeta(resolvedId);
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    if (isExpired(meta)) {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Session expired' }));
    }

    // ETag from stored content_hash + meta hash
    const metaBytes = fs.readFileSync(mp);
    const combinedHash = crypto.createHash('md5')
      .update(meta.content_hash || '')
      .update(metaBytes)
      .digest('hex');
    const etag = `"${combinedHash}"`;

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }

    const sub = match[2];
    const params = new URL(req.url, `http://${req.headers.host}`);
    const fields = params.searchParams.get('fields');

    let result;
    if (sub === '/comments') {
      result = { filename: meta.filename, comments: meta.comments || [] };
    } else if (sub === '/markdown') {
      const markdown = loadContent(resolvedId) || '';
      result = { filename: meta.filename, markdown };
    } else if (fields) {
      // Selective field loading: ?fields=meta,content,comments,files
      const wanted = new Set(fields.split(',').map(f => f.trim()));
      result = {};
      if (wanted.has('meta')) {
        const { comments, content_hash, ...rest } = meta;
        Object.assign(result, rest);
      }
      if (wanted.has('content')) {
        result.markdown = loadContent(resolvedId) || '';
      }
      if (wanted.has('comments')) {
        result.comments = meta.comments || [];
      }
      if (wanted.has('files')) {
        result.files = listSessionFiles(resolvedId);
      }
    } else {
      // Full response (backward compatible) — includes file list if any
      const markdown = loadContent(resolvedId) || '';
      result = { ...meta, markdown };
      const sessionFiles = listSessionFiles(resolvedId);
      if (sessionFiles.length > 0) result.files = sessionFiles;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
    res.end(JSON.stringify(result));
    return;
  }

  // ── Chunked uploads ──────────────────────────────────────────────────────
  // POST /paste/:id/upload/start — begin a chunked upload, returns uploadId
  const uploadStartMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/upload\/start$/);
  if (req.method === 'POST' && uploadStartMatch) {
    const pasteId = resolveId(uploadStartMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    if (!fs.existsSync(metaPath(pasteId))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    let rawBody;
    try { rawBody = await readBody(req); } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large' }));
    }
    let parsed = {};
    try { parsed = JSON.parse(rawBody); } catch {}
    const uploadId = crypto.randomBytes(8).toString('hex');
    const uploadMeta = { pasteId, totalChunks: parsed.totalChunks || null, filename: parsed.filename || null, target: parsed.target || 'markdown' };
    fs.mkdirSync(chunkDir(uploadId), { recursive: true });
    fs.writeFileSync(path.join(chunkDir(uploadId), '_meta.json'), JSON.stringify(uploadMeta));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ uploadId, chunkSize: 512 * 1024 }));
  }

  // POST /paste/:id/upload/chunk — send a chunk
  const uploadChunkMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/upload\/chunk$/);
  if (req.method === 'POST' && uploadChunkMatch) {
    let rawBody;
    try { rawBody = await readBody(req); } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large' }));
    }
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    const { uploadId, index, data } = parsed;
    if (!uploadId || index === undefined || !data) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing uploadId, index, or data' }));
    }
    if (!fs.existsSync(chunkDir(uploadId))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Upload not found' }));
    }
    saveChunk(uploadId, index, data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, index }));
  }

  // POST /paste/:id/upload/complete — assemble chunks
  const uploadCompleteMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/upload\/complete$/);
  if (req.method === 'POST' && uploadCompleteMatch) {
    const pasteId = resolveId(uploadCompleteMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    let rawBody;
    try { rawBody = await readBody(req); } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large' }));
    }
    let parsed = {};
    try { parsed = JSON.parse(rawBody); } catch {}
    const { uploadId } = parsed;
    if (!uploadId || !fs.existsSync(chunkDir(uploadId))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Upload not found' }));
    }
    // Read upload metadata
    let uploadMeta = {};
    try { uploadMeta = JSON.parse(fs.readFileSync(path.join(chunkDir(uploadId), '_meta.json'), 'utf-8')); } catch {}

    const assembled = assembleChunks(uploadId);
    if (assembled === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No chunks found' }));
    }

    if (uploadMeta.target === 'file' && uploadMeta.filename) {
      // Save as session file
      const info = saveSessionFile(pasteId, uploadMeta.filename, assembled, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, file: info }));
    } else {
      // Save as primary markdown content
      const data = loadPaste(pasteId);
      if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
      data.markdown = assembled;
      if (uploadMeta.filename) data.filename = uploadMeta.filename;
      savePaste(pasteId, data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, size: assembled.length }));
    }
  }

  // ── File collections ──────────────────────────────────────────────────────
  // GET    /paste/:id/files              — list files
  // POST   /paste/:id/files              — add a file { name, content, encoding? }
  // GET    /paste/:id/files/:name        — download a file (binary)
  // DELETE /paste/:id/files/:name        — remove a file
  const filesMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/files(?:\/(.+))?$/);
  if (filesMatch) {
    const pasteId = resolveId(filesMatch[1]);
    const fileName = filesMatch[2] ? decodeURIComponent(filesMatch[2]) : null;
    if (!pasteId || !fs.existsSync(metaPath(pasteId))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    if (req.method === 'GET' && !fileName) {
      // List files
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(listSessionFiles(pasteId)));
    }

    if (req.method === 'GET' && fileName) {
      // Serve file (binary)
      const file = getSessionFile(pasteId, fileName);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'file not found' }));
      }
      const content = fs.readFileSync(file.path);
      const etag = `"${crypto.createHash('md5').update(content).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': file.mime,
        'Content-Length': content.length,
        'ETag': etag,
        'Cache-Control': 'no-cache',
      });
      return res.end(content);
    }

    if (req.method === 'POST' && !fileName) {
      // Add file
      let rawBody;
      try { rawBody = await readBody(req); } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }
      let parsed;
      try { parsed = JSON.parse(rawBody); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      if (!parsed.name || !parsed.content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing name or content' }));
      }
      try {
        const info = saveSessionFile(pasteId, parsed.name, parsed.content, parsed.encoding || 'utf-8');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(info));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (req.method === 'DELETE' && fileName) {
      if (deleteSessionFile(pasteId, fileName)) {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'file not found' }));
    }
  }

  // GET /github?url=<github-url> — fetch file from GitHub
  if (req.method === 'GET' && req.url.startsWith('/github?')) {
    const params = new URL(req.url, `http://${req.headers.host}`);
    const ghUrl = params.searchParams.get('url');

    if (!ghUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
    }

    // Parse github.com blob URLs → raw URL
    // Supports: github.com/{owner}/{repo}/blob/{ref}/{path}
    //           raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
    let rawUrl = null;
    let filename = null;

    const blobMatch = ghUrl.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/
    );
    const rawMatch = ghUrl.match(
      /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
    );

    if (blobMatch) {
      const [, owner, repo, ref, filePath] = blobMatch;
      rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
      filename = filePath.split('/').pop();
    } else if (rawMatch) {
      rawUrl = ghUrl;
      filename = rawMatch[4].split('/').pop();
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not a recognized GitHub file URL' }));
    }

    const token = process.env.GITHUB_TOKEN || '';
    const headers = { 'User-Agent': 'md-review-paste-service' };
    if (token) headers['Authorization'] = `token ${token}`;

    const https = require('https');
    https.get(rawUrl, { headers }, (ghRes) => {
      if (ghRes.statusCode === 404) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'File not found on GitHub' }));
      }
      if (ghRes.statusCode < 200 || ghRes.statusCode >= 300) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `GitHub returned ${ghRes.statusCode}` }));
      }

      let body = '';
      ghRes.on('data', (chunk) => { body += chunk; });
      ghRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: body, filename }));
      });
    }).on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch from GitHub' }));
    });

    return;
  }

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

    siteIndex[id] = {
      slug,
      name: parsed.name,
      created_at: new Date().toISOString(),
      expires_at,
      file_count: fileCount,
      spa: parsed.spa !== false, // default true — SPA fallback to index.html
    };
    if (slug) {
      slugIndex[slug] = id;
      saveSlugIndex();
    }
    saveSiteIndex();

    const result = { id, url: `/site/${slug || id}/` };
    if (slug) result.slug = slug;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // GET /site/list — list all hosted sites
  if (req.method === 'GET' && req.url === '/site/list') {
    const results = [];
    for (const [id, meta] of Object.entries(siteIndex)) {
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
    const meta = siteIndex[siteId];
    // Remove slug from slugIndex
    if (meta && meta.slug && slugIndex[meta.slug]) {
      delete slugIndex[meta.slug];
      saveSlugIndex();
    }
    // Remove files
    const siteDir = path.join(SITES_DIR, siteId);
    try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch {}
    delete siteIndex[siteId];
    saveSiteIndex();

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
    const meta = siteIndex[siteId];
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

  // GET / — health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // ── Root-level asset fallback for hosted sites ───────────────────────────
  // React/Vite builds use absolute paths like /assets/index-abc.js.
  // When a site is hosted at /site/<slug>/, the browser requests /assets/...
  // instead of /site/<slug>/assets/... — resolve it here.
  if (req.method === 'GET') {
    const reqPath = decodeURIComponent(req.url.split('?')[0]);

    // Try Referer header first — most reliable since the browser sends it
    const referer = req.headers['referer'] || '';
    const refMatch = referer.match(/\/site\/([a-zA-Z0-9][a-zA-Z0-9-]*)/);
    if (refMatch) {
      const siteId = resolveSiteId(refMatch[1]);
      if (siteId) {
        const candidate = path.resolve(path.join(SITES_DIR, siteId), '.' + reqPath);
        if (candidate.startsWith(path.join(SITES_DIR, siteId)) && fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
          const mime = getMime(candidate);
          const content = fs.readFileSync(candidate);
          const etag = `"${crypto.createHash('md5').update(content).digest('hex')}"`;
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
          const cacheControl = mime === 'text/html' ? 'no-cache' : 'public, max-age=31536000, immutable';
          res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length, 'ETag': etag, 'Cache-Control': cacheControl });
          return res.end(content);
        }
      }
    }

    // Fallback: scan all sites for the file
    for (const [id, meta] of Object.entries(siteIndex)) {
      if (meta.expires_at && new Date(meta.expires_at) < new Date()) continue;
      const candidate = path.resolve(path.join(SITES_DIR, id), '.' + reqPath);
      if (candidate.startsWith(path.join(SITES_DIR, id)) && fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
        const mime = getMime(candidate);
        const content = fs.readFileSync(candidate);
        const etag = `"${crypto.createHash('md5').update(content).digest('hex')}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
        const cacheControl = mime === 'text/html' ? 'no-cache' : 'public, max-age=31536000, immutable';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length, 'ETag': etag, 'Cache-Control': cacheControl });
        return res.end(content);
      }
    }
  }

  res.writeHead(404);
  res.end();
}

// One bad request (or one corrupt file on disk) must never take the service
// down for everyone: every handler failure becomes a JSON error response.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : 'Internal server error';
    if (status >= 500) console.error(`[md-review] ${req.method} ${req.url} failed:`, err);
    try {
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      } else {
        res.end();
      }
    } catch { /* socket already gone */ }
  });
});

// Last line of defence: log stray failures instead of exiting. Everything
// request-scoped is already caught above; these cover fire-and-forget work.
process.on('unhandledRejection', (reason) => {
  console.error('[md-review] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[md-review] uncaught exception:', err);
});

server.listen(PORT, () => {
  console.log(`Paste service running on http://0.0.0.0:${PORT}`);
});
