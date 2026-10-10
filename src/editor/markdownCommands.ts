import { EditorSelection, Prec, countColumn, type ChangeSpec, type EditorState, type Extension, type Line, type SelectionRange, type StateCommand, type Transaction } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language'
import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'
import type { SyntaxNode } from '@lezer/common'
import { ownUndoStep } from '@/editor/history'

/**
 * Markdown keyboard shortcuts (spec #9, 00 §3.5, §4.7).
 *
 * Formatting commands are CodeMirror state commands (`({state, dispatch}) => boolean`)
 * so they run on a bare EditorState in unit tests. Each acts on every selection
 * range and is dispatched as exactly one undo step (#8). In a non-markdown doc
 * (HTML) the formatting keys are consumed and do nothing, except Mod+I which
 * falls through to CodeMirror's select-parent-syntax.
 *
 * Kept from `defaultKeymap`: Alt+↑/↓ move lines, Shift+Alt+↑/↓ copy lines,
 * Mod+/ toggle comment (`<!-- -->` in markdown). Esc-then-Tab leaving the
 * editor is CodeMirror's built-in tab-focus escape.
 */

type Target = { state: EditorState; dispatch: (tr: Transaction) => void }

/** True when the document's top-level language is markdown. */
export function isMarkdownDoc(state: EditorState): boolean {
  return state.facet(language)?.name === 'markdown'
}

function commit(target: Target, spec: ReturnType<EditorState['changeByRange']>) {
  target.dispatch(target.state.update(spec, { scrollIntoView: true, userEvent: 'input.format', annotations: ownUndoStep }))
}

// ── wrap / unwrap (rule 1, rule 3 inline) ───────────────────────────────────

type RangeResult = { range: SelectionRange; changes: ChangeSpec[] }

interface Marker {
  /** Markers to insert when wrapping `text`. */
  open(text: string): string
  close(text: string): string
  /** Marker lengths found just inside `text` (start, end), or null. */
  inside(text: string): [number, number] | null
  /** Marker lengths found just outside [from, to), or null. */
  outside(doc: string, from: number, to: number): [number, number] | null
  /** Does `text` itself contain this marker (so it is not one wrapped span)? */
  contains(text: string): boolean
  /** `text` with its own markers removed, before wrapping all of it. */
  strip(text: string): string
}

/** Length of the run of `ch` ending at `pos` (going left) / starting at `pos` (going right). */
function runLeft(doc: string, pos: number, ch: string): number {
  let n = 0
  while (pos - n - 1 >= 0 && doc[pos - n - 1] === ch) n++
  return n
}
function runRight(doc: string, pos: number, ch: string): number {
  let n = 0
  while (pos + n < doc.length && doc[pos + n] === ch) n++
  return n
}

/** A symmetric marker such as `**` or `~~`: wrapped when both runs are at least as long. */
function simpleMarker(mark: string): Marker {
  const ch = mark[0]!
  const len = mark.length
  return {
    open: () => mark,
    close: () => mark,
    inside(text) {
      if (text.length <= 2 * len) return null
      return runRight(text, 0, ch) >= len && runLeft(text, text.length, ch) >= len ? [len, len] : null
    },
    outside(doc, from, to) {
      return runLeft(doc, from, ch) >= len && runRight(doc, to, ch) >= len ? [len, len] : null
    },
    contains: (text) => text.includes(mark),
    strip: (text) => text.split(mark).join(''),
  }
}

const LONE_STAR = /(?<!\*)\*(?!\*)/g

/**
 * Italic: `*` that is not half of a `**` (an odd run counts: `*x*`, `***x***`), or a
 * single `_` (recognised for unwrapping only).
 */
const italicMarker: Marker = {
  open: () => '*',
  close: () => '*',
  inside(text) {
    if (text.length <= 2) return null
    for (const ch of ['*', '_']) {
      const a = runRight(text, 0, ch)
      const b = runLeft(text, text.length, ch)
      if (a < text.length && a % 2 === 1 && b % 2 === 1 && (ch === '*' || (a === 1 && b === 1))) return [1, 1]
    }
    return null
  },
  outside(doc, from, to) {
    for (const ch of ['*', '_']) {
      const a = runLeft(doc, from, ch)
      const b = runRight(doc, to, ch)
      if (a % 2 === 1 && b % 2 === 1 && (ch === '*' || (a === 1 && b === 1))) return [1, 1]
    }
    return null
  },
  contains: (text) => new RegExp(LONE_STAR.source).test(text),
  strip: (text) => text.replace(LONE_STAR, ''),
}

