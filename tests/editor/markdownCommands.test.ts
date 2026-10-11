// #9 — implementation unit tests beyond the frozen item tests: Tab / Shift+Tab,
// Enter continuation config, HTML-doc behaviour, overlay key labels.
import { describe, it, expect } from 'vitest'
import { EditorState, EditorSelection, type Transaction } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import {
  indentMore, indentLess, insertNewlineContinue, toggleBold, toggleItalic, toggleCode, toggleLink,
} from '@/editor/markdownCommands'
import { formatCombo, SHORTCUT_ROWS } from '@/editor/shortcutList'
import { isEditableTarget } from '@/composables/useShortcutsOverlay'

type Cmd = (t: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean

function st(doc: string, anchor: number, head = anchor, lang = markdown()) {
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [lang] })
}
function run(cmd: Cmd, state: EditorState) {
  let next = state
  const handled = cmd({ state, dispatch: (tr) => { next = tr.state } })
  return { text: next.doc.toString(), state: next, handled }
}
const end = (doc: string) => doc.length

describe('#9 Tab / Shift+Tab', () => {
  it('nests a bullet under its previous sibling and outdents it back', () => {
    const r = run(indentMore, st('- a\n- b', end('- a\n- b')))
    expect(r.text).toBe('- a\n  - b')
    expect(run(indentLess, r.state).text).toBe('- a\n- b')
  })

  it('nests an ordered item by its sibling content width and restarts it at 1', () => {
    expect(run(indentMore, st('1. a\n2. b', 9)).text).toBe('1. a\n   1. b')
    expect(run(indentMore, st('10. a\n11. b', 11)).text).toBe('10. a\n    1. b')
  })

  it('keeps the outer list consecutive and appends to an existing sub-list', () => {
    const doc = '1. a\n2. b\n3. c'
    expect(run(indentMore, st(doc, doc.indexOf('b'))).text).toBe('1. a\n   1. b\n2. c')
    const doc2 = '1. a\n   1. x\n2. b'
    expect(run(indentMore, st(doc2, doc2.indexOf('b'))).text).toBe('1. a\n   1. x\n   2. b')
  })

  it('leaves a first item unchanged but consumes the key', () => {
    const r = run(indentMore, st('- first', 7))
    expect(r.handled).toBe(true)
    expect(r.text).toBe('- first')
  })

  it('carries nested children along', () => {
    const doc = '- a\n- b\n  - c'
    expect(run(indentMore, st(doc, doc.indexOf('b'))).text).toBe('- a\n  - b\n    - c')
  })

  it('treats a list line inside a fenced block as plain text', () => {
    const doc = '- a\n```\n- b\n```'
    const at = doc.indexOf('- b')
    expect(run(indentMore, st(doc, at)).text).toBe('- a\n```\n  - b\n```')
  })

  it('non-list: two spaces at the cursor, every selected line, Shift+Tab removes up to two', () => {
    expect(run(indentMore, st('plain', 0)).text).toBe('  plain')
    expect(run(indentMore, st('one\ntwo', 0, 7)).text).toBe('  one\n  two')
    expect(run(indentLess, st('   three', 0)).text).toBe(' three')
  })

  it('HTML docs: Tab is two spaces', () => {
    expect(run(indentMore, st('<b>x</b>', 0, 0, html())).text).toBe('  <b>x</b>')
  })
})

describe('#9 Enter continuation', () => {
  it('an empty second item of a tight list ends the list (no loosening)', () => {
    const doc = '- a\n- '
    const r = run(insertNewlineContinue, st(doc, end(doc)))
    expect(r.text).toBe('- a\n')
  })

  it('does nothing in HTML docs', () => {
    expect(run(insertNewlineContinue, st('- a', 3, 3, html())).handled).toBe(false)
  })
})

describe('#9 HTML docs', () => {
  it('Mod+B/K/E are consumed without changes; Mod+I falls through', () => {
    for (const cmd of [toggleBold, toggleCode, toggleLink]) {
      const r = run(cmd, st('<b>x</b>', 0, 8, html()))
      expect(r.handled).toBe(true)
      expect(r.text).toBe('<b>x</b>')
    }
    expect(run(toggleItalic, st('<b>x</b>', 0, 8, html())).handled).toBe(false)
  })
})

