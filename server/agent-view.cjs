'use strict';
// Human view vs agent view (#28 rules 15–18) — the server side of
// shared/agentSections.mjs (00 §4.8). Every read route that takes `view` goes
// through here, so the raw route, /paste/:id[/markdown] and the meta page
// agree on what is hidden and on the ETag variants.
const { stripAgentSections, countAgentSections } = require('../shared/agentSections.mjs');

const VIEWS = new Set(['agent', 'human']);

// Every opener contains this; a source without it has no agent sections (a cheap
// linear precheck that keeps the line scanner off ordinary documents).
const MAYBE_OPENER = /<!--\s*agent/i;

/**
 * The `view` query value: 'agent' when absent (the default for raw/API/MCP
 * reads), 'agent' | 'human' when valid, null for anything else (callers
 * answer 400). Case-sensitive: `AGENT` is unknown.
 */
function readView(searchParams) {
  if (!searchParams.has('view')) return 'agent';
  const v = searchParams.get('view');
  return VIEWS.has(v) ? v : null;
}

/**
 * Rule 18: one ETag per response variant, as a suffix inside the quotes —
 * 'human' → `-h`, 'agent' (an explicit ?view=agent whose body differs from the
 * plain read) → `-a`, anything else (the plain/default body) unchanged.
 */
const ETAG_SUFFIX = { human: '-h', agent: '-a' };
const viewEtag = (etag, variant) => (ETAG_SUFFIX[variant] ? etag.replace(/"$/, `${ETAG_SUFFIX[variant]}"`) : etag);

/**
 * `{ markdown, count }` of `source` in `view` (agent = the source unchanged).
 * HTML docs have no agent sections (rule 21): unchanged, count 0.
 */
function viewOf(source, view, html = false) {
  const text = typeof source === 'string' ? source : '';
  if (html || !MAYBE_OPENER.test(text)) return { markdown: text, count: 0 };
  return view === 'human' ? stripAgentSections(text) : { markdown: text, count: countAgentSections(text) };
}

/** The human view of a markdown source (display derivations: docTitle, the #22 description). */
function humanMarkdown(source) {
  const text = typeof source === 'string' ? source : '';
  return MAYBE_OPENER.test(text) ? stripAgentSections(text).markdown : text;
}

const VIEW_ERROR = { error: 'Invalid view: use view=agent or view=human' };

module.exports = { readView, viewEtag, viewOf, humanMarkdown, VIEW_ERROR };
