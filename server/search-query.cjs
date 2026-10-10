'use strict';
// Pure helpers for GET /library/docs (00 §8): the FTS5 query a user's `q`
// becomes, and the plain-text excerpt (`match.snippet`) shown for a result.
//
// Excerpts are cut here rather than with FTS5 snippet()/highlight(): those are
// quadratic in the number of hits (a 5 MB doc with 200k hits took minutes).
// The matcher mirrors the index tokenizer (unicode61, remove_diacritics 2):
// tokens are runs of letters/numbers, compared case- and accent-folded, the
// last part of each query token as a prefix.

const SNIPPET_TOKENS = 32;
const TOKENS_BEFORE_HIT = 8;
const TOKEN_SRC = '[\\p{L}\\p{N}\\p{M}\\p{Co}]+';

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** FTS5 MATCH expression for a user query, or null when nothing in it is searchable. */
function ftsQuery(q) {
  // control characters (NUL, …) are never part of a token
  const tokens = q.replace(/\p{Cc}/gu, ' ').split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return null;
  // Each token is one quoted string (FTS syntax inside is literal) with a prefix star.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

/** The folded terms of a query: a token like "foo-bar" is the phrase foo + bar*. */
function queryTerms(q) {
  const terms = [];
  for (const t of String(q).replace(/\p{Cc}/gu, ' ').split(/\s+/)) {
    const parts = (t.match(new RegExp(TOKEN_SRC, 'gu')) || []).map(fold).filter(Boolean);
    parts.forEach((text, i) => terms.push({ text, prefix: i === parts.length - 1 }));
  }
  return terms;
}

const isHit = (token, terms) => {
  const f = fold(token);
  return terms.some((t) => (t.prefix ? f.startsWith(t.text) : f === t.text));
};

/**
 * Excerpt of `text` around its first hit: about SNIPPET_TOKENS tokens, as
 * plain-text segments [{text, hit}] with `…` at cut edges. Returns null when
 * `text` has no hit (or, with { fallback: true }, its opening tokens unmarked).
 */
function excerpt(text, terms, { fallback = false } = {}) {
  text = String(text ?? '');
  const re = new RegExp(TOKEN_SRC, 'gu');
  const before = []; // the last few tokens before the first hit
  let window = null;
  let exhausted = true;
  let m;
  while ((m = re.exec(text))) {
    const tok = { start: m.index, end: m.index + m[0].length, hit: terms.length > 0 && isHit(m[0], terms) };
    if (window) window.push(tok);
    else if (tok.hit) window = [...before, tok];
    else {
      before.push(tok);
      if (before.length > TOKENS_BEFORE_HIT) before.shift();
      continue;
    }
    if (window.length >= SNIPPET_TOKENS) { exhausted = !new RegExp(TOKEN_SRC, 'u').test(text.slice(re.lastIndex)); break; }
  }
  if (!window) {
    if (!fallback) return null;
    // no hit: the opening tokens, unmarked
    window = [];
    const re2 = new RegExp(TOKEN_SRC, 'gu');
    while (window.length < SNIPPET_TOKENS && (m = re2.exec(text))) window.push({ start: m.index, end: m.index + m[0].length, hit: false });
    if (window.length === 0) return text.trim() ? [{ text: text.slice(0, 200), hit: false }] : [];
    exhausted = !new RegExp(TOKEN_SRC, 'u').test(text.slice(window[window.length - 1].end));
  }
  const atStart = !new RegExp(TOKEN_SRC, 'u').test(text.slice(0, window[0].start));
  const start = atStart ? 0 : window[0].start;
  const end = exhausted ? text.length : window[window.length - 1].end;
  const out = [];
  const push = (t, hit) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && !last.hit && !hit) last.text += t; else out.push({ text: t, hit });
  };
  if (!atStart) push('…', false);
  let pos = start;
  for (const tok of window) {
    push(text.slice(pos, tok.start), false);
    push(text.slice(tok.start, tok.end), tok.hit);
    pos = tok.end;
  }
  push(text.slice(pos, end), false);
  if (!exhausted) push('…', false);
  return out;
}

module.exports = { ftsQuery, queryTerms, excerpt, SNIPPET_TOKENS };
