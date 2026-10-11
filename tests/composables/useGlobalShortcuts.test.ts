import { describe, it, expect } from 'vitest'
import { matchesShortcut } from '@/composables/useGlobalShortcuts'

const ev = (key: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m })

describe('matchesShortcut (00 §3.5)', () => {
  const save = { key: 's', mod: true, run: () => {} }

  it('Mod is Ctrl or Cmd, key case-insensitive', () => {
    expect(matchesShortcut(ev('s', { ctrlKey: true }), save)).toBe(true)
    expect(matchesShortcut(ev('S', { metaKey: true }), save)).toBe(true)
  })

  it('needs the modifier exactly', () => {
    expect(matchesShortcut(ev('s'), save)).toBe(false)
    expect(matchesShortcut(ev('s', { ctrlKey: true }), { key: 's', run: () => {} })).toBe(false)
  })

  it('shift/alt are only checked when declared', () => {
    expect(matchesShortcut(ev('s', { ctrlKey: true, shiftKey: true }), save)).toBe(true)
    expect(matchesShortcut(ev('s', { ctrlKey: true, shiftKey: true }), { ...save, shift: false })).toBe(false)
  })
})
