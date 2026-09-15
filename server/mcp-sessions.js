// Registry of live streamable-HTTP MCP sessions.
//
// Why this exists: transports used to be kept in a plain object and only removed
// when the client sent a close — which most MCP clients never do. Over weeks
// the map grew without bound and the unit died with a V8 out-of-memory
// (2026-09-14, 08:55 UTC). Sessions now expire after an idle TTL and the
// registry is capped; the oldest idle session is evicted first.

export function createSessionRegistry({
  ttlMs = 30 * 60 * 1000,
  maxSessions = 200,
  now = () => Date.now(),
  onEvict = () => {},
} = {}) {
  /** @type {Map<string, { transport: any, lastSeen: number, createdAt: number }>} */
  const sessions = new Map();
  let evicted = 0;

  function evict(id, reason) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    evicted++;
    try { onEvict(id, entry.transport, reason); } catch { /* best effort */ }
  }

  function evictOldestUntil(limit) {
    while (sessions.size > limit) {
      let oldestId = null;
      let oldestSeen = Infinity;
      for (const [id, entry] of sessions) {
        if (entry.lastSeen < oldestSeen) { oldestSeen = entry.lastSeen; oldestId = id; }
      }
      if (oldestId === null) break;
      evict(oldestId, 'capacity');
    }
  }

  return {
    add(id, transport) {
      const t = now();
      sessions.set(id, { transport, lastSeen: t, createdAt: t });
      evictOldestUntil(maxSessions);
    },
    /** Returns the transport and marks the session as just used. */
    get(id) {
      const entry = sessions.get(id);
      if (!entry) return undefined;
      entry.lastSeen = now();
      return entry.transport;
    },
    has(id) { return sessions.has(id); },
    /** Forget a session without calling onEvict (the transport closed itself). */
    remove(id) { sessions.delete(id); },
    /** Close every session idle for longer than the TTL. Returns how many. */
    sweep() {
      const cutoff = now() - ttlMs;
      const stale = [];
      for (const [id, entry] of sessions) if (entry.lastSeen < cutoff) stale.push(id);
      for (const id of stale) evict(id, 'idle');
      return stale.length;
    },
    size() { return sessions.size; },
    stats() { return { active: sessions.size, evicted, ttlMs, maxSessions }; },
  };
}