/** Inline code: one backtick, or two plus a space when the text itself contains a backtick. */
const codeMarker: Marker = {
  open: (text) => (text.includes('`') ? '`` ' : '`'),
  close: (text) => (text.includes('`') ? ' ``' : '`'),
  inside(text) {
    if (text.length > 6 && text.startsWith('`` ') && text.endsWith(' ``')) return [3, 3]
    if (text.length > 2 && text.startsWith('`') && text.endsWith('`') && !text.startsWith('``')) return [1, 1]
    return null
  },
  outside(doc, from, to) {
    if (doc.slice(from - 3, from) === '`` ' && doc.slice(to, to + 3) === ' ``') return [3, 3]
    if (runLeft(doc, from, '`') === 1 && runRight(doc, to, '`') === 1) return [1, 1]
    return null
  },
  // Backticks inside code are literal text (the double-backtick form wraps them).
  contains: () => false,
  strip: (text) => text,
}

const MARKERS = {
  bold: simpleMarker('**'),
  italic: italicMarker,
  strike: simpleMarker('~~'),
  code: codeMarker,
}

type Found = { kind: 'inside' | 'outside'; a: number; b: number } | null

/**
 * Is [s, e) one span wrapped in `m`? Markers inside the selection ends or just
 * outside them count, unless the bare text itself contains the marker
 * (`**a** and **b**` is two spans, not one).
 */
function findWrap(doc: string, s: number, e: number, m: Marker): Found {
  const text = doc.slice(s, e)
  const inner = m.inside(text)
  if (inner && !m.contains(text.slice(inner[0], text.length - inner[1]))) return { kind: 'inside', a: inner[0], b: inner[1] }
  const outer = m.outside(doc, s, e)
  if (outer && !m.contains(text)) return { kind: 'outside', a: outer[0], b: outer[1] }
  return null
}

type SpanEdit = { changes: ChangeSpec[]; from: number; to: number; delta: number }

function unwrapSpan(s: number, e: number, f: NonNullable<Found>): SpanEdit {
  const { a, b } = f
  return f.kind === 'inside'
    ? { changes: [{ from: s, to: s + a }, { from: e - b, to: e }], from: s, to: e - a - b, delta: -a }
    : { changes: [{ from: s - a, to: s }, { from: e, to: e + b }], from: s - a, to: e - a, delta: -a }
}

/**
 * Wrap [s, e). Text that already holds some of these markers (`**a** and **b**`,
 * or `a** and **b` inside an outer pair) becomes one span: its own markers go
 * and the whole is wrapped, like Docs' "bold a partly bold selection".
 */
function wrapSpan(doc: string, s: number, e: number, m: Marker): SpanEdit {
  const text = doc.slice(s, e)
  const open = m.open(text)
  const close = m.close(text)
  if (!m.contains(text)) {
    return { changes: [{ from: s, insert: open }, { from: e, insert: close }], from: s + open.length, to: e + open.length, delta: open.length }
  }
  const body = m.strip(text)
  // Absorb a pair right around the selection so it is not doubled.
  const outer = m.outside(doc, s, e)
  const [from, to] = outer ? [s - outer[0], e + outer[1]] : [s, e]
  return { changes: [{ from, to, insert: open + body + close }], from: from + open.length, to: from + open.length + body.length, delta: 0 }
}

/** Where a line's text starts after its block markup: `> `, `# `, `- `, `1. `, `- [ ] `. */
const BLOCK_PREFIX = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:#{1,6}(?:[ \t]+|$)|(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/

function contentStart(line: Line): number {
  return line.from + BLOCK_PREFIX.exec(line.text)![0].length
}

/** [from, to) on one line, without its block markup and outer whitespace. */
function spanOnLine(doc: string, line: Line, from: number, to: number): [number, number] {
  from = Math.max(from, contentStart(line), line.from)
  to = Math.min(to, line.to)
  while (from < to && /\s/.test(doc[from]!)) from++
  while (to > from && /\s/.test(doc[to - 1]!)) to--
  return [from, Math.max(from, to)]
}

/** A selection that ends at the very start of a line (triple-click style) stops at the end of the previous line. */
function effectiveTo(state: EditorState, range: SelectionRange): number {
  const { from, to } = range
  if (to > from && state.doc.lineAt(to).from === to) return to - 1
  return to
}

