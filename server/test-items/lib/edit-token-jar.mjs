// Edit-token jar for server tests written before #23 (view vs edit links).
//
// Since #23 every doc created with POST /paste is edit-protected: its writes
// need the token the create returned. Tests whose subject is something else
// (revisions, ETags, search, covers …) opt in to this jar so they keep their
// intent unchanged: it remembers the editToken of every doc they create (by id
// and slug, following slug changes and rotations) and presents it on later
// requests to that doc, unless the request already carries a token header.
// The #23 tests never use it — they check exactly what a token-less write gets.

const tokens = new Map(); // id or slug → token

const docKey = (pathname) => /^\/paste\/([a-zA-Z0-9][a-zA-Z0-9-]*)(?:\/|$)/.exec(pathname)?.[1] ?? null;
const hasTokenHeader = (h) => Object.keys(h).some((k) => ['x-edit-token', 'authorization'].includes(k.toLowerCase()));

/** The token the jar holds for a doc id or slug (undefined when none). */
export const tokenFor = (x) => tokens.get(x);

/** Headers plus X-Edit-Token for a write to the doc `pathname` addresses, when the jar knows it. */
export function withToken(method, pathname, headers = {}) {
  if (method === 'GET' || method === 'HEAD') return headers;
  const x = docKey(pathname);
  const t = x && tokens.get(x);
  if (!t || hasTokenHeader(headers)) return headers;
  return { ...headers, 'X-Edit-Token': t };
}

/** Learn from a response: create (POST /paste), rotation/claim, slug change (PUT /meta). */
export function learn(method, pathname, status, json) {
  if (status !== 200 || !json || typeof json !== 'object') return;
  if (method === 'POST' && pathname === '/paste' && json.editToken) {
    tokens.set(json.id, json.editToken);
    if (json.slug) tokens.set(json.slug, json.editToken);
    return;
  }
  const x = docKey(pathname);
  if (!x) return;
  if (method === 'POST' && pathname.endsWith('/edit-token') && json.editToken) {
    for (const [k, v] of tokens) if (v === tokens.get(x)) tokens.set(k, json.editToken);
    tokens.set(x, json.editToken);
  } else if (method === 'PUT' && pathname.endsWith('/meta') && json.slug && tokens.has(x)) {
    tokens.set(json.slug, tokens.get(x));
  }
}

/** Patch globalThis.fetch (this test process only) to present and learn tokens. */
export function installFetchJar() {
  if (globalThis.fetch.__editTokenJar) return;
  const orig = globalThis.fetch;
  const jarred = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const plain = init.headers instanceof Headers ? Object.fromEntries(init.headers) : { ...(init.headers || {}) };
    const res = await orig(input, { ...init, headers: withToken(method, url.pathname, plain) });
    if (res.status === 200 && method !== 'GET' && /^\/paste(\/|$)/.test(url.pathname)) {
      try { learn(method, url.pathname, res.status, await res.clone().json()); } catch { /* not JSON */ }
    }
    return res;
  };
  jarred.__editTokenJar = true;
  globalThis.fetch = jarred;
}
