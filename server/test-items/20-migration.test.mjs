// Item #20 — migration script server/scripts/migrate-json-to-sqlite.mjs (spec rule 8).
// Replaces the JSON-file pokes in server/test.mjs:535-567 (corrupt meta / gzip)
// and 731-750 (seeding a pre-history session) with fixture-dir migrations.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {
  copyToTmp, tmpDir, cleanupTmp, runMigrate, migrateWithReport, tableCounts, openDbReadOnly, snapshotTree, diffSnapshots,
  startServer, http, LEGACY_FIXTURE, DB_NAME, MIGRATE_SCRIPT,
} from './lib/20-helpers.mjs';

after(cleanupTmp);

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const FIXTURE_IDS = fs.readdirSync(LEGACY_FIXTURE).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.slice(0, -5)).sort();
const SUMMARY_RE = /sessions:\s*(\d+)\s+migrated,\s*(\d+)\s+updated,\s*(\d+)\s+unchanged,\s*(\d+)\s+errors/;
const notDb = (rel) => rel.startsWith(DB_NAME);
const statusById = (report) => Object.fromEntries((report?.sessions || []).map((s) => [s.id, s.status]));

/** Source content of a fixture session as the migration must see it. */
function sourceMarkdown(dir, id) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
  if (meta.markdown !== undefined) return meta.markdown;
  const cp = path.join(dir, `${id}.content.gz`);
  return fs.existsSync(cp) ? zlib.gunzipSync(fs.readFileSync(cp)).toString('utf-8') : '';
}

test('R-20.8 the migration script exists at server/scripts/migrate-json-to-sqlite.mjs', () => {
  assert.ok(fs.existsSync(MIGRATE_SCRIPT), `missing ${MIGRATE_SCRIPT}`);
});

describe('AC-20.4 idempotent migration of the golden fixture', () => {
  test('AC-20.4 run 1 → all migrated, exit 0; run 2 → all unchanged, identical row counts', async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-idem');
    const r1 = migrateWithReport(dir);
    assert.equal(r1.status, 0, `run 1 exit ${r1.status}\n${r1.stdout}\n${r1.stderr}`);
    const s1 = r1.stdout.match(SUMMARY_RE);
    assert.ok(s1, `summary line missing:\n${r1.stdout}`);
    assert.deepEqual(s1.slice(1).map(Number), [FIXTURE_IDS.length, 0, 0, 0]);
    for (const k of ['revisions', 'comments', 'files', 'sites', 'slugs']) assert.match(r1.stdout, new RegExp(k), `summary mentions ${k}`);
    assert.ok(r1.report, '--report JSON written');
    for (const k of ['totals', 'sessions', 'errors']) assert.ok(k in r1.report, `report.${k}`);
    assert.deepEqual(r1.report.errors, []);
    assert.deepEqual(Object.keys(statusById(r1.report)).sort(), FIXTURE_IDS);
    assert.ok(Object.values(statusById(r1.report)).every((s) => s === 'migrated'), JSON.stringify(statusById(r1.report)));
    assert.ok(r1.report.sessions.every((s) => s.checks && typeof s.checks === 'object'), 'every session has checks');
    const counts1 = await tableCounts(path.join(dir, DB_NAME));
    assert.equal(counts1.sessions, FIXTURE_IDS.length);

    const r2 = migrateWithReport(dir);
    assert.equal(r2.status, 0, `run 2 exit ${r2.status}\n${r2.stdout}\n${r2.stderr}`);
    assert.deepEqual(r2.stdout.match(SUMMARY_RE)?.slice(1).map(Number), [0, 0, FIXTURE_IDS.length, 0]);
    assert.ok(Object.values(statusById(r2.report)).every((s) => s === 'unchanged'), JSON.stringify(statusById(r2.report)));
    assert.deepEqual(await tableCounts(path.join(dir, DB_NAME)), counts1, 'row counts identical between runs');
  });

  test('R-20.8 a source session changed since the last run is re-imported and reported as updated', async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-updated');
    assert.equal(runMigrate(['--data-dir', dir]).status, 0);
    // S7: new comment in meta; S8: new content
    const mp = path.join(dir, '0a0a0a0a0a0a.json');
    const meta = JSON.parse(fs.readFileSync(mp, 'utf-8'));
    meta.comments = [{ id: 'added-later', startLine: 1, endLine: 1, selectedText: 'Pre', body: 'added after run 1', category: 'nit' }];
    fs.writeFileSync(mp, JSON.stringify(meta));
    const newMd = '# Cafe notes\n\nChanged after the first migration.\n';
    fs.writeFileSync(path.join(dir, 'cafe00000001.content.gz'), zlib.gzipSync(Buffer.from(newMd)));
    const cm = JSON.parse(fs.readFileSync(path.join(dir, 'cafe00000001.json'), 'utf-8'));
    cm.content_hash = md5(Buffer.from(newMd));
    fs.writeFileSync(path.join(dir, 'cafe00000001.json'), JSON.stringify(cm));

    const r = migrateWithReport(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const st = statusById(r.report);
    assert.equal(st['0a0a0a0a0a0a'], 'updated');
    assert.equal(st.cafe00000001, 'updated');
    assert.deepEqual(Object.entries(st).filter(([id]) => !['0a0a0a0a0a0a', 'cafe00000001'].includes(id)).map(([, s]) => s),
      Array(FIXTURE_IDS.length - 2).fill('unchanged'));
    assert.deepEqual(r.stdout.match(SUMMARY_RE)?.slice(1).map(Number), [0, 2, FIXTURE_IDS.length - 2, 0]);

    const s = await startServer({ dataDir: dir });
    try {
      assert.deepEqual((await http(s.url, 'GET', '/paste/0a0a0a0a0a0a/comments')).json.comments.map((c) => c.id), ['added-later']);
      assert.equal((await http(s.url, 'GET', '/paste/cafe/markdown')).json.markdown, newMd);
      const q = await http(s.url, 'GET', '/library/docs?q=changed');
      assert.ok(q.json.items.some((i) => i.id === 'cafe00000001'), 'FTS row replaced with the new content');
    } finally { await s.stop(); }
  });
});

