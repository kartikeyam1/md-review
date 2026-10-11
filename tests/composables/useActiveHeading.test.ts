import { describe, it, expect } from 'vitest'
import { activeIndex } from '@/composables/useActiveHeading'

// #3 rule 13: the active TOC entry from heading tops (viewport px, document order).
describe('activeIndex', () => {
  const o = { line: 132, atBottom: false, viewportHeight: 900 }

  it('before the first heading → the first entry', () => {
    expect(activeIndex([400, 900, 1600], o)).toBe(0)
  })

  it('the last heading at or above the line wins', () => {
    expect(activeIndex([-800, 72, 132, 400], o)).toBe(2)
    expect(activeIndex([-800, 72, 133, 400], o)).toBe(1)
  })

  it('headings not rendered (null) are skipped', () => {
    expect(activeIndex([-800, null, 100, 400], o)).toBe(2)
    expect(activeIndex([null, null], o)).toBe(0)
  })

  it('at the very bottom → the last entry whose heading is visible', () => {
    expect(activeIndex([-900, -100, 500, 850], { ...o, atBottom: true })).toBe(3)
    expect(activeIndex([-900, -100, 500, 950], { ...o, atBottom: true })).toBe(2)
  })

  it('at the bottom never moves the active entry backwards', () => {
    expect(activeIndex([-900, -100, 50, 1200], { ...o, atBottom: true })).toBe(2)
  })
})
