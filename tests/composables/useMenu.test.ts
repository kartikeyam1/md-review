import { describe, it, expect } from 'vitest'
import { menuKeyTarget } from '@/composables/useMenu'

describe('menuKeyTarget (00 §3.2)', () => {
  it('arrows move by one and wrap', () => {
    expect(menuKeyTarget('ArrowDown', 0, 4)).toBe(1)
    expect(menuKeyTarget('ArrowDown', 3, 4)).toBe(0)
    expect(menuKeyTarget('ArrowUp', 0, 4)).toBe(3)
    expect(menuKeyTarget('ArrowUp', 2, 4)).toBe(1)
  })

  it('Home/End jump', () => {
    expect(menuKeyTarget('Home', 2, 4)).toBe(0)
    expect(menuKeyTarget('End', 0, 4)).toBe(3)
  })

  it('focus outside the list starts at the first (down) or last (up) item', () => {
    expect(menuKeyTarget('ArrowDown', -1, 4)).toBe(0)
    expect(menuKeyTarget('ArrowUp', -1, 4)).toBe(3)
  })

  it('other keys and empty menus are not moves', () => {
    expect(menuKeyTarget('Enter', 0, 4)).toBeNull()
    expect(menuKeyTarget('a', 0, 4)).toBeNull()
    expect(menuKeyTarget('ArrowDown', 0, 0)).toBeNull()
  })
})
