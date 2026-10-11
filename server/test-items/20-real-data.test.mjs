// Item #20 — migration verification against a COPY of the live data.
//
// Skipped unless MDREVIEW_REAL_DATA_COPY points at a copied data dir, e.g.
//   cp -a /home/ubuntu/locus-repos/md-review/server/data /tmp/md-review-data-copy-$(date +%s)
//   MDREVIEW_REAL_DATA_COPY=/tmp/md-review-data-copy-<ts> node --test server/test-items/20-real-data.test.mjs
//
// The copy is treated as READ-ONLY: the DB goes to a temp dir via --db, and the
// test asserts every file in the copy is byte- and mtime-identical afterwards.
// It refuses to run against the live dir itself.
//
// Response comparison: the legacy JSON-file server (server/server.cjs at
// MDREVIEW_LEGACY_REF, default the commit goldens.json was recorded from) runs
// on a scratch mirror of the copy; the new server runs on the migrated DB; GETs
// for every session / slug / site are compared with the golden comparator.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  tmpDir, cleanupTmp, migrateWithReport, runMigrate, tableCounts, snapshotTree, diffSnapshots, startServer,
  REPO_ROOT, FIXTURE_DIR,
} from './lib/20-helpers.mjs';
import { readFixture, replay, compareEntries } from './lib/20-golden.mjs';

const COPY = process.env.MDREVIEW_REAL_DATA_COPY ? path.resolve(process.env.MDREVIEW_REAL_DATA_COPY) : null;
const LIVE = path.resolve(REPO_ROOT, '..', 'md-review', 'server', 'data');
const skip = !COPY ? 'set MDREVIEW_REAL_DATA_COPY to a COPY of the live data dir to run' : false;

after(cleanupTmp);

// Make the skip visible in node:test / verify.sh counts (a skipped describe counts 0).
if (skip) test('AC-20.3/20.4/20.5/20.6 real-data verification', { skip }, () => {});

