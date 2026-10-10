import { describe, it, expect } from 'vitest'
import { relativeTime, updatedLabel, payloadMode, isDocMode } from '@/composables/docMeta'
import { breakpointFor } from '@/composables/useBreakpoint'

const T0 = Date.parse('2026-10-10T12:00:00Z')

describe('relativeTime (#2 rule 8)', () => {
  it('just now / minutes / hours', () => {
    expect(relativeTime(T0, T0 + 59_000)).toBe('just now')
    expect(relativeTime(T0, T0 + 60_000)).toBe('1 min ago')
    expect(relativeTime(T0, T0 + 59 * 60_000)).toBe('59 min ago')
    expect(relativeTime(T0, T0 + 3 * 3_600_000 + 60_000)).toBe('3 h ago')
    expect(relativeTime(T0, T0 + 23 * 3_600_000)).toBe('23 h ago')
  })

  it('a day or more → "MMM D", with the year when it differs', () => {
    const at = new Date(2026, 2, 5, 10).getTime()
    expect(relativeTime(at, new Date(2026, 5, 1).getTime())).toBe('Mar 5')
    expect(relativeTime(at, new Date(2027, 0, 2).getTime())).toBe('Mar 5, 2026')
  })

  it('a future time (clock skew) reads as just now', () => {
    expect(relativeTime(T0 + 5000, T0)).toBe('just now')
  })
})

describe('updatedLabel', () => {
  it('adds "by <name>" only when known', () => {
    const at = new Date(T0).toISOString()
    expect(updatedLabel(at, 'agent', T0 + 3 * 3_600_000 + 60_000)).toBe('Updated 3 h ago by agent')
    expect(updatedLabel(at, null, T0 + 120_000)).toBe('Updated 2 min ago')
    expect(updatedLabel(at, '  ', T0)).toBe('Updated just now')
  })

  it('no time → nothing to show', () => {
    expect(updatedLabel(null, 'x', T0)).toBeNull()
    expect(updatedLabel('not a date', 'x', T0)).toBeNull()
  })
})

describe('doc mode values (00 §1.4)', () => {
  it('only publish|review are valid; anything else reads as review', () => {
    expect(isDocMode('publish')).toBe(true)
    expect(isDocMode('REVIEW')).toBe(false)
    expect(payloadMode(undefined)).toBe('review')
    expect(payloadMode('draft')).toBe('review')
    expect(payloadMode('publish')).toBe('publish')
  })
})

describe('breakpointFor (00 §12)', () => {
  it('phone < 641 ≤ tablet < 1100 ≤ desktop', () => {
    expect(breakpointFor(390)).toBe('phone')
    expect(breakpointFor(640)).toBe('phone')
    expect(breakpointFor(641)).toBe('tablet')
    expect(breakpointFor(1099)).toBe('tablet')
    expect(breakpointFor(1100)).toBe('desktop')
  })
})
