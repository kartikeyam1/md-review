// QA fix (persona librarian m6): library search finds a CJK word in the middle of a title and
// an emoji. unicode61 keeps an unbroken CJK run as one token (prefix match only from its
// start) and does not index symbol-only tokens, so those queries also match title substrings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFetchJar } from './lib/edit-token-jar.mjs';
installFetchJar();

const BASE = process.env.PASTE_API || 'http://localhost:3100';
const KATAKANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモ';
const EMOJI = ['🦩', '🧭', '🪐', '🛶', '🧿', '🪁', '🦔', '🫖', '🪗', '🦚'];
const pick = (s, n) => Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');

async function create(title, markdown = `# ${title}\n\nBody text.\n`) {
  const res = await fetch(`${BASE}/paste`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, filename: 'q.md', sessionName: title }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).id;
}
async function search(q) {
  const res = await fetch(`${BASE}/library/docs?q=${encodeURIComponent(q)}&limit=100`);
  assert.equal(res.status, 200);
  return res.json();
}
const ids = (r) => r.items.map((i) => i.id);

test('a CJK word in the middle of a title is found (not only the start of the run)', async () => {
  const word = pick(KATAKANA, 5);
  const id = await create(`日本語のレポート：配送${word}`);
  const start = await search('日本語');
  assert.ok(ids(start).includes(id), 'the start of the run still matches');
  const mid = await search(word);
  assert.ok(ids(mid).includes(id), `q=${word} finds the doc`);
  const item = mid.items.find((i) => i.id === id);
  assert.equal(item.match.field, 'title');
  assert.deepEqual(item.match.snippet.filter((s) => s.hit).map((s) => s.text), [word], 'the substring is the marked hit');
  assert.equal(mid.items[0].id, id, 'a title substring hit ranks first');
});

test('an emoji in a title is found; several tokens must all occur', async () => {
  const e = pick(EMOJI, 3);
  const id = await create(`${e} Launch plan 2026`);
  const other = await create(`${e} Other thing`);
  assert.ok(ids(await search(e)).includes(id), `q=${e} finds the doc`);
  const both = ids(await search(`${e} launch`));
  assert.ok(both.includes(id), 'emoji + word finds the doc');
  assert.ok(!both.includes(other), 'every token must occur in the title');
});

test('ordinary queries are unchanged: no substring matching for latin words', async () => {
  const tag = `zq${Math.random().toString(36).slice(2, 8)}`;
  const id = await create(`Notes ${tag}word`);
  assert.ok(ids(await search(tag)).includes(id), 'prefix match from the start of a token');
  assert.ok(!ids(await search(tag.slice(2))).includes(id), 'mid-token latin text is not a substring match');
  const punct = await search('"');
  assert.equal(punct.total, 0, 'bare punctuation still matches nothing');
});
