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

// ── title substrings (persona-QA m6) ─────────────────────────────────────────
// unicode61 keeps an unbroken CJK run as ONE token ("日本語のレポート：配送ルート"
// → "日本語のレポート", "配送ルート"), so prefix matching only finds the start of
// a run, and a token with no letter/number (an emoji) is not indexed at all.
// For a query holding such a token every query token is also tried as a
// case-insensitive substring of the title (a scan of sessions.title — titles
// only; contents keep token matching). See DECISIONS.md.

/** Scripts written without spaces between words. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const MAX_SUBSTRING_TERMS = 8;

/**
 * The lower-cased query tokens to look for as title substrings, or [] when the
 * query has no token the index cannot find (no CJK-like script, no symbol-only token).
 */
function titleSubstringTerms(q) {
  const tokens = String(q).replace(/\p{Cc}/gu, ' ').split(/\s+/).filter(Boolean).map((t) => t.normalize('NFC'));
  const symbolOnly = (t) => !/[\p{L}\p{N}]/u.test(t) && /[^\p{P}]/u.test(t); // an emoji, →, …; not bare punctuation
  const needs = tokens.some((t) => NO_SPACE_SCRIPT.test(t) || symbolOnly(t));
  if (!needs) return [];
  // pure punctuation (", -, *) is FTS syntax noise, not something to look for
  return tokens.filter((t) => /[^\p{P}]/u.test(t)).slice(0, MAX_SUBSTRING_TERMS).map((t) => t.toLowerCase());
}

/** Plain-text segments of `text` with every occurrence of `subs` marked as hits, or null when none occurs. */
function substringExcerpt(text, subs) {
  text = String(text ?? '');
  if (!text || !subs.length) return null;
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return null; // case folding changed offsets: no safe marks
  const hits = [];
  for (const sub of subs) {
    if (!sub) continue;
    for (let i = lower.indexOf(sub); i !== -1; i = lower.indexOf(sub, i + sub.length)) hits.push([i, i + sub.length]);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  let pos = 0;
  for (const [a, b] of hits) {
    if (b <= pos) continue;
    const start = Math.max(a, pos);
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
    out.push({ text: text.slice(start, b), hit: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

module.exports = { ftsQuery, queryTerms, excerpt, titleSubstringTerms, substringExcerpt, SNIPPET_TOKENS };
