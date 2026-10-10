// Doc expiry (#23 rule 8) — one definition for the server and the FE (00 §4.8).
// A doc lives 1, 7, 30 or 90 days from the time of the request, or forever (null).

/** The allowed day counts, in picker order (the picker adds "Never" = null after them). */
export const EXPIRY_DAYS = Object.freeze([1, 7, 30, 90])

/** Applied when expiry_days is absent on create, and for any value outside EXPIRY_DAYS (legacy coercion). */
export const DEFAULT_EXPIRY_DAYS = 30

/**
 * What a request's `expiry_days` applies: null (never) for null, the value itself
 * when it is one of EXPIRY_DAYS, else DEFAULT_EXPIRY_DAYS ("7", 0, -1, 365, 2.5 …).
 */
export function normalizeExpiryDays(v) {
  if (v === null) return null
  return EXPIRY_DAYS.includes(v) ? v : DEFAULT_EXPIRY_DAYS
}

/** ISO expires_at for `days` from `now` (ms), or null for never. */
export function expiresAtFor(days, now = Date.now()) {
  return days === null ? null : new Date(now + days * 86400000).toISOString()
}
