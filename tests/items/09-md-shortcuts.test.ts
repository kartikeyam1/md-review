// #9 Markdown keyboard shortcuts — frozen unit tests (docs/build/specs/09-md-shortcuts.md rules 1-3,
// AC-09.1 / .2 / .4 / .6 / .18; 00 §4.7 editor extensions).
//
// Contract fixed by this test (the spec names the module as an example; this pins it):
//   module  src/editor/markdownCommands.ts
//   exports toggleBold           Mod+B         `**`
//           toggleItalic         Mod+I         `*`  (`_x_` also unwraps)
//           toggleStrikethrough  Mod+Shift+X   `~~`
//           toggleCode           Mod+E         backticks / fenced block
//           toggleLink           Mod+K         `[text]()` / `[](url)` / unwrap `[x](y)`
//   Each is a CodeMirror StateCommand: `({ state, dispatch }) => boolean`, returning true
//   when it handled the key (it dispatches its change through `dispatch`).
// The commands are run here on a plain EditorState (jsdom, no EditorView) built with the
// markdown language and multiple selections enabled, so "markdown docs only" checks inside
// a command see a markdown doc.
//
// The module is looked up with import.meta.glob so a missing file fails these tests with
// a clear message instead of breaking collection.
import { describe, it, expect } from 'vitest'
import { EditorState, EditorSelection, type Transaction } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'

type Command = (target: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean
const NAMES = ['toggleBold', 'toggleItalic', 'toggleStrikethrough', 'toggleCode', 'toggleLink'] as const
type Name = (typeof NAMES)[number]

const MODULE = '/src/editor/markdownCommands.ts'
const loaders = import.meta.glob('/src/editor/markdownCommands.ts')

async function command(name: Name): Promise<Command> {
  const load = loaders[MODULE]
  expect(load, `${MODULE} exists`).toBeTypeOf('function')
  const mod = (await load!()) as Record<string, unknown>
  expect(mod[name], `${MODULE} exports ${name}({ state, dispatch })`).toBeTypeOf('function')
  return mod[name] as Command
}

/**
 * A markdown EditorState. `doc` marks selections inline:
 *   `|`        a cursor            `[`…`]`   a selected range (anchor at `[`, head at `]`)
 * Several markers give several ranges (multi-cursor). Text without markers puts one cursor at 0.
 */
function mdState(marked: string): EditorState {
  const ranges: { anchor: number; head: number }[] = []
  let doc = ''
  let open = -1
  for (const ch of marked) {
    if (ch === '|') ranges.push({ anchor: doc.length, head: doc.length })
    else if (ch === '[' && open < 0 && marked.includes(']')) open = doc.length
    else if (ch === ']' && open >= 0) { ranges.push({ anchor: open, head: doc.length }); open = -1 }
    else doc += ch
  }
  const selection = ranges.length
    ? EditorSelection.create(ranges.map((r) => EditorSelection.range(r.anchor, r.head)), ranges.length - 1)
    : EditorSelection.single(0)
  return EditorState.create({
    doc,
    selection,
    extensions: [markdown(), EditorState.allowMultipleSelections.of(true)],
  })
}

/** A state with an explicit doc and selection (for docs that themselves contain `[`, `]` or `|`). */
function rawState(doc: string, ranges: [number, number][]): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h)), ranges.length - 1),
    extensions: [markdown(), EditorState.allowMultipleSelections.of(true)],
  })
}

/** Run a command; returns the resulting state and whether it reported handling the key. */
function run(cmd: Command, state: EditorState): { state: EditorState; handled: boolean } {
  let next = state
  const handled = cmd({ state, dispatch: (tr) => { next = tr.state } })
  return { state: next, handled }
}

const text = (s: EditorState) => s.doc.toString()
const selected = (s: EditorState) => s.sliceDoc(s.selection.main.from, s.selection.main.to)
/** Type `ch` at every cursor / over every selection, the way a keystroke would. */
const type = (s: EditorState, ch: string) => s.update(s.replaceSelection(ch)).state

