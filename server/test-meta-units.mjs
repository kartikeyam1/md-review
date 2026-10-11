// Unit tests for the #22 pure helpers: meta-page text (doc-text.cjs) and the
// cover template maths (cover.cjs). No server, no DB.
//   node --test server/test-meta-units.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { truncateText, docDescription } = require('./doc-text.cjs');
const cover = require('./cover.cjs');

const cps = (s) => [...s].length;

test('truncateText: short text unchanged; long text cut at a word boundary with …', () => {
  assert.equal(truncateText('short words', 200), 'short words');
  const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
  const t = truncateText(words, 50);
  assert.ok(cps(t) <= 50 && t.endsWith('…'), t);
  assert.ok(words.startsWith(t.slice(0, -1)));
  assert.equal(words[t.length - 1], ' ', 'the next character after the kept text is whitespace');
});

test('truncateText: no whitespace → hard cut; surrogate pairs never split', () => {
  assert.equal(truncateText('x'.repeat(30), 10), `${'x'.repeat(9)}…`);
  const e = truncateText('😀'.repeat(300), 200);
  assert.equal(cps(e), 200);
  assert.ok(e.isWellFormed());
});

test('docDescription (markdown): TL;DR heading, TL;DR label, first paragraph, generic fallback', () => {
  const d = (md) => docDescription({ contentType: 'markdown' }, md);
  assert.equal(d('# T\n\nIntro.\n\n## TL;DR\nThe summary.'), 'The summary.');
  assert.equal(d('# T\n\nIntro.\n\n### tldr\n\nLower case.'), 'Lower case.');
  assert.equal(d('Intro.\n\n**TL;DR:** Bold label.'), 'Bold label.');
  assert.equal(d('Intro.\n\nTL;DR – dash label.'), 'dash label.');
  assert.equal(d('# T\n\n> Quoted **first** [para](u).\n\nNext.'), 'Quoted first para.');
  assert.equal(d('Setext\n======\n\n- item one\n- item two'), 'item one item two');
  assert.equal(d('```\ncode\n```\n\n    indented code\n\n<!-- c -->\n\n---\n\nReal text &amp; more.'), 'Real text & more.');
  assert.equal(d('<!-- agent -->\nAgent only.\n<!-- /agent -->\n\nHuman text.'), 'Human text.');
  assert.equal(d('![only an image](x.png)'), 'Markdown document shared on md-review');
  assert.equal(d(''), 'Markdown document shared on md-review');
});

test('docDescription (HTML): TL;DR, <meta name=description>, first <p>, generic', () => {
  const d = (html) => docDescription({ contentType: 'html' }, html);
  assert.equal(d('<h2>TL;DR</h2><p>Html summary.</p><meta name="description" content="Meta">'), 'Html summary.');
  assert.equal(d("<meta content='A &amp; B' name='description'><p>Para.</p>"), 'A & B');
  assert.equal(d('<head><title>T</title></head><body><script>x()</script><p>  First   para. </p></body>'), 'First para.');
  assert.equal(d('<body></body>'), 'HTML document shared on md-review');
});

test('metaLine / coverKey: type, author and UTC day; key changes with title and line', () => {
  assert.equal(cover.metaLine({ contentType: 'html', author: 'Ann  Lee', updatedAt: '2026-01-05T23:30:00Z' }), 'HTML · by Ann Lee · Updated 5 Jan 2026');
  assert.equal(cover.metaLine({ contentType: 'markdown' }), 'Markdown');
  const k = cover.coverKey('T', 'Markdown');
  assert.match(k, /^[0-9a-f]{12}$/);
  assert.equal(cover.coverKey('T', 'Markdown'), k);
  assert.notEqual(cover.coverKey('T2', 'Markdown'), k);
  assert.notEqual(cover.coverKey('T', 'HTML'), k);
});

