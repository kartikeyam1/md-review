// #8 Undo / redo — frozen unit test for AC-08.15 (docs/build/specs/08-undo-redo.md rule 4a, "Files").
//
// Contract fixed by this test (the spec names the file only as an example):
//   module  src/composables/useExternalChange.ts   (pure, no CodeMirror import needed)
//   export  minimalChange(oldText: string, newText: string)
//           → null for identical texts, else ONE change `{ from, to, insert }`
//             in `oldText` offsets (UTF-16, CodeMirror ChangeSpec-compatible)
//             covering only the span between the common prefix and suffix.
// Also accepted, so the helper can hand CodeMirror whatever it builds: an array
// of 0 or 1 such changes, `undefined`, or a CodeMirror ChangeSet (`empty` /
// `iterChanges`).
//
// The module is looked up with import.meta.glob so a missing file fails these
// tests with a clear message instead of breaking collection.
import { describe, it, expect } from 'vitest'

type Change = { from: number; to: number; insert: string }
type Fn = (oldText: string, newText: string) => unknown

const MODULE = '/src/composables/useExternalChange.ts'
const loaders = import.meta.glob('/src/composables/useExternalChange.ts')

async function helper(): Promise<Fn> {
  const load = loaders[MODULE]
  expect(load, `${MODULE} exists`).toBeTypeOf('function')
  const mod = (await load!()) as Record<string, unknown>
  expect(mod.minimalChange, `${MODULE} exports minimalChange(oldText, newText)`).toBeTypeOf('function')
  return mod.minimalChange as Fn
}

/** Normalise every accepted return shape to a list of { from, to, insert }. */
function changes(r: unknown): Change[] {
  if (r == null) return []
  if (Array.isArray(r)) return r.map(one)
  const cs = r as { empty?: boolean; iterChanges?: (f: (fa: number, ta: number, fb: number, tb: number, ins: { toString(): string }) => void) => void }
  if (typeof cs.iterChanges === 'function') {
    const out: Change[] = []
    cs.iterChanges((fromA, toA, _fromB, _toB, inserted) => out.push({ from: fromA, to: toA, insert: inserted.toString() }))
    return out
  }
  return [one(r)]
}

function one(c: unknown): Change {
  const x = c as Partial<Change> & { insert?: unknown }
  expect(typeof x.from, 'change.from is a number').toBe('number')
  const to = x.to ?? x.from
  const insert = x.insert == null ? '' : String(x.insert)
  return { from: x.from as number, to: to as number, insert }
}

const apply = (text: string, cs: Change[]) =>
  [...cs].sort((a, b) => b.from - a.from).reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), text)

describe('#8 AC-08.15 minimalChange (pure old→new change helper)', () => {
  it('AC-08.15 texts differing only in the middle → one change covering only the differing span', async () => {
    const fn = await helper()
    const oldText = '# Title\n\nParagraph one.\n\nParagraph two ORIGINAL here.\n\nParagraph three.\n'
    const newText = '# Title\n\nParagraph one.\n\nParagraph two REPLACED here.\n\nParagraph three.\n'
    const cs = changes(fn(oldText, newText))
    expect(cs).toHaveLength(1)
    const from = oldText.indexOf('ORIGINAL')
    expect(cs[0]).toEqual({ from, to: from + 'ORIGINAL'.length, insert: 'REPLACED' })
    expect(apply(oldText, cs)).toBe(newText)
  })

  it('AC-08.15 identical texts → no change', async () => {
    const fn = await helper()
    const text = '# Same\n\nNothing changed.\n'
    expect(changes(fn(text, text))).toEqual([])
    expect(changes(fn('', ''))).toEqual([])
  })

  it('AC-08.15 a pure insertion at the top is an empty-range insert at 0 (rest of the doc kept)', async () => {
    const fn = await helper()
    const oldText = 'line 1\nline 2\nline 3\n'
    const newText = 'NEW TOP\n' + oldText
    const cs = changes(fn(oldText, newText))
    expect(cs).toEqual([{ from: 0, to: 0, insert: 'NEW TOP\n' }])
  })

  it('AC-08.15 a pure deletion in the middle replaces only the deleted span with nothing', async () => {
    const fn = await helper()
    const oldText = 'keep A\nDROP ME\nkeep B\n'
    const newText = 'keep A\nkeep B\n'
    const cs = changes(fn(oldText, newText))
    expect(cs).toEqual([{ from: 'keep A\n'.length, to: 'keep A\nDROP ME\n'.length, insert: '' }])
  })

  it('AC-08.15 an append at the end and a whole-text replacement both round-trip', async () => {
    const fn = await helper()
    const a = changes(fn('abc', 'abcdef'))
    expect(a).toEqual([{ from: 3, to: 3, insert: 'def' }])
    const b = changes(fn('xyz', '123'))
    expect(b).toEqual([{ from: 0, to: 3, insert: '123' }])
    expect(changes(fn('', 'fresh'))).toEqual([{ from: 0, to: 0, insert: 'fresh' }])
    expect(changes(fn('gone', ''))).toEqual([{ from: 0, to: 4, insert: '' }])
  })
})