describe('AC-20.5 dry run and read-only source', () => {
  test('AC-20.5 --dry-run creates no DB, leaves source mtimes/sha256 unchanged, prints the report', () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-dry');
    const before = snapshotTree(dir);
    const r = runMigrate(['--data-dir', dir, '--dry-run']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, SUMMARY_RE, 'report printed');
    assert.deepEqual(r.stdout.match(SUMMARY_RE).slice(1).map(Number), [FIXTURE_IDS.length, 0, 0, 0], 'dry run verifies the same migration');
    assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith(DB_NAME)), 'no DB file (or -wal/-shm) created');
    assert.deepEqual(diffSnapshots(before, snapshotTree(dir)), []);

    const dbElsewhere = path.join(tmpDir('md-review-20-dry-db'), 'x.sqlite');
    const r2 = runMigrate(['--data-dir', dir, '--db', dbElsewhere, '--dry-run']);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.ok(!fs.existsSync(dbElsewhere), '--db target not created on --dry-run');
    assert.deepEqual(diffSnapshots(before, snapshotTree(dir)), []);
  });

  test('R-20.8 a real run writes nothing under --data-dir except the DB file', () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-readonly');
    const before = snapshotTree(dir, { exclude: notDb });
    const r = runMigrate(['--data-dir', dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(dir, DB_NAME)), 'default DB path is DATA_DIR/md-review.sqlite');
    // directory entries' mtimes may change only because the DB file was added to the root
    assert.deepEqual(diffSnapshots(before, snapshotTree(dir, { exclude: notDb })), []);
    // the inline-markdown session is NOT split out on disk by the script
    assert.ok(!fs.existsSync(path.join(dir, 'c3c3c3c3c3c3.content.gz')));
  });

  test('R-20.8 --db puts the DB elsewhere and leaves --data-dir byte-identical', () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-dbflag');
    const before = snapshotTree(dir);
    const db = path.join(tmpDir('md-review-20-dbflag-db'), 'out.sqlite');
    const r = runMigrate(['--data-dir', dir, '--db', db]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(db));
    assert.deepEqual(diffSnapshots(before, snapshotTree(dir)), []);
  });
});

