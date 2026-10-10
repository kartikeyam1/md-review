'use strict';
// The 1200×630 PNG cover behind og:image (#22 rules 8–10): an SVG template
// rendered with @resvg/resvg-js and the Montserrat files bundled in
// server/assets/fonts — never system fonts, so a cover looks the same on
// every host. Covers are cached on disk as DATA_DIR/covers/{id}-{cover_key}.png.
//
// The fonts are static Regular (400) and SemiBold (600) instances of
// google/fonts ofl/montserrat/Montserrat[wght].ttf (commit 76fca9fd, OFL 1.1,
// see assets/fonts/OFL.txt): resvg ignores variable-font axes, so the
// variable file alone would render every weight as Thin.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { COVERS_DIR } = require('./config.cjs');

// Bump when the template's look changes: every cover_key (and so every cached
// image and every og:image URL) changes with it.
const TEMPLATE_VERSION = 'cover-v1';

const W = 1200;
const H = 630;
const PAD = 80;
const META_SIZE = 28;
const PALETTE = { bg: '#280A38', accent: '#B066FF', title: '#FFFFFF', meta: '#9B8FA8' };
const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const FONT_FILES = { regular: 'Montserrat-Regular.ttf', semibold: 'Montserrat-SemiBold.ttf' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── text helpers ────────────────────────────────────────────────────────────

/** "D Mon YYYY" in UTC (the server's own clock zone must not change a cover). */
function formatDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The cover's type label: "Markdown" or "HTML". */
const typeLabel = (contentType) => (contentType === 'html' ? 'HTML' : 'Markdown');

/**
 * `{Markdown|HTML} · by {author} · Updated {D Mon YYYY}` (absent parts left
 * out). `fits(line)` says whether a line fits the cover; the author is cut
 * with … until it does, so the date is always shown.
 */
function metaLine({ contentType, author, updatedAt }, fits = () => true) {
  const head = typeLabel(contentType);
  const day = updatedAt ? formatDay(updatedAt) : null;
  const tail = day ? ` · Updated ${day}` : '';
  let by = Array.from(typeof author === 'string' ? author.replace(/\s+/g, ' ').trim() : '').slice(0, 80);
  if (!by.length) return head + tail;
  const line = (cut) => `${head} · by ${by.join('').trimEnd()}${cut ? '…' : ''}${tail}`;
  if (fits(line(false))) return line(false);
  while (by.length > 1 && !fits(line(true))) by = by.slice(0, -1);
  return line(true);
}

// Emoji and their glue: pictographs, skin-tone modifiers, flags, ZWJ,
// variation selectors, keycaps and tag characters.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu;

/**
 * The text a cover can actually draw: emoji removed, characters the bundled
 * font has no glyph for dropped, whitespace collapsed. `hasGlyph` may be null
 * (renderer unavailable): then only emoji are removed.
 */
function drawableText(s, hasGlyph) {
  let out = '';
  for (const ch of String(s).replace(EMOJI, '')) {
    if (/\s/.test(ch)) out += ' ';
    else if (!hasGlyph || hasGlyph(ch.codePointAt(0))) out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Everything the cover shows, and its cover_key: the title (drawable part;
 * falls back to the filename, then "{Markdown|HTML} document", when nothing
 * readable is left), the meta line (fitted to the width), the type label.
 */
function coverText({ title, filename, contentType, author, updatedAt }) {
  let e = null;
  try { e = loadEngine(); } catch { /* rendering is unavailable; the key still has to be stable */ }
  const hasGlyph = e ? e.semibold.hasGlyph : null;
  const readable = (t) => (/[\p{L}\p{N}]/u.test(t) ? t : '');
  const label = typeLabel(contentType);
  const name = typeof filename === 'string' ? filename.replace(/\.(md|markdown|txt|html|htm)$/i, '') : '';
  const coverTitle = readable(drawableText(title, hasGlyph)) || readable(drawableText(name, hasGlyph)) || `${label} document`;
  const fits = e ? (l) => e.regular.width(l, META_SIZE) <= W - 2 * PAD : () => true;
  const line = metaLine({ contentType, author: drawableText(author || '', hasGlyph), updatedAt }, fits);
  return { title: coverTitle, line, label, key: coverKey(coverTitle, line) };
}

/** cover_key = first 12 hex of md5(template_version | title | meta line). */
function coverKey(title, line) {
  return crypto.createHash('md5').update(`${TEMPLATE_VERSION}|${title}|${line}`).digest('hex').slice(0, 12);
}

/** XML-escape text for the SVG, dropping characters XML 1.0 cannot carry. */
function xmlText(s) {
  return String(s).toWellFormed()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── font metrics (advance widths for wrapping; read once from the TTFs) ─────

/** Minimal TrueType reader: unitsPerEm and a code point → advance width lookup. */
function fontMetrics(buf) {
  const tables = {};
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    tables[buf.toString('latin1', o, o + 4)] = buf.readUInt32BE(o + 8);
  }
  const unitsPerEm = buf.readUInt16BE(tables.head + 18);
  const numHMetrics = buf.readUInt16BE(tables.hhea + 34);
  const advanceOf = (gid) => buf.readUInt16BE(tables.hmtx + 4 * Math.min(gid, numHMetrics - 1));

  // cmap: prefer a full-repertoire format 12 subtable, else BMP format 4.
  const cmap = tables.cmap;
  let f12 = null; let f4 = null;
  for (let i = 0, count = buf.readUInt16BE(cmap + 2); i < count; i++) {
    const rec = cmap + 4 + i * 8;
    const sub = cmap + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(sub);
    if (format === 12 && f12 === null) f12 = sub;
    if (format === 4 && f4 === null) f4 = sub;
  }
  function glyphId(cp) {
    if (f12 !== null) {
      const groups = buf.readUInt32BE(f12 + 12);
      let lo = 0; let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = f12 + 16 + mid * 12;
        const start = buf.readUInt32BE(g); const end = buf.readUInt32BE(g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return buf.readUInt32BE(g + 8) + (cp - start);
      }
      return 0;
    }
    if (f4 === null || cp > 0xffff) return 0;
    const segX2 = buf.readUInt16BE(f4 + 6);
    const ends = f4 + 14; const starts = ends + segX2 + 2; const deltas = starts + segX2; const ranges = deltas + segX2;
    for (let i = 0; i < segX2; i += 2) {
      if (buf.readUInt16BE(ends + i) < cp) continue;
      const start = buf.readUInt16BE(starts + i);
      if (start > cp) return 0;
      const delta = buf.readInt16BE(deltas + i);
      const ro = buf.readUInt16BE(ranges + i);
      if (ro === 0) return (cp + delta) & 0xffff;
      const gid = buf.readUInt16BE(ranges + i + ro + 2 * (cp - start));
      return gid === 0 ? 0 : (gid + delta) & 0xffff;
    }
    return 0;
  }
  const cache = new Map();
  /** Advance width of one code point in em; characters the font lacks count as a full em (CJK/emoji). */
  function advance(cp) {
    let w = cache.get(cp);
    if (w === undefined) {
      const gid = glyphId(cp);
      w = gid === 0 ? 1 : advanceOf(gid) / unitsPerEm;
      cache.set(cp, w);
    }
    return w;
  }
  return {
    width: (text, size) => { let w = 0; for (const ch of text) w += advance(ch.codePointAt(0)); return w * size; },
    hasGlyph: (cp) => glyphId(cp) !== 0,
  };
}

// ── renderer (loaded lazily, once; a failure is remembered) ─────────────────

let engine = null;
let engineError = null;
function loadEngine() {
  if (engine) return engine;
  if (engineError) throw engineError;
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const fontFiles = [FONT_FILES.regular, FONT_FILES.semibold].map((f) => path.join(FONT_DIR, f));
    const [regular, semibold] = fontFiles.map((f) => fs.readFileSync(f));
    engine = { Resvg, fontFiles, regular: fontMetrics(regular), semibold: fontMetrics(semibold) };
    return engine;
  } catch (e) {
    engineError = e;
    console.error('[md-review] cover renderer unavailable:', e.message);
    throw e;
  }
}

/** Whether covers can be rendered at all (renderer + bundled fonts load). Rule 10: the meta page omits og:image otherwise. */
function coversAvailable() {
  try { loadEngine(); return true; } catch { return false; }
}

// ── layout ──────────────────────────────────────────────────────────────────

/** Break one word that is wider than `max` into pieces that fit. */
function splitLongWord(word, size, measure, max) {
  const pieces = [];
  let cur = '';
  for (const ch of word) {
    if (cur && measure(cur + ch, size) > max) { pieces.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/** Greedy word wrap into lines no wider than `max`. */
function wrap(text, size, measure, max) {
  const lines = [];
  let cur = '';
  for (const word of text.split(' ').filter(Boolean)) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (measure(candidate, size) <= max) { cur = candidate; continue; }
    if (cur) lines.push(cur);
    if (measure(word, size) <= max) { cur = word; continue; }
    const pieces = splitLongWord(word, size, measure, max);
    cur = pieces.pop();
    lines.push(...pieces);
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Title lines: the largest size 64→40 that fits in ≤3 lines, else 40 px, 3 lines, the last ending in "…". */
function layoutTitle(title, measure, max = W - 2 * PAD) {
  for (const size of [64, 58, 52, 46, 40]) {
    const lines = wrap(title, size, measure, max);
    if (lines.length <= 3) return { size, lines };
  }
  const size = 40;
  const lines = wrap(title, size, measure, max).slice(0, 3);
  let last = Array.from(lines[2]);
  while (last.length && measure(`${last.join('').trimEnd()}…`, size) > max) last.pop();
  lines[2] = `${last.join('').trimEnd()}…`;
  return { size, lines };
}

/** The cover SVG for a title (≤200 chars, whitespace collapsed) and its meta line. */
function coverSvg({ title, line, label }) {
  const e = loadEngine();
  const measure = (t, size) => e.semibold.width(t, size);
  const { size, lines } = layoutTitle(title || 'Untitled', measure);
  const lh = Math.round(size * 1.18);
  // Title block centred in the band between the wordmark and the meta line.
  const bandTop = 180; const bandBottom = 500;
  const firstBaseline = Math.round(bandTop + (bandBottom - bandTop - lh * lines.length) / 2 + size * 0.95);
  const pillFont = 22;
  const pillText = label.toUpperCase();
  const pillW = Math.ceil(e.semibold.width(pillText, pillFont) + pillFont * 0.08 * pillText.length + 40);
  const pillH = 44;
  const pillX = W - PAD - pillW;
  const pillY = 72;
  const font = 'font-family="Montserrat"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${PALETTE.bg}"/>
<text x="${PAD}" y="105" ${font} font-weight="600" font-size="34" fill="${PALETTE.accent}">md-review</text>
<rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${PALETTE.accent}"/>
<text x="${pillX + pillW / 2}" y="${pillY + 30}" ${font} font-weight="600" font-size="${pillFont}" letter-spacing="${(pillFont * 0.08).toFixed(2)}" text-anchor="middle" fill="${PALETTE.bg}">${xmlText(pillText)}</text>
${lines.map((l, i) => `<text x="${PAD}" y="${firstBaseline + i * lh}" ${font} font-weight="600" font-size="${size}" fill="${PALETTE.title}">${xmlText(l)}</text>`).join('\n')}
<text x="${PAD}" y="${H - PAD + 10}" ${font} font-weight="400" font-size="${META_SIZE}" fill="${PALETTE.meta}">${xmlText(line)}</text>
</svg>`;
}

/** Render a cover PNG (Buffer). Throws when the renderer or fonts cannot load. */
function renderCover({ title, line, label }) {
  const e = loadEngine();
  const svg = coverSvg({ title, line, label });
  const r = new e.Resvg(svg, {
    fitTo: { mode: 'original' },
    font: { fontFiles: e.fontFiles, loadSystemFonts: false, defaultFontFamily: 'Montserrat' },
    logLevel: 'off',
  });
  return r.render().asPng();
}

// ── disk cache ──────────────────────────────────────────────────────────────

const coverPath = (id, key) => path.join(COVERS_DIR, `${id}-${key}.png`);

/**
 * The cached cover for (id, key), rendering and storing it on a miss. A new
 * key replaces the doc's older files. Synchronous end to end, so concurrent
 * requests for a cold cover render it once. `removeOthers(id, keepName)` is
 * storage's cleanup helper.
 */
function getCover(id, key, spec, removeOthers) {
  const file = coverPath(id, key);
  try { return fs.readFileSync(file); } catch { /* miss */ }
  const png = renderCover(spec);
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, png);
  fs.renameSync(tmp, file);
  removeOthers(id, path.basename(file));
  return png;
}

module.exports = {
  TEMPLATE_VERSION, typeLabel, metaLine, coverText, drawableText, coverKey, formatDay, xmlText, fontMetrics, layoutTitle, wrap,
  coversAvailable, coverSvg, renderCover, getCover,
};
