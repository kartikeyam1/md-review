import { describe, it, expect } from 'vitest'
import { buildLineDiff, collapseContext, type DiffRow } from '@/composables/useDiff'

const ctx = (n: number): DiffRow => ({ type: 'context', oldNo: n, newNo: n, text: `line ${n}` })

describe('buildLineDiff', () => {
  it('reports added and removed lines with line numbers', async () => {
    const { rows, stats } = await buildLineDiff('a\nb\nc\n', 'a\nc\nd\n')
    expect(stats).toEqual({ added: 1, removed: 1 })
    expect(rows.map(r => [r.type, r.oldNo, r.newNo, r.text])).toEqual([
      ['context', 1, 1, 'a'],
      ['del', 2, null, 'b'],
      ['context', 3, 2, 'c'],
      ['add', null, 3, 'd'],
    ])
  })

  it('pairs a changed line and marks only the changed words', async () => {
    const { rows } = await buildLineDiff('The quick brown fox\n', 'The quick red fox\n')
    const del = rows.find(r => r.type === 'del')!
    const add = rows.find(r => r.type === 'add')!
    expect(del.segments!.filter(s => s.changed).map(s => s.text)).toEqual(['brown'])
    expect(add.segments!.filter(s => s.changed).map(s => s.text)).toEqual(['red'])
    expect(add.segments!.map(s => s.text).join('')).toBe('The quick red fox')
  })

  it('does not pair blocks of different length', async () => {
    const { rows } = await buildLineDiff('x\n', 'y\nz\n')
    expect(rows.filter(r => r.type === 'del')[0].segments).toBeUndefined()
    expect(rows.filter(r => r.type === 'add')).toHaveLength(2)
  })

  it('handles documents without a trailing newline and empty documents', async () => {
    expect((await buildLineDiff('', 'hello')).rows.map(r => r.type)).toEqual(['add'])
    expect((await buildLineDiff('hello', '')).rows.map(r => r.type)).toEqual(['del'])
    expect((await buildLineDiff('same', 'same')).stats).toEqual({ added: 0, removed: 0 })
  })

  it('folds long unchanged runs into skip rows keeping context around changes', async () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
    const after = before.replace('l15', 'L15')
    const { rows } = await buildLineDiff(before, after, { context: 2 })
    expect(rows.map(r => r.type)).toEqual(['skip', 'context', 'context', 'del', 'add', 'context', 'context', 'skip'])
    expect(rows[0].hidden).toHaveLength(13) // l0..l12
    expect(rows[7].hidden).toHaveLength(12) // l18..l29
  })
})

describe('collapseContext', () => {
  it('keeps short runs intact', () => {
    const rows = [ctx(1), ctx(2), { type: 'add', oldNo: null, newNo: 3, text: 'x' } as DiffRow, ctx(3)]
    expect(collapseContext(rows, 3)).toEqual(rows)
  })
})
