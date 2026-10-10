'use strict';
// Server configuration (env-driven). Shared by server.cjs and the route modules.
const path = require('path');

const PORT = parseInt(process.env.PORT || '3100', 10);
// DATA_DIR is overridable so tests can run against a throwaway directory.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SITES_DIR = path.join(DATA_DIR, 'sites');
const FILES_DIR = path.join(DATA_DIR, 'files');  // per-session file collections
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks'); // temp chunked upload staging
// The SQLite database (sessions, content, revisions, comments, slugs, sites,
// search index). Session files and hosted-site files stay on disk above.
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'md-review.sqlite');
// Boot with an empty DB even though DATA_DIR still holds legacy JSON sessions.
const ALLOW_EMPTY_DB = process.env.ALLOW_EMPTY_DB === '1';
// Revision history: every content change is kept, except that consecutive
// writes by the same author/client within REVISION_COALESCE_MS fold into one
// revision (an "editing session"), and at most REVISIONS_MAX are retained.
const REVISIONS_MAX = parseInt(process.env.REVISIONS_MAX || '100', 10);
const REVISION_COALESCE_MS = parseInt(process.env.REVISION_COALESCE_MS || String(5 * 60 * 1000), 10);
const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB (raised from 10 MB)
const MAX_SITE_BYTES = 50 * 1024 * 1024; // 50 MB for site uploads
// Rendered /d/:x/cover.png images (#22), one file per doc: {id}-{cover_key}.png.
const COVERS_DIR = path.join(DATA_DIR, 'covers');
// Links (#22, 00 §6): the SPA lives at FRONTEND_URL; PUBLIC_BASE_URL is this
// backend's externally reachable origin (the /d/ meta pages and covers).
// Trailing slashes are ignored. Handed-out links use PUBLIC_BASE_URL only when
// it is set explicitly — the localhost default is for the meta page's own tags.
const trimSlash = (s) => String(s).replace(/\/+$/, '');
const FRONTEND_URL = trimSlash(process.env.FRONTEND_URL || 'https://kartikeyam1.github.io/md-review');
const PUBLIC_BASE_URL_SET = !!process.env.PUBLIC_BASE_URL;
const PUBLIC_BASE_URL = trimSlash(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`);

module.exports = { PORT, DATA_DIR, SITES_DIR, FILES_DIR, CHUNKS_DIR, DB_PATH, ALLOW_EMPTY_DB, REVISIONS_MAX, REVISION_COALESCE_MS, MAX_BODY_BYTES, MAX_SITE_BYTES,
  COVERS_DIR, FRONTEND_URL, PUBLIC_BASE_URL, PUBLIC_BASE_URL_SET };