function wrapRange(state: EditorState, range: SelectionRange, m: Marker): RangeResult {
  const doc = state.doc.toString()
  if (range.empty) {
    const pos = range.head
    const word = state.wordAt(pos)
    if (word && word.from < pos && pos < word.to) {
      const found = findWrap(doc, word.from, word.to, m)
      const r = found ? unwrapSpan(word.from, word.to, found) : wrapSpan(doc, word.from, word.to, m)
      return { changes: r.changes, range: EditorSelection.cursor(pos + r.delta) }
    }
    const open = m.open('')
    return { changes: [{ from: pos, insert: open + m.close('') }], range: EditorSelection.cursor(pos + open.length) }
  }
  const to = effectiveTo(state, range)
  const first = state.doc.lineAt(range.from)
  const last = state.doc.lineAt(to)
  if (first.number === last.number) {
    const [s, e] = spanOnLine(doc, first, range.from, to)
    if (s === e) return { changes: [], range }
    const found = findWrap(doc, s, e, m)
    const r = found ? unwrapSpan(s, e, found) : wrapSpan(doc, s, e, m)
    return { changes: r.changes, range: EditorSelection.range(r.from, r.to) }
  }
  // Rule 1e: emphasis cannot span blocks — each non-empty line separately. Whether
  // to wrap or unwrap is decided once, from the first non-empty line.
  const changes: ChangeSpec[] = []
  let unwrap: boolean | null = null
  for (let n = first.number; n <= last.number; n++) {
    const line = state.doc.line(n)
    const [s, e] = spanOnLine(doc, line, range.from, to)
    if (s === e) continue
    const found = findWrap(doc, s, e, m)
    if (unwrap === null) unwrap = !!found
    if (unwrap && found) changes.push(...unwrapSpan(s, e, found).changes)
    else if (!unwrap && !found) changes.push(...wrapSpan(doc, s, e, m).changes)
  }
  const set = state.changes(changes)
  return { changes, range: EditorSelection.range(set.mapPos(range.from, 1), set.mapPos(to, -1)) }
}

function tree(state: EditorState, upto: number) {
  return ensureSyntaxTree(state, upto, 50) ?? syntaxTree(state)
}

/** The FencedCode node whose opening fence is on line `a` and closing fence on line `b`, if any. */
function fencedBlock(state: EditorState, a: number, b: number): boolean {
  if (a < 1 || b > state.doc.lines || a >= b) return false
  const open = state.doc.line(a)
  const lead = /^\s*/.exec(open.text)![0].length
  for (let n: SyntaxNode | null = tree(state, state.doc.line(b).to).resolveInner(open.from + lead, 1); n; n = n.parent) {
    if (n.name === 'FencedCode') {
      return state.doc.lineAt(n.from).number === a && state.doc.lineAt(n.to).number === b
    }
  }
  return false
}

/** Fenced block around whole lines (rule 3, multi-line); removes the fences of one code block. */
function fenceRange(state: EditorState, range: SelectionRange): RangeResult | null {
  const to = effectiveTo(state, range)
  const first = state.doc.lineAt(range.from)
  const last = state.doc.lineAt(to)
  if (first.number === last.number) return null
  const unfence = (a: number, b: number): RangeResult => {
    const open = state.doc.line(a)
    const close = state.doc.line(b)
    const changes = [
      { from: open.from, to: Math.min(open.to + 1, state.doc.length) },
      { from: Math.max(close.from - 1, 0), to: close.to },
    ]
    const set = state.changes(changes)
    return { changes, range: EditorSelection.range(set.mapPos(range.from, 1), set.mapPos(to, -1)) }
  }
  if (fencedBlock(state, first.number, last.number)) return unfence(first.number, last.number)
  if (fencedBlock(state, first.number - 1, last.number + 1)) return unfence(first.number - 1, last.number + 1)
  const br = state.lineBreak
  return {
    changes: [{ from: first.from, insert: '```' + br }, { from: last.to, insert: br + '```' }],
    range: EditorSelection.cursor(first.from + 3),
  }
}

function formatCommand(per: (state: EditorState, range: SelectionRange) => RangeResult, opts: { htmlFallthrough?: boolean } = {}): StateCommand {
  return (target) => {
    const { state } = target
    if (!isMarkdownDoc(state)) return !opts.htmlFallthrough
    commit(target, state.changeByRange((range) => per(state, range)))
    return true
  }
}