describe('#9 markdownCommands — wrap/unwrap (rule 1)', () => {
  it('AC-09.1 `world` selected + Mod+B → `hello **world**` with `world` still selected; Mod+B again → `hello world`', async () => {
    const bold = await command('toggleBold')
    const r1 = run(bold, mdState('hello [world]'))
    expect(r1.handled).toBe(true)
    expect(text(r1.state)).toBe('hello **world**')
    expect(selected(r1.state)).toBe('world')

    const r2 = run(bold, r1.state)
    expect(text(r2.state)).toBe('hello world')
    expect(selected(r2.state)).toBe('world')
  })

  it('rule 1b: a selection that includes the markers unwraps too (`**world**` selected + Mod+B → `world`, bare text selected)', async () => {
    const bold = await command('toggleBold')
    const r = run(bold, mdState('hello [**world**]'))
    expect(text(r.state)).toBe('hello world')
    expect(selected(r.state)).toBe('world')
  })

  it('AC-09.2 cursor inside `planning`, no selection + Mod+I → `*planning*`; typing X lands at the same offset inside the word', async () => {
    const italic = await command('toggleItalic')
    const r = run(italic, mdState('plan|ning'))
    expect(r.handled).toBe(true)
    expect(text(r.state)).toBe('*planning*')
    expect(r.state.selection.main.empty).toBe(true)
    expect(text(type(r.state, 'X'))).toBe('*planXning*')
  })

  it('AC-09.4 `**bold**` selected (markers included) + Mod+I → `***bold***` (a `*` of `**` is not italic)', async () => {
    const italic = await command('toggleItalic')
    const r = run(italic, mdState('[**bold**]'))
    expect(text(r.state)).toBe('***bold***')
  })

  it('AC-09.4 `_it_` selected + Mod+I → `it` (underscore italic is recognised for unwrapping)', async () => {
    const italic = await command('toggleItalic')
    const r = run(italic, mdState('[_it_]'))
    expect(text(r.state)).toBe('it')
    expect(selected(r.state)).toBe('it')
  })

  it('rule 1a: leading/trailing whitespace in the selection stays outside the markers (`" word "` → `" **word** "`)', async () => {
    const bold = await command('toggleBold')
    const r = run(bold, mdState('a[ word ]b'))
    expect(text(r.state)).toBe('a **word** b')
    expect(selected(r.state)).toBe('word')
  })

  it('rule 1d: empty selection outside a word → `****` / `**` / `~~~~` with the cursor between the markers', async () => {
    for (const [name, inserted] of [['toggleBold', '****'], ['toggleItalic', '**'], ['toggleStrikethrough', '~~~~']] as const) {
      const cmd = await command(name)
      const r = run(cmd, mdState('end. |'))
      expect(text(r.state), name).toBe(`end. ${inserted}`)
      expect(text(type(r.state, 'Q')), `${name}: typing lands between the markers`).toBe(`end. ${inserted.slice(0, inserted.length / 2)}Q${inserted.slice(inserted.length / 2)}`)
    }
  })

  it('rule 1: Mod+Shift+X wraps a selection in `~~` and unwraps it again', async () => {
    const strike = await command('toggleStrikethrough')
    const r1 = run(strike, mdState('keep [this] text'))
    expect(text(r1.state)).toBe('keep ~~this~~ text')
    expect(selected(r1.state)).toBe('this')
    expect(text(run(strike, r1.state).state)).toBe('keep this text')
  })

  it('rule 1e: a selection over several lines wraps each non-empty line separately (blank line untouched)', async () => {
    const bold = await command('toggleBold')
    const r = run(bold, mdState('[one\n\ntwo]'))
    expect(text(r.state)).toBe('**one**\n\n**two**')
  })

  it('AC-09.18 two cursors each inside a different word + Mod+B → both words wrapped in `**`', async () => {
    const bold = await command('toggleBold')
    const r = run(bold, mdState('al|pha beta gam|ma'))
    expect(text(r.state)).toBe('**alpha** beta **gamma**')
    expect(r.state.selection.ranges).toHaveLength(2)
    // Each cursor keeps its offset inside its word.
    expect(text(type(r.state, 'X'))).toBe('**alXpha** beta **gamXma**')
  })
})

