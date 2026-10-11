#!/usr/bin/env node
// Migrate a JSON-file md-review data dir into the SQLite database (item #20).
//
//   node server/scripts/migrate-json-to-sqlite.mjs --data-dir <dir> [--db <path>] [--dry-run] [--report <file.json>]
//
// - Reads the JSON layout read-only: nothing under --data-dir is written,
//   renamed or deleted except the DB file itself (default <dir>/md-review.sqlite).
// - --dry-run migrates into :memory: and runs the same verification; no file is written.
// - Idempotent: a session whose source is unchanged since the last run is left
//   alone and re-verified ("unchanged"); a changed one is replaced ("updated").
// - Every session is verified against its source (content md5 / content_hash,
//   comments + replies, revision hashes + readable blobs, files, slug, meta).
// - Corrupt meta JSON, unreadable gzip or a missing revision blob: the session
//   is reported under `errors` and skipped; the run continues. Exit 0 only when
//   there are no errors at all.
// - Each session is written and verified in one transaction; a verification
//   failure rolls it back. schema_meta gets `migration_started` at the start of
//   a run and `migration_complete` (same timestamp) only when the run had no
//   failures besides reported corrupt sources; the server refuses to boot on a
//   DB whose migration started but did not complete.
//
// PRE-CUTOVER TOOL. Run it while the JSON server is still the live one (as
// often as you like), then stop that server, run it a last time and start the
// SQLite server. After cutover the DB is the source of truth: a re-run reports
// sessions the server has written since as "diverged" and leaves them alone,
// but it cannot tell a session deleted after cutover from a new JSON one, so it
// would re-import it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDb, tx, DB_FILE_NAME, MIGRATION_STARTED, MIGRATION_COMPLETE } = require('../db.cjs');
const rows = require('../session-rows.cjs');
const { getMime } = require('../http-util.cjs');

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
    if (a === '--data-dir') out.dataDir = val();
    else if (a === '--db') out.db = val();
    else if (a === '--report') out.report = val();
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument: ${a}`);
  }
  if (!out.dataDir) usage('--data-dir is required');
  return out;
}
function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node server/scripts/migrate-json-to-sqlite.mjs --data-dir <dir> [--db <path>] [--dry-run] [--report <file.json>]');
  process.exit(msg ? 2 : 0);
}

// ── helpers ─────────────────────────────────────────────────────────────────

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

class SourceError extends Error {}
class VerifyFailed extends Error {}

/** Every file under files/<id>/ (relative names, '/' separated), like the old server's walk. */
function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d, prefix) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), rel);
      else {
        const st = fs.statSync(path.join(d, ent.name));
        out.push({ name: rel, size: st.size, type: getMime(ent.name), mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Read one session from the JSON layout. Throws SourceError for anything that
 * makes the session unmigratable (corrupt meta, unreadable gzip, missing or
 * unreadable revision blob).
 */
function readSource(dataDir, id) {
  const metaFile = path.join(dataDir, `${id}.json`);
  const metaBytes = fs.readFileSync(metaFile);
  let meta;
  try { meta = JSON.parse(metaBytes.toString('utf-8')); }
  catch (e) { throw new SourceError(`corrupt meta JSON: ${e.message}`); }
  if (!isObj(meta)) throw new SourceError('meta JSON is not an object');

  const sig = crypto.createHash('sha256').update(metaBytes);
  let markdown; let hashless; let contentFileHash = null;
  const contentFile = path.join(dataDir, `${id}.content.gz`);
  const hasContentFile = fs.existsSync(contentFile);
  if (meta.markdown !== undefined) {
    // legacy inline content (the old server split it out on first read)
    if (typeof meta.markdown !== 'string') throw new SourceError('inline markdown is not a string');
    markdown = meta.markdown;
    hashless = false;
  } else if (hasContentFile) {
    const gz = fs.readFileSync(contentFile);
    sig.update('\0content\0').update(gz);
    try { markdown = zlib.gunzipSync(gz).toString('utf-8'); }
    catch (e) { throw new SourceError(`unreadable content gzip: ${e.message}`); }
    contentFileHash = md5(Buffer.from(markdown, 'utf-8'));
    hashless = !meta.content_hash;
  } else {
    markdown = '';
    // no content file: the old server served '' and never seeded history from it
    hashless = !meta.content_hash;
  }

  let revisions = [];
  if (meta.revisions !== undefined) {
    if (!Array.isArray(meta.revisions)) throw new SourceError('revisions is not an array');
    revisions = meta.revisions.map((r, i) => {
      if (!isObj(r) || typeof r.hash !== 'string') throw new SourceError(`revision #${i} has no hash`);
      const blobFile = path.join(dataDir, 'revisions', id, `${r.hash}.gz`);
      if (!fs.existsSync(blobFile)) throw new SourceError(`revision blob missing: revisions/${id}/${r.hash}.gz`);
      const blob = fs.readFileSync(blobFile);
      let text;
      try { text = zlib.gunzipSync(blob); }
      catch (e) { throw new SourceError(`unreadable revision blob ${r.hash}: ${e.message}`); }
      if (md5(text) !== r.hash) throw new SourceError(`revision blob ${r.hash} does not match its hash`);
      sig.update(`\0rev\0${r.hash}\0`).update(blob);
      return { entry: r, blob };
    });
  }

  const files = walkFiles(path.join(dataDir, 'files', id));
  for (const f of files) sig.update(`\0file\0${f.name}\0${f.size}\0${f.mtimeMs}`);

  const cleanMeta = { ...meta };
  delete cleanMeta.markdown;
  delete cleanMeta.revisions;
  delete cleanMeta.content_hash;
  for (const k of rows.COLUMN_OWNED) delete cleanMeta[k]; // never stored (server-managed columns)
  return {
    id, meta, cleanMeta, markdown, hashless, contentFileHash, revisions, files,
    contentHash: meta.markdown !== undefined ? md5(Buffer.from(markdown, 'utf-8')) : (meta.content_hash || null),
    sig: sig.digest('hex'),
  };
}

