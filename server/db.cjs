'use strict';
// SQLite database (node:sqlite DatabaseSync): open, pragmas, schema migrations,
// transactions, and the boot-time safety check. Shared by the server and
// server/scripts/migrate-json-to-sqlite.mjs.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE_NAME = 'md-review.sqlite';
const SCHEMA_VERSION = 1;
const MIGRATE_SCRIPT = 'server/scripts/migrate-json-to-sqlite.mjs';

// Forward migrations, keyed by the schema_version they produce. Each runs in
// one transaction together with the schema_version bump.
const MIGRATIONS = {
  1: `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      session_name TEXT,
      filename TEXT,
      content_type TEXT,
      approval_status TEXT,
      approved_by TEXT,
      approved_at TEXT,
      shared_at TEXT,
      expires_at TEXT,
      callback_url TEXT,
      mode TEXT NOT NULL DEFAULT 'review' CHECK (mode IN ('publish', 'review')),
      upsert_key TEXT UNIQUE,
      edit_token_hash TEXT,
      created_by TEXT,
      from_template_json TEXT,
      extra_json TEXT NOT NULL DEFAULT '{}',   -- every other meta key, verbatim
      version INTEGER NOT NULL DEFAULT 1,       -- +1 on every write
      created_at TEXT,
      updated_at TEXT,                          -- latest revision (at_end || at), else shared_at
      title TEXT,                               -- server docTitle (00 §5)
      fts_rowid INTEGER,                        -- the session's doc_fts row
      comments_sig TEXT,                        -- fingerprint of the comment list last written
      source_sig TEXT                           -- migration: fingerprint of the JSON source
    );
    CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at);
    CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions(created_at);

    CREATE TABLE IF NOT EXISTS contents (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      markdown TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      hashless INTEGER NOT NULL DEFAULT 0       -- 1: legacy session that never stored a content hash
    );

    CREATE TABLE IF NOT EXISTS revisions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      hash TEXT NOT NULL,
      at TEXT,
      at_end TEXT,
      by TEXT,
      client TEXT,
      size INTEGER,
      parent TEXT,
      writes INTEGER,
      seeded INTEGER,
      note TEXT,
      blob BLOB,                                -- gzip of the revision's content
      extra_json TEXT,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS revisions_hash ON revisions(session_id, hash);

    CREATE TABLE IF NOT EXISTS comments (
      pk INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      id TEXT,
      data_json TEXT NOT NULL,                  -- the comment without its replies
      has_replies INTEGER NOT NULL DEFAULT 0,   -- 1: the comment had a replies array (maybe empty)
      must_fix_open INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS comments_session ON comments(session_id, ord);

    CREATE TABLE IF NOT EXISTS replies (
      pk INTEGER PRIMARY KEY,
      comment_pk INTEGER NOT NULL REFERENCES comments(pk) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      id TEXT,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS replies_comment ON replies(comment_pk, ord);

    CREATE TABLE IF NOT EXISTS files (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      type TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (session_id, name)
    );

    CREATE TABLE IF NOT EXISTS slugs (
      slug TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('session', 'site')),
      target_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      slug TEXT,
      name TEXT,
      created_at TEXT,
      expires_at TEXT,
      file_count INTEGER,
      spa INTEGER,
      meta_json TEXT NOT NULL                   -- the site-index entry, verbatim
    );
    CREATE INDEX IF NOT EXISTS sites_slug ON sites(slug);

    -- Created now for later items; their columns are owned by those specs.
    CREATE TABLE IF NOT EXISTS reactions (           -- #24 rule 3 (section '' = the whole doc)
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      section TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL,
      reader_id TEXT NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, section, code, reader_id)
    );
    CREATE TABLE IF NOT EXISTS views (               -- #25 rule 1 (one row per reader per doc per UTC day)
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      reader_id TEXT NOT NULL,
      day TEXT NOT NULL,                        -- YYYY-MM-DD (UTC)
      name TEXT,
      revision TEXT,
      first_viewed_at TEXT NOT NULL,
      last_viewed_at TEXT NOT NULL,
      is_editor INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, reader_id, day)
    );
    CREATE TABLE IF NOT EXISTS collections (         -- #26
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS collection_items (    -- #26 (a doc is in at most one collection)
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      added_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tags (                -- #26
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE IF NOT EXISTS session_tags (        -- #26
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (session_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS pins (                -- #26
      reader_key TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      pinned_at TEXT,
      PRIMARY KEY (reader_key, session_id)
    );
    CREATE TABLE IF NOT EXISTS templates (           -- #27
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    -- Search index (00 §8): one row per session (file_name = ''); #26 adds document files.
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
      title, filename, content, session_id UNINDEXED, file_name UNINDEXED,
      tokenize='unicode61 remove_diacritics 2', prefix='2 3'
    );
  `,
};

/** Run `fn` inside one BEGIN IMMEDIATE … COMMIT (joins an open transaction). */
function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
  const current = row ? parseInt(row.value, 10) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema_version ${current} is newer than this server (${SCHEMA_VERSION})`);
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(v));
    });
  }
}

/** Open (creating if needed) a database, set the pragmas and bring the schema up to date. */
function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

/** schema_meta keys the migration script writes: started at the beginning of a run, complete at a clean end. */
const MIGRATION_STARTED = 'migration_started';
const MIGRATION_COMPLETE = 'migration_complete';

/** A DB whose migration started but never completed: the run's timestamp, else null. Read-only. */
function incompleteMigration(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const get = (k) => db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(k)?.value ?? null;
    const started = get(MIGRATION_STARTED);
    return started && get(MIGRATION_COMPLETE) !== started ? started : null;
  } catch { return null; } // no schema_meta yet: not a migration DB
  finally { try { db?.close(); } catch { /* not open */ } }
}

/**
 * Boot safety (spec 20 rule 7): with no DB file, a data dir that still holds
 * legacy session JSON must be migrated first — serving an empty DB would 404
 * every shared link. A DB whose migration started but did not complete is
 * refused too. Returns an error message, or null when boot may proceed.
 */
function bootCheck({ dataDir, dbPath, allowEmpty }) {
  if (fs.existsSync(dbPath)) {
    const started = incompleteMigration(dbPath);
    if (!started) return null;
    return `[md-review] the migration into ${dbPath} started at ${started} but did not complete.\n`
      + `Re-run it until it reports no failures:  node ${MIGRATE_SCRIPT} --data-dir ${dataDir}${dbPath === path.join(dataDir, DB_FILE_NAME) ? '' : ` --db ${dbPath}`}`;
  }
  if (allowEmpty) return null;
  let legacy = [];
  try { legacy = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { /* no dir yet */ }
  if (legacy.length === 0) return null;
  return `[md-review] ${dataDir} holds ${legacy.length} legacy JSON session file(s) but no database at ${dbPath}.\n`
    + `Migrate first:  node ${MIGRATE_SCRIPT} --data-dir ${dataDir}${dbPath === path.join(dataDir, DB_FILE_NAME) ? '' : ` --db ${dbPath}`}\n`
    + '(or set ALLOW_EMPTY_DB=1 to start with an empty database; legacy files are never read).';
}

module.exports = { DB_FILE_NAME, SCHEMA_VERSION, MIGRATION_STARTED, MIGRATION_COMPLETE, openDb, tx, bootCheck };
