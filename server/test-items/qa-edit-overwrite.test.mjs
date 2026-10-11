// QA fix (persona engineer M6): a conflict resolved with "keep my version" must not fold the
// copy it overwrites into the same editing-session revision — the losing side stays in History.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFetchJar } from './lib/edit-token-jar.mjs';
installFetchJar();

const BASE = process.env.PASTE_API || 'http://localhost:3100';
const UI = { 'Content-Type': 'application/json', 'X-MdReview-Client': 'ui' };
const put = (id, body) => fetch(`${BASE}/paste/${id}/markdown`, { method: 'PUT', headers: UI, body: JSON.stringify(body) });
const revs = async (id) => (await fetch(`${BASE}/paste/${id}/revisions`)).json();

async function create(markdown) {
  const res = await fetch(`${BASE}/paste`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown, filename: 'q.md' }) });
  assert.equal(res.status, 200);
  return (await res.json()).id;
}

test('overwrite: true keeps the overwritten copy as its own revision (same author, inside the fold window)', async () => {
  const id = await create('start');
  assert.equal((await put(id, { markdown: 'tab A wins' })).status, 200);
  const aHash = (await revs(id)).current;
  const res = await put(id, { markdown: 'tab B keeps mine', overwrite: true });
  assert.equal(res.status, 200);
  const list = await revs(id);
  assert.equal(list.revisions.length, 3, 'start + A + B (B did not fold into A)');
  assert.equal(list.revisions[1].hash, aHash);
  const a = await (await fetch(`${BASE}/paste/${id}/revisions/${aHash}`)).json();
  assert.equal(a.markdown, 'tab A wins', 'the losing side can still be read and restored');
  assert.equal(list.revisions[2].parent, aHash);
});

test('without overwrite, same-author writes still fold (unchanged behaviour)', async () => {
  const id = await create('start');
  await put(id, { markdown: 'one' });
  await put(id, { markdown: 'two' });
  const list = await revs(id);
  assert.equal(list.revisions.length, 2);
  assert.equal(list.revisions[1].writes, 2);
});

test('a non-boolean overwrite value is ignored (folds as usual)', async () => {
  const id = await create('start');
  await put(id, { markdown: 'one' });
  await put(id, { markdown: 'two', overwrite: 'yes' });
  assert.equal((await revs(id)).revisions.length, 2);
});