test('xmlText escapes markup and drops XML-invalid characters', () => {
  assert.equal(cover.xmlText(`<a href="x">&'\u0001</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  assert.equal(cover.xmlText('\uD800x'), '�x');
});

test('layoutTitle: short titles stay large; long ones shrink, then cap at 3 lines with …', () => {
  const measure = (t, size) => [...t].length * size * 0.6; // monospace stand-in
  assert.deepEqual(cover.layoutTitle('Short title', measure), { size: 64, lines: ['Short title'] });
  const long = Array.from({ length: 200 }, () => 'word').join(' ');
  const { size, lines } = cover.layoutTitle(long, measure);
  assert.equal(size, 40);
  assert.equal(lines.length, 3);
  assert.ok(lines[2].endsWith('…'));
  for (const l of lines) assert.ok(measure(l, size) <= 1040, l);
  const one = cover.layoutTitle('w'.repeat(500), measure);
  assert.equal(one.lines.length, 3, 'a single long word is broken by character');
});

test('fontMetrics reads the bundled Montserrat: wider at a larger size, missing glyphs count 1 em', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const m = cover.fontMetrics(fs.readFileSync(path.join(import.meta.dirname, 'assets', 'fonts', 'Montserrat-SemiBold.ttf')));
  const a = m.width('Hello', 40);
  assert.ok(a > 80 && a < 200, String(a));
  assert.ok(m.width('Hello', 64) > a);
  assert.ok(m.width('W', 10) > m.width('i', 10));
  assert.equal(m.width('東', 50), 50);
});

// ── review fixes: linear-time text extraction, description quality, cover text ──

const { docTitle, effectiveContentType } = require('./doc-text.cjs');

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

test('pathological 1 MB inputs: description and title extraction stay under 50 ms (unclosed tags, comments, brackets)', () => {
  const MB = 1024 * 1024;
  const fill = (u) => u.repeat(Math.ceil(MB / u.length)).slice(0, MB);
  const cases = [
    ['html', fill('<p>')], ['html', fill('<meta name="description" ')], ['html', fill('<!--')], ['html', fill('<script')],
    ['html', fill('<title>')], ['html', fill('<h1 ')], ['html', fill('<a')], ['html', `<p>${fill('&amp')}`],
    ['markdown', fill('<!--')], ['markdown', fill('[a')], ['markdown', fill('**a')], ['markdown', fill('_a ')],
    ['markdown', `# ${fill('[a')}`], ['markdown', `# a${' '.repeat(MB)}b`], ['markdown', `| a |\n${fill('| - ')}x`],
    ['markdown', fill('<a')], ['markdown', fill('![a')], ['markdown', fill('# [a\n')], ['markdown', fill('a\n\n')],
    ['markdown', fill('![a](b)\n\n')], ['markdown', fill('TL;DR [a ')], ['markdown', `---\n${fill('a\n')}`],
  ];
  for (const [contentType, src] of cases) {
    const ms = bestMs(() => {
      docDescription({ contentType }, src);
      docTitle({ contentType }, src.slice(0, 256 * 1024)); // the meta page reads at most SCAN_CAP
    });
    if (process.env.MDREVIEW_PERF_LOG) console.log(`${ms.toFixed(1)} ms  ${contentType} ${JSON.stringify(src.slice(0, 24))}`);
    assert.ok(ms < 50, `${contentType} ${JSON.stringify(src.slice(0, 24))}…: ${ms.toFixed(1)} ms`);
  }
});

test('docDescription quality: lone TL;DR label, BOM, escapes, autolinks, entities; type inferred from a .html name', () => {
  const md = (s) => docDescription({ contentType: 'markdown' }, s);
  assert.equal(md('# T\n\nIntro.\n\n**TL;DR**\n\nThe real summary.'), 'The real summary.');
  assert.equal(md('﻿First paragraph after a BOM.'), 'First paragraph after a BOM.');
  assert.equal(md('Not \\*bold\\*, 1\\. item, a \\[bracket\\] and \\<tag\\>.'), 'Not *bold*, 1. item, a [bracket] and <tag>.');
  assert.equal(md('See <https://example.com/a_b> and <me@example.com>.'), 'See https://example.com/a_b and me@example.com.');
  assert.equal(md('Fish &amp; chips &lt;3'), 'Fish & chips <3');
  assert.equal(docDescription({ filename: 'r.html' }, '<head><meta name="description" content="Inferred"></head>'), 'Inferred');
  assert.equal(effectiveContentType({ filename: 'x.HTM' }), 'html');
  assert.equal(effectiveContentType({ filename: 'x.md' }), 'markdown');
  assert.equal(effectiveContentType({ contentType: 'markdown', filename: 'x.html' }), 'markdown');
});

test('docTitle: H1 entities decoded and escapes honoured; BOM before an H1; unclosed <title> is no title', () => {
  assert.equal(docTitle({}, '# Fish &amp; chips \\*not em\\*'), 'Fish & chips *not em*');
  assert.equal(docTitle({}, '﻿# After BOM'), 'After BOM');
  assert.equal(docTitle({ contentType: 'html' }, '<title>Open but never closed <h1>Head</h1>'), 'Head');
  assert.equal(docTitle({ contentType: 'html' }, '<TITLE >A &amp; B</title >'), 'A & B');
});

test('coverText: emoji (ZWJ, flags, modifiers, keycaps) and glyph-less characters are dropped; fallbacks', () => {
  const base = { contentType: 'markdown', updatedAt: '2026-10-10T10:00:00Z' };
  assert.equal(cover.drawableText('👩‍💻 Launch 🇬🇧 plan 👍🏽 1️⃣', null), 'Launch plan 1');
  const a = cover.coverText({ ...base, title: '🚀 Launch 🚀', filename: 'x.md' });
  assert.equal(a.title, 'Launch');
  assert.equal(a.key, cover.coverText({ ...base, title: 'Launch', filename: 'y.md' }).key, 'same drawn cover → same key');
  assert.equal(cover.coverText({ ...base, title: '路线评审', filename: 'route-plan.md' }).title, 'route-plan', 'no Montserrat glyphs → filename');
  assert.equal(cover.coverText({ ...base, title: '😀😀', filename: '东京.md' }).title, 'Markdown document');
  assert.equal(cover.coverText({ ...base, contentType: 'html', title: '— · —' }).title, 'HTML document');
});

test('coverText: a long author is cut with … so the date always fits; no author → no "by"', () => {
  const t = { title: 'T', contentType: 'markdown', updatedAt: '2026-10-10T10:00:00Z' };
  const long = cover.coverText({ ...t, author: 'Very Long Name '.repeat(20) }).line;
  assert.match(long, /^Markdown · by Very Long Name.*… · Updated 10 Oct 2026$/);
  assert.equal(cover.coverText({ ...t, author: 'Ann' }).line, 'Markdown · by Ann · Updated 10 Oct 2026');
  assert.equal(cover.coverText({ ...t, author: null }).line, 'Markdown · Updated 10 Oct 2026');
  assert.equal(cover.coverText({ ...t, author: '😀' }).line, 'Markdown · Updated 10 Oct 2026');
});
