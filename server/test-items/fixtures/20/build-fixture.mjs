#!/usr/bin/env node
// Builds the JSON-era golden fixture data dir for item #20 (SQLite storage):
//   server/test-items/fixtures/20/legacy-data/
//
// The output is committed and FROZEN together with goldens.json (recorded from
// the JSON-file server by record-goldens.mjs). Re-running this script rewrites
// the dir byte-for-byte identically; only do it on purpose, and re-record the
// goldens against the pre-#20 server afterwards.
//
// Every timestamp is fixed (2025) or far-future (2099), so responses do not
// depend on the clock. Coverage (spec 20 AC-20.3 + task brief):
//   md + html sessions, slugs (incl. all-hex "cafe" that is also an id prefix,
//   and "shared-name" used by both a session and a site), comments with replies,
//   comment without `replies`, id-less comments, session without a `comments`
//   key, approval approved / changes_requested / pending + must-fix, revisions
//   incl. a merged (coalesced) one and a seeded one, a session with no revisions,
//   session files (nested + binary), an expired session, a legacy inline-markdown
//   meta (no .content.gz), a missing content file, extra meta keys, valid and
//   invalid stored `mode`, hosted sites (live, SPA off, expired, orphan dir).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'legacy-data');

const md5 = (s) => crypto.createHash('md5').update(Buffer.from(s, 'utf-8')).digest('hex');
const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf-8'));
const size = (s) => Buffer.byteLength(s, 'utf-8');

fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['', 'files', 'revisions', 'sites', 'chunks']) fs.mkdirSync(path.join(OUT, d), { recursive: true });

const write = (rel, data) => {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};
const writeMeta = (id, meta) => write(`${id}.json`, JSON.stringify(meta));
const writeContent = (id, md) => write(`${id}.content.gz`, gz(md));
const writeRevBlob = (id, md) => write(`revisions/${id}/${md5(md)}.gz`, gz(md));

const slugIndex = {};
const siteIndex = {};

// ── S1: markdown, approved, extra keys, comments + replies, 3 revisions (one merged), files
{
  const id = 'a1a1a1a1a1a1';
  const v1 = '# Weekly routing status\n\nDraft.\n';
  const v2 = '# Weekly routing status\n\nRoutes optimised this week: 42.\n';
  const v3 = '# Weekly routing status\n\nRoutes optimised this week: 42.\n\n## Next\n\nDock capacity review.\n';
  for (const v of [v1, v2, v3]) writeRevBlob(id, v);
  writeContent(id, v3);
  writeMeta(id, {
    filename: 'weekly.md',
    contentType: 'markdown',
    sessionName: 'Weekly routing status',
    slug: 'weekly-routing-status',
    sharedAt: '2025-03-01T09:00:00.000Z',
    expiry_days: null,
    approval_status: 'approved',
    approved_by: 'Dana',
    approved_at: '2025-03-05T10:00:00.000Z',
    custom_extra: { nested: [1, 'two', { three: 3 }], flag: false },
    legacy_labels: ['ops', 'routing'],
    comments: [
      {
        id: '11111111-1111-4111-8111-111111111111', createdAt: 1740823200000,
        startLine: 3, endLine: 3, selectedText: 'Routes optimised', body: 'Which depot?', category: 'question',
        author: 'Ann',
        replies: [
          { id: '22222222-2222-4222-8222-222222222222', createdAt: 1740826800000, body: 'North depot.', author: 'Bob' },
          { id: '33333333-3333-4333-8333-333333333333', createdAt: 1740830400000, body: 'Thanks!' },
        ],
        resolved: true, resolved_by: 'Ann', resolved_at: 1740834000000,
      },
      {
        id: '44444444-4444-4444-8444-444444444444', createdAt: 1740837600000,
        startLine: 7, endLine: 7, selectedText: 'Dock capacity review.', body: 'Add owner', category: 'must-fix',
        replies: [], resolved: true, resolved_by: null, resolved_at: 1740841200000,
      },
    ],
    content_hash: md5(v3),
    revisions: [
      { hash: md5(v1), at: '2025-03-01T09:00:00.000Z', by: 'alice', client: 'ui', size: size(v1), parent: null },
      { hash: md5(v2), at: '2025-03-02T10:00:00.000Z', by: 'bob', client: 'mcp', size: size(v2), parent: md5(v1),
        at_end: '2025-03-02T10:04:00.000Z', writes: 3 },
      { hash: md5(v3), at: '2025-03-03T08:30:00.000Z', by: 'alice', client: 'api', size: size(v3), parent: md5(v2) },
    ],
  });
  slugIndex['weekly-routing-status'] = id;
  // a binary file and a nested text file
  write(`files/${id}/diagram.png`, Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 'hex'));
  write(`files/${id}/notes/readme.md`, '# Notes\n\nAttached notes for the weekly status.\n');
}

