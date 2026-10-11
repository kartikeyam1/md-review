// Unit tests for the pure parts of the SQLite storage (item #20): docTitle and
// indexed text (00 §5 / §8), the FTS query builder and snippet segments, and
// the meta / comment / revision row codec. No server, no PASTE_API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { docTitle, htmlToText, searchContent, markdownToPlain, decodeEntities } = require('./doc-text.cjs');
const { ftsQuery, queryTerms, excerpt } = require('./search-query.cjs');
const rows = require('./session-rows.cjs');
const { openDb } = require('./db.cjs');

test('docTitle: sessionName → front matter → first H1 → filename → Untitled (00 §5)', () => {
  assert.equal(docTitle({ sessionName: '  Weekly   routing ' }, '# Other'), 'Weekly routing');
  assert.equal(docTitle({}, '---\ntitle: "Front matter title"\n---\n# H1'), 'Front matter title');
  assert.equal(docTitle({}, "---\ntitle: 'single'\n---\n"), 'single');
  assert.equal(docTitle({}, 'intro\n\n# **Bold** [link](http://x) `code`\n'), 'Bold link code');
  assert.equal(docTitle({}, '```\n# not a title\n```\n# Real ##'), 'Real');
  assert.equal(docTitle({}, '<!-- agent -->\n# Agent only\n<!-- /agent -->\n# Human'), 'Human');
  assert.equal(docTitle({ filename: 'plan.markdown' }, 'no heading'), 'plan');
  assert.equal(docTitle({ filename: 'x.HTML', contentType: 'html' }, '<p>x</p>'), 'x');
  assert.equal(docTitle({}, ''), 'Untitled');
  assert.equal(docTitle({ sessionName: 42 }, '#\n#  \n'), 'Untitled', 'non-string name and empty headings are skipped');
});

test('docTitle: HTML uses <title>, then the first <h1>, never executing anything', () => {
  assert.equal(docTitle({ contentType: 'html' }, '<title>Q&amp;A  report</title><h1>H</h1>'), 'Q&A report');
  assert.equal(docTitle({ contentType: 'html' }, '<body><h1>First <em>one</em></h1><h1>Two</h1>'), 'First one');
});

test('htmlToText / searchContent drop tags, scripts, styles and comments', () => {
  const html = '<style>.x{}</style><script>var secretvar=1</script><!-- c --><p>visible &lt;words&gt;</p>';
  assert.equal(htmlToText(html), 'visible <words>');
  assert.equal(searchContent('html', html), 'visible <words>');
  assert.equal(searchContent('markdown', '# md <b>kept</b>'), '# md <b>kept</b>', 'markdown is indexed as source');
});

test('markdownToPlain / decodeEntities give plain snippet text', () => {
  assert.equal(markdownToPlain('# H1\n\n> **b** *i* _e_ [l](u) ![a](i.png)\n- one\n1. two\n| x | y |\n|---|---|\n```js\nf()\n```\nsnake_case <b>t</b>'),
    'H1 b i e l a one two x y f() snake_case t');
  assert.equal(decodeEntities('caf&eacute; &Eacute;t&eacute; &#233;&#xE9; &hellip; &nosuch; &amp;amp;'), 'café Été éé … &nosuch; &amp;');
});

test('ftsQuery quotes, prefix-matches and ANDs tokens; unsearchable input gives null', () => {
  assert.equal(ftsQuery('week stat'), '"week"* AND "stat"*');
  assert.equal(ftsQuery('a"b NEAR'), '"a""b"* AND "NEAR"*');
  assert.equal(ftsQuery('foo-bar (x'), '"foo-bar"* AND "(x"*');
  for (const q of ['"', '*', '(', '🚚', '% ^ -', '\u0000', '\u0001\u0002']) assert.equal(ftsQuery(q), null, JSON.stringify(q));
  assert.equal(ftsQuery('ab\u0000c'), '"ab"* AND "c"*', 'control characters separate tokens');
});

