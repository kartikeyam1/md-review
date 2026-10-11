'use strict';
// Template variables (#27 rules 4–8) — pure: no I/O, the clock is passed in.
//
// Syntax `{{name}}` (spaces or tabs allowed inside the braces, never a line
// break), name = [a-zA-Z][a-zA-Z0-9_]*, case-sensitive. Only names that have a
// value are replaced; everything else stays verbatim (unknown names, mermaid
// `A{{Decide}}` nodes, `{{ }}`, `{{1abc}}`). `\{{name}}` produces the literal
// `{{name}}`. One left-to-right pass with a replacer function: a value is never
// re-expanded and `$&`-style patterns in values are inserted literally.

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** An optional escaping backslash, then a placeholder. */
const PLACEHOLDER_RE = /(\\?)\{\{[ \t]*([a-zA-Z][a-zA-Z0-9_]*)[ \t]*\}\}/g;

const MAX_VARIABLES = 20;
const MAX_VARIABLE_LENGTH = 500;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** Rule 8: the sorted, de-duplicated names the content uses (escaped placeholders excluded). */
function listVariables(content) {
  if (typeof content !== 'string') return [];
  const names = new Set();
  for (const m of content.matchAll(PLACEHOLDER_RE)) if (!m[1]) names.add(m[2]);
  return [...names].sort();
}

/**
 * Replace every placeholder whose name has a value in `values` (own string
 * properties only). `html` escapes the inserted values (rule 7).
 */
function substitute(content, values, { html = false } = {}) {
  if (typeof content !== 'string') return '';
  const vals = values || {};
  return content.replace(PLACEHOLDER_RE, (whole, esc, name) => {
    if (esc) return whole.slice(1); // \{{name}} → literal {{name}}
    if (!Object.hasOwn(vals, name) || typeof vals[name] !== 'string') return whole;
    return html ? escapeHtml(vals[name]) : vals[name];
  });
}

const pad2 = (n) => String(n).padStart(2, '0');

/** ISO-8601 week of a calendar date, as `YYYY-Www` (the ISO week-year may differ from `y`). */
function isoWeek(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dow + 3); // the Thursday of this week decides the year
  const isoYear = date.getUTCFullYear();
  const week = Math.ceil(((date - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7);
  return `${isoYear}-W${pad2(week)}`;
}

/** A usable IANA timezone, else 'UTC' (absent, non-string or unknown zones). */
function resolveTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** `date` (YYYY-MM-DD) and `week` (ISO, YYYY-Www) of instant `now` in `timezone` (UTC if invalid). */
function dateValues(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimezone(timezone), year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const y = get('year'); const m = get('month'); const d = get('day');
  return { date: `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`, week: isoWeek(y, m, d) };
}

/** null when `variables` is acceptable (absent, or ≤ 20 valid names → strings ≤ 500 chars), else the 400 message. */
function validateVariables(variables) {
  if (variables === undefined || variables === null) return null;
  if (typeof variables !== 'object' || Array.isArray(variables)) return 'variables must be an object of strings';
  const keys = Object.keys(variables);
  if (keys.length > MAX_VARIABLES) return `At most ${MAX_VARIABLES} variables`;
  for (const k of keys) {
    if (!NAME_RE.test(k)) return `Invalid variable name "${k}" (letters, digits and _; starts with a letter)`;
    if (typeof variables[k] !== 'string') return `Variable "${k}" must be a string`;
    if (variables[k].length > MAX_VARIABLE_LENGTH) return `Variable "${k}" is longer than ${MAX_VARIABLE_LENGTH} characters`;
  }
  return null;
}

const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The values for one render (rule 5): built-ins `title`, `date`, `week`, and
 * `author` / `collection` when given (non-empty), overridden by `variables`.
 */
function templateValues({ title, author, collection, variables, now = Date.now(), timezone } = {}) {
  const values = { ...dateValues(now, timezone) };
  const t = nonEmpty(title); if (t !== null) values.title = t;
  const a = nonEmpty(author); if (a !== null) values.author = a;
  const c = nonEmpty(collection); if (c !== null) values.collection = c;
  if (variables && typeof variables === 'object') {
    for (const [k, v] of Object.entries(variables)) if (typeof v === 'string') values[k] = v;
  }
  return values;
}

/** Render a template's content for a new doc: `template` = { content, contentType }, `opts` as templateValues. */
function renderTemplate(template, opts = {}) {
  return substitute(template.content, templateValues(opts), { html: template.contentType === 'html' });
}

module.exports = {
  NAME_RE, MAX_VARIABLES, MAX_VARIABLE_LENGTH,
  escapeHtml, listVariables, substitute, isoWeek, resolveTimezone, dateValues, validateVariables, templateValues, renderTemplate,
};