// ── write ───────────────────────────────────────────────────────────────────

/** Insert a session from its source (rows exactly as the server writes them). */
function insertSession(db, src, slugIndex) {
  const { id, cleanMeta, markdown, hashless, revisions, files } = src;
  const slugOwned = (s) => slugIndex[s] === id
    && !db.prepare('SELECT 1 FROM sessions WHERE slug = ? AND id <> ?').get(s, id);
  rows.upsertSessionRow(db, id, cleanMeta, { mode: cleanMeta.mode, slugOwned, sourceSig: src.sig });
  db.prepare('INSERT INTO contents (session_id, markdown, content_hash, hashless) VALUES (?, ?, ?, ?)')
    .run(id, markdown, md5(Buffer.from(markdown, 'utf-8')), hashless ? 1 : 0);
  revisions.forEach(({ entry, blob }, i) => rows.insertRevision(db, id, i + 1, entry, blob));
  const replies = rows.syncComments(db, id, cleanMeta.comments) || 0;
  const insF = db.prepare('INSERT INTO files (session_id, name, size, type, updated_at) VALUES (?, ?, ?, ?, ?)');
  for (const f of files) insF.run(id, f.name, f.size, f.type, new Date(f.mtimeMs).toISOString());
  rows.syncSearchRow(db, id, cleanMeta, markdown);
  rows.refreshUpdatedAt(db, id);
  return { replies };
}

