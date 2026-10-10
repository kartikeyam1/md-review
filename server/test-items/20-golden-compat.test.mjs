// Item #20 — AC-20.3 + rule 5: the SQLite server answers exactly like the
// JSON-file server. Responses were recorded ONCE from the JSON-file server
// (fixtures/20/record-goldens.mjs → goldens.json, frozen) on
// fixtures/20/legacy-data; here a copy of that fixture is migrated with the
// script, served by the new server, and the same request sequences replayed.
//
// Allowed differences (see lib/20-golden.mjs): ETag values, ids/uuids/
// timestamps generated during the run, file-list order, the invalid-regex list
// request (400 instead of the legacy 500), additive keys named by spec 20 rule 5
// / 00 §10.5, and `mode` per 00 §1.4 (invalid stored → "review").
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyToTmp, cleanupTmp, runMigrate, startServer, http, LEGACY_FIXTURE, FIXTURE_DIR } from './lib/20-helpers.mjs';
import { deriveGetRequests, replay, runWriteSequence, startHookReceiver, normalizeEntries, compareEntries, fixtureKnownValues } from './lib/20-golden.mjs';

after(cleanupTmp);

const GOLDENS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'goldens.json'), 'utf-8'));
const known = fixtureKnownValues(LEGACY_FIXTURE);

async function migratedServer(label) {
  const dir = copyToTmp(LEGACY_FIXTURE, label);
  const m = runMigrate(['--data-dir', dir]);
  assert.equal(m.status, 0, `migration of the golden fixture failed (exit ${m.status}):\n${m.stdout}\n${m.stderr}`);
  return startServer({ dataDir: dir });
}

const report = (diffs) => `${diffs.length} difference(s) from the JSON-file server:\n  ${diffs.slice(0, 60).join('\n  ')}`;

test('AC-20.3 goldens are present and were recorded from a JSON-file server', () => {
  assert.ok(GOLDENS.gets.length > 200 && GOLDENS.writes.length > 100);
  assert.ok(GOLDENS.server_commit, 'server_commit recorded');
});

test('AC-20.3 the fixture is the one the goldens were recorded on (≥10 sessions, files, slugs, a site)', () => {
  const sessions = fs.readdirSync(LEGACY_FIXTURE).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  assert.ok(sessions.length >= 10);
  assert.ok(fs.existsSync(path.join(LEGACY_FIXTURE, 'files', 'a1a1a1a1a1a1', 'diagram.png')));
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(LEGACY_FIXTURE, '_site-index.json'), 'utf-8'))).length >= 1);
  const expectedNames = GOLDENS.gets.map((e) => e.name);
  assert.deepEqual(deriveGetRequests(LEGACY_FIXTURE).map((r) => r.name), expectedNames, 'request list derived from the fixture matches the goldens');
});

test('AC-20.3 replayed GETs on the migrated fixture deep-equal the JSON-file server', async () => {
  const s = await migratedServer('md-review-20-golden-gets');
  try {
    const actual = normalizeEntries(await replay(s.url, deriveGetRequests(LEGACY_FIXTURE)), known);
    const diffs = compareEntries(GOLDENS.gets, actual);
    assert.deepEqual(diffs, [], report(diffs));
  } finally { await s.stop(); }
});

test('AC-20.3 rule 5: the full write sequence (every existing endpoint) answers like the JSON-file server', async () => {
  const s = await migratedServer('md-review-20-golden-writes');
  const hook = await startHookReceiver();
  try {
    const actual = normalizeEntries(await runWriteSequence(s.url, { hookUrl: hook.url, hookEvents: hook.events }), known, { [hook.url]: '<hook>' });
    const diffs = compareEntries(GOLDENS.writes, actual);
    assert.deepEqual(diffs, [], report(diffs));
  } finally { await s.stop(); await hook.close(); }
});

test('AC-20.3 an invalid /paste/list name regex does not take the server down', async () => {
  const s = await migratedServer('md-review-20-golden-regex');
  try {
    const r = await http(s.url, 'GET', '/paste/list?name=(');
    assert.ok([400, 500].includes(r.status), `status ${r.status}`);
    assert.equal((await http(s.url, 'GET', '/paste/list')).status, 200);
  } finally { await s.stop(); }
});
