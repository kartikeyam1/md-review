// #18 Reader font size + content width — pure logic (docs/build/specs/18-font-width-control.md
// rule 1, AC-18.15) plus the storage round trip of rule 2.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  FONT_SCALES,
  DEFAULT_READER_PREFS,
  READER_PREFS_KEY,
  stepFontScale,
  parseReaderPrefs,
} from '@/composables/useReaderPrefs'

describe('#18 useReaderPrefs — pure exports', () => {
  it('AC-18.15 FONT_SCALES and defaults', () => {
    expect([...FONT_SCALES]).toEqual([80, 90, 100, 110, 120, 135, 150])
    expect(DEFAULT_READER_PREFS).toEqual({ fontScale: 100, width: 'narrow' })
    expect(READER_PREFS_KEY).toBe('md-review-reader-prefs')
  })

  it('AC-18.15 stepFontScale clamps at the ends and snaps off-list values to 100 first', () => {
    expect(stepFontScale(150, 1)).toBe(150)
    expect(stepFontScale(80, -1)).toBe(80)
    expect(stepFontScale(100, 1)).toBe(110)
    expect(stepFontScale(120, 1)).toBe(135)
    expect(stepFontScale(97, 1)).toBe(110)
    expect(stepFontScale(97, -1)).toBe(90)
    expect(stepFontScale(135, -1)).toBe(120)
    expect(stepFontScale(Number.NaN, 1)).toBe(110)
  })

  it('AC-18.15 parseReaderPrefs sanitises each field independently', () => {
    expect(parseReaderPrefs(null)).toEqual(DEFAULT_READER_PREFS)
    expect(parseReaderPrefs('{"fontScale":110}')).toEqual({ fontScale: 110, width: 'narrow' })
    expect(parseReaderPrefs('{"width":"wide","fontScale":"x"}')).toEqual({ fontScale: 100, width: 'wide' })
  })

  it('rule 2 / edge cases: bad JSON, numbers, arrays and out-of-list values fall back to defaults', () => {
    for (const raw of ['{', '', '5', '[1,2]', 'null', '"wide"', '{"fontScale":999,"width":"huge"}', '{"fontScale":105}']) {
      expect(parseReaderPrefs(raw), raw).toEqual(DEFAULT_READER_PREFS)
    }
    expect(parseReaderPrefs('{"fontScale":150,"width":"wide","extra":1}')).toEqual({ fontScale: 150, width: 'wide' })
  })

  it('parseReaderPrefs never returns the shared default object (callers may mutate)', () => {
    const a = parseReaderPrefs(null)
    a.fontScale = 150
    expect(DEFAULT_READER_PREFS.fontScale).toBe(100)
  })
})

describe('#18 useReaderPrefs — reactive state and storage (rule 2)', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('reads the stored value once and writes JSON on every change', async () => {
    localStorage.setItem('md-review-reader-prefs', '{"fontScale":120,"width":"wide"}')
    const { useReaderPrefs } = await import('@/composables/useReaderPrefs')
    const p = useReaderPrefs()
    expect(p.fontScale.value).toBe(120)
    expect(p.width.value).toBe('wide')
    p.increase()
    expect(p.fontScale.value).toBe(135)
    expect(JSON.parse(localStorage.getItem('md-review-reader-prefs')!)).toEqual({ fontScale: 135, width: 'wide' })
    p.setWidth('narrow')
    expect(JSON.parse(localStorage.getItem('md-review-reader-prefs')!)).toEqual({ fontScale: 135, width: 'narrow' })
    p.decrease(); p.decrease()
    expect(p.fontScale.value).toBe(110)
    p.reset()
    expect(p.fontScale.value).toBe(100)
    expect(JSON.parse(localStorage.getItem('md-review-reader-prefs')!)).toEqual({ fontScale: 100, width: 'narrow' })
  })

  it('the prefs act through <html>: --reader-scale and data-reader-width follow every change', async () => {
    localStorage.setItem('md-review-reader-prefs', '{"fontScale":135,"width":"wide"}')
    const { useReaderPrefs } = await import('@/composables/useReaderPrefs')
    const p = useReaderPrefs()
    const h = document.documentElement
    expect(h.style.getPropertyValue('--reader-scale')).toBe('1.35')
    expect(h.getAttribute('data-reader-width')).toBe('wide')
    p.decrease()
    p.setWidth('narrow')
    expect(h.style.getPropertyValue('--reader-scale')).toBe('1.2')
    expect(h.getAttribute('data-reader-width')).toBe('narrow')
  })

  it('a second call shares the same state (one per browser tab)', async () => {
    const { useReaderPrefs } = await import('@/composables/useReaderPrefs')
    const a = useReaderPrefs()
    const b = useReaderPrefs()
    a.increase()
    expect(b.fontScale.value).toBe(110)
  })

  it('works for the session when storage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    try {
      const { useReaderPrefs } = await import('@/composables/useReaderPrefs')
      const p = useReaderPrefs()
      expect(p.fontScale.value).toBe(100)
      p.increase()
      p.setWidth('wide')
      expect(p.fontScale.value).toBe(110)
      expect(p.width.value).toBe('wide')
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })

  it('ignores an invalid width passed to setWidth', async () => {
    const { useReaderPrefs } = await import('@/composables/useReaderPrefs')
    const p = useReaderPrefs()
    p.setWidth('huge' as never)
    expect(p.width.value).toBe('narrow')
  })
})
