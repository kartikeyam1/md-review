// Reactions (#24) and reader identity (00 §7) — one definition for the server and the FE (00 §4.8).

/** The fixed emoji set, in display order (#24 rule 1). Addressed by code; `emoji` is display only. */
export const REACTIONS = Object.freeze([
  Object.freeze({ code: '+1', emoji: '👍', label: 'Thumbs up' }),
  Object.freeze({ code: 'tada', emoji: '🎉', label: 'Celebrate' }),
  Object.freeze({ code: 'question', emoji: '❓', label: 'Question' }),
  Object.freeze({ code: 'eyes', emoji: '👀', label: 'Looking' }),
  Object.freeze({ code: 'heart', emoji: '❤️', label: 'Love' }),
  Object.freeze({ code: 'rocket', emoji: '🚀', label: 'Ship it' }),
])

export const REACTION_CODES = Object.freeze(REACTIONS.map((r) => r.code))

/** 00 §7: a browser's anonymous reader id (`anon-<uuid>`), validated server side. */
export const READER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

/** #24 rule 4: a section key is a heading id (Unicode word characters and '-'), 1–200 chars. */
export const SECTION_RE = /^[\p{L}\p{M}\p{N}\p{Pc}-]{1,200}$/u

/** Max length of a reader's self-declared name (00 §7). */
export const READER_NAME_MAX = 80

/** A reader name as stored: trimmed, at most 80 chars; empty / non-string → null (anonymous). */
export function normalizeReaderName(v) {
  if (typeof v !== 'string') return null
  const t = v.trim().slice(0, READER_NAME_MAX).trim()
  return t || null
}
