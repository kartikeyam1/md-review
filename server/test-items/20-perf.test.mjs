// Item #20 — linear-time indexing and snippets (perf round after #22's review
// found quadratic text extraction on the write and search paths). A document
// built from a pathological repeated token must be stored (POST /paste builds
// its search row: docTitle + indexed text) and searched (GET /library/docs
// builds snippets) in well under a second each. Before the fix: '<script'×90k
// took 61 s to POST, '<!--'×150k 46 s, and a markdown '[a'×300k 122 s to search.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, tmpDir, cleanupTmp, http } from './lib/20-helpers.mjs';

const KB600 = 600 * 1024;
const fill = (unit) => unit.repeat(Math.ceil(KB600 / unit.length)).slice(0, KB600);

// [label, contentType, body]. Each body also carries a searchable word, so the
// search returns the doc and builds its snippet.
const SHAPES = [
  ['html <script', 'html', fill('<script')],
  ['html <!--', 'html', fill('<!--')],
  ['html <meta name="description" ', 'html', fill('<meta name="description" ')],
  ['html <title>', 'html', fill('<title>')],
  ['html <p>', 'html', fill('<p>')],
  ['html <a', 'html', fill('<a')],
  ['html <style>', 'html', fill('<style>')],
  ['md [a', 'markdown', fill('[a')],
  ['md ![a', 'markdown', fill('![a')],
  ['md __a ', 'markdown', fill('__a ')],
  ['md <a', 'markdown', fill('<a')],
  ['md <!--', 'markdown', fill('<!--')],
  ['md newlines', 'markdown', fill('\n')],
  ['md blank lines with spaces', 'markdown', fill(' \n')],
  ['md "#" lines', 'markdown', fill('#\n')],
  ['md "> " lines', 'markdown', fill('> \n')],
  ['md "|--" lines', 'markdown', fill('|--\n')],
  ['md H1 of brackets', 'markdown', `# ${fill('[a')}`],
];

let server; let base;
before(async () => { server = await startServer({ dataDir: tmpDir('md-review-20-perf') }); base = server.url; });
after(async () => { await server?.stop(); cleanupTmp(); });

for (const [label, contentType, body] of SHAPES) {
  test(`pathological 600 KB doc (${label}): POST and search each answer in < 1 s`, async () => {
    const word = `perfprobe${Math.random().toString(36).slice(2, 8)}`;
    const markdown = contentType === 'html' ? `<p>${word}</p>${body}` : `${word}\n\n${body}`;
    let t = Date.now();
    const created = await http(base, 'POST', '/paste', { body: { filename: contentType === 'html' ? 'p.html' : 'p.md', contentType, markdown } });
    const postMs = Date.now() - t;
    assert.equal(created.status, 200, created.text.slice(0, 200));
    assert.ok(postMs < 1000, `POST took ${postMs} ms`);

    t = Date.now();
    const found = await http(base, 'GET', `/library/docs?${new URLSearchParams({ q: word })}`);
    const searchMs = Date.now() - t;
    assert.equal(found.status, 200, found.text.slice(0, 200));
    assert.ok(searchMs < 1000, `search took ${searchMs} ms`);
    const item = found.json.items.find((i) => i.id === created.json.id);
    assert.ok(item, `the doc is found by its word (${JSON.stringify(found.json).slice(0, 200)})`);
    assert.ok(item.match.snippet.some((s) => s.hit && s.text.toLowerCase() === word), 'the snippet marks the word');
  });
}
