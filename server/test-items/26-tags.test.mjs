// Item #26 — tag normalisation (shared/tags.mjs), the one rule the UI and the API share (spec rule 12, contract).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeTag, normalizeTags, MAX_TAGS_PER_DOC, TAG_MAX_LENGTH } = require('../../shared/tags.mjs');

const ok = (raw) => {
  const r = normalizeTag(raw);
  assert.ok(r && typeof r.tag === 'string', `expected ${JSON.stringify(raw)} to normalise, got ${JSON.stringify(r)}`);
  return r.tag;
};
const bad = (raw) => {
  const r = normalizeTag(raw);
  assert.ok(r && typeof r.error === 'string' && r.error && !('tag' in r), `expected ${JSON.stringify(raw)} to be rejected, got ${JSON.stringify(r)}`);
};

test('constants', () => {
  assert.equal(MAX_TAGS_PER_DOC, 20);
  assert.equal(TAG_MAX_LENGTH, 32);
});

test('trim, lower-case, whitespace runs → "-"', () => {
  assert.equal(ok(' Q4 Plan '), 'q4-plan');
  assert.equal(ok('Ops'), 'ops');
  assert.equal(ok('a \t b  c'), 'a-b-c');
  assert.equal(ok('v1.2_beta-x'), 'v1.2_beta-x');
  assert.equal(ok('a'), 'a');
  assert.equal(ok('x'.repeat(32)), 'x'.repeat(32));
});

test('rejects instead of stripping', () => {
  bad('café'); // rule 12 + spec edge case: never stripped to "caf"
  bad('x'.repeat(33));
  bad('');
  bad('   ');
  bad('a/b');
  bad('#ops');
  bad('emoji🙂');
  bad('K'); // KELVIN SIGN lower-cases to ASCII "k" with toLowerCase(): still rejected
  bad('İ');
  bad(null);
  bad(undefined);
  bad(42);
  bad({});
});

test('normalizeTags: de-duplicates, sorts, enforces the per-doc limit and fails on any invalid tag', () => {
  assert.deepEqual(normalizeTags(['b', ' A ', 'a', 'B']), { tags: ['a', 'b'] });
  assert.deepEqual(normalizeTags([]), { tags: [] });
  assert.deepEqual(normalizeTags(['a.b', 'a-b', 'a_b']), { tags: ['a-b', 'a.b', 'a_b'] }, 'code-point order');
  const twenty = Array.from({ length: 20 }, (_, i) => `t${String(i).padStart(2, '0')}`);
  assert.deepEqual(normalizeTags(twenty).tags, twenty);
  assert.ok(normalizeTags([...twenty, 'T00']).tags, 'a duplicate does not count toward the limit');
  assert.ok(normalizeTags([...twenty, 'extra']).error, '21 distinct tags');
  assert.ok(normalizeTags(['ok', 'café']).error);
  assert.ok(normalizeTags('ops').error, 'not an array');
  assert.ok(normalizeTags(null).error);
});