// ── S2: HTML session, no revisions, no slug, 30-day expiry far in the future
{
  const id = 'b2b2b2b2b2b2';
  const html = '<!doctype html><html><head><title>Quarterly report</title><style>.x{color:red}</style></head>'
    + '<body><script>var secretvar = 1;</script><h1>Quarterly report</h1><p>visible words</p></body></html>';
  writeContent(id, html);
  writeMeta(id, {
    filename: 'report.html', contentType: 'html', sharedAt: '2025-03-04T09:00:00.000Z',
    expiry_days: 30, expires_at: '2099-12-31T00:00:00.000Z', approval_status: 'pending',
    comments: [], content_hash: md5(html),
  });
}

// ── S3: legacy meta with inline markdown (no .content.gz, no content_hash)
{
  const id = 'c3c3c3c3c3c3';
  writeMeta(id, {
    markdown: '# Old format\n\nInline content from before content files existed.\n',
    filename: 'old.md', approval_status: 'pending', comments: [], sharedAt: '2025-01-15T12:00:00.000Z',
  });
}

// ── S4: comments stored verbatim at create time: one without id, one with id and empty replies
{
  const id = 'd4d4d4d4d4d4';
  const md = '# Agent created plan\n\nIntro paragraph.\n\nStep one.\n';
  writeContent(id, md);
  writeMeta(id, {
    filename: 'plan.md', sessionName: 'Agent created plan', slug: 'agent-created-plan',
    sharedAt: '2025-03-06T09:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', approval_status: 'pending',
    comments: [
      { startLine: 3, endLine: 3, selectedText: 'Intro paragraph.', body: 'No id here', category: 'suggestion' },
      { id: 'legacy-1', startLine: 5, endLine: 5, selectedText: 'Step one.', body: 'Has id, no createdAt', category: 'nit', replies: [] },
    ],
    content_hash: md5(md),
  });
  slugIndex['agent-created-plan'] = id;
}

// ── S5: expired session (410 on read, excluded from list)
{
  const id = 'e5e5e5e5e5e5';
  const md = '# Old expired doc\n\nexpiredterm lives here.\n';
  writeContent(id, md);
  writeMeta(id, {
    filename: 'expired.md', sessionName: 'Old expired doc', slug: 'old-expired', expiry_days: 7,
    sharedAt: '2025-01-01T00:00:00.000Z', expires_at: '2025-01-08T00:00:00.000Z', approval_status: 'pending',
    comments: [], content_hash: md5(md),
  });
  slugIndex['old-expired'] = id;
}

// ── S6: seeded revision history, approval changes_requested
{
  const id = 'f6f6f6f6f6f6';
  const v0 = '# Seeded\n\nOriginal text.\n';
  const v1 = '# Seeded\n\nOriginal text, edited by Carol.\n';
  writeRevBlob(id, v0); writeRevBlob(id, v1);
  writeContent(id, v1);
  writeMeta(id, {
    filename: 'seeded.md', sharedAt: '2025-02-10T09:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z',
    approval_status: 'changes_requested', approved_by: null, approved_at: null,
    comments: [], content_hash: md5(v1),
    revisions: [
      { hash: md5(v0), at: '2025-02-10T09:00:00.000Z', by: null, client: null, size: size(v0), parent: null, seeded: true },
      { hash: md5(v1), at: '2025-02-11T09:00:00.000Z', by: 'carol', client: 'ui', size: size(v1), parent: md5(v0) },
    ],
  });
}

// ── S7: pre-history session (no revisions) and NO `comments` key at all
{
  const id = '0a0a0a0a0a0a';
  const md = '# Pre history doc\n\nWritten before revision history existed.\n';
  writeContent(id, md);
  writeMeta(id, {
    filename: 'prehistory.md', sessionName: 'Pre history doc', slug: 'pre-history-doc',
    sharedAt: '2025-02-01T09:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', approval_status: 'pending',
    content_hash: md5(md),
  });
  slugIndex['pre-history-doc'] = id;
}