export const toggleBold: StateCommand = formatCommand((s, r) => wrapRange(s, r, MARKERS.bold))
export const toggleItalic: StateCommand = formatCommand((s, r) => wrapRange(s, r, MARKERS.italic), { htmlFallthrough: true })
export const toggleStrikethrough: StateCommand = formatCommand((s, r) => wrapRange(s, r, MARKERS.strike))
export const toggleCode: StateCommand = formatCommand((s, r) => fenceRange(s, r) ?? wrapRange(s, r, MARKERS.code))

// ── link (rule 2) ───────────────────────────────────────────────────────────

const LINK_RE = /^\[((?:\\.|[^\\\]])*)\]\(([^)]*)\)$/
const URL_RE = /^https?:\/\/\S+$/

/** Brackets in link text are escaped so the label cannot end the link early. */
export function escapeLinkLabel(text: string): string {
  return text.replace(/\\?([[\]])/g, (m, b: string) => (m.length === 2 ? m : '\\' + b))
}
function unescapeLinkLabel(text: string): string {
  return text.replace(/\\([[\]])/g, '$1')
}

export const toggleLink: StateCommand = formatCommand((state, range) => {
  if (range.empty) {
    return { changes: [{ from: range.from, insert: '[]()' }], range: EditorSelection.cursor(range.from + 1) }
  }
  const doc = state.doc.toString()
  const to = effectiveTo(state, range)
  const line = state.doc.lineAt(range.from)
  const [s, e] = line.number === state.doc.lineAt(to).number ? spanOnLine(doc, line, range.from, to) : [range.from, to]
  if (s === e) return { changes: [], range }
  const text = doc.slice(s, e)
  const link = LINK_RE.exec(text)
  if (link) {
    const label = unescapeLinkLabel(link[1]!)
    return { changes: [{ from: s, to: e, insert: label }], range: EditorSelection.range(s, s + label.length) }
  }
  if (URL_RE.test(text)) {
    return { changes: [{ from: s, insert: '[](' }, { from: e, insert: ')' }], range: EditorSelection.cursor(s + 1) }
  }
  const label = escapeLinkLabel(text)
  return { changes: [{ from: s, to: e, insert: `[${label}]()` }], range: EditorSelection.cursor(s + label.length + 3) }
})

// ── Enter (rule 4) ──────────────────────────────────────────────────────────

/** List / quote continuation; Enter on an empty item always ends that list level. */
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })
export const insertNewlineContinue: StateCommand = (target) => isMarkdownDoc(target.state) && continueMarkup(target)

// ── Tab / Shift+Tab (rule 6) ────────────────────────────────────────────────

const INDENT = 2
const TAB = 4

/** Length of a line's blockquote prefix (`> `, `> > `). Indentation is added after it. */
function quoteLen(text: string): number {
  return /^(?:[ \t]*>[ \t]?)*/.exec(text)![0].length
}

/** The ListItem whose marker starts on line `n`, or null (never inside fenced or indented code). */
function listItemAt(state: EditorState, n: number): SyntaxNode | null {
  if (!isMarkdownDoc(state)) return null
  const line = state.doc.line(n)
  const lead = /^[\s>]*/.exec(line.text)![0].length
  if (lead === line.length) return null
  for (let node: SyntaxNode | null = tree(state, line.to).resolveInner(line.from + lead, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return null
    if (node.name === 'ListItem') {
      const mark = node.getChild('ListMark')
      return mark && state.doc.lineAt(mark.from).number === n ? node : null
    }
  }
  return null
}

function column(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  return countColumn(line.text, TAB, pos - line.from)
}

/** Column where a list item's content starts (after its marker and the spaces after it). */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild('ListMark')!
  const line = state.doc.lineAt(mark.from)
  let i = mark.to - line.from
  while (i < line.length && (line.text[i] === ' ' || line.text[i] === '\t')) i++
  return i === mark.to - line.from ? column(state, mark.to) + 1 : countColumn(line.text, TAB, i)
}

function markColumn(state: EditorState, item: SyntaxNode): number {
  return column(state, item.getChild('ListMark')!.from)
}

function prevItem(item: SyntaxNode): SyntaxNode | null {
  for (let n = item.prevSibling; n; n = n.prevSibling) if (n.name === 'ListItem') return n
  return null
}