test('excerpt marks folded prefix hits in a ~32-token window, as plain-text segments', () => {
  assert.deepEqual(excerpt('# Cafe notes\n\nMet at the café.', queryTerms('cafe')), [
    { text: '# ', hit: false }, { text: 'Cafe', hit: true }, { text: ' notes\n\nMet at the ', hit: false },
    { text: 'café', hit: true }, { text: '.', hit: false }]);
  assert.deepEqual(excerpt('Weekly routing status', queryTerms('ROUT')), [
    { text: 'Weekly ', hit: false }, { text: 'routing', hit: true }, { text: ' status', hit: false }]);
  assert.deepEqual(excerpt('路线 🚚 plan', queryTerms('路线')), [{ text: '路线', hit: true }, { text: ' 🚚 plan', hit: false }]);
  assert.equal(excerpt('配送路线', queryTerms('路线')), null, 'prefix match only, like the index');
  // "foo-ba" is the phrase foo + ba*: foo matches exactly, ba as a prefix
  assert.deepEqual(excerpt('foo bar foobar', queryTerms('foo-ba')).filter((x) => x.hit).map((x) => x.text), ['foo', 'bar']);
  const long = `${Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')} hit ${Array.from({ length: 60 }, (_, i) => `v${i}`).join(' ')}`;
  const ex = excerpt(long, queryTerms('hit'));
  const joined = ex.map((x) => x.text).join('');
  assert.ok(joined.startsWith('…w52 ') && joined.endsWith('v22…'), joined);
  assert.equal(joined.split(/\s+/).length, 32);
  assert.equal(excerpt('no match here', queryTerms('zz')), null);
  assert.deepEqual(excerpt('no match here', queryTerms('zz'), { fallback: true }), [{ text: 'no match here', hit: false }]);
  const big = `${'routing words and more. '.repeat(220000)} needleword`;
  const t0 = performance.now();
  assert.deepEqual(excerpt(big, queryTerms('needleword')).filter((x) => x.hit).map((x) => x.text), ['needleword']);
  assert.ok(performance.now() - t0 < 2000, 'linear in the document size');
});

test('meta codec round-trips absent vs null, unusual types and extra keys; mode normalised', () => {
  const meta = {
    filename: 'a.md', sessionName: 'S', slug: 'mine', approved_by: null, expires_at: 42,
    custom: { n: [1, null] }, expiry_days: null, mode: 'draft', comments: [], content_hash: 'h', revisions: [],
  };
  const { cols, extra } = rows.encodeMeta(meta, { slugOwned: (s) => s === 'mine' });
  assert.equal(cols.slug, 'mine');
  assert.equal(cols.approved_by, null);
  assert.deepEqual(extra, { approved_by: null, expires_at: 42, custom: { n: [1, null] }, expiry_days: null });
  const row = { ...cols, mode: 'review', extra_json: JSON.stringify(extra) };
  const back = rows.decodeMeta(row, { content_hash: 'h', hashless: 0 });
  const { comments, revisions, mode, ...rest } = meta;
  assert.deepEqual(back, { ...rest, mode: 'review' });
  assert.ok(!('content_hash' in rows.decodeMeta(row, { content_hash: 'h', hashless: 1 })), 'hashless sessions omit content_hash');
  const owned = rows.encodeMeta({ edit_token_hash: 'h', created_by: 'x', version: 9, title: 't', keep: 1 });
  assert.deepEqual(owned.extra, { keep: 1 }, 'column-owned names are dropped, never stored in extra_json');
  const notOwned = rows.encodeMeta({ slug: 'theirs' }, { slugOwned: () => false });
  assert.equal(notOwned.cols.slug, null);
  assert.deepEqual(notOwned.extra, { slug: 'theirs' });
});

test('comment + revision rows round-trip exactly (id-less, absent vs empty replies, absent keys)', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO sessions (id, extra_json, version) VALUES ('s', '{}', 1)").run();
  const comments = [
    { body: 'no id', category: 'nit' },
    { id: 'c2', category: 'must-fix', replies: [] },
    { id: 'c3', category: 'must-fix', resolved: true, replies: [{ id: 'r1', body: 'x' }, { body: 'no id' }] },
    'weird',
  ];
  rows.writeComments(db, 's', comments);
  assert.deepEqual(rows.readComments(db, 's'), comments);
  assert.equal(db.prepare('SELECT sum(must_fix_open) AS n FROM comments').get().n, 1);
  const revs = [
    { hash: 'a', at: 't1', by: null, client: null, size: 1, parent: null, seeded: true },
    { hash: 'b', at: 't2', by: 'x', client: 'ui', size: 2, parent: 'a', at_end: 't3', writes: 3 },
    { hash: 'c', at: 't4', size: 3, odd: [1] }, // no by/client/parent keys at all
  ];
  revs.forEach((r, i) => rows.insertRevision(db, 's', i + 1, r, Buffer.from('')));
  assert.deepEqual(db.prepare('SELECT * FROM revisions ORDER BY seq').all().map(rows.decodeRevision), revs);
  db.close();
});

