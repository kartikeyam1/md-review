import { describe, it, expect } from 'vitest'
import { EXPIRY_DAYS, normalizeExpiryDays, expiresAtFor } from '@shared/expiry.mjs'

describe('shared/expiry (#23 rule 8)', () => {
  it('allows 1, 7, 30, 90 and null', () => {
    expect([...EXPIRY_DAYS]).toEqual([1, 7, 30, 90])
    for (const d of [1, 7, 30, 90]) expect(normalizeExpiryDays(d)).toBe(d)
    expect(normalizeExpiryDays(null)).toBeNull()
  })

  it('coerces anything else to 30 (legacy compatibility)', () => {
    for (const v of ['7', 0, -1, 365, 2.5, undefined, {}]) expect(normalizeExpiryDays(v)).toBe(30)
  })

  it('computes expires_at from now', () => {
    expect(expiresAtFor(1, 0)).toBe(new Date(86400000).toISOString())
    expect(expiresAtFor(null)).toBeNull()
  })
})