// ── S8: all-hex slug "cafe" that is also a prefix of this session's own id
{
  const id = 'cafe00000001';
  const md = '# Cafe notes\n\nMeeting at the café on Friday.\n';
  writeContent(id, md);
  writeMeta(id, {
    filename: 'cafe.md', sessionName: 'Cafe notes', slug: 'cafe',
    sharedAt: '2025-03-07T09:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', approval_status: 'pending',
    comments: [], content_hash: md5(md),
  });
  slugIndex['cafe'] = id;
}

// ── S9: unresolved must-fix, callback_url, slug also used by a hosted site
{
  const id = '1b1b1b1b1b1b';
  const md = '# Shared name doc\n\nNeeds work.\n';
  writeContent(id, md);
  writeMeta(id, {
    filename: 'shared.md', sessionName: 'Shared name', slug: 'shared-name',
    callback_url: 'http://127.0.0.1:9/hook',
    sharedAt: '2025-03-08T09:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', approval_status: 'pending',
    comments: [
      { id: '55555555-5555-4555-8555-555555555555', createdAt: 1741424400000, startLine: 3, endLine: 3,
        selectedText: 'Needs work.', body: 'Fix before approval', category: 'must-fix', author: 'Eve' },
    ],
    content_hash: md5(md),
  });
  slugIndex['shared-name'] = id;
}

// ── S10: no filename / sessionName / slug, content file missing, no content_hash
{
  const id = '2c2c2c2c2c2c';
  writeMeta(id, { sharedAt: '2025-03-09T09:00:00.000Z', approval_status: 'pending', comments: [] });
}

// ── S11: stored valid mode (#2) + CJK/emoji name
{
  const id = '3d3d3d3d3d3d';
  const md = '# 路线 🚚 plan\n\n配送路线 and emoji 🚚 search.\n';
  writeContent(id, md);
  writeMeta(id, {
    filename: 'cjk.md', sessionName: '路线 🚚 plan', slug: 'cjk-plan', mode: 'publish',
    sharedAt: '2025-03-10T09:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', approval_status: 'pending',
    comments: [], content_hash: md5(md),
  });
  slugIndex['cjk-plan'] = id;
}

// ── S12: stored INVALID mode (migration must write 'review') + front-matter title
{
  const id = '4e4e4e4e4e4e';
  const md = '---\ntitle: "Front matter title"\n---\n\n# Body heading\n\nText.\n';
  writeContent(id, md);
  writeMeta(id, {
    filename: 'fm.md', mode: 'draft',
    sharedAt: '2025-03-11T09:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', approval_status: 'pending',
    comments: [], content_hash: md5(md),
  });
}

// ── Hosted sites
{
  const id = '5f5f5f5f5f5f';
  write(`sites/${id}/index.html`, '<!doctype html><html><body><h1>Demo site</h1><script src="/assets/app.js"></script></body></html>');
  write(`sites/${id}/assets/app.js`, 'console.log("demo site");\n');
  siteIndex[id] = { slug: 'demo-site', name: 'Demo site', created_at: '2025-03-01T00:00:00.000Z', expires_at: null, file_count: 2, spa: true };
  slugIndex['demo-site'] = id;
}
{
  // site whose slug is ALSO a session slug (the slug index points at the session)
  const id = '6a6a6a6a6a6a';
  write(`sites/${id}/index.html`, '<!doctype html><html><body><h1>Shared name site</h1></body></html>');
  write(`sites/${id}/page.html`, '<!doctype html><html><body><p>page</p></body></html>');
  siteIndex[id] = { slug: 'shared-name', name: 'Shared name site', created_at: '2025-03-02T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', file_count: 2, spa: false };
}
{
  const id = '7b7b7b7b7b7b';
  write(`sites/${id}/index.html`, '<!doctype html><html><body>expired</body></html>');
  siteIndex[id] = { slug: 'expired-site', name: 'Expired site', created_at: '2025-01-01T00:00:00.000Z', expires_at: '2025-01-08T00:00:00.000Z', file_count: 1, spa: true };
  slugIndex['expired-site'] = id;
}
// orphan site dir (exists on disk, not in the site index — the live data has one)
write('sites/8c8c8c8c8c8c/index.html', '<!doctype html><html><body>orphan site</body></html>');

write('_slug-index.json', JSON.stringify(slugIndex));
write('_site-index.json', JSON.stringify(siteIndex));
// chunks/ must exist (the server creates it); keep it in git
write('chunks/.keep', '');

console.log(`fixture written to ${OUT}`);