describe('#9 more wrap edge cases', () => {
  it('`***x***` with `x` selected: Mod+I removes the italic half, Mod+B the bold half', () => {
    const doc = '***x***'
    expect(run(toggleItalic, st(doc, 3, 4)).text).toBe('**x**')
    expect(run(toggleBold, st(doc, 3, 4)).text).toBe('*x*')
  })

  it('a selection ending at the next line start stays on one line', () => {
    expect(run(toggleBold, st('word\nnext', 0, 5)).text).toBe('**word**\nnext')
  })

  it('a fenced block is removed again by Mod+E on its lines', () => {
    const doc = '```\none\ntwo\n```'
    expect(run(toggleCode, st(doc, 4, 11)).text).toBe('one\ntwo')
  })
})

describe('#9 overlay labels', () => {
  it('formats combos per platform', () => {
    expect(formatCombo('Mod-b', false)).toBe('Ctrl+B')
    expect(formatCombo('Mod-b', true)).toBe('⌘B')
    expect(formatCombo('Mod-Shift-x', true)).toBe('⇧⌘X')
    expect(formatCombo('Shift-Alt-ArrowUp', false)).toBe('Shift+Alt+↑')
    expect(formatCombo('Escape Tab', false)).toBe('Esc then Tab')
    expect(formatCombo('Mod-/', false)).toBe('Ctrl+/')
    expect(formatCombo('?', true)).toBe('?')
  })

  it('lists at least 14 rows incl. the required ones', () => {
    const labels = SHORTCUT_ROWS.map((r) => r.label)
    expect(labels.length).toBeGreaterThanOrEqual(14)
    for (const l of ['Bold', 'Link', 'Undo', 'Redo', 'Find', 'Save']) expect(labels).toContain(l)
  })

  it('isEditableTarget: inputs and the editor are editable, buttons and body are not', () => {
    const input = document.createElement('input')
    const btn = document.createElement('button')
    const cm = document.createElement('div')
    cm.className = 'cm-editor'
    const inner = document.createElement('div')
    cm.appendChild(inner)
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(inner)).toBe(true)
    expect(isEditableTarget(btn)).toBe(false)
    expect(isEditableTarget(document.body)).toBe(false)
  })
})

// ── fix round (QA + review) ─────────────────────────────────────────────────

const line = (doc: string, n: number) => {
  const lines = doc.split('\n')
  const from = lines.slice(0, n).reduce((a, l) => a + l.length + 1, 0)
  return [from, from + lines[n]!.length] as const
}

describe('#9 fix 1 — block markup stays outside the markers', () => {
  it('whole list / task / ordered / heading / quote lines keep their prefix', () => {
    for (const [doc, want] of [
      ['- item', '- **item**'],
      ['* item', '* **item**'],
      ['- [ ] task', '- [ ] **task**'],
      ['- [x] done', '- [x] **done**'],
      ['12. twelve', '12. **twelve**'],
      ['1) one', '1) **one**'],
      ['## Head', '## **Head**'],
      ['> quote', '> **quote**'],
      ['> - quoted item', '> - **quoted item**'],
    ]) {
      expect(run(toggleBold, st(doc, 0, doc.length)).text, doc).toBe(want)
    }
  })

  it('multi-line list selection wraps each item text; Mod+B again unwraps', () => {
    const doc = '- a\n- b'
    const r = run(toggleBold, st(doc, 0, doc.length))
    expect(r.text).toBe('- **a**\n- **b**')
    expect(run(toggleBold, st(r.text, 0, r.text.length)).text).toBe(doc)
  })

  it('a whole bold list line unwraps; link and code respect the prefix too', () => {
    expect(run(toggleBold, st('- **item**', 0, 10)).text).toBe('- item')
    expect(run(toggleLink, st('- item', 0, 6)).text).toBe('- [item]()')
    expect(run(toggleCode, st('# cmd', 0, 5)).text).toBe('# `cmd`')
  })

  it('`**bold**` text (not a bullet) is not mistaken for a list marker', () => {
    expect(run(toggleItalic, st('**bold** x', 0, 8)).text).toBe('***bold*** x')
  })
})

