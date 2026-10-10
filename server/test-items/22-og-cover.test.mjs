// Item #22 — GET /d/:slugOrId/cover.png (PNG half).
// Spec: docs/build/specs/22-og-meta-route.md rules 8–10 (+ 00 §6 route precedence).
// Helpers + gating: 22-helpers.mjs. Runs against E2E_API_URL / MDREVIEW_API /
// PASTE_API when set, else boots its own backend. The DATA_DIR/covers checks
// need the backend's data dir (E2E_DATA_DIR / DATA_DIR, or the own backend's).
//
// Set MDREVIEW_22_COVER_OUT=/some/dir to keep the rendered fixture cover
// (AC-22.12 is verified by an agent looking at it).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SKIP, sharedBackend, cleanupTmp, request, createDoc, createExpiredDoc, putMeta, putMarkdown,
  getMeta, one, pathOf, readPng, PNG_SIG, hex, near, coverFiles, dayStamp, md5, uniq, UA, FIXTURE_DIR,
} from './22-helpers.mjs';

describe('#22 /d/:slug/cover.png', { skip: SKIP }, () => {
  let B;
  before(async () => { B = await sharedBackend(); });
  after(async () => { await B?.stop(); cleanupTmp(); });

  /** og:image (absolute) and its ?v= from the bot meta page. */
  async function ogImage(x) {
    const r = await getMeta(B.url, `/d/${x}`, UA.slack);
    assert.equal(r.status, 200, `GET /d/${x} → ${r.status}: ${r.text.slice(0, 200)}`);
    const img = one(r.doc, 'og:image');
    const v = new URL(img).searchParams.get('v');
    assert.match(v || '', /^[0-9a-f]{12}$/, `og:image ?v= is a 12-hex cover_key (${img})`);
    return { img, v, path: pathOf(img) };
  }
  async function getCover(p) {
    const r = await request(B.url, 'GET', p, { headers: { 'User-Agent': 'Slack-ImgProxy (+https://api.slack.com/robots)' } });
    return r;
  }
  function assertPng(r, label) {
    assert.equal(r.status, 200, `${label}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.match(r.headers['content-type'] || '', /^image\/png\b/i, `${label}: content-type`);
    assert.ok(r.buf.subarray(0, 8).equals(PNG_SIG), `${label}: PNG signature`);
    const png = readPng(r.buf);
    assert.ok(png.valid, `${label}: parseable PNG`);
    assert.equal(png.width, 1200, `${label}: IHDR width`);
    assert.equal(png.height, 630, `${label}: IHDR height`);
    return png;
  }
  const needDataDir = (t) => { if (!B.dataDir) { t.skip('backend data dir unknown (set E2E_DATA_DIR)'); return false; } return true; };

  test('AC-22.6 og:image → 200 image/png, PNG signature, IHDR 1200×630, < 500 KB, immutable when ?v= is current', async () => {
    const d = await createDoc(B.url, { sessionName: 'Q3 routing review', filename: 'q3.md', markdown: '# Q3\n\nBody.' }, { author: 'Kartikeya' });
    const { v, path: p } = await ogImage(d.x);
    const r = await getCover(p);
    assertPng(r, 'cover');
    assert.ok(r.buf.length < 500 * 1024, `size ${r.buf.length} < 500 KB`);
    assert.ok(r.buf.length > 3000, `non-trivial image (${r.buf.length} bytes)`);
    const cc = (r.headers['cache-control'] || '').toLowerCase();
    assert.ok(cc.includes('immutable') && cc.includes('public') && /max-age=31536000\b/.test(cc), `Cache-Control "${cc}"`);
    assert.equal(r.headers.etag, `"${v}"`, 'ETag = "{cover_key}"');
  });

  test('rule 8 (AC-22.12 automated part): the cover is on-palette — flat #280A38 background, white title, #B066FF accents', async () => {
    const md = fs.readFileSync(path.join(FIXTURE_DIR, 'cover-fixture.md'), 'utf-8');
    const d = await createDoc(B.url, { filename: 'cover-fixture.md', markdown: md }, { author: 'Kartikeya' });
    const { path: p } = await ogImage(d.x);
    const r = await getCover(p);
    const png = assertPng(r, 'fixture cover');
    if (process.env.MDREVIEW_22_COVER_OUT) {
      fs.mkdirSync(process.env.MDREVIEW_22_COVER_OUT, { recursive: true });
      const out = path.join(process.env.MDREVIEW_22_COVER_OUT, '22-cover-fixture.png');
      fs.writeFileSync(out, r.buf);
      console.log(`[22] fixture cover written to ${out}`);
    }
    assert.ok(png.pixel, `8-bit non-interlaced PNG expected for pixel checks (bitDepth ${png.bitDepth}, colorType ${png.colorType}, interlace ${png.interlace})`);
    const bg = hex('#280A38'); const accent = hex('#B066FF');
    for (const [x, y] of [[2, 2], [1197, 2], [2, 627], [1197, 627]]) {
      assert.ok(near(png.pixel(x, y), bg, 3), `corner (${x},${y}) is #280A38, got ${png.pixel(x, y)}`);
    }
    let bgCount = 0; let white = 0; let purple = 0; let total = 0;
    for (let y = 0; y < 630; y += 2) {
      for (let x = 0; x < 1200; x += 2) {
        const px = png.pixel(x, y); total++;
        if (near(px, bg, 3)) bgCount++;
        else if (px[0] > 240 && px[1] > 240 && px[2] > 240) white++;
        else if (near(px, accent, 14)) purple++;
      }
    }
    assert.ok(bgCount / total > 0.5, `flat background (no gradient): ${(100 * bgCount / total).toFixed(1)}% of pixels are #280A38`);
    assert.ok(white > 150, `white title text present (${white} sampled pixels)`);
    assert.ok(purple > 40, `#B066FF wordmark/pill present (${purple} sampled pixels)`);
  });

  test('rule 9: a missing or stale ?v= serves the current cover with max-age=300 (not immutable), same ETag', async () => {
    const d = await createDoc(B.url, { sessionName: `Stale v ${uniq()}`, filename: 's.md', markdown: 'Body.' });
    const { v, path: p } = await ogImage(d.x);
    const cur = await getCover(p);
    assertPng(cur, 'current');
    for (const q of ['', '?v=000000000000', '?v=']) {
      const r = await getCover(`/d/${d.x}/cover.png${q}`);
      assertPng(r, `cover.png${q}`);
      const cc = (r.headers['cache-control'] || '').toLowerCase();
      assert.ok(/max-age=300\b/.test(cc) && cc.includes('public') && !cc.includes('immutable'), `${q || '(no v)'}: Cache-Control "${cc}"`);
      assert.equal(r.headers.etag, `"${v}"`);
      assert.equal(md5(r.buf), md5(cur.buf), 'same image bytes');
    }
  });

  test('rule 9: unchanged doc → same ?v=, identical bytes, one cached file', async (t) => {
    const d = await createDoc(B.url, { sessionName: `Cached ${uniq()}`, filename: 'c.md', markdown: 'Body.' });
    const a = await ogImage(d.x);
    const ra = await getCover(a.path);
    assertPng(ra, 'first');
    const b = await ogImage(d.x);
    assert.equal(b.v, a.v, 'cover_key stable when nothing changed');
    const rb = await getCover(b.path);
    assert.equal(md5(rb.buf), md5(ra.buf), 'identical bytes');
    if (!needDataDir(t)) return;
    assert.deepEqual(coverFiles(B.dataDir, d.id), [`${d.id}-${a.v}.png`], 'DATA_DIR/covers/{id}-{cover_key}.png');
  });

  test('AC-22.7 title + content change → new ?v=; the old ?v= URL returns the new image with max-age=300; one cover file per id', async (t) => {
    const d = await createDoc(B.url, { sessionName: `Before change ${uniq()}`, filename: 'a.md', markdown: '# A\n\nOld body.' });
    const old = await ogImage(d.x);
    const oldCover = await getCover(old.path);
    assertPng(oldCover, 'old cover');
    await putMeta(B.url, d.id, { sessionName: `After change ${uniq()}` });
    await putMarkdown(B.url, d.id, '# A\n\nNew body text.');
    const neu = await ogImage(d.x);
    assert.notEqual(neu.v, old.v, 'og:image ?v= differs');
    const newCover = await getCover(neu.path);
    assertPng(newCover, 'new cover');
    assert.ok(/immutable/.test(newCover.headers['cache-control'] || ''), 'current ?v= is immutable');
    assert.notEqual(md5(newCover.buf), md5(oldCover.buf), 'the image changed with the title');
    const viaOld = await getCover(old.path);
    assertPng(viaOld, 'old ?v= URL');
    assert.equal(md5(viaOld.buf), md5(newCover.buf), 'old ?v= serves the NEW image');
    const cc = (viaOld.headers['cache-control'] || '').toLowerCase();
    assert.ok(/max-age=300\b/.test(cc) && !cc.includes('immutable'), `old ?v= Cache-Control "${cc}"`);
    assert.equal(viaOld.headers.etag, `"${neu.v}"`);
    if (!needDataDir(t)) return;
    assert.deepEqual(coverFiles(B.dataDir, d.id), [`${d.id}-${neu.v}.png`], 'only the current cover file remains');
  });

  test('rule 9: cover_key follows title (also an H1-derived one) but not body-only edits', async (t) => {
    const day = dayStamp();
    const d = await createDoc(B.url, { filename: 'h1.md', markdown: '# First H1 title\n\nBody one.' });
    const a = await ogImage(d.x);
    await putMarkdown(B.url, d.id, '# First H1 title\n\nBody two, different words.');
    const b = await ogImage(d.x);
    await putMarkdown(B.url, d.id, '# Second H1 title\n\nBody two, different words.');
    const c = await ogImage(d.x);
    assert.notEqual(c.v, b.v, 'H1-derived title change → new cover_key');
    if (dayStamp() !== day) { t.skip('date rolled over mid-test (the meta line carries the date)'); return; }
    assert.equal(b.v, a.v, 'a body-only edit (same title, same day) keeps the cover_key: the cover is cached');
  });

  test('AC-22.8 a 300-char title with emoji and CJK renders a valid 1200×630 PNG (no 500)', async () => {
    const unit = '路线评审🚀東京✅ ';
    let title = ''; while ([...title].length < 300) title += unit;
    title = [...title].slice(0, 300).join('');
    const d = await createDoc(B.url, { sessionName: title, filename: 'cjk.md', markdown: 'Body.' });
    const { path: p } = await ogImage(d.x);
    const r = await getCover(p);
    assertPng(r, 'emoji+CJK cover');
  });

  test('rule 8 edges: RTL, XML-special characters, a 10 KB single-line title and an emoji-only title all render', async () => {
    const titles = {
      rtl: 'مراجعة التوجيه للربع الثالث ‮evil‬',
      xml: `<svg onload="x"> & ' " ]]> <!-- --> &amp; </text>`,
      huge: 'w'.repeat(10 * 1024),
      emoji: '😀'.repeat(300),
      newline: 'Line one\nLine two',
    };
    for (const [name, sessionName] of Object.entries(titles)) {
      const d = await createDoc(B.url, { sessionName, filename: `${name}.md`, markdown: 'Body.' });
      const { path: p } = await ogImage(d.x);
      assertPng(await getCover(p), name);
    }
  });

  test('AC-22.11 (cover) an HTML doc gets a valid cover whose meta line differs from an otherwise identical Markdown doc', async () => {
    const author = `Author ${uniq()}`;
    const html = '<!doctype html><html><head><title>Report</title><meta name="description" content="Desc"></head><body><p>x</p></body></html>';
    const h = await createDoc(B.url, { filename: 'report.html', contentType: 'html', markdown: html }, { author });
    const m = await createDoc(B.url, { sessionName: 'Report', filename: 'report.md', markdown: 'x' }, { author });
    const hi = await ogImage(h.x);
    const mi = await ogImage(m.x);
    const hc = await getCover(hi.path);
    const mc = await getCover(mi.path);
    assertPng(hc, 'HTML cover');
    assertPng(mc, 'Markdown cover');
    assert.notEqual(hi.v, mi.v, 'same title + author, different type → different meta line → different cover_key');
    assert.notEqual(md5(hc.buf), md5(mc.buf), 'different pixels (type pill / meta line)');
  });

  test('rule 9 edge: 50 parallel requests on a cold cache → all 200, identical bytes, one cache file', async (t) => {
    const d = await createDoc(B.url, { sessionName: `Parallel ${uniq()}`, filename: 'p.md', markdown: 'Body.' });
    // Cold: nothing has asked for this doc's cover or meta page yet (the meta
    // page may pre-render), so hit cover.png (no ?v=) directly.
    if (B.dataDir) assert.deepEqual(coverFiles(B.dataDir, d.id), [], 'cold cache');
    const rs = await Promise.all(Array.from({ length: 50 }, () => getCover(`/d/${d.x}/cover.png`)));
    const hashes = new Set(); const etags = new Set();
    for (const [i, r] of rs.entries()) { assertPng(r, `request ${i}`); hashes.add(md5(r.buf)); etags.add(r.headers.etag); }
    assert.equal(hashes.size, 1, 'identical bytes');
    assert.equal(etags.size, 1, 'one ETag');
    const { v } = await ogImage(d.x);
    assert.deepEqual([...etags], [`"${v}"`], 'the same cover_key the meta page advertises');
    if (!needDataDir(t)) return;
    assert.deepEqual(coverFiles(B.dataDir, d.id), [`${d.id}-${v}.png`], 'one cache file');
  });

  test('rule 9: unknown → 404 JSON, expired → 410 JSON, never an image', async () => {
    const u = await getCover(`/d/no-such-doc-${uniq()}/cover.png`);
    assert.equal(u.status, 404);
    assert.match(u.headers['content-type'] || '', /^application\/json/i);
    assert.ok(u.json && typeof u.json.error === 'string', `JSON error body: ${u.text}`);
    assert.ok(!u.buf.subarray(0, 8).equals(PNG_SIG));
    const e = await createExpiredDoc(B.url, { slug: `exp-cover-${uniq()}`, sessionName: 'Expired cover', filename: 'e.md', markdown: 'x' });
    const r = await getCover(`/d/${e.slug || e.id}/cover.png`);
    assert.equal(r.status, 410);
    assert.match(r.headers['content-type'] || '', /^application\/json/i);
    assert.ok(r.json && typeof r.json.error === 'string', `JSON error body: ${r.text}`);
  });

  test('rule 9: deleting the doc removes its cached covers', async (t) => {
    const d = await createDoc(B.url, { sessionName: `Delete me ${uniq()}`, filename: 'd.md', markdown: 'Body.' });
    const { path: p } = await ogImage(d.x);
    assertPng(await getCover(p), 'before delete');
    if (B.dataDir) assert.equal(coverFiles(B.dataDir, d.id).length, 1, 'cached before delete');
    const del = await request(B.url, 'DELETE', `/paste/${d.id}`);
    assert.equal(del.status, 204);
    assert.equal((await getCover(p)).status, 404, 'cover gone after delete');
    if (!needDataDir(t)) return;
    assert.deepEqual(coverFiles(B.dataDir, d.id), [], 'no {id}-*.png left in DATA_DIR/covers');
  });

  test('00 §6: /d/<x>/cover.png/extra and traversal-shaped cover paths → 404', async () => {
    const d = await createDoc(B.url, { sessionName: `Cover paths ${uniq()}`, filename: 'c.md', markdown: 'Body.' });
    for (const p of [`/d/${d.x}/cover.png/extra`, `/d/${d.x}%2F..%2F/cover.png`, '/d/..%2F..%2Fmd-review.sqlite/cover.png']) {
      const r = await getCover(p);
      assert.equal(r.status, 404, `${p} → ${r.status}`);
      assert.ok(!r.buf.subarray(0, 8).equals(PNG_SIG), `${p} is not an image`);
    }
  });
});
