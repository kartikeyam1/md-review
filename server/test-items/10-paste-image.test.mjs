// Item #10 — server side of paste/drop image: `assets/` attachment validation and safe headers.
// Spec: docs/build/specs/10-paste-image.md rule 16, AC-10.14, AC-10.15.
//
// Runs against verify.sh's backend (E2E_API_URL + DATA_DIR) when given, else boots its own.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sharedBackend, cleanupTmp, http, uniq, create, brief } from './23-helpers.mjs';

let B;
before(async () => { B = await sharedBackend(); });
after(async () => { await B?.stop(); cleanupTmp(); });

const MIB = 1024 * 1024;
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function newDoc() {
  const d = await create(B.url, { sessionName: `Img ${uniq()}` });
  return { id: d.id, h: { 'X-Edit-Token': d.editToken } };
}
const post = (doc, body) => http(B.url, 'POST', `/paste/${doc.id}/files`, { body, headers: doc.h });

describe('#10 POST /paste/:id/files — assets/ prefix (rule 16)', () => {
  test('AC-10.14 assets/x.exe → 415 Unsupported attachment type', async () => {
    const doc = await newDoc();
    const r = await post(doc, { name: 'assets/x.exe', content: 'TVqQ', encoding: 'base64' });
    assert.equal(r.status, 415, brief(r));
    assert.equal(r.json?.error, 'Unsupported attachment type');
    // Every accepted extension passes, in any case.
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'PNG']) {
      const ok = await post(doc, { name: `assets/ok-${uniq()}.${ext}`, content: PNG_1x1, encoding: 'base64' });
      assert.equal(ok.status, 201, `${ext}: ${brief(ok)}`);
    }
    for (const name of ['assets/x.bmp', 'assets/noext', 'assets/x.png.exe', 'assets/x.html']) {
      const bad = await post(doc, { name, content: PNG_1x1, encoding: 'base64' });
      assert.equal(bad.status, 415, `${name}: ${brief(bad)}`);
    }
  });

  test('AC-10.14 an 11 MiB decoded assets/x.png → 413 Attachment too large; exactly 10 MiB is accepted', async () => {
    const doc = await newDoc();
    const big = Buffer.alloc(11 * MIB, 7).toString('base64');
    const r = await post(doc, { name: 'assets/x.png', content: big, encoding: 'base64' });
    assert.equal(r.status, 413, brief(r));
    assert.equal(r.json?.error, 'Attachment too large');

    const edge = Buffer.alloc(10 * MIB, 7).toString('base64');
    const ok = await post(doc, { name: 'assets/edge.png', content: edge, encoding: 'base64' });
    assert.equal(ok.status, 201, `exactly 10 MiB: ${brief(ok)}`);
    assert.equal(ok.json?.size, 10 * MIB);

    const over = Buffer.alloc(10 * MIB + 1, 7).toString('base64');
    const no = await post(doc, { name: 'assets/over.png', content: over, encoding: 'base64' });
    assert.equal(no.status, 413, `10 MiB + 1: ${brief(no)}`);
  });

  test('AC-10.14 non-assets names keep today\'s behaviour (notes/x.exe → 201, any size under the body cap)', async () => {
    const doc = await newDoc();
    const r = await post(doc, { name: 'notes/x.exe', content: 'TVqQ', encoding: 'base64' });
    assert.equal(r.status, 201, brief(r));
    const big = await post(doc, { name: 'big.bin', content: Buffer.alloc(11 * MIB, 1).toString('base64'), encoding: 'base64' });
    assert.equal(big.status, 201, `non-assets 11 MiB: ${brief(big)}`);
    const got = await http(B.url, 'GET', `/paste/${doc.id}/files/notes/x.exe`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('x-content-type-options'), null, 'non-assets GET: no new nosniff header');
  });

  test('a utf-8 (non-base64) assets/ upload is size-checked on its byte length', async () => {
    const doc = await newDoc();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'x'.repeat(11 * MIB)}</svg>`;
    const r = await post(doc, { name: 'assets/big.svg', content: svg });
    assert.equal(r.status, 413, brief(r));
  });

  test('the upload still needs the edit token (assets/ checks do not bypass it)', async () => {
    const doc = await newDoc();
    const r = await http(B.url, 'POST', `/paste/${doc.id}/files`, { body: { name: 'assets/x.png', content: PNG_1x1, encoding: 'base64' } });
    assert.equal(r.status, 401, brief(r));
  });
});

describe('#10 GET of assets/ files (rule 16)', () => {
  test('AC-10.15 assets/*.svg → image/svg+xml, nosniff, CSP default-src \'none\'', async () => {
    const doc = await newDoc();
    const name = `assets/20261010-142233-${uniq().slice(0, 6)}.svg`;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script><rect width="4" height="4"/></svg>';
    const up = await post(doc, { name, content: Buffer.from(svg).toString('base64'), encoding: 'base64' });
    assert.equal(up.status, 201, brief(up));
    const r = await http(B.url, 'GET', `/paste/${doc.id}/files/${name}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/svg+xml');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.equal(r.text, svg, 'bytes unchanged');
  });

  test('assets/*.png → nosniff, no CSP; bytes byte-for-byte', async () => {
    const doc = await newDoc();
    const up = await post(doc, { name: 'assets/a.png', content: PNG_1x1, encoding: 'base64' });
    assert.equal(up.status, 201, brief(up));
    const r = await http(B.url, 'GET', `/paste/${doc.id}/files/assets/a.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-security-policy'), null);
    assert.equal(r.buf.toString('base64'), PNG_1x1);
  });
});

describe('#10 POST assets/ — malformed content', () => {
  test('a non-string content for an assets/ name → 400', async () => {
    const doc = await newDoc();
    const r = await post(doc, { name: 'assets/x.png', content: { a: 1 }, encoding: 'base64' });
    assert.equal(r.status, 400, brief(r));
  });
});
