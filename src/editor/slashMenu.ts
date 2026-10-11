import {
  EditorSelection, MapMode, Prec, StateEffect, StateField, Transaction,
  type EditorState, type Extension, type TransactionSpec,
} from '@codemirror/state'
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { externalWrite, ownUndoStep } from '@/editor/history'
import { isMarkdownDoc } from '@/editor/markdownCommands'
import {
  MAX_QUERY, SLASH_ITEMS, filterLanguages, filterSlashItems, slashItemText, validLanguage,
  type LangOption, type SlashItem,
} from '@/editor/slashCatalogue'
import { FENCE_LANGUAGES } from '@/composables/useMarkdown'
import './slashMenu.css'

/**
 * Slash menu (spec #12, 00 §3.4 layer 6, §3.6, §4.7).
 *
 * Typing `/` at line start or after a space/tab opens a filterable menu of
 * blocks. The typed `/query` is ordinary text while it is open; committing
 * replaces it in one isolated undo step (undo → `/query`, menu closed), and
 * every other way of closing leaves the document as typed.
 *
 * - `slashField` holds the open menu (slash position, typed extent, highlight,
 *   items vs code-language step); it closes itself when the doc or selection
 *   moves out of the rules (rule 9).
 * - An input handler opens it for typed `/` only (never paste/drop/dispatch).
 * - A highest-precedence keymap owns ↑ ↓ Enter Tab Esc while it is open (beats
 *   #9's list continuation and indent).
 * - `SlashMenuView` draws the menu as a fixed layer on the body and runs the
 *   code-language step's input.
 */

// ── state ───────────────────────────────────────────────────────────────────

const MENU_ID = 'slash-menu'
const itemDomId = (id: string) => `slash-menu-item-${id}`

interface SlashOpen {
  /** Position of the `/`. */
  from: number
  /** End of the typed query (the caret may sit anywhere in [from + 1, to]). */
  to: number
  /** Text between the `/` and the caret (rule 3): what the menu filters by. */
  query: string
  /** Highlighted item in `filterSlashItems(query)`. */
  index: number
  /** `lang`: `code` was committed and the language step is showing (rule 16). */
  mode: 'items' | 'lang'
}

const openSlash = StateEffect.define<number>()
const closeSlash = StateEffect.define<null>()
const highlightSlash = StateEffect.define<number>()
const langStep = StateEffect.define<null>()

function validate(value: SlashOpen, state: EditorState): SlashOpen | null {
  const sel = state.selection
  if (sel.ranges.length > 1 || !sel.main.empty) return null
  const head = sel.main.head
  if (head < value.from + 1 || head > value.to) return null
  if (state.doc.sliceString(value.from, value.from + 1) !== '/') return null
  const typed = state.doc.sliceString(value.from + 1, value.to)
  if (/\s/.test(typed) || typed.length > MAX_QUERY) return null
  const query = state.doc.sliceString(value.from + 1, head)
  if (query === value.query) return value
  return { ...value, query, index: 0 }
}

const slashField = StateField.define<SlashOpen | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(closeSlash)) return null
      if (e.is(openSlash)) return validate({ from: e.value, to: e.value + 1, query: '', index: 0, mode: 'items' }, tr.state)
    }
    if (!value) return null
    if (tr.docChanged) {
      // A remote update (or any external write) closes it; so does any edit under the language step.
      if (tr.annotation(externalWrite) !== undefined || tr.annotation(Transaction.remote) || value.mode === 'lang') return null
      const from = tr.changes.mapPos(value.from, 1, MapMode.TrackDel)
      if (from === null) return null
      value = { ...value, from, to: Math.max(from + 1, tr.changes.mapPos(value.to, 1)) }
    }
    for (const e of tr.effects) {
      if (e.is(highlightSlash)) value = { ...value, index: e.value }
      if (e.is(langStep)) value = { ...value, mode: 'lang' }
    }
    if (value.mode === 'lang') return tr.selection ? null : value
    return validate(value, tr.state)
  },
  provide: (f) => EditorView.contentAttributes.compute([f], (state) => {
    const v = state.field(f)
    if (!v || v.mode !== 'items') return {}
    const item = filterSlashItems(v.query)[v.index]
    // As CodeMirror's own autocomplete: the editor keeps role=textbox and points at the popup.
    const attrs: Record<string, string> = { 'aria-controls': MENU_ID, 'aria-haspopup': 'listbox', 'aria-autocomplete': 'list' }
    if (item) attrs['aria-activedescendant'] = itemDomId(item.id)
    return attrs
  }),
})

