// Library tags (#26 rule 12) — one rule for the server and the FE (00 §4.8).
// A tag is trimmed, lower-cased, each whitespace run becomes '-', and the result
// must be 1–32 characters of [a-z0-9._-]. Anything else is rejected, never
// stripped ("café" is an error, not "caf").

/** Most tags one doc may carry. */
export const MAX_TAGS_PER_DOC = 20

/** Longest tag, in characters. */
export const TAG_MAX_LENGTH = 32

const TAG_RE = /^[a-z0-9._-]{1,32}$/

/** Code-point order (tags are ASCII, so this is stable across locales). */
export const compareTags = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** `{tag}` for a valid input, else `{error}` (a sentence for the UI). */
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return { error: 'A tag must be text' }
  // ASCII-only lower-casing: a non-ASCII letter that lower-cases to ASCII (KELVIN SIGN → k) stays invalid
  const tag = raw.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/\s+/g, '-')
  if (!tag) return { error: 'A tag cannot be empty' }
  if (tag.length > TAG_MAX_LENGTH) return { error: `A tag is at most ${TAG_MAX_LENGTH} characters` }
  if (!TAG_RE.test(tag)) return { error: 'A tag may only contain letters a–z, digits, ".", "_" and "-"' }
  return { tag }
}

/** A doc's whole tag list: `{tags}` (normalised, de-duplicated, sorted) or `{error}` for any invalid tag or more than MAX_TAGS_PER_DOC. */
export function normalizeTags(list) {
  if (!Array.isArray(list)) return { error: 'tags must be a list' }
  const out = new Set()
  for (const raw of list) {
    const r = normalizeTag(raw)
    if (r.error) return { error: typeof raw === 'string' ? `"${raw.trim()}": ${r.error}` : r.error }
    out.add(r.tag)
  }
  if (out.size > MAX_TAGS_PER_DOC) return { error: `A document can have at most ${MAX_TAGS_PER_DOC} tags` }
  return { tags: [...out].sort(compareTags) }
}
