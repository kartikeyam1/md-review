import { describe, it, expect } from 'vitest'
import { minimalChanges, type TextChange } from '@/composables/useExternalChange'

const apply = (text: string, cs: TextChange[]) =>
  [...cs].sort((a, b) => b.from - a.from).reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), text)

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`)

describe('#8 minimalChanges (multi-hunk)', () => {
  it('two distant edits become two small changes that leave the middle untouched', () => {
    const a = lines(300)
    const b = a.slice()
    b[1] = 'line 2 EDITED'
    b[249] = 'line 250 FAR'
    const oldText = a.join('\n') + '\n'
    const newText = b.join('\n') + '\n'
    const cs = minimalChanges(oldText, newText)
    expect(cs).toHaveLength(2)
    expect(cs[0]).toEqual({ from: oldText.indexOf('line 2\n') + 6, to: oldText.indexOf('line 2\n') + 6, insert: ' EDITED' })
    expect(cs[1]).toEqual({ from: oldText.indexOf('line 250\n') + 8, to: oldText.indexOf('line 250\n') + 8, insert: ' FAR' })
    expect(apply(oldText, cs)).toBe(newText)
    const caret = oldText.indexOf('line 151')
    expect(cs.every((c) => c.to <= caret || c.from >= caret)).toBe(true)
  })

  it('handles insertions, deletions and replacements in several places (2000 lines)', () => {
    const a = lines(2000)
    const b = a.slice()
    b.splice(1999, 1)
    b.splice(1000, 0, 'inserted A', 'inserted B')
    b[10] = 'replaced 11'
    b.splice(0, 0, 'NEW TOP')
    const oldText = a.join('\n')
    const newText = b.join('\n')
    const cs = minimalChanges(oldText, newText)
    expect(cs.length).toBeGreaterThanOrEqual(3)
    expect(apply(oldText, cs)).toBe(newText)
    for (let i = 1; i < cs.length; i++) expect(cs[i].from).toBeGreaterThanOrEqual(cs[i - 1].to)
  })

  it('equal texts → []; single-line edits stay one change', () => {
    expect(minimalChanges('same', 'same')).toEqual([])
    expect(minimalChanges('abc', 'aXc')).toEqual([{ from: 1, to: 2, insert: 'X' }])
    expect(minimalChanges('', 'x\ny')).toEqual([{ from: 0, to: 0, insert: 'x\ny' }])
  })
})
