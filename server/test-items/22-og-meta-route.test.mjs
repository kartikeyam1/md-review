// Item #22 — server-rendered /d/:slug meta page (HTML half).
// Spec: docs/build/specs/22-og-meta-route.md (+ 00 §5 docTitle, §6 URLs).
// The PNG cover lives in 22-og-cover.test.mjs; PUBLIC_BASE_URL / FRONTEND_URL /
// MCP shareUrl in 22-public-base-url.test.mjs. Helpers + gating: 22-helpers.mjs.
//
// Runs against E2E_API_URL / MDREVIEW_API / PASTE_API when set, else boots its own backend.
// Real Slack unfurls are out of scope (owner): bots are simulated by User-Agent.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIP, sharedBackend, cleanupTmp, request, createDoc, createExpiredDoc, putMeta, putMarkdown,
  getMeta, one, refreshTarget, scriptNavigations, hasRedirect, UA, BOT_UAS, uniq, cpLen, escapeRe,
} from './22-helpers.mjs';

const SUFFIX = ' · md-review';

describe('#22 /d/:slug meta page', { skip: SKIP }, () => {
  let B;
  before(async () => { B = await sharedBackend(); });
  after(async () => { await B?.stop(); cleanupTmp(); });

  const app = (x) => `${B.frontend}/d/${x}`;
  const share = (x) => `${B.publicBase}/d/${x}`;

  /** Bot fetch of /d/<x>, asserting a 200 HTML page. */
  async function botPage(x, ua = UA.slack) {
    const r = await getMeta(B.url, `/d/${x}`, ua);
    assert.equal(r.status, 200, `GET /d/${x} (${ua}) → ${r.status}: ${r.text.slice(0, 300)}`);
    return r;
  }
  async function titleOf(body) {
    const d = await createDoc(B.url, body);
    const r = await botPage(d.x);
    return { doc: d, title: one(r.doc, 'og:title'), page: r };
  }
  async function descOf(body) {
    const d = await createDoc(B.url, body);
    const r = await botPage(d.x);
    return one(r.doc, 'og:description');
  }

  // ── AC-22.1 / rule 2: the bot page ────────────────────────────────────────

  test('AC-22.1 Slackbot gets 200 HTML with og:title, twitter:card summary_large_image and no redirect', async () => {
    const d = await createDoc(B.url, { sessionName: 'Q3 routing review', filename: 'q3.md', markdown: '# Something else\n\nBody para.' });
    assert.ok(d.slug, 'POST /paste with a sessionName returns a slug');
    const r = await getMeta(B.url, `/d/${d.slug}`, 'Slackbot-LinkExpanding 1.0');
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.match(r.headers['content-type'] || '', /^text\/html;\s*charset=utf-8$/i);
    assert.equal(one(r.doc, 'og:title'), 'Q3 routing review');
    assert.equal(one(r.doc, 'twitter:card'), 'summary_large_image');
    assert.ok(!/http-equiv\s*=\s*["']?refresh/i.test(r.text), 'no http-equiv="refresh" for a bot');
    assert.ok(!r.text.includes('location.replace'), 'no location.replace for a bot');
    assert.ok(!hasRedirect(r.doc), 'no navigation of any kind for a bot');
  });

  test('AC-22.1 (rule 2) the head carries the full, HTML-escaped tag set and the body a fallback', async () => {
    const t0 = Date.now();
    const d = await createDoc(B.url, { sessionName: `Full tag set ${uniq()}`, filename: 'full.md', markdown: '# H\n\nThe first paragraph.\n\nSecond.' });
    const { doc } = await botPage(d.slug);
    const title = one(doc, 'og:title');
    assert.match(title, /^Full tag set [0-9a-f]{8}$/);
    assert.equal(doc.title, `${title}${SUFFIX}`, '<title>');
    const desc = one(doc, 'description');
    assert.equal(desc, 'The first paragraph.', '<meta name=description>');
    assert.equal(one(doc, 'robots').replace(/\s+/g, '').toLowerCase(), 'noindex,nofollow');
    assert.deepEqual(doc.canonical, [share(d.slug)], '<link rel=canonical>');
    assert.equal(one(doc, 'og:site_name'), 'md-review');
    assert.equal(one(doc, 'og:type'), 'article');
    assert.equal(one(doc, 'og:description'), desc);
    assert.equal(one(doc, 'og:url'), share(d.slug));
    const img = one(doc, 'og:image');
    assert.match(img, new RegExp(`^${escapeRe(share(d.slug))}/cover\\.png\\?v=[0-9a-f]{12}$`), 'og:image');
    assert.equal(one(doc, 'og:image:type'), 'image/png');
    assert.equal(one(doc, 'og:image:width'), '1200');
    assert.equal(one(doc, 'og:image:height'), '630');
    assert.equal(one(doc, 'og:image:alt'), title);
    const mod = one(doc, 'article:modified_time');
    assert.match(mod, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/, 'article:modified_time is ISO 8601');
    assert.ok(Math.abs(Date.parse(mod) - t0) < 10 * 60 * 1000, `article:modified_time ${mod} is the doc's updated_at (now-ish)`);
    assert.equal(one(doc, 'twitter:title'), title);
    assert.equal(one(doc, 'twitter:description'), desc);
    assert.equal(one(doc, 'twitter:image'), img);
    assert.ok(doc.h1s.includes(title), `<body> has an <h1> with the title (got ${JSON.stringify(doc.h1s)})`);
    assert.ok(doc.ps.includes(desc), `<body> has a <p> with the description (got ${JSON.stringify(doc.ps)})`);
    assert.ok(doc.anchors.some((a) => a.href === app(d.slug)), `<body> links to the app URL ${app(d.slug)}`);
  });

  test('AC-22.1 (rule 2) article:modified_time follows the doc\'s updated_at', async () => {
    const d = await createDoc(B.url, { sessionName: `Modified ${uniq()}`, filename: 'm.md', markdown: 'v1' });
    const before1 = one((await botPage(d.slug)).doc, 'article:modified_time');
    await new Promise((r) => setTimeout(r, 20));
    await putMarkdown(B.url, d.id, 'v2 changed body');
    const after1 = one((await botPage(d.slug)).doc, 'article:modified_time');
    assert.ok(Date.parse(after1) > Date.parse(before1), `${after1} > ${before1}`);
  });

  // ── AC-22.2 / rule 5: humans are redirected ───────────────────────────────

  test('AC-22.2 a Chrome UA gets meta refresh + script redirect to {FRONTEND_URL}/d/<slug>; ?view=slides is carried', async () => {
    const name = `Human redirect ${uniq()}`;
    const d = await createDoc(B.url, { sessionName: name, filename: 'h.md', markdown: '# T\n\nBody.' });
    const r = await getMeta(B.url, `/d/${d.slug}`, UA.chrome);
    assert.equal(r.status, 200);
    assert.equal(r.doc.refreshes.length, 1, 'exactly one meta refresh');
    assert.equal(refreshTarget(r.doc.refreshes[0]), app(d.slug), 'meta refresh target');
    assert.deepEqual(scriptNavigations(r.doc, ''), [app(d.slug)], 'script target (no hash)');
    assert.equal(one(r.doc, 'og:title'), name, 'humans still get the meta tags');
    assert.ok(one(r.doc, 'og:image'), 'humans still get og:image');

    const s = await getMeta(B.url, `/d/${d.slug}?view=slides`, UA.chrome);
    assert.equal(s.status, 200);
    assert.equal(refreshTarget(s.doc.refreshes[0]), `${app(d.slug)}?view=slides`);
    const nav = scriptNavigations(s.doc, '');
    assert.equal(nav.length, 1);
    assert.ok(nav[0].endsWith(`/d/${d.slug}?view=slides`), nav[0]);
    assert.equal(nav[0], `${app(d.slug)}?view=slides`);
  });

  test('AC-22.2 (rule 5) the JS redirect appends the browser-side #fragment; the meta refresh carries none', async () => {
    const d = await createDoc(B.url, { sessionName: `Fragment ${uniq()}`, filename: 'f.md', markdown: '# T\n\n## Section two\n\nBody.' });
    const r = await getMeta(B.url, `/d/${d.slug}?view=slides`, UA.chrome);
    assert.deepEqual(scriptNavigations(r.doc, '#section-two'), [`${app(d.slug)}?view=slides#section-two`]);
    const plain = await getMeta(B.url, `/d/${d.slug}`, UA.chrome);
    assert.deepEqual(scriptNavigations(plain.doc, '#section-two'), [`${app(d.slug)}#section-two`]);
    assert.ok(!refreshTarget(plain.doc.refreshes[0]).includes('#'), 'meta refresh has no fragment');
  });

  test('AC-22.2 (rule 5) the query string is carried verbatim (several params, edit token)', async () => {
    const d = await createDoc(B.url, { sessionName: `Query ${uniq()}`, filename: 'q.md', markdown: 'Body.' });
    const q = '?view=slides&edit=abc123DEF_-x&embed=1';
    const r = await getMeta(B.url, `/d/${d.slug}${q}`, UA.chrome);
    assert.equal(r.status, 200);
    assert.equal(refreshTarget(r.doc.refreshes[0]), `${app(d.slug)}${q}`, 'meta refresh (attribute-decoded)');
    assert.deepEqual(scriptNavigations(r.doc, '#h'), [`${app(d.slug)}${q}#h`]);
  });

  test('rule 5: a hostile query string cannot break out of the <script> or the meta attribute', async () => {
    const d = await createDoc(B.url, { sessionName: `Hostile query ${uniq()}`, filename: 'x.md', markdown: 'Body.' });
    const q = '?x=</script><script>alert(1)</script>"\'><img/src=x/onerror=alert(2)><!--';
    const r = await getMeta(B.url, `/d/${d.slug}${q}`, UA.chrome);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('<script>alert(1)'), 'no injected <script>');
    assert.ok(!/<img/i.test(r.text), 'no injected <img>');
    assert.equal(r.doc.scripts.length, 1, 'exactly one <script> element');
    assert.equal(r.doc.refreshes.length, 1);
    assert.equal(refreshTarget(r.doc.refreshes[0]), `${app(d.slug)}${q}`, 'meta refresh target is the verbatim query, attribute-escaped');
    assert.deepEqual(scriptNavigations(r.doc, ''), [`${app(d.slug)}${q}`], 'TARGET is JSON-encoded with < escaped');
  });

  test('rule 5: every listed unfurler UA (case-insensitive) gets the meta page with no redirect', async () => {
    const d = await createDoc(B.url, { sessionName: `Bots ${uniq()}`, filename: 'b.md', markdown: 'Body.' });
    const uas = { ...BOT_UAS, 'slackbot (lowercase)': 'slackbot-linkexpanding 1.0', 'TWITTERBOT (uppercase)': 'TWITTERBOT/1.0' };
    for (const [name, ua] of Object.entries(uas)) {
      const r = await getMeta(B.url, `/d/${d.slug}`, ua);
      assert.equal(r.status, 200, `${name}: ${r.status}`);
      assert.ok(one(r.doc, 'og:title').startsWith('Bots '), `${name}: og:title`);
      assert.ok(!hasRedirect(r.doc), `${name} (${ua}) must not be redirected`);
    }
  });

  test('rule 5: browsers, curl, an empty and a missing User-Agent are treated as humans', async () => {
    const d = await createDoc(B.url, { sessionName: `Humans ${uniq()}`, filename: 'h.md', markdown: 'Body.' });
    const uas = { chrome: UA.chrome, safariIphone: UA.safariIphone, firefox: UA.firefox, curl: UA.curl, empty: '', missing: null };
    for (const [name, ua] of Object.entries(uas)) {
      const r = await getMeta(B.url, `/d/${d.slug}`, ua);
      assert.equal(r.status, 200, `${name}: ${r.status}`);
      assert.equal(r.doc.refreshes.length, 1, `${name}: meta refresh`);
      assert.equal(refreshTarget(r.doc.refreshes[0]), app(d.slug), `${name}: refresh target`);
      assert.deepEqual(scriptNavigations(r.doc, '#a'), [`${app(d.slug)}#a`], `${name}: script target`);
    }
  });

  // ── AC-22.3 / AC-22.4 / rule 4: description ───────────────────────────────

  test('AC-22.3 the paragraph after a TL;DR heading is the description', async () => {
    assert.equal(await descOf({ filename: 'a.md', markdown: '# Title\n\n## TL;DR\nShipped the thing. More text…' }),
      'Shipped the thing. More text…');
  });

  test('AC-22.3 TL;DR wins over an earlier first paragraph (heading and inline-label forms)', async () => {
    assert.equal(await descOf({ filename: 'b.md', markdown: '# Title\n\nIntro paragraph that comes first.\n\n## TL;DR\nShipped the thing. More text…\n\n## Details\n\nMore.' }),
      'Shipped the thing. More text…', '## TL;DR');
    assert.equal(await descOf({ filename: 'c.md', markdown: '# Title\n\nIntro paragraph.\n\n### tldr\n\nShort version here.' }),
      'Short version here.', '### tldr (no semicolon, lower case)');
    assert.equal(await descOf({ filename: 'd.md', markdown: '# Title\n\nIntro paragraph.\n\n**TL;DR:** Shipped it.' }),
      'Shipped it.', 'bold **TL;DR:** label removed');
    assert.equal(await descOf({ filename: 'e.md', markdown: '# Title\n\nIntro paragraph.\n\nTL;DR: Plain shipped.' }),
      'Plain shipped.', 'plain TL;DR: label removed');
  });

  test('AC-22.4 a 400-char first paragraph is cut to ≤200 chars at a word boundary with …, markdown stripped', async () => {
    const lead = 'This **bold** claim and a [link](https://x.example/y) and `code` start the paragraph';
    const plainLead = 'This bold claim and a link and code start the paragraph';
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(' ');
    let filler = ''; let i = 0;
    while ((lead + filler).length < 400) filler += ` ${words[i++ % words.length]}`;
    const desc = await descOf({ filename: 'long.md', markdown: `# Heading\n\n${lead}${filler}\n\nNext paragraph.` });
    const plain = `${plainLead}${filler}`;
    assert.ok(cpLen(desc) <= 200, `≤200 chars (got ${cpLen(desc)})`);
    assert.ok(desc.endsWith('…'), `ends with … (${JSON.stringify(desc)})`);
    assert.ok(desc.includes('bold') && desc.includes('link') && desc.includes('code'));
    for (const bad of ['**', '[', '](', '`']) assert.ok(!desc.includes(bad), `no ${bad} in ${JSON.stringify(desc)}`);
    const cut = desc.slice(0, -1).trimEnd();
    assert.ok(plain.startsWith(cut), `description is a prefix of the plain paragraph: ${JSON.stringify(cut)}`);
    assert.ok(cut.length >= 100, 'cut reasonably close to 200 chars');
    assert.match(plain[cut.length] ?? ' ', /\s/, 'cut at a word boundary (the next char is whitespace)');
  });

  test('rule 4c: the fallback paragraph skips front matter, headings, comments, code fences, tables and images; whitespace collapsed', async () => {
    const md = [
      '---', 'title: Front Title', 'tags: [a, b]', '---',
      '# Heading One', '',
      '<!-- hidden comment text -->', '',
      '```js', 'const codeText = 1;', '```', '',
      '| col | col2 |', '| --- | --- |', '| tableText | x |', '',
      '![image alt](https://x.example/img.png)', '',
      'The real   first', 'paragraph here.', '',
      'Second paragraph.',
    ].join('\n');
    const d = await createDoc(B.url, { filename: 'fallback.md', markdown: md });
    const { doc } = await botPage(d.x);
    assert.equal(one(doc, 'og:description'), 'The real first paragraph here.');
    assert.equal(one(doc, 'og:title'), 'Front Title', '00 §5: front-matter title: beats the first H1');
  });

  test('rule 4d: a doc that is only a code block / only a table gets the generic description', async () => {
    assert.equal(await descOf({ filename: 'code.md', markdown: '```\nonly code here\n```\n' }), 'Markdown document shared on md-review');
    assert.equal(await descOf({ filename: 'table.md', markdown: '| a | b |\n| - | - |\n| 1 | 2 |\n' }), 'Markdown document shared on md-review');
    assert.equal(await descOf({ filename: 'empty.html', contentType: 'html', markdown: '<!doctype html><html><head><title>T</title></head><body></body></html>' }),
      'HTML document shared on md-review');
  });

  test('rule 4: a 10 KB single-line paragraph still yields a ≤200-char description ending in …', async () => {
    const desc = await descOf({ filename: 'huge.md', markdown: `${'word '.repeat(2048)}` });
    assert.ok(cpLen(desc) <= 200 && desc.endsWith('…'), JSON.stringify(desc));
  });

  // ── rule 3 / 00 §5: title ──────────────────────────────────────────────────

  test('rule 3 (00 §5) title precedence: sessionName → front matter → first H1 (plain text, outside fences) → filename → Untitled', async () => {
    const cases = [
      [{ sessionName: '  Named  ', filename: 'n.md', markdown: '---\ntitle: FM\n---\n# H1' }, 'Named'],
      [{ filename: 'fm.md', markdown: '---\ntitle: "Quoted FM"\n---\n# H1 loses' }, 'Quoted FM'],
      [{ filename: 'h.md', markdown: 'Intro.\n\n# **Bold** `code` [link](https://u.example) _em_\n\nText.' }, 'Bold code link em'],
      [{ filename: 'fence.md', markdown: '```\n# Not this\n```\n\n# Real H1\n\nText.' }, 'Real H1'],
      [{ filename: 'notes-2026.md', markdown: '#nospace is not a heading\n\nText.' }, 'notes-2026'],
      [{ filename: 'deck.markdown', markdown: 'Just text.' }, 'deck'],
      [{ markdown: 'Just text, no filename.' }, 'Untitled'],
      [{ sessionName: 'Line one\nLine   two\tthree', filename: 'w.md', markdown: 'x' }, 'Line one Line two three'],
    ];
    for (const [body, want] of cases) {
      const { title, page } = await titleOf(body);
      assert.equal(title, want, `og:title for ${JSON.stringify(body).slice(0, 80)}`);
      assert.equal(page.doc.title, `${want}${SUFFIX}`);
    }
  });

  test('rule 3: very long titles are cut to ≤200 characters (ASCII, 10 KB single line, emoji without broken surrogates)', async () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const { title: t1, page } = await titleOf({ sessionName: words, filename: 'l.md', markdown: 'x' });
    assert.ok(cpLen(t1) <= 200, `≤200 (got ${cpLen(t1)})`);
    assert.ok(words.startsWith(t1.replace(/…$/, '').trimEnd()), 'a prefix of the full title');
    assert.equal(page.doc.title, `${t1}${SUFFIX}`);

    const huge = 'x'.repeat(10 * 1024);
    const { title: t2, page: p2 } = await titleOf({ sessionName: huge, filename: 'huge.md', markdown: 'x' });
    assert.ok(cpLen(t2) <= 200, `10 KB title cut (got ${cpLen(t2)})`);
    assert.ok(p2.buf.length < 16 * 1024, `meta page stays small (${p2.buf.length} bytes)`);

    const emoji = '😀'.repeat(300);
    const { title: t3 } = await titleOf({ sessionName: emoji, filename: 'e.md', markdown: 'x' });
    assert.ok(cpLen(t3) <= 200, `emoji title ≤200 code points (got ${cpLen(t3)})`);
    assert.ok(!t3.includes('\uFFFD') && t3.isWellFormed(), 'no split surrogate pair');
  });

  // ── AC-22.5 / rule 2: escaping ─────────────────────────────────────────────

  test('AC-22.5 a sessionName with <script>, & and quotes is HTML-escaped everywhere', async () => {
    const name = '<script>alert(1)</script> & "q"';
    const d = await createDoc(B.url, { sessionName: name, filename: 's.md', markdown: 'Body.' });
    for (const ua of [UA.slack, UA.chrome]) {
      const r = await getMeta(B.url, `/d/${d.x}`, ua);
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes('<script>alert'), `no unescaped <script>alert (${ua})`);
      assert.equal(one(r.doc, 'og:title'), name, 'og:title content attribute decodes to the exact title');
      assert.equal(one(r.doc, 'twitter:title'), name);
      assert.equal(one(r.doc, 'og:image:alt'), name);
      assert.equal(r.doc.title, `${name}${SUFFIX}`);
      assert.ok(r.doc.h1s.includes(name), '<h1> text');
      assert.equal(r.doc.scripts.length, ua === UA.slack ? 0 : 1, 'no extra <script> elements');
    }
  });

  test('rule 2: quotes, literal entities, RTL, emoji/CJK and newlines round-trip through the escaping exactly once', async () => {
    const cases = [
      [`It's "quoted" &amp; <b>bold</b>`, `It's "quoted" &amp; <b>bold</b>`],
      ['مراجعة التوجيه \u202Eevil\u202C', 'مراجعة التوجيه \u202Eevil\u202C'],
      ['🚀 路线评审 — 東京 ✅', '🚀 路线评审 — 東京 ✅'],
      ['A\nB', 'A B'],
    ];
    for (const [name, want] of cases) {
      const d = await createDoc(B.url, { sessionName: name, filename: 'u.md', markdown: 'Body.' });
      const r = await botPage(d.x);
      assert.equal(one(r.doc, 'og:title'), want, JSON.stringify(name));
      assert.equal(r.doc.title, `${want}${SUFFIX}`);
      assert.ok(!r.text.includes('\uFFFD'), 'valid UTF-8 output');
      assert.ok(!r.text.includes('<b>bold'), 'markup in titles is escaped');
    }
    const desc = await descOf({ filename: 'd.md', markdown: '# T\n\nHello <script>alert(3)</script> & "friends" it\'s fine.' });
    assert.ok(desc.includes('Hello') && desc.includes('"friends"') && desc.includes('&'), JSON.stringify(desc));
    const d2 = await createDoc(B.url, { filename: 'd2.md', markdown: '# T\n\nHello <script>alert(3)</script> & "friends".' });
    const r2 = await botPage(d2.x);
    assert.ok(!r2.text.includes('<script>alert(3)'), 'no unescaped <script> from the description');
  });

  // ── AC-22.9 / rule 6: not found / expired ─────────────────────────────────

  test('AC-22.9 an unknown slug → 404 HTML "Document not found", no og:image; humans still redirected to the app URL', async () => {
    const x = `no-such-doc-${uniq()}`;
    const bot = await getMeta(B.url, `/d/${x}`, UA.slack);
    assert.equal(bot.status, 404);
    assert.match(bot.headers['content-type'] || '', /^text\/html/i);
    assert.equal(bot.doc.title, 'Document not found · md-review');
    assert.deepEqual(bot.doc.metaAll('og:image'), [], 'no og:image');
    assert.deepEqual(bot.doc.metaAll('twitter:image'), [], 'no twitter:image');
    assert.ok(!hasRedirect(bot.doc), 'bots are not redirected');
    const human = await getMeta(B.url, `/d/${x}?view=slides`, UA.chrome);
    assert.equal(human.status, 404);
    assert.equal(human.doc.title, 'Document not found · md-review');
    assert.equal(refreshTarget(human.doc.refreshes[0]), `${app(x)}?view=slides`);
    assert.deepEqual(scriptNavigations(human.doc, '#top'), [`${app(x)}?view=slides#top`]);
  });

  test('AC-22.9 an expired doc → 410 HTML "Expired document", fixed description, no og:image, stored title and content absent', async () => {
    const tag = uniq();
    const slug = `exp-doc-${tag}`;
    const d = await createExpiredDoc(B.url, { slug, sessionName: `Classified Quarterly Numbers ${tag}`, filename: 'secret.md', markdown: `# Secret Heading ${tag}\n\nSecretBodyToken ${tag}.` });
    const x = d.slug || d.id;
    for (const ua of [UA.slack, UA.chrome]) {
      const r = await getMeta(B.url, `/d/${x}`, ua);
      assert.equal(r.status, 410, `${ua}: ${r.status}`);
      assert.match(r.headers['content-type'] || '', /^text\/html/i);
      assert.equal(r.doc.title, 'Expired document · md-review');
      assert.equal(one(r.doc, 'description'), 'This document has expired.');
      assert.deepEqual(r.doc.metaAll('og:image'), []);
      assert.deepEqual(r.doc.metaAll('twitter:image'), []);
      for (const leak of ['Classified', 'Quarterly', 'Secret Heading', 'SecretBodyToken']) {
        assert.ok(!r.text.includes(leak), `${ua}: must not leak "${leak}"`);
      }
      if (ua === UA.chrome) assert.equal(refreshTarget(r.doc.refreshes[0]), app(x), 'humans redirected to the app URL');
      else assert.ok(!hasRedirect(r.doc), 'bots not redirected');
    }
  });

  // ── AC-22.10 / rule 7: caching ─────────────────────────────────────────────

  test('AC-22.10 a second GET with the returned ETag in If-None-Match (same UA) → 304; rule 7 headers', async () => {
    const d = await createDoc(B.url, { sessionName: `Etag ${uniq()}`, filename: 'e.md', markdown: '# T\n\nBody.' });
    const etags = {};
    for (const [name, ua] of [['bot', UA.slack], ['human', UA.chrome]]) {
      const r = await getMeta(B.url, `/d/${d.slug}`, ua);
      assert.equal(r.status, 200);
      const cc = (r.headers['cache-control'] || '').toLowerCase();
      assert.ok(cc.includes('public') && /max-age=60\b/.test(cc), `${name}: Cache-Control "${cc}"`);
      assert.ok(/(^|,)\s*user-agent\s*(,|$)/i.test(r.headers.vary || ''), `${name}: Vary includes User-Agent ("${r.headers.vary}")`);
      assert.ok(r.headers.etag, `${name}: ETag present`);
      etags[name] = r.headers.etag;
      const again = await getMeta(B.url, `/d/${d.slug}`, ua, { 'If-None-Match': r.headers.etag });
      assert.equal(again.status, 304, `${name}: conditional GET → 304`);
      assert.equal(again.buf.length, 0, '304 has no body');
    }
    assert.notEqual(etags.bot, etags.human, 'the bot and human variants have different ETags');
    const cross = await getMeta(B.url, `/d/${d.slug}`, UA.chrome, { 'If-None-Match': etags.bot });
    assert.equal(cross.status, 200, "a bot's ETag does not validate the human variant");
  });

  test('rule 7: the ETag changes when the title or description changes', async () => {
    const d = await createDoc(B.url, { sessionName: `Etag change ${uniq()}`, filename: 'e.md', markdown: '# T\n\nFirst body.' });
    const r1 = await getMeta(B.url, `/d/${d.slug}`, UA.slack);
    assert.equal(r1.status, 200, `GET /d/${d.slug} → ${r1.status}`);
    const e1 = r1.headers.etag;
    assert.ok(e1, 'ETag present');
    await putMarkdown(B.url, d.id, '# T\n\nA different first paragraph.');
    const r2 = await getMeta(B.url, `/d/${d.slug}`, UA.slack, { 'If-None-Match': e1 });
    assert.equal(r2.status, 200, 'description changed → old ETag no longer matches');
    assert.equal(one(r2.doc, 'og:description'), 'A different first paragraph.');
    await putMeta(B.url, d.id, { sessionName: `Renamed ${uniq()}` });
    assert.ok(r2.headers.etag, 'ETag present');
    const r3 = await getMeta(B.url, `/d/${d.slug}`, UA.slack, { 'If-None-Match': r2.headers.etag });
    assert.equal(r3.status, 200, 'title changed → old ETag no longer matches');
    assert.match(one(r3.doc, 'og:title'), /^Renamed /);
  });

  // ── AC-22.11: HTML docs ───────────────────────────────────────────────────

  test('AC-22.11 an HTML doc takes og:title from <title> and og:description from <meta name=description>', async () => {
    const html = '<!doctype html><html><head><title>Report</title><meta name="description" content="Desc"></head>'
      + '<body><h1>Other heading</h1><p>Body text para.</p></body></html>';
    const d = await createDoc(B.url, { filename: 'report.html', contentType: 'html', markdown: html });
    const { doc } = await botPage(d.x);
    assert.equal(one(doc, 'og:title'), 'Report');
    assert.equal(one(doc, 'og:description'), 'Desc');
  });

  test('rule 3/4 (HTML): entities in <title> are decoded once, <h1> is the next fallback, and the first <p> skips scripts/styles', async () => {
    const t = await titleOf({ filename: 'ent.html', contentType: 'html', markdown: '<html><head><title>A &amp; B &lt;C&gt;</title></head><body><p>x</p></body></html>' });
    assert.equal(t.title, 'A & B <C>');
    const h = await titleOf({ filename: 'h1.html', contentType: 'html', markdown: '<html><body><h1>Main <em>Heading</em></h1><p>Para.</p></body></html>' });
    assert.equal(h.title, 'Main Heading');
    const desc = await descOf({ filename: 'p.html', contentType: 'html',
      markdown: '<html><head><title>T</title><style>.x{color:red}</style></head><body><script>var leakVar=1;</script><h1>H</h1><p>First html paragraph.</p><p>Second.</p></body></html>' });
    assert.equal(desc, 'First html paragraph.');
  });

  // ── rule 2 / 00 §6: id vs slug, variants, path hygiene ─────────────────────

  test('00 §6: /d/<id> and /d/<slug> give the same canonical (slug form); a doc without a slug uses its id', async () => {
    const d = await createDoc(B.url, { sessionName: `Canonical ${uniq()}`, filename: 'c.md', markdown: 'Body.' });
    const bySlug = (await botPage(d.slug)).doc;
    const byId = (await botPage(d.id)).doc;
    assert.deepEqual(byId.canonical, [share(d.slug)]);
    assert.equal(one(byId, 'og:url'), share(d.slug));
    assert.equal(one(byId, 'og:image'), one(bySlug, 'og:image'), 'og:image uses the slug form too');
    const n = await createDoc(B.url, { filename: 'noslug.md', markdown: 'Body.' });
    assert.equal(n.slug, null);
    const nd = (await botPage(n.id)).doc;
    assert.deepEqual(nd.canonical, [share(n.id)]);
    assert.match(one(nd, 'og:image'), new RegExp(`^${escapeRe(share(n.id))}/cover\\.png\\?v=[0-9a-f]{12}$`));
  });

  test('rule 2: /d/<slug>@<rev> and /d/<slug>/<file> resolve and carry the suffix into the app URL', async () => {
    const d = await createDoc(B.url, { sessionName: `Variants ${uniq()}`, filename: 'v.md', markdown: '# V\n\nFirst version.' });
    const revs = await request(B.url, 'GET', `/paste/${d.id}/revisions`);
    assert.equal(revs.status, 200);
    const rev = revs.json.current;
    assert.match(rev, /^[0-9a-f]{32}$/);
    await putMarkdown(B.url, d.id, '# V\n\nSecond version.');
    const pinned = await getMeta(B.url, `/d/${d.slug}@${rev}`, UA.chrome);
    assert.equal(pinned.status, 200, pinned.text.slice(0, 200));
    assert.equal(refreshTarget(pinned.doc.refreshes[0]), app(`${d.slug}@${rev}`));
    assert.deepEqual(scriptNavigations(pinned.doc, '#v'), [`${app(`${d.slug}@${rev}`)}#v`]);
    assert.equal((await getMeta(B.url, `/d/${d.slug}@${rev}`, UA.slack)).status, 200, 'bots get the pinned page too');

    const add = await request(B.url, 'POST', `/paste/${d.id}/files`, { body: { name: 'appendix.md', content: '# Appendix\n\nText.' } });
    assert.ok(add.status < 300, `add file: ${add.status} ${add.text}`);
    const file = await getMeta(B.url, `/d/${d.slug}/appendix.md?view=read`, UA.chrome);
    assert.equal(file.status, 200, file.text.slice(0, 200));
    assert.equal(refreshTarget(file.doc.refreshes[0]), `${app(`${d.slug}/appendix.md`)}?view=read`);
    const fileBot = await getMeta(B.url, `/d/${d.slug}/appendix.md`, UA.slack);
    assert.equal(fileBot.status, 200);
    assert.ok(one(fileBot.doc, 'og:title'), 'file page has og:title');
    assert.ok(!hasRedirect(fileBot.doc));
  });

  test('rule 11 / edges: traversal-shaped and malformed /d/ paths → 404 and never fall through to files', async () => {
    const d = await createDoc(B.url, { sessionName: `Paths ${uniq()}`, filename: 'p.md', markdown: 'Body.' });
    for (const p of [
      `/d/${d.slug}%2F..%2F`,
      `/d/${d.slug}/cover.png/extra`,
      '/d/..%2F..%2Fetc%2Fpasswd',
      '/d/%2e%2e/%2e%2e/server.cjs',
      '/d/..%2F..%2Fserver%2Fserver.cjs/cover.png',
    ]) {
      const r = await getMeta(B.url, p, UA.slack);
      assert.equal(r.status, 404, `${p} → ${r.status}`);
      assert.ok(!r.text.includes('root:') && !r.text.includes('require('), `${p} leaks no file content`);
    }
  });
});