/** The open menu's state, or null (exported for tests and the toolbar). */
export function slashMenuState(state: EditorState): Readonly<SlashOpen> | null {
  return state.field(slashField, false) ?? null
}

// ── trigger (rules 1–2) ─────────────────────────────────────────────────────

/** Syntax nodes the `/` must not land in: code, HTML, comments, URLs. */
const EXCLUDED = new Set([
  'FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock',
  'Comment', 'HTMLTag', 'ProcessingInstruction', 'URL', 'Autolink',
])

/** Line `n` lies inside a leading `---` … `---` front-matter block (1-based). */
function inFrontMatter(state: EditorState, n: number): boolean {
  const doc = state.doc
  if (doc.line(1).text !== '---') return false
  const last = Math.min(doc.lines, 1000)
  for (let i = 2; i <= last; i++) {
    const text = doc.line(i).text
    if (text === '---' || text === '...') return n <= i
  }
  return false
}

/** An odd number of unescaped backticks: an inline code span is open (closed or not). */
function insideInlineCode(before: string): boolean {
  let ticks = 0
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '\\') { i++; continue }
    if (before[i] === '`') ticks++
  }
  return ticks % 2 === 1
}

/** Would a `/` typed at `pos` (empty selection) open the menu? */
export function canOpenSlashMenu(state: EditorState, pos: number): boolean {
  if (!isMarkdownDoc(state)) return false
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  if (before && !/[ \t]$/.test(before)) return false
  if (inFrontMatter(state, line.number)) return false
  if (insideInlineCode(before)) return false
  if (/\]\([^)]*$/.test(before)) return false // an unclosed link destination
  // Judge the tree as it will be once the `/` is in: `    /` after a paragraph break is an indented code block.
  const next = state.update({ changes: { from: pos, insert: '/' } }).state
  // At most 20 ms of parsing (only reached for a `/` after whitespace); a partial tree is still used.
  const tree = ensureSyntaxTree(next, pos + 1, 20) ?? syntaxTree(next)
  for (let node: { name: string; parent: unknown } | null = tree.resolve(pos + 1, -1); node; node = node.parent as typeof node) {
    if (EXCLUDED.has(node.name)) return false
  }
  return true
}

// ── commit (rules 11–15) ────────────────────────────────────────────────────

/** Strip the ‸ / «x» markers; returns the text and the selection offsets. */
function unmark(text: string): { text: string; anchor: number; head: number } {
  const sel = text.indexOf('«')
  if (sel >= 0) {
    const end = text.indexOf('»', sel)
    return { text: text.slice(0, sel) + text.slice(sel + 1, end) + text.slice(end + 1), anchor: sel, head: end - 1 }
  }
  const caret = text.indexOf('‸')
  if (caret >= 0) return { text: text.slice(0, caret) + text.slice(caret + 1), anchor: caret, head: caret }
  return { text, anchor: text.length, head: text.length }
}

/**
 * A line start made only of container markers: blockquote `>`s and/or one list
 * marker (incl. a task box), e.g. `- `, `1. `, `> `, `> - [ ] `.
 */