describe('AC-20.6 corrupt sources', () => {
  test('AC-20.6 corrupt meta JSON and unreadable gzip are reported under errors; others migrate; exit ≠ 0', async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-corrupt');
    fs.writeFileSync(path.join(dir, 'deadbeef0001.json'), '{ definitely not json');
    // the live data has exactly this shape: inline markdown with a raw newline (invalid JSON)
    fs.writeFileSync(path.join(dir, 'oldformat12345.json'), '{"markdown":"# Old Format\nInline content","filename":"old.md","approval_status":"pending","comments":[]}');
    fs.writeFileSync(path.join(dir, 'deadbeef0002.json'), JSON.stringify({ filename: 'g.md', approval_status: 'pending', comments: [], sharedAt: '2025-01-01T00:00:00.000Z' }));
    fs.writeFileSync(path.join(dir, 'deadbeef0002.content.gz'), Buffer.from('not gzip at all'));
    const r = migrateWithReport(dir);
    assert.ok(r.signal === null && typeof r.status === 'number', `script must exit normally, not crash (signal ${r.signal})`);
    assert.notEqual(r.status, 0, 'corrupt sources count as failures');
    assert.ok(r.report, '--report still written');
    const errs = JSON.stringify(r.report.errors);
    for (const id of ['deadbeef0001', 'oldformat12345', 'deadbeef0002']) {
      assert.ok(errs.includes(id), `${id} must be listed under errors: ${errs}`);
      assert.match(r.stdout + r.stderr, new RegExp(id), `a per-failure line names ${id}`);
    }
    const st = statusById(r.report);
    for (const id of FIXTURE_IDS) assert.equal(st[id], 'migrated', `${id} still migrates`);
    assert.equal(r.stdout.match(SUMMARY_RE)?.[4], '3', 'summary counts 3 errors');

    const s = await startServer({ dataDir: dir });
    try {
      assert.equal((await http(s.url, 'GET', '/paste/a1a1a1a1a1a1')).status, 200);
      assert.equal((await http(s.url, 'GET', '/paste/deadbeef0001')).status, 404);
      assert.equal((await http(s.url, 'GET', '/paste/deadbeef0002')).status, 404, 'a skipped session is not half-imported');
    } finally { await s.stop(); }
  });

  test('R-20.8 a revision list referencing a missing blob is a reported failure, not a crash', () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-missing-blob');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'f6f6f6f6f6f6.json'), 'utf-8'));
    fs.unlinkSync(path.join(dir, 'revisions', 'f6f6f6f6f6f6', `${meta.revisions[0].hash}.gz`));
    const r = migrateWithReport(dir);
    assert.ok(r.signal === null && typeof r.status === 'number', 'exits normally');
    assert.notEqual(r.status, 0, 'verification failure → non-zero exit');
    assert.match(r.stdout, SUMMARY_RE, 'summary still printed');
    const st = statusById(r.report);
    const reported = JSON.stringify(r.report.errors).includes('f6f6f6f6f6f6') || !['migrated', 'unchanged', 'updated'].includes(st.f6f6f6f6f6f6);
    assert.ok(reported, `f6f6f6f6f6f6 must be reported as failed: status=${st.f6f6f6f6f6f6} errors=${JSON.stringify(r.report.errors)}`);
    for (const id of FIXTURE_IDS.filter((x) => x !== 'f6f6f6f6f6f6')) assert.equal(st[id], 'migrated', id);
  });
});