describe('real data copy', { skip }, () => {
  let snapBefore; let corrupt; let sessionIds; let dbPath;

  before(() => {
    const real = fs.realpathSync(COPY);
    if (fs.existsSync(LIVE) && real === fs.realpathSync(LIVE)) throw new Error(`refusing to run against the LIVE data dir ${LIVE}`);
    assert.ok(fs.existsSync(path.join(COPY, '_slug-index.json')) || fs.readdirSync(COPY).some((f) => f.endsWith('.json')), 'looks like a data dir');
    snapBefore = snapshotTree(COPY);
    const metas = fs.readdirSync(COPY).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    corrupt = []; sessionIds = [];
    for (const f of metas) {
      const id = f.slice(0, -5);
      let ok = false;
      try { const m = JSON.parse(fs.readFileSync(path.join(COPY, f), 'utf-8')); ok = !!m && typeof m === 'object' && !Array.isArray(m); } catch { /* corrupt */ }
      (ok ? sessionIds : corrupt).push(id);
    }
    console.log(`[20-real] ${COPY}: ${sessionIds.length} sessions, ${corrupt.length} corrupt meta (${corrupt.join(', ') || 'none'})`);
    dbPath = path.join(tmpDir('md-review-20-real-db'), 'real.sqlite');
  });

  test('AC-20.5 real copy: --dry-run writes nothing and verifies every parseable session', () => {
    const dryDb = path.join(tmpDir('md-review-20-real-dry'), 'dry.sqlite');
    const r = runMigrate(['--data-dir', COPY, '--db', dryDb, '--dry-run']);
    assert.ok(r.signal === null, 'no crash');
    assert.equal(r.status === 0, corrupt.length === 0, `exit ${r.status} with ${corrupt.length} corrupt sources\n${r.stdout.slice(-2000)}`);
    assert.match(r.stdout, /sessions:\s*\d+ migrated/);
    assert.ok(!fs.existsSync(dryDb));
    assert.deepEqual(diffSnapshots(snapBefore, snapshotTree(COPY)), []);
  });

  test('AC-20.4/AC-20.6 real copy: every parseable session migrates and verifies; only corrupt sources are errors', () => {
    const r = migrateWithReport(COPY, ['--db', dbPath]);
    console.log(r.stdout.split('\n').filter((l) => /sessions:|revisions|comments|files|sites|slugs|error|fail/i.test(l)).slice(0, 40).join('\n'));
    assert.ok(r.signal === null, 'no crash');
    assert.equal(r.status === 0, corrupt.length === 0, `exit ${r.status}; expected ${corrupt.length ? 'non-zero (corrupt sources)' : '0'}`);
    assert.ok(r.report, 'report written');
    const st = Object.fromEntries(r.report.sessions.map((s) => [s.id, s.status]));
    const notMigrated = sessionIds.filter((id) => st[id] !== 'migrated');
    assert.deepEqual(notMigrated, [], `sessions not migrated: ${notMigrated.map((id) => `${id}=${st[id]}`).join(', ')}`);
    const errs = JSON.stringify(r.report.errors);
    for (const id of corrupt) assert.ok(errs.includes(id), `corrupt ${id} listed under errors`);
    const errIds = (r.report.errors || []).map((e) => (typeof e === 'string' ? e : e.id)).filter(Boolean);
    for (const id of errIds) assert.ok(corrupt.includes(id), `unexpected error for parseable session ${id}: ${errs}`);
    assert.deepEqual(diffSnapshots(snapBefore, snapshotTree(COPY)), [], 'the copy is untouched');
  });

  test('AC-20.4 real copy: a second run reports every session unchanged with identical row counts', async () => {
    assert.ok(fs.existsSync(dbPath), 'needs the DB migrated by the previous test');
    const counts1 = await tableCounts(dbPath);
    const r = migrateWithReport(COPY, ['--db', dbPath]);
    const st = Object.fromEntries(r.report.sessions.map((s) => [s.id, s.status]));
    const changed = sessionIds.filter((id) => st[id] !== 'unchanged');
    assert.deepEqual(changed, [], `not unchanged on run 2: ${changed.map((id) => `${id}=${st[id]}`).join(', ')}`);
    assert.deepEqual(await tableCounts(dbPath), counts1);
    assert.deepEqual(diffSnapshots(snapBefore, snapshotTree(COPY)), []);
  });

  test('AC-20.3 real copy: GET responses of the migrated server equal the JSON-file server', async () => {
    assert.ok(fs.existsSync(dbPath), 'needs the DB migrated by the previous tests');
    // legacy server source from git
    const goldens = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'goldens.json'), 'utf-8'));
    const ref = process.env.MDREVIEW_LEGACY_REF || String(goldens.server_commit).replace(/\+dirty$/, '');
    const legacyFile = path.join(tmpDir('md-review-20-real-legacy-src'), 'server.cjs');
    fs.writeFileSync(legacyFile, execFileSync('git', ['-C', REPO_ROOT, 'show', `${ref}:server/server.cjs`], { encoding: 'utf-8' }));

    // scratch mirrors: small files copied, big trees symlinked (GETs never write there)
    const mirror = tmpDir('md-review-20-real-legacy-data');
    for (const e of fs.readdirSync(COPY, { withFileTypes: true })) {
      const src = path.join(COPY, e.name);
      if (e.isDirectory() && ['files', 'sites', 'chunks'].includes(e.name)) fs.symlinkSync(src, path.join(mirror, e.name));
      else fs.cpSync(src, path.join(mirror, e.name), { recursive: true, preserveTimestamps: true });
    }
    const fresh = tmpDir('md-review-20-real-new-data');
    for (const d of ['files', 'sites']) if (fs.existsSync(path.join(COPY, d))) fs.symlinkSync(path.join(COPY, d), path.join(fresh, d));

    const { sessions, siteIndex, siteDirs } = readFixture(COPY);
    const reqs = [{ name: 'list', method: 'GET', path: '/paste/list' }, { name: 'sites', method: 'GET', path: '/site/list' }];
    for (const { id, meta, files } of sessions) {
      const keys = [id, ...(meta.slug ? [meta.slug] : [])];
      for (const x of keys) reqs.push({ name: `full ${x}`, method: 'GET', path: `/paste/${x}` });
      for (const sfx of ['?fields=meta', '?fields=meta,content,comments,files', '/comments', '/markdown', '/approval', '/revisions', '/revisions/current', '/files']) {
        reqs.push({ name: `${id}${sfx}`, method: 'GET', path: `/paste/${id}${sfx}` });
      }
      for (const r of meta.revisions || []) reqs.push({ name: `${id} rev ${r.hash}`, method: 'GET', path: `/paste/${id}/revisions/${r.hash}` });
      for (const f of files.slice(0, 3)) reqs.push({ name: `${id} file ${f}`, method: 'GET', path: `/paste/${id}/files/${encodeURIComponent(f)}` });
    }
    for (const d of siteDirs) reqs.push({ name: `site ${d}`, method: 'GET', path: `/site/${d}/` });
    for (const [, s] of Object.entries(siteIndex)) if (s.slug) reqs.push({ name: `site ${s.slug}`, method: 'GET', path: `/site/${s.slug}/` });

    const legacy = await startServer({ dataDir: mirror, serverFile: legacyFile });
    let golden;
    try { golden = await replay(legacy.url, reqs, { hashBodies: true }); } finally { await legacy.stop(); }
    const neu = await startServer({ dataDir: fresh, env: { DB_PATH: dbPath } });
    let actual;
    try { actual = await replay(neu.url, reqs, { hashBodies: true }); } finally { await neu.stop(); }
    const sortFiles = (entries) => entries.map((e) => {
      const fix = (v) => (Array.isArray(v) && v.every((x) => x && typeof x.name === 'string' && 'size' in x) ? [...v].sort((a, b) => a.name.localeCompare(b.name)) : v);
      if (e.body?.json && typeof e.body.json === 'object') {
        const j = Array.isArray(e.body.json) ? fix(e.body.json) : { ...e.body.json, ...(e.body.json.files ? { files: fix(e.body.json.files) } : {}) };
        return { ...e, body: { json: j } };
      }
      return e;
    });
    const diffs = compareEntries(sortFiles(golden), sortFiles(actual));
    assert.deepEqual(diffs, [], `${diffs.length} differences:\n  ${diffs.slice(0, 80).join('\n  ')}`);
    assert.deepEqual(diffSnapshots(snapBefore, snapshotTree(COPY)), [], 'the copy is untouched');
  });
});
