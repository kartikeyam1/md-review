'use strict';
// Doc mode (#2 rule 12, 00 §1.4) — the server side of shared/docMode.mjs, which
// the FE uses too. Every route that reads or writes `mode` goes through here.
const { DOC_MODES, isDocMode, modeOf: reportedMode, MODE_ERROR } = require('../shared/docMode.mjs');

const VALID_MODES = new Set(DOC_MODES);
/** The mode if valid, else null. */
const validMode = (m) => (isDocMode(m) ? m : null);
/** What a response reports for a stored session: its mode, or `review` for one without (computed on read). */
const modeOf = (meta) => reportedMode(meta && meta.mode);
/** Default for a new session without `mode`: publish, or review when an approval webhook is attached. */
const defaultMode = (body) => (body && body.callback_url ? 'review' : 'publish');

/**
 * A request body's `mode`: `{}` when absent, `{ mode }` when valid, `{ error }`
 * (the documented 400 body) for anything else — wrong case, null, non-strings.
 */
function readMode(body) {
  if (!body || body.mode === undefined) return {};
  return isDocMode(body.mode) ? { mode: body.mode } : { error: MODE_ERROR };
}

module.exports = { DOC_MODES, VALID_MODES, MODE_ERROR, isDocMode, validMode, modeOf, defaultMode, readMode };
