'use strict';
// Server configuration (env-driven). Shared by server.cjs and the route modules.
const path = require('path');

const PORT = parseInt(process.env.PORT || '3100', 10);
// DATA_DIR is overridable so tests can run against a throwaway directory.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SITES_DIR = path.join(DATA_DIR, 'sites');
const FILES_DIR = path.join(DATA_DIR, 'files');  // per-session file collections
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks'); // temp chunked upload staging
const REVISIONS_DIR = path.join(DATA_DIR, 'revisions'); // per-session content history (content-addressed)
// Revision history: every content change is kept, except that consecutive
// writes by the same author/client within REVISION_COALESCE_MS fold into one
// revision (an "editing session"), and at most REVISIONS_MAX are retained.
const REVISIONS_MAX = parseInt(process.env.REVISIONS_MAX || '100', 10);
const REVISION_COALESCE_MS = parseInt(process.env.REVISION_COALESCE_MS || String(5 * 60 * 1000), 10);
const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB (raised from 10 MB)
const MAX_SITE_BYTES = 50 * 1024 * 1024; // 50 MB for site uploads

module.exports = { PORT, DATA_DIR, SITES_DIR, FILES_DIR, CHUNKS_DIR, REVISIONS_DIR, REVISIONS_MAX, REVISION_COALESCE_MS, MAX_BODY_BYTES, MAX_SITE_BYTES };