describe('#9 markdownCommands — link (rule 2)', () => {
  it('rule 2 / AC-09.5 `docs` selected + Mod+K → `[docs]()` with the cursor between `()`', async () => {
    const link = await command('toggleLink')
    const r = run(link, mdState('see [docs] now'))
    expect(r.handled).toBe(true)
    expect(text(r.state)).toBe('see [docs]() now')
    expect(text(type(r.state, 'https://x.io'))).toBe('see [docs](https://x.io) now')
  })

  it('rule 2 / AC-09.5 a URL selected + Mod+K → `[](url)` with the cursor between `[]`', async () => {
    const link = await command('toggleLink')
    const doc = 'go https://x.io now'
    const r = run(link, rawState(doc, [[3, 15]]))
    expect(text(r.state)).toBe('go [](https://x.io) now')
    expect(text(type(r.state, 'site'))).toBe('go [site](https://x.io) now')
  })

  it('rule 2: empty selection + Mod+K → `[]()` with the cursor between `[]`', async () => {
    const link = await command('toggleLink')
    const r = run(link, mdState('x |'))
    expect(text(r.state)).toBe('x []()')
    expect(text(type(r.state, 'a'))).toBe('x [a]()')
  })

  it('rule 2: a selection that is exactly `[x](y)` unwraps to `x`', async () => {
    const link = await command('toggleLink')
    const doc = 'a [label](https://y.io) b'
    const r = run(link, rawState(doc, [[2, 23]]))
    expect(text(r.state)).toBe('a label b')
  })
})

describe('#9 markdownCommands — code (rule 3)', () => {
  it('rule 3: a single-line selection + Mod+E → one backtick each side; Mod+E again unwraps', async () => {
    const code = await command('toggleCode')
    const r1 = run(code, mdState('run [npm test] now'))
    expect(r1.handled).toBe(true)
    expect(text(r1.state)).toBe('run `npm test` now')
    expect(selected(r1.state)).toBe('npm test')
    expect(text(run(code, r1.state).state)).toBe('run npm test now')
  })

  it('AC-09.6 a selection containing a backtick + Mod+E → two backticks and a space each side', async () => {
    const code = await command('toggleCode')
    const doc = 'a`b'
    const r = run(code, rawState(doc, [[0, 3]]))
    expect(text(r.state)).toBe('`` a`b ``')
  })

  it('AC-09.6 three whole lines selected + Mod+E → a ``` line before and after; cursor at the end of the opening fence line', async () => {
    const code = await command('toggleCode')
    const doc = 'before\none\ntwo\nthree\nafter'
    const from = doc.indexOf('one')
    const to = doc.indexOf('three') + 'three'.length
    const r = run(code, rawState(doc, [[from, to]]))
    const out = text(r.state)
    expect(out).toBe('before\n```\none\ntwo\nthree\n```\nafter')
    const opening = r.state.doc.line(2)
    expect(opening.text).toBe('```')
    expect(r.state.selection.main.empty).toBe(true)
    expect(r.state.selection.main.head, 'cursor at the end of the opening fence line').toBe(opening.to)
    // Typing there names the fence language.
    expect(text(type(r.state, 'js')).split('\n')[1]).toBe('```js')
  })

  it('rule 3: empty selection + Mod+E → a backtick pair with the cursor between', async () => {
    const code = await command('toggleCode')
    const r = run(code, mdState('x |'))
    expect(text(r.state)).toBe('x ``')
    expect(text(type(r.state, 'k'))).toBe('x `k`')
  })
})