// ── linear-time indexing and snippet text (perf round) ──────────────────────

/** Best of 3 runs (the first pays for JIT warm-up), in ms. */
function bestMs(fn) {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return best;
}

// A quadratic-behaviour detector, not a benchmark: the quadratic versions took
// seconds to minutes, so 400 ms leaves room for a loaded test box.
test('indexing + snippet text of 1 MB pathological docs stay under 400 ms each (were quadratic or worse)', () => {
  const MB = 1024 * 1024;
  const fill = (u) => u.repeat(Math.ceil(MB / u.length)).slice(0, MB);
  const html = ['<script', '<!--', '<meta name="description" ', '<title>', '<h1>', '<p>', '<a', '</', '<style>', '<SCRIPT', '<!x', '&a'];
  const md = ['[a', '![a', '](a', '[a](', '[a][', '_a ', '__a ', '*a ', '**a ', '~~a ', '`a', '<a', '<!--', '\n', ' \n', '\n \n',
    '-\n', '- \n', '#\n', '# ', '> ', '> \n', '1. \n', '|--', '|--\n', '| - ', '```\n', '_\n', '😀_', '<!-- agent -->\n'];
  const slow = [];
  const check = (label, fn) => {
    const ms = bestMs(fn);
    if (process.env.MDREVIEW_PERF_LOG) console.log(`${ms.toFixed(1)} ms  ${label}`);
    if (ms >= 400) slow.push(`${label}: ${ms.toFixed(1)} ms`);
  };
  for (const u of html) {
    const s = fill(u);
    check(`searchContent html ${JSON.stringify(u)}`, () => searchContent('html', s));
    check(`docTitle html ${JSON.stringify(u)}`, () => docTitle({ contentType: 'html' }, s));
  }
  for (const u of md) {
    const s = fill(u);
    check(`markdownToPlain ${JSON.stringify(u)}`, () => markdownToPlain(s));
    check(`docTitle markdown ${JSON.stringify(u)}`, () => docTitle({}, s));
    check(`docTitle "# "+${JSON.stringify(u)}`, () => docTitle({}, `# ${s}`));
  }
  assert.deepEqual(slow, []);
});

// Expected values are what the regex versions (3f8ba88) return for the same input.
test('the linear scanners keep the old results: unclosed tags, raw-text elements, links, emphasis', () => {
  // HTML: comments, script/style/template/noscript elements, an unterminated <script> to the end, then tags.
  assert.equal(htmlToText('a<!-- c -->b<script>x</script>c<STYLE >y</style >d<template>t</template>e'), 'a b c d e');
  assert.equal(htmlToText('keep <b <script>gone</script>- </script> tail'), 'keep tail', 'elements before tags: "<b … >" swallows "- "');
  assert.equal(htmlToText('x <script>never closed <p>more'), 'x');
  assert.equal(htmlToText('a <noscript>open b'), 'a open b');
  assert.equal(htmlToText('1 < 2 and <3 <a href="x">link</a> &amp; <!doctype html>'), '1 < 2 and <3 link &');
  assert.equal(htmlToText('<a'.repeat(5)), '<a<a<a<a<a', 'no ">" anywhere: nothing is a tag');
  // Markdown: links/images/reference links, tags, emphasis (snake_case untouched), fences, tables.
  assert.equal(markdownToPlain('![alt](i.png) [text](u) [ref][r] <b>x</b> __bold__ _em_ snake_case_name ~~del~~ `code`'),
    'alt text ref x bold em snake_case_name del code');
  assert.equal(markdownToPlain('[unclosed [also](x) ] tail'), 'unclosed [also ] tail', 'the first "[" pairs with the first "]"');
  assert.equal(markdownToPlain('| a | b |\n| --- | --: |\n| 1 | 2 |'), 'a b 1 2');
  assert.equal(markdownToPlain('| a |\n| :-: |'), 'a :-:', 'a delimiter cell needs two dashes');
  assert.equal(markdownToPlain('- item\n  1. sub\n> quote\n# Head\n```\ncode\n```'), 'item sub quote Head code');
  assert.equal(docTitle({}, '# A **b** #'), 'A b');
  assert.equal(docTitle({}, '#  ##'), '##');
  assert.equal(docTitle({ contentType: 'html' }, '<title-x>no</title-x><title>T &amp; U</title>'), 'no T & U', '<title\\b also opens at <title-x>');
  assert.equal(docTitle({ contentType: 'html' }, '<titles>x</titles><h1>H</h1>'), 'H');
});
