'use strict';
// Derived text for a session: the server docTitle (00 §5) and the plain text
// the search index holds (00 §8). Pure functions, no I/O.

const AGENT_OPEN = /^ {0,3}<!--\s*agent(?:\s*:\s*(.*?))?\s*-->\s*$/i;
const AGENT_CLOSE = /^ {0,3}<!--\s*\/agent\s*-->\s*$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

// HTML named entities: the Latin-1 set (U+00A0..U+00FF, in order) plus common
// typographic ones. Case-sensitive (&Eacute; ≠ &eacute;), as in HTML.
const LATIN1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 '
  + 'acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig '
  + 'Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave '
  + 'Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave '
  + 'iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');
const ENTITIES = Object.assign(Object.fromEntries(LATIN1.map((n, i) => [n, String.fromCodePoint(0xa0 + i)])), {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', hellip: '…',
  bull: '•', middot: '·', prime: '′', Prime: '″', trade: '™', euro: '€', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  harr: '↔', laquo: '«', raquo: '»', dagger: '†', Dagger: '‡', permil: '‰', thinsp: '\u2009', ensp: '\u2002',
  emsp: '\u2003', zwnj: '\u200c', zwj: '\u200d', minus: '−', le: '≤', ge: '≥', ne: '≠', infin: '∞', check: '✓',
});
function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return cp > 0 ? String.fromCodePoint(cp) : m; } catch { return m; }
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

// ── linear-time scanning ────────────────────────────────────────────────────
// Every function here is linear in its input: an indexing or snippet call on a
// hostile document must never stall the event loop. Lazy cross-tag regexes
// (`<x>[\s\S]*?</x>`) and "scan from every start token" patterns are quadratic
// on unclosed tokens, so tags, comments and markdown links are scanned with
// indexOf, and line regexes only ever see one bounded line.

/** Longest line a line regex (ATX heading) is run on. */
const LINE_CAP = 1024;

/** ASCII-only lower case: same length as the input, so indices line up. */
const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
/** [a-z0-9_] — a regex word character (lower-cased text): `<name\\b` needs anything else after the name. */
const isWordChar = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c === 95;
const isAsciiLetter = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);

/** Start/end of the first closing tag `</name\s*>` at or after `from` (in the lower-cased text), or null. */
function closingTagEnd(lower, name, from) {
  let j = from;
  while ((j = lower.indexOf(`</${name}`, j)) !== -1) {
    let k = j + 2 + name.length;
    if (k < lower.length && isWordChar(lower.charCodeAt(k))) { j = k; continue; }
    while (k < lower.length && /\s/.test(lower[k])) k++;
    if (lower[k] === '>') return { start: j, end: k + 1 };
    j = k;
  }
  return null;
}

/** Inner HTML of the first `<name …>…</name>` (case-insensitive), or null. */
function firstElementInner(src, name) {
  const lower = asciiLower(src);
  let i = 0;
  while ((i = lower.indexOf(`<${name}`, i)) !== -1) {
    const after = i + 1 + name.length;
    if (after < lower.length && isWordChar(lower.charCodeAt(after))) { i = after; continue; }
    const gt = lower.indexOf('>', after);
    if (gt === -1) return null;
    const close = closingTagEnd(lower, name, gt + 1);
    return close ? src.slice(gt + 1, close.start) : null;
  }
  return null;
}

/**
 * `indexOf` for queries whose `from` never decreases: each character is
 * scanned at most once per searched string, however many starts fail.
 */
function forwardFinder(s) {
  const cache = new Map();
  return (needle, from) => {
    const c = cache.get(needle);
    if (c && (c.at === -1 ? c.from <= from : c.at >= from && c.from <= from)) return c.at;
    const at = s.indexOf(needle, from);
    cache.set(needle, { from, at });
    return at;
  };
}

const RAW_TEXT = ['script', 'style', 'template', 'noscript'];

/** Is lower[i..] `<name` followed by a non-word character (the regex `<name\b`)? */
function tagNameAt(lower, i, name) {
  return lower.startsWith(name, i + 1) && !isWordChar(lower.charCodeAt(i + 1 + name.length));
}

/**
 * Visible text of an HTML document: no tags, scripts, styles or comments.
 * Same four passes as the regex version it replaces (comments; script / style /
 * template / noscript elements; an unterminated script or style to the end;
 * then every tag), each one an indexOf scan, so it is linear time.
 */