/** Line numbers touched by the selection (a selection ending at a line start skips that line). */
function selectedLines(state: EditorState): number[] {
  const out = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(effectiveTo(state, r)).number
    for (let n = a; n <= b; n++) out.add(n)
  }
  return [...out].sort((x, y) => x - y)
}

/** Lines of `item` (its marker line through its last line). */
function itemLines(state: EditorState, item: SyntaxNode): [number, number] {
  const a = state.doc.lineAt(item.from).number
  let end = item.to
  // A ListItem can end on the line break; keep it to its own text.
  if (end > item.from && state.doc.sliceString(end - 1, end) === '\n') end--
  return [a, state.doc.lineAt(end).number]
}

/** Remove `by` columns of leading whitespace after the quote prefix (a tab that overshoots leaves spaces). */
function removeColumns(line: Line, by: number): ChangeSpec | null {
  const start = quoteLen(line.text)
  let i = start
  let col = countColumn(line.text, TAB, start)
  const target = col + by
  while (i < line.length && col < target) {
    const ch = line.text[i]
    if (ch === ' ') col++
    else if (ch === '\t') col += TAB - (col % TAB)
    else break
    i++
  }
  if (i === start) return null
  return { from: line.from + start, to: line.from + i, insert: ' '.repeat(Math.max(0, col - target)) }
}

type Moved = { line: number; lines: [number, number] }

/**
 * Apply an indent change and, in the same undo step, renumber the ordered lists
 * it touched: a nested ordered list counts from 1 (CommonMark lets only `1.`
 * interrupt the parent item's paragraph), a top-level one from its first number.
 */
function dispatchIndent(target: Target, specs: ChangeSpec[], moved: Moved[]) {
  const { state } = target
  if (!specs.length) return
  const c1 = state.changes(specs)
  const s2 = state.update({ changes: c1 }).state
  const lists = new Map<number, SyntaxNode>()
  const addListAt = (n: number) => {
    if (n < 1 || n > s2.doc.lines) return
    const item = listItemAt(s2, n)
    if (item?.parent?.name === 'OrderedList') lists.set(item.parent.from, item.parent)
  }
  for (const m of moved) {
    const at = (n: number) => s2.doc.lineAt(c1.mapPos(state.doc.line(n).from, 1)).number
    addListAt(at(m.line))
    // The list it left: the items right before and after the moved block.
    if (m.lines[0] > 1) addListAt(at(m.lines[0] - 1))
    if (m.lines[1] < state.doc.lines) addListAt(at(m.lines[1] + 1))
  }
  const renumber: ChangeSpec[] = []
  for (const list of lists.values()) {
    const items: SyntaxNode[] = []
    for (let c = list.firstChild; c; c = c.nextSibling) if (c.name === 'ListItem') items.push(c)
    let nested = false
    for (let p = list.parent; p; p = p.parent) if (p.name === 'ListItem') { nested = true; break }
    let next = nested ? 1 : itemNumber(s2, items[0]!)
    for (const it of items) {
      const mark = it.getChild('ListMark')!
      const digits = /^\d+/.exec(s2.sliceDoc(mark.from, mark.to))![0]
      if (+digits !== next) renumber.push({ from: mark.from, to: mark.from + digits.length, insert: String(next) })
      next++
    }
  }
  const changes = renumber.length ? c1.compose(s2.changes(renumber)) : c1
  target.dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.indent', annotations: ownUndoStep }))
}

/** The number an item gets when appended to `parent`'s nested ordered list (1 when it has none). */
function nextChildNumber(state: EditorState, parent: SyntaxNode): number {
  const sub = parent.getChild('OrderedList')
  if (!sub) return 1
  let last: SyntaxNode | null = null
  for (let c = sub.firstChild; c; c = c.nextSibling) if (c.name === 'ListItem') last = c
  return last ? itemNumber(state, last) + 1 : 1
}

function itemNumber(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild('ListMark')!
  return parseInt(state.sliceDoc(mark.from, mark.to), 10)
}

