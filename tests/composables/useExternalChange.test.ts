import { describe, it, expect } from 'vitest'
import { markExternalChange, takeExternalOrigin, historyBarrier, historyEpoch } from '@/composables/useExternalChange'

describe('useExternalChange origin marks (#8)', () => {
  it('a mark is consumed once by a write of the same text', () => {
    markExternalChange('restored text', 'local')
    expect(takeExternalOrigin('restored text')).toBe('local')
    expect(takeExternalOrigin('restored text')).toBe('remote')
  })

  it('unmarked writes and marks for other text are remote (the safe default)', () => {
    expect(takeExternalOrigin('anything')).toBe('remote')
    markExternalChange('a', 'local')
    expect(takeExternalOrigin('b')).toBe('remote')
    expect(takeExternalOrigin('a')).toBe('remote')
  })

  it('remote marks and barriers bump the history epoch; local marks do not', () => {
    const e0 = historyEpoch()
    markExternalChange('x', 'local')
    expect(historyEpoch()).toBe(e0)
    markExternalChange('y', 'remote')
    expect(historyEpoch()).toBe(e0 + 1)
    historyBarrier()
    expect(historyEpoch()).toBe(e0 + 2)
    takeExternalOrigin('')
  })
})
