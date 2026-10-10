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

const { PORT, DATA_DIR, DB_PATH, ALLOW_EMPTY_DB } = require('./config.cjs');
const { NEXT, HttpError } = require('./http-util.cjs');

// Boot safety: never serve an empty DB over an un-migrated JSON data dir (that
// would 404 every shared link). Checked before anything is created on disk.
const bootError = require('./db.cjs').bootCheck({ dataDir: DATA_DIR, dbPath: DB_PATH, allowEmpty: ALLOW_EMPTY_DB });
if (bootError) {
  console.error(bootError);
  process.exit(1);
}
require('./storage.cjs'); // opens the DB; creates DATA_DIR and its subdirectories

// ── Route table ──────────────────────────────────────────────────────────────
// Tried in order; a handler returns NEXT when the request is not its own. The
// order is significant (e.g. /paste/list before GET /paste/:id, the hosted-site
// asset fallback last). A later server item adds one module and one line here.
const ROUTES = [
  require('./routes/paste-create.cjs'),
  require('./routes/edit-tokens.cjs'),
  require('./routes/comments.cjs'),
  require('./routes/approval.cjs'),
  require('./routes/markdown.cjs'),
  require('./routes/revisions.cjs'),
  require('./routes/list.cjs'),
  require('./routes/library-docs.cjs'),
  require('./routes/session.cjs'),
  require('./routes/uploads.cjs'),
  require('./routes/files.cjs'),
  require('./routes/github.cjs'),
  require('./routes/sites.cjs'),
  require('./routes/health.cjs'),
  require('./routes/meta.cjs'),
  require('./routes/site-assets.cjs'),
];

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 00 §9: the full shared header list (PATCH is for #26/#27).
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match, If-Match, X-MdReview-Client, Authorization, X-Edit-Token, X-MdReview-Reader');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, X-Agent-Sections');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  for (const route of ROUTES) {
    if ((await route(req, res)) !== NEXT) return;
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