/** Tab: nest list items under their previous sibling; elsewhere two spaces (at the cursor, or before every selected line). */
export const indentMore: StateCommand = (target) => {
  const { state } = target
  const lines = selectedLines(state)
  const items = lines.map((n) => listItemAt(state, n))
  const single = state.selection.ranges.length === 1 && state.selection.main.empty
  if (single && !items[0]) {
    target.dispatch(state.update(state.replaceSelection(' '.repeat(INDENT)), { scrollIntoView: true, userEvent: 'input.indent', annotations: ownUndoStep }))
    return true
  }
  const amount = new Map<number, { by: number; list: boolean }>()
  const moved: Moved[] = []
  const specs: ChangeSpec[] = []
  // An ordered item that becomes nested gets its sub-list number now: `   2. b`
  // under `1. a` would parse as paragraph text, not as a list item.
  const numbers = new Map<number, number>()
  lines.forEach((n, i) => {
    if (amount.has(n)) return
    const item = items[i]
    if (!item) { amount.set(n, { by: INDENT, list: false }); return }
    const prev = prevItem(item)
    const by = prev ? Math.max(0, contentColumn(state, prev) - markColumn(state, item)) : 0
    const span = itemLines(state, item)
    for (let k = span[0]; k <= span[1]; k++) if (!amount.has(k)) amount.set(k, { by, list: true })
    if (by > 0) moved.push({ line: n, lines: span })
    if (prev && by > 0 && item.parent?.name === 'OrderedList') {
      const num = numbers.has(prev.from) ? numbers.get(prev.from)! + 1 : nextChildNumber(state, prev)
      numbers.set(item.from, num)
      const mark = item.getChild('ListMark')!
      const digits = /^\d+/.exec(state.sliceDoc(mark.from, mark.to))![0]
      if (+digits !== num) specs.push({ from: mark.from, to: mark.from + digits.length, insert: String(num) })
    }
  })
  for (const [n, { by, list }] of amount) {
    const line = state.doc.line(n)
    if (by > 0 && line.length > 0) specs.push({ from: line.from + (list ? quoteLen(line.text) : 0), insert: ' '.repeat(by) })
  }
  dispatchIndent(target, specs, moved)
  return true
}

/** Shift+Tab: outdent list items to their parent's marker column; elsewhere drop up to two leading columns. */
export const indentLess: StateCommand = (target) => {
  const { state } = target
  const remove = new Map<number, number>()
  const moved: Moved[] = []
  for (const n of selectedLines(state)) {
    if (remove.has(n)) continue
    const item = listItemAt(state, n)
    if (!item) { remove.set(n, INDENT); continue }
    const parentItem = item.parent?.parent
    const by = parentItem?.name === 'ListItem' ? Math.max(0, markColumn(state, item) - markColumn(state, parentItem)) : 0
    const span = itemLines(state, item)
    for (let k = span[0]; k <= span[1]; k++) if (!remove.has(k)) remove.set(k, by)
    if (by > 0) moved.push({ line: n, lines: span })
  }
  const specs: ChangeSpec[] = []
  // The siblings an outdented ordered item leaves behind become its own sub-list:
  // they count from 1 again (a `2.` there would parse as paragraph text).
  const movedFrom = new Set(moved.map((m) => state.doc.line(m.line).from))
  for (const m of moved) {
    const item = listItemAt(state, m.line)!
    if (item.parent?.name !== 'OrderedList') continue
    let num = 1
    for (let sib = item.nextSibling; sib; sib = sib.nextSibling) {
      if (sib.name !== 'ListItem') continue
      if (movedFrom.has(state.doc.lineAt(sib.from).from)) break
      const mark = sib.getChild('ListMark')!
      const digits = /^\d+/.exec(state.sliceDoc(mark.from, mark.to))![0]
      if (+digits !== num) specs.push({ from: mark.from, to: mark.from + digits.length, insert: String(num) })
      num++
    }
  }
  for (const [n, by] of remove) {
    if (by <= 0) continue
    const spec = removeColumns(state.doc.line(n), by)
    if (spec) specs.push(spec)
  }
  dispatchIndent(target, specs, moved)
  return true
}

// ── keymap ──────────────────────────────────────────────────────────────────

/**
 * Registered from `editorExtensions` (00 §4.7). High precedence and listed before
 * the language, so it beats lang-markdown's own Enter binding; a slash menu (#12)
 * that must win while open registers at `Prec.highest`.
 */
export const markdownCommands: Extension = Prec.high(keymap.of([
  { key: 'Mod-b', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-Shift-x', run: toggleStrikethrough, preventDefault: true },
  { key: 'Mod-e', run: toggleCode, preventDefault: true },
  { key: 'Mod-k', run: toggleLink, preventDefault: true },
  { key: 'Enter', run: insertNewlineContinue },
  { key: 'Tab', run: indentMore, shift: indentLess },
]))