describe('#9 fix 2 — fences of two different code blocks are never merged', () => {
  it('selection spanning two blocks wraps instead of unfencing', () => {
    const doc = '```\na\n```\n\n```\nb\n```'
    const [from] = line(doc, 1)
    const [, to] = line(doc, 5)
    const out = run(toggleCode, st(doc, from, to)).text
    expect(out).toBe('```\n```\na\n```\n\n```\nb\n```\n```')
  })

  it('first/last selected lines that are fences of different blocks are not one block', () => {
    const doc = '```\na\n```\n\n```\nb\n```'
    const out = run(toggleCode, st(doc, 0, doc.length)).text
    expect(out.startsWith('```\n```\n')).toBe(true)
  })

  it('the lines of ONE block still unfence (inside or including the fences)', () => {
    const doc = 'x\n```\none\ntwo\n```\ny'
    const [from] = line(doc, 2)
    const [, to] = line(doc, 3)
    expect(run(toggleCode, st(doc, from, to)).text).toBe('x\none\ntwo\ny')
    const [f2] = line(doc, 1)
    const [, t2] = line(doc, 4)
    expect(run(toggleCode, st(doc, f2, t2)).text).toBe('x\none\ntwo\ny')
  })
})

describe('#9 fix 4 — link labels escape brackets', () => {
  it('`]` / `[` in the label are escaped, and unescaped on unwrap', () => {
    const doc = 'a [b] c'
    const r = run(toggleLink, st(doc, 0, doc.length))
    expect(r.text).toBe('[a \\[b\\] c]()')
    expect(r.state.selection.main.head).toBe(r.text.length - 1)
    const linked = '[a \\[b\\] c](https://x.io)'
    expect(run(toggleLink, st(linked, 0, linked.length)).text).toBe('a [b] c')
  })

  it('already-escaped brackets are not escaped twice', () => {
    const doc = 'x \\] y'
    expect(run(toggleLink, st(doc, 0, doc.length)).text).toBe('[x \\] y]()')
  })
})

describe('#9 fix 5 — outdent renumbers; quoted and tab-indented lists', () => {
  it('Shift+Tab on a nested ordered item: outer list consecutive, left-behind siblings restart at 1', () => {
    const doc = '1. a\n   1. x\n   2. y\n2. b'
    const [, at] = line(doc, 1)
    expect(run(indentLess, st(doc, at)).text).toBe('1. a\n2. x\n   1. y\n3. b')
  })

  it('Tab then Shift+Tab round-trips an ordered list', () => {
    const doc = '1. a\n2. b\n3. c'
    const [, at] = line(doc, 1)
    const r = run(indentMore, st(doc, at))
    expect(r.text).toBe('1. a\n   1. b\n2. c')
    const [, at2] = line(r.text, 1)
    expect(run(indentLess, st(r.text, at2)).text).toBe(doc)
  })

  it('Tab / Shift+Tab nest inside a blockquote (`> - b`)', () => {
    const doc = '> - a\n> - b'
    const r = run(indentMore, st(doc, doc.length))
    expect(r.text).toBe('> - a\n>   - b')
    expect(run(indentLess, st(r.text, r.text.length)).text).toBe(doc)
  })

  it('Shift+Tab outdents a tab-indented item', () => {
    const doc = '- a\n\t- b'
    expect(run(indentLess, st(doc, doc.length)).text).toBe('- a\n- b')
  })

  it('Shift+Tab on a non-list line removes a leading tab as two columns and keeps the rest', () => {
    expect(run(indentLess, st('\tx', 0, 0, html())).text).toBe('  x')
  })
})

describe('#9 fix 6 — marker inside the selection', () => {
  it('`**a** and **b**` + Mod+B → one bold span, never `a** and **b`', () => {
    const doc = '**a** and **b**'
    expect(run(toggleBold, st(doc, 0, doc.length)).text).toBe('**a and b**')
  })

  it('`a** and **b` selected inside the outer markers → one bold span', () => {
    const doc = '**a** and **b**'
    expect(run(toggleBold, st(doc, 2, doc.length - 2)).text).toBe('**a and b**')
  })

  it('italic: `*a* and *b*` + Mod+I → `*a and b*`', () => {
    const doc = '*a* and *b*'
    expect(run(toggleItalic, st(doc, 0, doc.length)).text).toBe('*a and b*')
  })

  it('multi-line: wrap/unwrap is decided once, from the first line', () => {
    expect(run(toggleBold, st('**a**\nb', 0, 7)).text).toBe('a\nb')
    expect(run(toggleBold, st('a\n**b**', 0, 7)).text).toBe('**a**\n**b**')
  })
})
