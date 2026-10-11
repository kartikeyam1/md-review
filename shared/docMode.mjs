// Per-doc mode (#2 rule 12, 00 §1.4) — one definition for the server and the FE
// (00 §4.8: pure, dependency-free ESM; the server loads it with require(), the
// FE through the `@shared` alias).
//   publish = a read-only page for humans; review = comments + approval.

export const DOC_MODES = Object.freeze(['publish', 'review'])

/** True only for the exact strings 'publish' and 'review' (case matters). */
export function isDocMode(v) {
  return v === 'publish' || v === 'review'
}

/** The mode to report: the stored one when valid, else 'review' (legacy, computed on read). */
export function modeOf(v) {
  return isDocMode(v) ? v : 'review'
}

/** The 400 body for an invalid `mode` on POST /paste and PUT /paste/:id/meta. */
export const MODE_ERROR = Object.freeze({ error: 'mode must be "publish" or "review"' })
