/**
 * Minimal edit description between two versions of a document: the longest
 * common prefix and suffix are kept, everything in between is replaced.
 *
 * Sent to the server as `{ delta: { keepStart, keepEnd, insert } }` together
 * with `If-Match: <content_hash>` — the hash pins the exact base, so the server
 * needs no context matching and the result is bit-identical to `next`. For a
 * typical edit (typing in one place) the payload is a few bytes instead of the
 * whole document. Indices are UTF-16 code units on both sides (JS strings).
 */
export interface TextDelta {
  keepStart: number
  keepEnd: number
  insert: string
}

export function computeDelta(base: string, next: string): TextDelta {
  const maxPrefix = Math.min(base.length, next.length)
  let keepStart = 0
  while (keepStart < maxPrefix && base.charCodeAt(keepStart) === next.charCodeAt(keepStart)) keepStart++

  const maxSuffix = maxPrefix - keepStart
  let keepEnd = 0
  while (
    keepEnd < maxSuffix &&
    base.charCodeAt(base.length - 1 - keepEnd) === next.charCodeAt(next.length - 1 - keepEnd)
  ) keepEnd++

  return { keepStart, keepEnd, insert: next.slice(keepStart, next.length - keepEnd) }
}

export function applyDelta(base: string, delta: TextDelta): string {
  return base.slice(0, delta.keepStart) + delta.insert + base.slice(base.length - delta.keepEnd)
}

/** Rough wire size of the delta payload, to decide whether it beats a full PUT. */
export function deltaSize(delta: TextDelta): number {
  return delta.insert.length + 48
}
