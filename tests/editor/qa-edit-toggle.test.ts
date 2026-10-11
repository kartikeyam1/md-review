// QA fix (persona engineer M5): Mod+B / Mod+I / Mod+Shift+X / Mod+E can be toggled off after
// typing, like Docs — step over the closer, or drop an empty pair, instead of nesting `****`.
import { describe, it, expect } from 'vitest'
import { EditorState, EditorSelection, type Transaction } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { toggleBold, toggleItalic, toggleStrikethrough, toggleCode } from '@/editor/markdownCommands'

type Cmd = (t: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean
const st = (doc: string, at = doc.length) => EditorState.create({ doc, selection: EditorSelection.single(at), extensions: [markdown()] })
function run(cmd: Cmd, state: EditorState) {
  let next = state
  cmd({ state, dispatch: (tr) => { next = tr.state } })
  return next
}
const type = (s: EditorState, t: string) => s.update(s.replaceSelection(t)).state

describe('QA M5 — formatting toggles off after typing', () => {
  for (const [name, cmd, mark] of [
    ['bold', toggleBold, '**'], ['italic', toggleItalic, '*'], ['strike', toggleStrikethrough, '~~'], ['code', toggleCode, '`'],
  ] as const) {
    it(`${name}: on, type, off, type → one span and the caret after it`, () => {
      let s = run(cmd, st('a '))
      s = type(s, 'bb')
      s = run(cmd, s)
      s = type(s, ' cc')
      expect(s.doc.toString()).toBe(`a ${mark}bb${mark} cc`)
    })

    it(`${name}: on then straight off removes the empty pair`, () => {
      const s = run(cmd, run(cmd, st('- ')))
      expect(s.doc.toString()).toBe('- ')
      expect(s.selection.main.head).toBe(2)
    })
  }

  it('the persona repro: `a **bb**` and no `****` litter', () => {
    let s = run(toggleBold, st('a '))
    s = run(toggleBold, type(s, 'bb'))
    expect(s.doc.toString()).toBe('a **bb**')
    expect(s.selection.main.head).toBe(8)
  })

  it('a closer with no opener on the line still inserts a new pair (rule 1d)', () => {
    expect(run(toggleBold, st('x **', 2)).doc.toString()).toBe('x ******')
  })

  it('a marker after whitespace is an opener, not a closer', () => {
    expect(run(toggleBold, st('**a **b', 5)).doc.toString()).toBe('**a ******b')
  })

  it('Mod+I right before a `**` closer does not step over half of it', () => {
    expect(run(toggleItalic, st('**bb**', 4)).doc.toString()).toBe('**bb****')
  })

  it('an empty pair inside a longer run is not removed (`***|***`)', () => {
    expect(run(toggleBold, st('******', 3)).doc.toString()).not.toBe('**')
  })
})

// QA fix (persona engineer m7): an image pasted on the line after a table starts its own paragraph.
import { leadingBreak } from '@/editor/imagePaste'

describe('QA m7 — image after a table', () => {
  const table = '| a | b |\n| - | - |\n| 1 | 2 |'
  it('on the empty line right after the table → one extra newline (blank line before the image)', () => {
    const doc = `${table}\n`
    expect(leadingBreak(st(doc), doc.length)).toBe('\n')
  })
  it('at the end of the last row → a blank line', () => {
    expect(leadingBreak(st(table), table.length)).toBe('\n\n')
  })
  it('after a blank line, after a paragraph, or mid-row → nothing', () => {
    expect(leadingBreak(st(`${table}\n\n`), table.length + 2)).toBe('')
    expect(leadingBreak(st('text\n'), 5)).toBe('')
    expect(leadingBreak(st(table), table.length - 2)).toBe('')
  })
  it('pipes without a delimiter row are not a table', () => {
    expect(leadingBreak(st('a | b\n'), 6)).toBe('')
  })
})
