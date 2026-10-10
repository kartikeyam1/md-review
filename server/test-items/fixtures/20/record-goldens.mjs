#!/usr/bin/env node
// Records fixtures/20/goldens.json from the JSON-file (pre-#20) server.
//
//   node server/test-items/fixtures/20/record-goldens.mjs [--server <path/to/server.cjs>] [--ref <git-ref>]
//
// Default: the working tree's server/server.cjs — correct ONLY before #20 is
// implemented. After that, record from the last JSON-era commit instead:
//   --ref <commit>   extracts server/server.cjs at that commit into a temp dir
//                    (the JSON server only needs Node builtins).
// The fixture is copied to a temp dir first; legacy-data/ is never written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, copyToTmp, tmpDir, cleanupTmp, REPO_ROOT, SERVER_FILE, LEGACY_FIXTURE } from '../../lib/20-helpers.mjs';
import { deriveGetRequests, replay, runWriteSequence, startHookReceiver, normalizeEntries, fixtureKnownValues } from '../../lib/20-golden.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

let serverFile = opt('--server') ? path.resolve(opt('--server')) : SERVER_FILE;
let ref = opt('--ref');
let commit;
if (ref) {
  commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', ref], { encoding: 'utf-8' }).trim();
  const src = execFileSync('git', ['-C', REPO_ROOT, 'show', `${commit}:server/server.cjs`], { encoding: 'utf-8' });
  serverFile = path.join(tmpDir('md-review-20-legacy-server'), 'server.cjs');
  fs.writeFileSync(serverFile, src);
} else {
  commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  const dirty = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'server/server.cjs'], { encoding: 'utf-8' }).trim();
  if (dirty) commit += '+dirty';
}
const serverSrc = fs.readFileSync(serverFile, 'utf-8');
if (/node:sqlite|DatabaseSync/.test(serverSrc)) {
  console.error('refusing to record: this server.cjs is already the SQLite server. Use --ref <last JSON-era commit>.');
  process.exit(2);
}

const known = fixtureKnownValues(LEGACY_FIXTURE);
const dataDir = copyToTmp(LEGACY_FIXTURE, 'md-review-20-golden-legacy');
const hook = await startHookReceiver();
const srv = await startServer({ dataDir, serverFile });
try {
  const gets = normalizeEntries(await replay(srv.url, deriveGetRequests(LEGACY_FIXTURE)), known);
  const writes = normalizeEntries(await runWriteSequence(srv.url, { hookUrl: hook.url, hookEvents: hook.events }), known, { [hook.url]: '<hook>' });
  const out = {
    about: 'Frozen responses of the JSON-file server for fixtures/20/legacy-data (item #20 AC-20.3 / rule 5). Do not edit by hand; see record-goldens.mjs.',
    recorded_at: new Date().toISOString(),
    server_commit: commit,
    server_sha256: crypto.createHash('sha256').update(serverSrc).digest('hex'),
    node: process.version,
    gets,
    writes,
  };
  fs.writeFileSync(path.join(HERE, 'goldens.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`recorded ${gets.length} GET entries and ${writes.length} write-sequence entries from ${commit}`);
  const bad = writes.filter((e) => e.status === 0 || e.status >= 500);
  if (bad.length) console.warn('WARNING: entries with status 0/5xx:', bad.map((e) => `${e.name}=${e.status}`).join(', '));
} finally {
  await srv.stop();
  await hook.close();
  cleanupTmp();
}
