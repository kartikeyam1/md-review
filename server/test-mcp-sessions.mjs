import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRegistry } from './mcp-sessions.js';

function fakeTransport(name) {
  return { name, closed: false, async close() { this.closed = true; } };
}

test('sessions idle past the TTL are evicted and their transports closed', () => {
  let t = 1_000_000;
  const closed = [];
  const reg = createSessionRegistry({ ttlMs: 1000, now: () => t, onEvict: (id, tr, reason) => { tr.close(); closed.push([id, reason]); } });
  reg.add('a', fakeTransport('a'));
  t += 600;
  reg.add('b', fakeTransport('b'));
  t += 500; // a idle 1100 > ttl, b idle 500
  assert.equal(reg.sweep(), 1);
  assert.deepEqual(closed, [['a', 'idle']]);
  assert.equal(reg.has('a'), false);
  assert.equal(reg.has('b'), true);
});

test('get() refreshes lastSeen so an active session is never swept', () => {
  let t = 0;
  const reg = createSessionRegistry({ ttlMs: 1000, now: () => t });
  reg.add('a', fakeTransport('a'));
  t = 900; reg.get('a');
  t = 1800;
  assert.equal(reg.sweep(), 0);
  assert.equal(reg.has('a'), true);
  t = 2000;
  assert.equal(reg.sweep(), 1);
});

test('registry is capped; the least recently used session is evicted first', () => {
  let t = 0;
  const evicted = [];
  const reg = createSessionRegistry({ ttlMs: 1e9, maxSessions: 2, now: () => t, onEvict: (id, _tr, reason) => evicted.push([id, reason]) });
  reg.add('a', fakeTransport('a')); t = 1;
  reg.add('b', fakeTransport('b')); t = 2;
  reg.get('a');                     t = 3; // a is now more recent than b
  reg.add('c', fakeTransport('c'));
  assert.deepEqual(evicted, [['b', 'capacity']]);
  assert.deepEqual([reg.has('a'), reg.has('b'), reg.has('c')], [true, false, true]);
  assert.equal(reg.size(), 2);
});

test('remove() forgets a session without invoking onEvict; stats count evictions', () => {
  const evicted = [];
  const reg = createSessionRegistry({ onEvict: (id) => evicted.push(id) });
  reg.add('a', fakeTransport('a'));
  reg.remove('a');
  assert.equal(reg.size(), 0);
  assert.deepEqual(evicted, []);
  assert.equal(reg.stats().evicted, 0);
});