describe('migrated DB contents (rule 2 / rule 8 verification)', () => {
  let db;
  before(async () => {
    const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-contents');
    const r = runMigrate(['--data-dir', dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    db = await openDbReadOnly(path.join(dir, DB_NAME));
  });
  after(() => db?.close());

  test('R-20.8 contents: markdown md5 equals the source (inline legacy and missing content file included)', () => {
    for (const id of FIXTURE_IDS) {
      const want = sourceMarkdown(LEGACY_FIXTURE, id);
      const row = db.prepare('SELECT markdown, content_hash FROM contents WHERE session_id = ?').get(id);
      assert.ok(row, `contents row for ${id}`);
      assert.equal(row.markdown, want, `${id} markdown`);
      assert.equal(row.content_hash, md5(Buffer.from(want, 'utf-8')), `${id} content_hash`);
    }
  });

  test('R-20.8 sessions: mode per 00 §1.4, extra meta keys kept in extra_json, slugs and sites indexed', () => {
    const mode = (id) => db.prepare('SELECT mode FROM sessions WHERE id = ?').get(id).mode;
    assert.equal(mode('3d3d3d3d3d3d'), 'publish');
    assert.equal(mode('4e4e4e4e4e4e'), 'review');
    assert.equal(mode('a1a1a1a1a1a1'), 'review');
    const extra = JSON.parse(db.prepare('SELECT extra_json FROM sessions WHERE id = ?').get('a1a1a1a1a1a1').extra_json);
    assert.deepEqual(extra.custom_extra, { nested: [1, 'two', { three: 3 }], flag: false });
    assert.deepEqual(extra.legacy_labels, ['ops', 'routing']);
    const slug = (s) => db.prepare('SELECT kind, target_id FROM slugs WHERE slug = ?').get(s);
    assert.deepEqual({ ...slug('cafe') }, { kind: 'session', target_id: 'cafe00000001' });
    assert.deepEqual({ ...slug('weekly-routing-status') }, { kind: 'session', target_id: 'a1a1a1a1a1a1' });
    assert.deepEqual({ ...slug('demo-site') }, { kind: 'site', target_id: '5f5f5f5f5f5f' });
    assert.deepEqual({ ...slug('shared-name') }, { kind: 'session', target_id: '1b1b1b1b1b1b' }, 'the slug index decides a shared slug');
    const sites = db.prepare('SELECT id, slug FROM sites ORDER BY id').all().map((r) => `${r.id}:${r.slug}`);
    for (const s of ['5f5f5f5f5f5f:demo-site', '6a6a6a6a6a6a:shared-name', '7b7b7b7b7b7b:expired-site']) assert.ok(sites.includes(s), `site ${s}`);
  });

  test('R-20.8 comments + replies round-trip exactly (id-less comment, absent vs empty replies)', () => {
    const rows = db.prepare('SELECT pk, id, data_json FROM comments WHERE session_id = ? ORDER BY ord').all('d4d4d4d4d4d4');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, null, 'id-less comment stored with NULL id');
    const src = JSON.parse(fs.readFileSync(path.join(LEGACY_FIXTURE, 'd4d4d4d4d4d4.json'), 'utf-8')).comments;
    const replyCount = (pk) => db.prepare('SELECT count(*) AS c FROM replies WHERE comment_pk = ?').get(pk).c;
    assert.equal(replyCount(rows[0].pk), 0);
    const s1 = db.prepare('SELECT pk, id FROM comments WHERE session_id = ? ORDER BY ord').all('a1a1a1a1a1a1');
    assert.deepEqual(s1.map((r) => r.id), ['11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444']);
    assert.equal(replyCount(s1[0].pk), 2);
    assert.equal(src.length, 2);
  });

  test('R-20.8 revisions: ordered hashes equal the source; every blob gunzips to content with that md5', () => {
    for (const id of ['a1a1a1a1a1a1', 'f6f6f6f6f6f6']) {
      const meta = JSON.parse(fs.readFileSync(path.join(LEGACY_FIXTURE, `${id}.json`), 'utf-8'));
      const rows = db.prepare('SELECT hash, blob, seeded, writes, at_end FROM revisions WHERE session_id = ? ORDER BY seq').all(id);
      assert.deepEqual(rows.map((r) => r.hash), meta.revisions.map((r) => r.hash), `${id} hash order`);
      for (const r of rows) assert.equal(md5(zlib.gunzipSync(Buffer.from(r.blob))), r.hash, `${id}/${r.hash} blob`);
    }
    assert.equal(db.prepare('SELECT count(*) AS c FROM revisions WHERE session_id = ?').get('0a0a0a0a0a0a').c, 0, 'no revisions invented');
  });

  test('R-20.8 files metadata equals the disk walk; FTS has one row per session', () => {
    const files = db.prepare('SELECT name, size FROM files WHERE session_id = ? ORDER BY name').all('a1a1a1a1a1a1').map((r) => [r.name, r.size]);
    const disk = ['diagram.png', 'notes/readme.md'].map((n) => [n, fs.statSync(path.join(LEGACY_FIXTURE, 'files', 'a1a1a1a1a1a1', n)).size]);
    assert.deepEqual(files, disk);
    assert.equal(db.prepare("SELECT count(*) AS c FROM doc_fts WHERE file_name = ''").get().c, FIXTURE_IDS.length);
  });
});

test('R-20.4 seeding: a migrated session with no revisions is seeded on its first content write (replaces test.mjs:731-750)', async () => {
  const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-seed');
  assert.equal(runMigrate(['--data-dir', dir]).status, 0);
  const s = await startServer({ dataDir: dir });
  try {
    const id = '0a0a0a0a0a0a';
    const old = sourceMarkdown(LEGACY_FIXTURE, id);
    assert.equal((await http(s.url, 'GET', `/paste/${id}/revisions`)).json.revisions.length, 0);
    const c = await http(s.url, 'POST', `/paste/${id}/comments`, { body: { startLine: 1, endLine: 1, selectedText: 'x', body: 'y', category: 'nit' } });
    assert.equal(c.status, 201);
    assert.equal((await http(s.url, 'GET', `/paste/${id}/revisions`)).json.revisions.length, 0, 'comment writes add no revision');
    const w = await http(s.url, 'PUT', `/paste/${id}/markdown`, { body: { markdown: `${old}+ agent edit`, author: 'agent' }, headers: { 'X-MdReview-Client': 'mcp' } });
    assert.equal(w.status, 200);
    const list = (await http(s.url, 'GET', `/paste/${id}/revisions`)).json;
    assert.equal(list.revisions.length, 2);
    assert.equal(list.revisions[0].seeded, true);
    assert.equal(list.revisions[0].hash, md5(Buffer.from(old)));
    assert.equal(list.revisions[0].at, '2025-02-01T09:00:00.000Z', 'seed is dated at sharedAt');
    assert.deepEqual([list.revisions[1].by, list.revisions[1].client], ['agent', 'mcp']);
    assert.equal((await http(s.url, 'GET', `/paste/${id}/revisions/${list.revisions[0].hash}`)).json.markdown, old);
  } finally { await s.stop(); }
});

test('R-20.3 a corrupt content blob in the DB is never served as empty content (replaces test.mjs:550-562)', async () => {
  // The DB-era equivalent of "corrupt .content.gz → 500": a corrupt revision blob must be a 500, never ''.
  const dir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-corrupt-blob');
  assert.equal(runMigrate(['--data-dir', dir]).status, 0);
  const { DatabaseSync } = await import('node:sqlite');
  const w = new DatabaseSync(path.join(dir, DB_NAME));
  const h = w.prepare('SELECT hash FROM revisions WHERE session_id = ? ORDER BY seq LIMIT 1').get('a1a1a1a1a1a1').hash;
  w.prepare('UPDATE revisions SET blob = ? WHERE session_id = ? AND hash = ?').run(Buffer.from('not gzip'), 'a1a1a1a1a1a1', h);
  w.close();
  const s = await startServer({ dataDir: dir });
  try {
    const r = await http(s.url, 'GET', `/paste/a1a1a1a1a1a1/revisions/${h}`);
    assert.equal(r.status, 500);
    assert.match(r.json.error, /unreadable/i);
    assert.equal((await http(s.url, 'GET', '/')).status, 200, 'server keeps serving');
  } finally { await s.stop(); }
});