function deleteSessionRows(db, id) {
  rows.deleteSearchRow(db, id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ── verify ──────────────────────────────────────────────────────────────────

const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Compare the DB rows of one session with its source. Returns { checks, failures }. */
function verifySession(db, src, slugIndex) {
  const { id } = src;
  const failures = [];
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = ok; if (!ok) failures.push(`${name}: ${detail}`); };

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) { check('session', false, 'no sessions row'); return { checks, failures }; }
  const content = db.prepare('SELECT * FROM contents WHERE session_id = ?').get(id);

  const srcMd5 = md5(Buffer.from(src.markdown, 'utf-8'));
  const dbMd5 = content ? md5(Buffer.from(content.markdown, 'utf-8')) : null;
  check('content', !!content && dbMd5 === srcMd5 && content.content_hash === srcMd5
    && (!src.contentHash || src.contentHash === srcMd5),
  `db md5 ${dbMd5}, source md5 ${srcMd5}${src.contentHash ? `, source content_hash ${src.contentHash}` : ''}`);

  const dbComments = rows.readComments(db, id);
  const srcComments = Array.isArray(src.cleanMeta.comments) ? src.cleanMeta.comments : [];
  const replyCounts = (cs) => cs.map((c) => (isObj(c) && Array.isArray(c.replies) ? c.replies.length : -1));
  check('comments', dbComments.length === srcComments.length && same(replyCounts(dbComments), replyCounts(srcComments)) && same(dbComments, srcComments),
    `db ${dbComments.length} comments / replies ${JSON.stringify(replyCounts(dbComments))}, source ${srcComments.length} / ${JSON.stringify(replyCounts(srcComments))}`);

  const revRows = db.prepare('SELECT * FROM revisions WHERE session_id = ? ORDER BY seq').all(id);
  const dbHashes = revRows.map((r) => r.hash);
  const srcHashes = src.revisions.map((r) => r.entry.hash);
  let blobsOk = true;
  for (const r of revRows) {
    try { if (md5(zlib.gunzipSync(Buffer.from(r.blob))) !== r.hash) blobsOk = false; } catch { blobsOk = false; }
  }
  const entriesSame = same(revRows.map(rows.decodeRevision), src.revisions.map((r) => r.entry));
  check('revisions', same(dbHashes, srcHashes) && blobsOk && entriesSame,
    `db ${dbHashes.length} [${dbHashes.join(',')}], source ${srcHashes.length} [${srcHashes.join(',')}]${blobsOk ? '' : ', unreadable blob'}${entriesSame ? '' : ', entries differ'}`);

  const dbFiles = db.prepare('SELECT name, size FROM files WHERE session_id = ? ORDER BY name').all(id).map((f) => [f.name, f.size]);
  const srcFiles = src.files.map((f) => [f.name, f.size]);
  check('files', same(dbFiles, srcFiles), `db ${JSON.stringify(dbFiles)}, disk ${JSON.stringify(srcFiles)}`);

  // every slug the old index gave this session resolves to it; meta.slug resolves as before
  const resolve = (s) => db.prepare('SELECT target_id FROM slugs WHERE slug = ?').get(s)?.target_id ?? null;
  const owned = Object.entries(slugIndex).filter(([, t]) => t === id).map(([s]) => s);
  const metaSlug = typeof src.cleanMeta.slug === 'string' ? src.cleanMeta.slug : null;
  const slugOk = owned.every((s) => resolve(s) === id) && (!metaSlug || resolve(metaSlug) === (slugIndex[metaSlug] ?? null));
  check('slug', slugOk, `slug ${metaSlug} → ${metaSlug ? resolve(metaSlug) : '-'}, index ${metaSlug ? slugIndex[metaSlug] : '-'}`);

  // meta round-trip (mode normalised per 00 §1.4; the old server split inline markdown into content_hash)
  const decoded = rows.decodeMeta(row, content);
  if (!Object.hasOwn(decoded, 'comments')) decoded.comments = dbComments;
  const want = { ...src.cleanMeta, mode: rows.validMode(src.cleanMeta.mode) || 'review' };
  if (!src.hashless) want.content_hash = srcMd5;
  if (!Object.hasOwn(want, 'comments')) want.comments = [];
  const got = { ...decoded };
  if (src.hashless) delete got.content_hash;
  check('meta', same(got, want), 'decoded meta differs from the source meta');
  return { checks, failures };
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args.dataDir);
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) usage(`not a directory: ${dataDir}`);
  const dbPath = args.dryRun ? ':memory:' : path.resolve(args.db || path.join(dataDir, DB_FILE_NAME));

  const readIndex = (name) => {
    const p = path.join(dataDir, name);
    if (!fs.existsSync(p)) return {};
    try { const v = readJson(p); return isObj(v) ? v : {}; }
    catch (e) { throw new Error(`${name} is not valid JSON (${e.message}); fix or remove it and re-run`); }
  };
  const slugIndex = readIndex('_slug-index.json');
  const siteIndex = readIndex('_site-index.json');

  const db = openDb(dbPath);
  const runId = new Date().toISOString();
  const setMeta = db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (!args.dryRun) setMeta.run(MIGRATION_STARTED, runId);
  let fatal = 0; // failures other than reported corrupt sources
  const totals = { sessions: 0, migrated: 0, updated: 0, unchanged: 0, diverged: 0, errors: 0, revisions: 0, comments: 0, replies: 0, files: 0, sites: 0, slugs: 0 };
  const sessions = [];
  const errors = [];
  const fail = (id, error) => { errors.push({ id, error }); console.log(`FAIL ${id}: ${error}`); };

  // site index → sites; slug index → slugs (one namespace for sessions and sites).
  // First, so each session's slug check resolves through the table.
  tx(db, () => {
    const upSite = db.prepare(`INSERT INTO sites (id, slug, name, created_at, expires_at, file_count, spa, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, created_at = excluded.created_at,
                               expires_at = excluded.expires_at, file_count = excluded.file_count, spa = excluded.spa, meta_json = excluded.meta_json`);
    const str = (v) => (typeof v === 'string' ? v : null);
    for (const [id, meta] of Object.entries(siteIndex)) {
      if (!isObj(meta)) { fail(id, 'site index entry is not an object'); totals.errors++; continue; }
      upSite.run(id, str(meta.slug), str(meta.name), str(meta.created_at), str(meta.expires_at),
        Number.isInteger(meta.file_count) ? meta.file_count : null, meta.spa === undefined ? null : (meta.spa ? 1 : 0), JSON.stringify(meta));
      totals.sites++;
    }
    const upSlug = db.prepare(`INSERT INTO slugs (slug, kind, target_id) VALUES (?, ?, ?)
                               ON CONFLICT(slug) DO UPDATE SET kind = excluded.kind, target_id = excluded.target_id`);
    for (const [slug, target] of Object.entries(slugIndex)) {
      if (typeof target !== 'string') { fail(slug, 'slug index target is not a string'); totals.errors++; continue; }
      const isSession = fs.existsSync(path.join(dataDir, `${target}.json`));
      const isSite = !isSession && (Object.hasOwn(siteIndex, target) || fs.existsSync(path.join(dataDir, 'sites', target)));
      upSlug.run(slug, isSite ? 'site' : 'session', target);
      totals.slugs++;
    }
  });
  const ids = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.slice(0, -5)).sort();
  for (const id of ids) {
    totals.sessions++;
    let src;
    try { src = readSource(dataDir, id); }
    catch (e) {
      if (!(e instanceof SourceError)) throw e;
      totals.errors++;
      sessions.push({ id, status: 'error', checks: {} });
      fail(id, e.message);
      continue;
    }
    const existing = db.prepare('SELECT source_sig, version FROM sessions WHERE id = ?').get(id);
    if (existing && (existing.source_sig === null || existing.version > 1)) {
      // written by the server since it was migrated (or created by it): the DB wins
      totals.diverged++;
      sessions.push({ id, status: 'diverged', checks: {} });
      console.log(`diverged ${id}: changed in the database since migration — left as is`);
      continue;
    }
    let status;
    let result;
    if (existing && existing.source_sig === src.sig) {
      status = 'unchanged';
      result = verifySession(db, src, slugIndex);
    } else {
      status = existing ? 'updated' : 'migrated';
      try {
        tx(db, () => {
          if (existing) deleteSessionRows(db, id);
          insertSession(db, src, slugIndex);
          result = verifySession(db, src, slugIndex);
          if (result.failures.length) throw new VerifyFailed();
        });
      } catch (e) {
        if (!(e instanceof VerifyFailed)) throw e; // rolled back either way
      }
    }
    const { checks, failures } = result;
    if (failures.length) {
      totals.errors++; fatal++;
      sessions.push({ id, status: 'failed', checks, failures });
      fail(id, `verification failed${status === 'unchanged' ? '' : ', rolled back'} (${failures.join('; ')})`);
      continue;
    }
    totals[status]++;
    totals.revisions += src.revisions.length;
    const cs = Array.isArray(src.cleanMeta.comments) ? src.cleanMeta.comments : [];
    totals.comments += cs.length;
    totals.replies += cs.reduce((n, c) => n + (isObj(c) && Array.isArray(c.replies) ? c.replies.length : 0), 0);
    totals.files += src.files.length;
    sessions.push({ id, status, checks });
  }

  if (!args.dryRun && fatal === 0) setMeta.run(MIGRATION_COMPLETE, runId);
  const siteRows = db.prepare('SELECT count(*) AS c FROM sites').get().c;
  const slugRows = db.prepare('SELECT count(*) AS c FROM slugs').get().c;
  db.close();

  const summary = `sessions: ${totals.migrated} migrated, ${totals.updated} updated, ${totals.unchanged} unchanged, ${totals.errors} errors, `
    + `${totals.diverged} diverged; `
    + `revisions: ${totals.revisions}; comments: ${totals.comments} (+${totals.replies} replies); files: ${totals.files}; `
    + `sites: ${totals.sites} (${siteRows} in db); slugs: ${totals.slugs} (${slugRows} in db)`;
  console.log(`${args.dryRun ? '[dry run] ' : ''}${dataDir} → ${dbPath}`);
  console.log(summary);
  if (!args.dryRun) console.log(fatal === 0 ? `migration complete (${MIGRATION_COMPLETE}=${runId})` : `migration NOT complete: ${fatal} failure(s) — the server will not start on this DB until a clean run`);
  if (args.report) {
    fs.writeFileSync(args.report, `${JSON.stringify({ data_dir: dataDir, db: dbPath, dry_run: args.dryRun, complete: !args.dryRun && fatal === 0, summary, totals, sessions, errors }, null, 1)}\n`);
  }
  return errors.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`migration aborted: ${e.message}`);
  process.exitCode = 3;
}