function htmlToText(html) {
  let src = String(html);
  // 1. <!-- … --> (terminated only)
  src = stripHtmlComments(src);
  // 2. <script|style|template|noscript …> … </same>
  let lower = asciiLower(src);
  if (lower.includes('<')) {
    const out = []; let last = 0;
    const findGt = forwardFinder(lower);
    const closers = new Map(RAW_TEXT.map((n) => [n, { from: -1, hit: null }]));
    const closeFrom = (name, from) => {
      const c = closers.get(name);
      if (c.from !== -1 && c.from <= from && (c.hit === null || c.hit.start >= from)) return c.hit;
      c.from = from; c.hit = closingTagEnd(lower, name, from);
      return c.hit;
    };
    let i = lower.indexOf('<');
    while (i !== -1) {
      const name = RAW_TEXT.find((n) => tagNameAt(lower, i, n));
      if (name) {
        const gt = findGt('>', i + 1 + name.length);
        if (gt === -1) break; // no '>' after here: no later element can open either
        const close = closeFrom(name, gt + 1);
        if (close) {
          out.push(src.slice(last, i), ' ');
          last = close.end;
          i = lower.indexOf('<', last);
          continue;
        }
      }
      i = lower.indexOf('<', i + 1);
    }
    out.push(src.slice(last));
    src = out.join('');
    lower = asciiLower(src);
  }
  // 3. an unterminated <script …> / <style …> drops the rest of the document
  for (let i = lower.indexOf('<'); i !== -1; i = lower.indexOf('<', i + 1)) {
    if (!tagNameAt(lower, i, 'script') && !tagNameAt(lower, i, 'style')) continue;
    if (lower.indexOf('>', i) !== -1) src = `${src.slice(0, i)} `;
    break; // the first one decides: a later one has no more '>' after it than this one
  }
  // 4. every remaining tag (`<` or `</`, then a letter or `!`, up to the next `>`)
  return decodeEntities(removeTags(src, true, ' '))
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Replace every `open … ] mid … close` construct the way the regex
 * `\[([^\]]*)\]\(([^)]*)\)` (and its image / reference variants) would — the
 * first `]` after the opener, then `mid`, then the first `close` — with its
 * bracket text, in linear time.
 */
function replaceBracketed(s, open, mid, close) {
  if (!s.includes(open)) return s;
  // two finders: each sees non-decreasing `from` values
  const findBracket = forwardFinder(s);
  const findClose = forwardFinder(s);
  const out = [];
  let last = 0;
  let i = s.indexOf(open);
  while (i !== -1) {
    const j = findBracket(']', i + open.length);
    if (j === -1) break; // no ']' after here: no later opener can match either
    if (s.startsWith(mid, j + 1)) {
      const k = findClose(close, j + 1 + mid.length);
      if (k === -1) break;
      out.push(s.slice(last, i), s.slice(i + open.length, j));
      last = k + close.length;
      i = s.indexOf(open, last);
      continue;
    }
    i = s.indexOf(open, i + 1);
  }
  out.push(s.slice(last));
  return out.join('');
}

/**
 * Remove tags the way `/<\/?[a-z][^>]*>/gi` does (with `bang`, `[a-z!]`): `<`
 * or `</`, an ASCII letter (or `!`), up to the next `>` — replaced by `repl`.
 * Linear time.
 */
function removeTags(s, bang = false, repl = '') {
  if (!s.includes('<')) return s;
  const findGt = forwardFinder(s);
  const out = [];
  let last = 0;
  let i = s.indexOf('<');
  while (i !== -1) {
    const slash = s.charCodeAt(i + 1) === 47 ? 1 : 0;
    const c = s.charCodeAt(i + 1 + slash);
    if (isAsciiLetter(c) || (bang && c === 33)) {
      const gt = findGt('>', i + 2 + slash);
      if (gt === -1) break; // no '>' after here: nothing further is a tag
      out.push(s.slice(last, i), repl);
      last = gt + 1;
      i = s.indexOf('<', last);
      continue;
    }
    i = s.indexOf('<', i + 1);
  }
  out.push(s.slice(last));
  return out.join('');
}

/** Is the character a regex \s (ASCII decided without a regex)? */
const isSpace = (ch) => {
  const c = ch.charCodeAt(0);
  return c < 128 ? c === 32 || (c >= 9 && c <= 13) : /\s/.test(ch);
};
const WORD_RE = /[\p{L}\p{N}_]/u;
/** Is the code point string `ch` a word character (\p{L}, \p{N} or _)? ASCII is decided without a regex. */
function isWord(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  return WORD_RE.test(ch);
}
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;
const cpAt = (s, i) => { const c = s.charCodeAt(i); return c < 0xd800 || c > 0xdbff ? s[i] : String.fromCodePoint(s.codePointAt(i)); };
/** The code point that ends just before index `i`. */
function cpBefore(s, i) {
  const lo = s.charCodeAt(i - 1);
  if (lo < 0xdc00 || lo > 0xdfff) return s[i - 1];
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

/**
 * `_emphasis_` / `__strong__` at word boundaries, removed the way
 * `/(^|[^\p{L}\p{N}_])(__?)(?!\s)(.+?)\2(?![\p{L}\p{N}_])/gu` would (snake_case
 * names keep their underscores), in linear time: closers and line ends are
 * found with forward-only searches.
 */
function stripUnderscoreEmphasis(s) {
  if (!s.includes('_')) return s;
  // first closer for `delim` at or after `from`: the delimiter not followed by a word character
  const closers = new Map();
  const closerAt = (delim, from) => {
    const c = closers.get(delim);
    if (c && c.from <= from && (c.at === -1 || c.at >= from)) return c.at;
    let q = from;
    while ((q = s.indexOf(delim, q)) !== -1) {
      const after = q + delim.length;
      if (after >= s.length || !isWord(cpAt(s, after))) break;
      q += 1;
    }
    closers.set(delim, { from, at: q });
    return q;
  };
  let eolFrom = -1; let eol = -1;
  const lineEnd = (from) => {
    if (eolFrom !== -1 && eolFrom <= from && (eol === -1 || eol >= from)) return eol === -1 ? s.length : eol;
    eolFrom = from;
    LINE_TERMINATOR.lastIndex = from; // scans only as far as the next terminator
    const m = LINE_TERMINATOR.exec(s);
    eol = m ? m.index : -1;
    return eol === -1 ? s.length : eol;
  };
  const out = [];
  let last = 0;
  let exhausted = false; // no closing '_' anywhere ahead: nothing further can match
  let d = s.indexOf('_');
  while (d !== -1 && !exhausted) {
    let start = -1; // where the match (group 1) starts
    if (d === 0) start = 0;
    else {
      const prev = cpBefore(s, d);
      if (!isWord(prev) && d - prev.length >= last) start = d - prev.length;
    }
    let matched = false;
    if (start !== -1) {
      for (const delim of ['__', '_']) {
        if (!s.startsWith(delim, d)) continue;
        const c = d + delim.length;
        if (c >= s.length || isSpace(cpAt(s, c))) continue;
        const q = closerAt(delim, c + cpAt(s, c).length);
        if (q === -1) { if (delim === '_') exhausted = true; continue; }
        if (q > lineEnd(c)) continue;
        out.push(s.slice(last, d), s.slice(c, q));
        last = q + delim.length;
        matched = true;
        break;
      }
    }
    d = s.indexOf('_', matched ? last : d + 1);
  }
  out.push(s.slice(last));
  return out.join('');
}

/** Plain text of inline markdown (headings, titles, snippets), in linear time. */
function stripInlineMarkdown(s) {
  let t = String(s);
  t = replaceBracketed(t, '![', '(', ')');
  t = replaceBracketed(t, '[', '(', ')');
  t = replaceBracketed(t, '[', '[', ']');
  t = removeTags(t.replace(/`+([^`]*)`+/g, '$1'));
  t = stripUnderscoreEmphasis(t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1'));
  return t
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1');
}

/** Split leading YAML front matter off a markdown document. */
function splitFrontMatter(md) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(md);
  return m ? { front: m[1], body: md.slice(m[0].length) } : { front: null, body: md };
}

function frontMatterTitle(front) {
  for (const line of front.split(/\r?\n/)) {
    const m = /^title[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    return v;
  }
  return '';
}

/**
 * The content of an ATX H1 line, as `^ {0,3}#(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$`
 * captures it (null when that has no content group: not an H1, or a bare `#`),
 * parsed by hand in linear time: a closing `#` run after whitespace and
 * trailing blanks are not content.
 */
function atxH1Content(line) {
  const m = /^ {0,3}#/.exec(line);
  if (!m) return null;
  let i = m[0].length;
  if (i >= line.length || (line[i] !== ' ' && line[i] !== '\t')) return null;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  const c = line.slice(i);
  if (/[\r\u2028\u2029]/.test(c)) return null; // `.` stops there and `$` cannot match
  const blank = (k) => c[k] === ' ' || c[k] === '\t';
  let e = c.length;
  while (e > 0 && blank(e - 1)) e--;
  let k = e;
  while (k > 0 && c[k - 1] === '#') k--;
  if (k < e && k > 0 && blank(k - 1)) {
    while (k > 0 && blank(k - 1)) k--;
    return c.slice(0, k);
  }
  return c.slice(0, e);
}

/** First ATX `# ` heading outside fences and (top-level) agent sections. */
function firstH1(body) {
  let fence = null; let inAgent = false;
  for (const fullLine of body.split(/\r?\n/)) {
    // Marker regexes only see a bounded prefix of a line.
    const line = fullLine.length > LINE_CAP ? fullLine.slice(0, LINE_CAP) : fullLine;
    // Fast path: fences, agent markers and headings start with one of ` ~ < # (after ≤3 spaces).
    let lead = 0;
    while (lead < 3 && line[lead] === ' ') lead++;
    const c = line[lead];
    if (c !== '`' && c !== '~' && c !== '<' && c !== '#') continue;
    if (fence) { if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null; continue; }
    const f = FENCE.exec(line);
    if (f) { fence = f[1]; continue; }
    if (inAgent) { if (AGENT_CLOSE.test(line)) inAgent = false; continue; }
    if (AGENT_OPEN.test(line)) { inAgent = true; continue; }
    const h = atxH1Content(line);
    if (h !== null) {
      const t = collapse(stripInlineMarkdown(h));
      if (t) return t;
    }
  }
  return '';
}

/** A markdown table delimiter row (`| --- | :-: |`), checked by hand (no backtracking). */
function isTableDelimiterRow(line) {
  let t = line.trim();
  if (!t.includes('--')) return false;
  if (t[0] === '|') t = t.slice(1);
  const cells = t.split('|');
  if (cells.length < 2) return false; // at least one cell closed by '|'
  const last = cells.pop().trim();
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim())) && /^:?-*:?$/.test(last);
}

/** Replace terminated `<!-- … -->` comments with a space (an unterminated one stays, as text). */
function stripHtmlComments(s) {
  if (!s.includes('<!--')) return s;
  const out = [];
  let i = 0;
  for (;;) {
    const j = s.indexOf('<!--', i);
    if (j === -1) break;
    const end = s.indexOf('-->', j + 4);
    if (end === -1) break;
    out.push(s.slice(i, j), ' ');
    i = end + 3;
  }
  out.push(s.slice(i));
  return out.join('');
}

/**
 * Markdown source → plain reading text, for search snippets: block markers
 * (headings, quotes, list bullets, fences, table pipes), emphasis, links,
 * HTML tags and comments removed; whitespace collapsed to single spaces.
 * Block markers are removed line by line; everything is linear time.
 */
function markdownToPlain(md) {
  return stripInlineMarkdown(stripHtmlComments(String(md))
    .replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gm, ' ')
    .replace(/^ {0,3}#{1,6}(?=\s|$)/gm, ' ')
    .replace(/^ {0,3}(?:>\s?)+/gm, ' ')
    // leading blanks of the bullet's own line only (`^\s*` rescanned every blank run from each of its line starts)
    .replace(/^[^\S\n\r\u2028\u2029]*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/gm, ' ')
    .replace(/^ {0,3}(?:[-*_]\s*){3,}$/gm, ' ')
    // table delimiter rows, checked by hand (the old nested-quantifier regex backtracked badly)
    .replace(/^[^\n\r\u2028\u2029]*--[^\n\r\u2028\u2029]*/gm, (line) => (isTableDelimiterRow(line) ? ' ' : line)))
    .replace(/\|/g, ' ')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const isHtml = (contentType) => contentType === 'html';

/**
 * docTitle per 00 §5 (server, line-based): sessionName → front matter title /
 * HTML <title> → first H1 / HTML <h1> → filename without extension → Untitled.
 */
function docTitle({ sessionName, filename, contentType } = {}, markdown = '') {
  const candidates = [];
  candidates.push(() => (typeof sessionName === 'string' ? sessionName : ''));
  const src = typeof markdown === 'string' ? markdown : '';
  if (isHtml(contentType)) {
    const inner = (name) => { const t = firstElementInner(src, name); return t === null ? '' : htmlToText(t); };
    candidates.push(() => inner('title'));
    candidates.push(() => inner('h1'));
  } else {
    const { front, body } = splitFrontMatter(src);
    candidates.push(() => (front ? frontMatterTitle(front) : ''));
    candidates.push(() => firstH1(body));
  }
  candidates.push(() => (typeof filename === 'string' ? filename.replace(/\.(md|markdown|txt|html|htm)$/i, '') : ''));
  for (const c of candidates) {
    const t = collapse(c());
    if (t) return t;
  }
  return 'Untitled';
}

/** The text indexed for a session's content (00 §8: full source; HTML stripped). */
function searchContent(contentType, markdown) {
  return isHtml(contentType) ? htmlToText(markdown || '') : String(markdown || '');
}

/** Plain text for search snippets (the index keeps the full source, 00 §8). */
function snippetText(contentType, markdown) {
  return isHtml(contentType) ? htmlToText(markdown || '').replace(/\s+/g, ' ').trim() : markdownToPlain(markdown || '');
}

module.exports = { docTitle, htmlToText, markdownToPlain, searchContent, snippetText, decodeEntities };
