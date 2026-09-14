import { describe, it, expect } from 'vitest'
import { computeDelta, applyDelta, deltaSize } from '@/composables/useDelta'

describe('computeDelta / applyDelta', () => {
  const roundtrip = (base: string, next: string) => {
    const d = computeDelta(base, next)
    expect(applyDelta(base, d)).toBe(next)
    return d
  }

  it('typing in the middle keeps prefix and suffix', () => {
    const d = roundtrip('Hello world.\nBye.', 'Hello brave new world.\nBye.')
    expect(d).toEqual({ keepStart: 6, keepEnd: 11, insert: 'brave new ' })
  })

  it('appending at the end', () => {
    const d = roundtrip('abc', 'abcdef')
    expect(d).toEqual({ keepStart: 3, keepEnd: 0, insert: 'def' })
  })

  it('deleting in the middle produces an empty insert', () => {
    const d = roundtrip('abcdef', 'abef')
    expect(d).toEqual({ keepStart: 2, keepEnd: 2, insert: '' })
  })

  it('identical documents produce an empty delta', () => {
    const d = roundtrip('same', 'same')
    expect(d).toEqual({ keepStart: 4, keepEnd: 0, insert: '' })
  })

  it('handles empty base and empty next', () => {
    expect(roundtrip('', 'new')).toEqual({ keepStart: 0, keepEnd: 0, insert: 'new' })
    expect(roundtrip('old', '')).toEqual({ keepStart: 0, keepEnd: 0, insert: '' })
  })

  it('never lets prefix and suffix overlap on repeated text', () => {
    roundtrip('aaaa', 'aaaaaa')
    roundtrip('aaaaaa', 'aaaa')
    roundtrip('abab', 'ababab')
    roundtrip('x\n\n\nx', 'x\n\nx')
  })

  it('round-trips CRLF, unicode and surrogate pairs', () => {
    roundtrip('a\r\nb\r\n', 'a\r\nB\r\nc\r\n')
    roundtrip('café 🙂 fin', 'café 🙃🙂 fin')
    roundtrip('🙂🙂', '🙂')
  })

  it('deltaSize is small for a small edit of a large document', () => {
    const base = 'x'.repeat(100_000)
    const next = base.slice(0, 50_000) + 'INSERTED' + base.slice(50_000)
    expect(deltaSize(computeDelta(base, next))).toBeLessThan(100)
  })
})
