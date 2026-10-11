'use strict';
// HTTP plumbing shared by the route modules: body readers, errors, MIME types.
const path = require('path');
const { MAX_BODY_BYTES } = require('./config.cjs');

/** Returned by a route handler that did not handle the request (try the next route). */
const NEXT = Symbol('next-route');

// An error the request wrapper turns into a JSON response instead of a crash.
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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

/** Which client wrote: the UI and the MCP server identify themselves; anything else is 'api'. */
function clientOf(req) {
  const c = req.headers['x-mdreview-client'];
  return c === 'ui' || c === 'mcp' ? c : 'api';
}

module.exports = { NEXT, HttpError, MIME_TYPES, getMime, readBodyRaw, readBody, readJsonBody, fireWebhook, clientOf };
