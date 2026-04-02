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

const PORT = 3100;
const DATA_DIR = path.join(__dirname, 'data');
const SITES_DIR = path.join(DATA_DIR, 'sites');
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_SITE_BYTES = 50 * 1024 * 1024; // 50 MB for site uploads

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SITES_DIR, { recursive: true });

// ── Slug index ───────────────────────────────────────────────────────────────
const SLUG_INDEX_PATH = path.join(DATA_DIR, '_slug-index.json');
let slugIndex = {};
if (fs.existsSync(SLUG_INDEX_PATH)) {
  try { slugIndex = JSON.parse(fs.readFileSync(SLUG_INDEX_PATH, 'utf-8')); } catch { slugIndex = {}; }
}
function saveSlugIndex() {
  fs.writeFileSync(SLUG_INDEX_PATH, JSON.stringify(slugIndex));
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
  if (/^[a-f0-9]+$/.test(idOrSlug)) return idOrSlug;
  return slugIndex[idOrSlug] || null;
}

// ── Site index ───────────────────────────────────────────────────────────────
const SITE_INDEX_PATH = path.join(DATA_DIR, '_site-index.json');
let siteIndex = {};
if (fs.existsSync(SITE_INDEX_PATH)) {
  try { siteIndex = JSON.parse(fs.readFileSync(SITE_INDEX_PATH, 'utf-8')); } catch { siteIndex = {}; }
}
function saveSiteIndex() {
  fs.writeFileSync(SITE_INDEX_PATH, JSON.stringify(siteIndex));
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
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Payload too large'));
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function loadPaste(id) {
  const file = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function savePaste(id, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify(data));
}

// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
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

    let body = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large (max 10 MB)' }));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (res.writableEnded) return;

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
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

      fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify(parsed));
      const result = { id };
      if (slug) result.slug = slug;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });

    return;
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
      let rawBody;
      try { rawBody = await readBody(req); }
      catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }

      let parsed;
      try { parsed = JSON.parse(rawBody); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

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

      let rawBody;
      try { rawBody = await readBody(req); }
      catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }

      let parsed;
      try { parsed = JSON.parse(rawBody); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
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
      let rawBody;
      try { rawBody = await readBody(req); }
      catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }
      let parsed = {};
      try { parsed = JSON.parse(rawBody); } catch { /* optional body */ }

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
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (!data.comments) data.comments = [];

    if (req.method === 'POST' && !commentId) {
      let rawBody;
      try { rawBody = await readBody(req); }
      catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }

      let parsed;
      try { parsed = JSON.parse(rawBody); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

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

      let rawBody;
      try { rawBody = await readBody(req); }
      catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }

      let parsed;
      try { parsed = JSON.parse(rawBody); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
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
    let rawBody;
    try { rawBody = await readBody(req); }
    catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large' }));
    }
    let parsed;
    try { parsed = JSON.parse(rawBody); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

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

  // PUT /paste/:id/markdown — update markdown (and optionally filename)
  const markdownPutMatch = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/markdown$/);
  if (req.method === 'PUT' && markdownPutMatch) {
    const pasteId = resolveId(markdownPutMatch[1]);
    if (!pasteId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const data = loadPaste(pasteId);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    let rawBody;
    try { rawBody = await readBody(req); }
    catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large' }));
    }

    let parsed;
    try { parsed = JSON.parse(rawBody); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    if (parsed.markdown !== undefined) data.markdown = parsed.markdown;
    if (parsed.filename !== undefined) data.filename = parsed.filename;
    savePaste(pasteId, data);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // GET /paste/list — list sessions (optionally filtered by status)
  if (req.method === 'GET' && req.url.startsWith('/paste/list')) {
    const params = new URL(req.url, `http://${req.headers.host}`);
    const statusFilter = params.searchParams.get('status');
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    const results = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
        if (isExpired(data)) continue;
        if (statusFilter && data.approval_status !== statusFilter) continue;
        const id = f.replace('.json', '');
        results.push({
          id,
          slug: data.slug || null,
          sessionName: data.sessionName || null,
          filename: data.filename || null,
          approval_status: data.approval_status || 'pending',
          comment_count: (data.comments || []).length,
          must_fix_unresolved: (data.comments || []).filter(c => c.category === 'must-fix' && c.resolved !== true).length,
          created_at: data.sharedAt || null,
          expires_at: data.expires_at || null,
        });
      } catch { /* skip corrupt files */ }
    }
    results.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(results));
  }

  // GET /paste/:id — read full paste
  // GET /paste/:id/comments — read comments only
  // GET /paste/:id/markdown — read markdown only
  const match = req.url.match(/^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)(\/comments|\/markdown)?$/);
  if (req.method === 'GET' && match) {
    const resolvedId = resolveId(match[1]);
    if (!resolvedId) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    const file = path.join(DATA_DIR, `${resolvedId}.json`);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }

    // ETag: compute MD5 of raw file bytes
    const rawBytes = fs.readFileSync(file);
    const etag = `"${crypto.createHash('md5').update(rawBytes).digest('hex')}"`;

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }

    const data = JSON.parse(rawBytes.toString('utf-8'));

    if (isExpired(data)) {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Session expired' }));
    }

    const sub = match[2];

    let result;
    if (sub === '/comments') {
      result = { filename: data.filename, comments: data.comments || [] };
    } else if (sub === '/markdown') {
      result = { filename: data.filename, markdown: data.markdown || '' };
    } else {
      result = data;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
    res.end(JSON.stringify(result));
    return;
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
});

server.listen(PORT, () => {
  console.log(`Paste service running on http://0.0.0.0:${PORT}`);
});