const CONTAINER_RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)((?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?$/

/**
 * The change + selection that replaces `/query` ([from, head)) with `item`.
 * Inline items replace in place. Line-prefix and block items start their own
 * line: text before the `/` stays on its line (trimmed); after only
 * whitespace or only list/quote markers they take the `/`'s place. Blocks
 * also get blank lines around them, and every block line after the first gets
 * the line's indent (in a list item / quote: its continuation prefix).
 */
export function slashInsertion(
  state: EditorState, from: number, head: number, item: SlashItem,
  opts: { lang?: string; date?: Date } = {},
): TransactionSpec {
  const marked = slashItemText(item, opts)
  const doc = state.doc
  if (item.kind === 'inline') return placed(from, head, marked)

  const line = doc.lineAt(from)
  const before = doc.sliceString(line.from, from)
  const rest = doc.sliceString(head, line.to).trimStart()
  const container = before.trim() ? CONTAINER_RE.exec(before) : null
  let start = from
  let lead = ''
  let cont = /^[ \t]*/.exec(before)![0] // prefix of every block line after the first
  let blank = '' // a blank separator line inside that container
  if (container && (container[1] || container[3])) {
    // `- /table`, `> /note`: the item becomes the list item's / quote's content.
    const marker = container[3] ?? ''
    cont = container[1]! + container[2]! + ' '.repeat(marker.length)
    blank = container[1]!.trimEnd()
  } else if (before.trim()) {
    // Text before the `/` stays on its line, trailing whitespace trimmed.
    start = line.from + before.trimEnd().length
    lead = item.kind === 'block' ? '\n\n' + cont : '\n' + cont
  } else if (item.kind === 'block' && line.number > 1 && doc.line(line.number - 1).text.trim()) {
    // Only whitespace before, under a non-blank line: a blank line first.
    start = line.from
    lead = '\n' + cont
  }

  if (item.kind === 'prefix') return placed(start, line.to, lead + marked + rest)

  let body = marked.split('\n').join('\n' + cont)
  // Text after the query follows the caret when the caret ends the block (callouts, divider, toc),
  // otherwise it becomes the next paragraph.
  if (rest) body += marked.endsWith('‸') ? rest : '\n' + blank + '\n' + cont + rest
  // A blank line after the block when non-blank text follows on the next line.
  const lastLine = unmark(body).text.split('\n').pop()!
  if (line.number < doc.lines && doc.line(line.number + 1).text.trim() && lastLine.trim()) body += '\n' + blank
  return placed(start, line.to, lead + body)
}

/** Replace [from, to) with `marked`, selection per its markers. */
function placed(from: number, to: number, marked: string): TransactionSpec {
  const u = unmark(marked)
  return {
    changes: { from, to, insert: u.text },
    selection: EditorSelection.single(from + u.anchor, from + u.head),
  }
}

function commitItem(view: EditorView, item: SlashItem, opts: { lang?: string } = {}) {
  const v = view.state.field(slashField)
  if (!v) return
  if (item.id === 'code' && opts.lang === undefined) {
    view.dispatch({ effects: langStep.of(null) })
    return
  }
  const spec = slashInsertion(view.state, v.from, view.state.selection.main.head, item, opts)
  view.dispatch({
    ...spec,
    effects: closeSlash.of(null),
    annotations: ownUndoStep,
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
}

const close = (view: EditorView) => view.dispatch({ effects: closeSlash.of(null) })

// ── keys (rule 7) ───────────────────────────────────────────────────────────

function itemsOpen(view: EditorView): SlashOpen | null {
  const v = view.state.field(slashField)
  return v && v.mode === 'items' ? v : null
}

function move(by: number) {
  return (view: EditorView) => {
    const v = itemsOpen(view)
    if (!v) return false
    const n = filterSlashItems(v.query).length
    // Nothing to move through: the arrow moves the caret (which closes the menu, rule 9).
    if (!n) return false
    view.dispatch({ effects: highlightSlash.of((v.index + by + n) % n) })
    return true
  }
}

function commitKey(view: EditorView): boolean {
  const v = itemsOpen(view)
  if (!v) return false
  const item = filterSlashItems(v.query)[v.index]
  if (!item) {
    // No match: close and let the key do what it normally does (rule 6).
    close(view)
    return false
  }
  commitItem(view, item)
  return true
}

const slashKeymap = Prec.highest(keymap.of([
  { key: 'ArrowDown', run: move(1) },
  { key: 'ArrowUp', run: move(-1) },
  { key: 'Enter', run: commitKey },
  { key: 'Tab', run: commitKey },
  { key: 'Escape', run: (view) => { if (!view.state.field(slashField)) return false; close(view); return true } },
]))

const slashInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '/' || from !== to || view.composing) return false
  const sel = view.state.selection
  if (sel.ranges.length > 1 || !sel.main.empty || sel.main.head !== from) return false
  if (!canOpenSlashMenu(view.state, from)) return false
  view.dispatch({
    changes: { from, insert: '/' },
    selection: { anchor: from + 1 },
    effects: openSlash.of(from),
    userEvent: 'input.type',
    scrollIntoView: true,
  })
  return true
})

// ── the menu (rules 4, 8, 10, 16) ───────────────────────────────────────────

const LANG_LIST_ID = 'slash-menu-lang-list'
const langDomId = (i: number) => `slash-menu-lang-${i}`
const GAP = 4
const EDGE = 8
const SIDE = 16

class SlashMenuView {
  dom: HTMLElement | null = null
  private shown: SlashOpen | null = null
  private renderedQuery: string | null = null
  private input: HTMLInputElement | null = null
  private langOptions: LangOption[] = []
  private langIndex = 0
  private readonly reposition = () => { if (this.dom) this.view.requestMeasure(this.measure) }
  private readonly measure = {
    key: this,
    read: () => {
      const v = this.shown
      if (!v || !this.dom) return null
      return { at: this.view.coordsAtPos(v.from), w: this.dom.offsetWidth, h: this.dom.offsetHeight }
    },
    write: (m: { at: { left: number; top: number; bottom: number } | null; w: number; h: number } | null) => {
      if (!m || !this.dom) return
      this.place(m)
    },
  }

  constructor(readonly view: EditorView) {
    view.scrollDOM.addEventListener('scroll', this.reposition)
    window.addEventListener('scroll', this.reposition, true)
    window.addEventListener('resize', this.reposition)
    this.sync(view.state.field(slashField))
  }

  update(u: ViewUpdate) {
    const v = u.state.field(slashField)
    if (v !== this.shown) this.sync(v)
    else if (v && (u.geometryChanged || u.viewportChanged)) this.reposition()
    if (v?.mode === 'items' && u.focusChanged && !u.view.hasFocus) {
      // Focus left the editor and not for the menu: close (rule 9).
      setTimeout(() => {
        if (this.view.state.field(slashField)?.mode === 'items' && !this.view.hasFocus && !this.dom?.contains(document.activeElement)) close(this.view)
      })
    }
  }

  destroy() {
    this.view.scrollDOM.removeEventListener('scroll', this.reposition)
    window.removeEventListener('scroll', this.reposition, true)
    window.removeEventListener('resize', this.reposition)
    this.remove()
  }

  private remove() {
    // Closing while focus is inside (the language input): give it back to the editor, never to <body>.
    if (this.dom?.contains(document.activeElement)) {
      queueMicrotask(() => {
        const a = document.activeElement
        if (!a || a === document.body) this.view.focus()
      })
    }
    this.dom?.remove()
    this.dom = null
    this.input = null
    this.renderedQuery = null
  }

  private sync(v: SlashOpen | null) {
    const prev = this.shown
    this.shown = v
    if (!v) { this.remove(); return }
    if (v.mode === 'lang') {
      if (prev?.mode !== 'lang' || !this.dom) this.renderLang()
    } else {
      if (!this.dom || prev?.mode !== 'items' || this.renderedQuery !== v.query) this.renderItems(v)
      else this.highlight(v.index)
    }
    this.reposition()
  }

  private shell(): HTMLElement {
    this.remove()
    const dom = document.createElement('div')
    dom.className = 'slash-menu'
    dom.id = MENU_ID
    dom.setAttribute('data-testid', 'slash-menu')
    // Pressing anywhere in the menu (items, padding, its scrollbar) keeps focus where it is.
    dom.addEventListener('mousedown', (e) => e.preventDefault())
    ;(document.fullscreenElement ?? document.body).appendChild(dom)
    this.dom = dom
    return dom
  }

  private renderItems(v: SlashOpen) {
    const dom = this.shell()
    dom.setAttribute('role', 'listbox')
    dom.setAttribute('aria-label', 'Insert block')
    // In the tab order so its scrolling list counts as keyboard-reachable (axe scrollable-region-focusable),
    // but the keys belong to the editor (aria-activedescendant): focus that lands here goes straight back.
    dom.tabIndex = 0
    dom.addEventListener('focus', () => this.view.focus())
    const items = filterSlashItems(v.query)
    this.renderedQuery = v.query
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'slash-menu-empty'
      empty.setAttribute('data-testid', 'slash-menu-empty')
      empty.setAttribute('role', 'option')
      empty.setAttribute('aria-disabled', 'true')
      empty.setAttribute('aria-selected', 'false')
      empty.textContent = 'No matching blocks'
      dom.appendChild(empty)
      return
    }
    items.forEach((item, i) => {
      const el = document.createElement('div')
      el.className = 'slash-menu-item'
      el.id = itemDomId(item.id)
      el.setAttribute('role', 'option')
      el.setAttribute('data-testid', 'slash-menu-item')
      el.setAttribute('data-command', item.id)
      el.setAttribute('aria-selected', String(i === v.index))
      const label = document.createElement('span')
      label.className = 'slash-menu-label'
      label.textContent = item.label
      const hint = document.createElement('span')
      hint.className = 'slash-menu-hint'
      hint.textContent = item.hint
      el.append(label, hint)
      el.addEventListener('mousemove', () => {
        const cur = this.view.state.field(slashField)
        if (cur?.mode === 'items' && cur.index !== i) this.view.dispatch({ effects: highlightSlash.of(i) })
      })
      el.addEventListener('click', (e) => {
        if (e.button !== 0) return
        commitItem(this.view, item)
      })
      dom.appendChild(el)
    })
    this.highlight(v.index)
  }

  private highlight(index: number) {
    if (!this.dom) return
    const els = this.dom.querySelectorAll<HTMLElement>('.slash-menu-item')
    els.forEach((el, i) => el.setAttribute('aria-selected', String(i === index)))
    els[index]?.scrollIntoView({ block: 'nearest' })
  }

  // ── code language step ───────────────────────────────────────────────────

  private renderLang() {
    const dom = this.shell()
    dom.classList.add('slash-menu-lang')
    dom.setAttribute('role', 'group')
    dom.setAttribute('aria-label', 'Code block language')
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'slash-menu-lang-input'
    input.placeholder = 'Language'
    input.maxLength = 30
    input.spellcheck = false
    input.autocomplete = 'off'
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('data-testid', 'slash-menu-lang-input')
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-label', 'Code block language')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-expanded', 'true')
    input.setAttribute('aria-controls', LANG_LIST_ID)
    const list = document.createElement('div')
    list.className = 'slash-menu-lang-list'
    list.id = LANG_LIST_ID
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'Languages')
    dom.append(input, list)
    this.input = input
    input.addEventListener('input', () => this.renderLangOptions())
    input.addEventListener('keydown', (e) => this.langKey(e))
    input.addEventListener('blur', () => setTimeout(() => {
      // Focus went somewhere other than the menu: cancel the whole insertion (doc untouched).
      if (this.view.state.field(slashField)?.mode === 'lang' && !this.dom?.contains(document.activeElement)) close(this.view)
    }))
    this.renderLangOptions()
    input.focus({ preventScroll: true })
  }

  private renderLangOptions() {
    const list = this.dom?.querySelector('.slash-menu-lang-list')
    if (!list || !this.input) return
    const typed = this.input.value.trim()
    this.langOptions = filterLanguages(typed, FENCE_LANGUAGES)
    this.langIndex = 0
    list.textContent = ''
    this.langOptions.forEach((o, i) => {
      const el = document.createElement('div')
      el.className = 'slash-menu-lang-option'
      el.id = langDomId(i)
      el.setAttribute('role', 'option')
      el.setAttribute('data-testid', 'slash-menu-lang-option')
      el.setAttribute('data-lang', o.lang)
      el.textContent = o.label
      el.addEventListener('mousemove', () => { if (this.langIndex !== i) this.langHighlight(i) })
      el.addEventListener('click', (e) => { if (e.button === 0) this.chooseLang(o.lang) })
      list.appendChild(el)
    })
    if (!this.langOptions.length) {
      const hint = document.createElement('div')
      hint.className = 'slash-menu-empty'
      hint.setAttribute('role', 'option')
      hint.setAttribute('aria-disabled', 'true')
      hint.setAttribute('aria-selected', 'false')
      hint.textContent = validLanguage(typed) ? `Enter for “${typed}”` : 'Letters, digits and _ + # . - only'
      list.appendChild(hint)
    }
    this.input.setAttribute('aria-invalid', String(!this.langOptions.length && !validLanguage(typed)))
    this.langHighlight(0)
    this.reposition()
  }

  private langHighlight(i: number) {
    this.langIndex = i
    const els = this.dom?.querySelectorAll<HTMLElement>('.slash-menu-lang-option') ?? []
    els.forEach((el, j) => el.setAttribute('aria-selected', String(j === i)))
    if (els[i]) {
      this.input?.setAttribute('aria-activedescendant', els[i]!.id)
      els[i]!.scrollIntoView({ block: 'nearest' })
    } else {
      this.input?.removeAttribute('aria-activedescendant')
    }
  }

  private langKey(e: KeyboardEvent) {
    if (e.isComposing) return
    const n = this.langOptions.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (n) this.langHighlight((this.langIndex + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
    } else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      const typed = this.input?.value.trim() ?? ''
      if (n) this.chooseLang(this.langOptions[this.langIndex]!.lang)
      else if (validLanguage(typed)) this.chooseLang(typed)
    } else if (e.key === 'Escape') {
      // Cancel: doc unchanged (`/query` stays), focus back at its caret. preventDefault: one Esc, one layer (00 §3.4).
      e.preventDefault()
      close(this.view)
      this.view.focus()
    }
  }

  private chooseLang(lang: string) {
    const code = SLASH_ITEMS.find((i) => i.id === 'code')!
    commitItem(this.view, code, { lang })
    this.view.focus()
  }

  // ── placement (rule 4) ───────────────────────────────────────────────────

  private place(m: { at: { left: number; top: number; bottom: number } | null; w: number; h: number }) {
    const dom = this.dom!
    if (!m.at) { dom.style.visibility = 'hidden'; return }
    dom.style.visibility = ''
    const vw = document.documentElement.clientWidth || window.innerWidth
    const vh = window.innerHeight
    const left = Math.max(SIDE, Math.min(m.at.left, vw - SIDE - m.w))
    const below = m.at.bottom + GAP
    const above = m.at.top - GAP - m.h
    let top = below
    if (below + m.h > vh - EDGE) top = above >= EDGE ? above : Math.max(EDGE, vh - EDGE - m.h)
    dom.style.left = `${Math.round(left)}px`
    dom.style.top = `${Math.round(top)}px`
  }
}

const slashMenuView = ViewPlugin.fromClass(SlashMenuView)

/** The slash menu extension (registered in `editorExtensions`, 00 §4.7). */
export const slashMenu: Extension = [slashField, slashKeymap, slashInput, slashMenuView]
