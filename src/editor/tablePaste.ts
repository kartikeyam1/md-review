import { EditorSelection, Prec, Transaction, type EditorState, type Extension, type StateCommand } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { ownUndoStep } from '@/editor/history'
import { isMarkdownDoc } from '@/editor/markdownCommands'
import { isMacPlatform } from '@/editor/shortcutList'
import { DELIMITER_ROW_RE, detectTable, formatTableLines, splitRow, toMarkdownTable } from '@/editor/tableFormat'
import { toast } from '@/composables/useToast'

export { parseDelimited, detectTable, toMarkdownTable, formatMarkdownTable } from '@/editor/tableFormat'

/**
 * Pasted tables and the "format table" command (spec #11).
 *
 * - `plainPasteChord`: Ctrl/Cmd+Shift+V arms a flag; the next paste (within
 *   1 s) inserts text/plain verbatim and skips every later paste handler —
 *   image upload (#10), SVG, table. Registered first (00 §4.7 order).
 * - `tablePaste`: TSV/CSV text in a markdown doc, outside code/front
 *   matter/table rows, becomes an aligned GFM table. Two undo steps (00 §3.6):
 *   the raw paste, then the formatting.
 * - Shift+Alt+F (`formatTable`) re-aligns the table under the cursor.
 */

// ── Plain-text paste chord (rule 11) ─────────────────────────────────────────

const CHORD_WINDOW_MS = 1000
let chordAt = 0

function insertVerbatim(view: EditorView, text: string) {
  const sel = view.state.selection.main
  const insert = view.state.toText(text)
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.cursor(sel.from + insert.length),
    scrollIntoView: true,
    annotations: Transaction.userEvent.of('input.paste'),
  })
}

export const plainPasteChord: Extension = EditorView.domEventHandlers({
  keydown(event) {
    // `code` too, so the chord works on non-Latin layouts.
    const isV = event.code === 'KeyV' || event.key.toLowerCase() === 'v'
    if (isV && (event.ctrlKey || event.metaKey) && !event.altKey) chordAt = event.shiftKey ? Date.now() : 0 // a plain Mod+V disarms it
    return false // the browser goes on to paste
  },
  paste(event, view) {
    if (!chordAt) return false
    if (Date.now() - chordAt > CHORD_WINDOW_MS) { chordAt = 0; return false }
    const text = event.clipboardData?.getData('text/plain') ?? ''
    // Plain-text paste never uploads or converts; with no text there is nothing
    // to paste (the chord stays armed until a paste with text, a plain Mod+V or 1 s).
    event.preventDefault()
    if (text) { chordAt = 0; insertVerbatim(view, text) }
    return true
  },
})

// ── Where a paste may become a table (rule 1) ───────────────────────────────

/** Inside a leading `---` … `---` (or `...`) YAML block, fences included. */
function inFrontMatter(state: EditorState, pos: number): boolean {
  const doc = state.doc
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return false
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (/^(---|\.\.\.)\s*$/.test(line.text)) return pos <= line.to
  }
  return false
}

function inCode(state: EditorState, pos: number): boolean {
  // A huge doc may not parse in time: the partial tree still knows the code blocks it reached.
  const tree = ensureSyntaxTree(state, pos, 200) ?? syntaxTree(state)
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'InlineCode' && node.from < pos && pos < node.to) return true
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        if (node.from < pos && pos < node.to) return true
        // At the very end: inside unless the block was closed by a fence just before.
        if (pos === node.to && node.from < pos) {
          if (node.name === 'CodeBlock') return true
          const last = state.doc.lineAt(node.to).text.trim()
          if (!/^(`{3,}|~{3,})$/.test(last) || state.doc.lineAt(node.to).from === node.from) return true
        }
      }
    }
  }
  return false
}

function tableAllowedAt(state: EditorState, pos: number): boolean {
  if (!isMarkdownDoc(state)) return false
  // Inside a table row: verbatim. The very end of a row counts as outside, so a
  // second paste right after a pasted table becomes its own table.
  const line = state.doc.lineAt(pos)
  if (/^\s*\|/.test(line.text) && pos < line.to) return false
  return !inFrontMatter(state, pos) && !inCode(state, pos)
}

// ── Paste → table (rules 2–10) ──────────────────────────────────────────────

function pasteAsTable(view: EditorView, text: string): boolean {
  const state = view.state
  const sel = state.selection.main
  if (!tableAllowedAt(state, sel.head) || !tableAllowedAt(state, sel.from)) return false
  const detected = detectTable(text)
  if (!detected) return false
  const table = toMarkdownTable(detected.rows)

  // Step 1: the raw text, exactly as a plain paste would put it (its own undo step).
  insertVerbatim(view, text)
  const from = sel.from
  const rawTo = view.state.selection.main.head

  // Step 2: the table on its own lines (rule 8), one isolated undo step.
  const doc = view.state.doc
  const startLine = doc.lineAt(from)
  const endLine = doc.lineAt(rawTo)
  const before = doc.sliceString(startLine.from, from)
  const after = doc.sliceString(rawTo, endLine.to)
  let prefix = ''
  if (before.trim()) prefix = '\n\n'
  else if (startLine.number > 1 && doc.line(startLine.number - 1).text.trim()) prefix = '\n'
  let suffix = ''
  if (after.trim()) suffix = '\n\n'
  else if (endLine.number < doc.lines && doc.line(endLine.number + 1).text.trim()) suffix = '\n'
  const insert = prefix + table + suffix
  view.dispatch({
    changes: { from, to: rawTo, insert },
    selection: EditorSelection.cursor(from + prefix.length + table.length),
    scrollIntoView: true,
    annotations: [ownUndoStep, Transaction.userEvent.of('input.paste.table')],
  })
  const chord = isMacPlatform() ? 'Cmd+Shift+V' : 'Ctrl+Shift+V'
  toast.info(`Pasted as table · ${chord} to paste as plain text`)
  return true
}

export const tablePasteHandler: Extension = EditorView.domEventHandlers({
  paste(event, view) {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!text || !pasteAsTable(view, text)) return false
    event.preventDefault()
    return true
  },
})

// ── Format table (rules 12–15) ──────────────────────────────────────────────

const isRowLine = (text: string) => /^\s*\|/.test(text)

/** The GFM table around `pos`: its first and last line numbers, or null. */
function tableAt(state: EditorState, pos: number): { first: number; last: number } | null {
  const doc = state.doc
  const here = doc.lineAt(pos).number
  if (!isRowLine(doc.line(here).text)) return null
  let first = here
  while (first > 1 && isRowLine(doc.line(first - 1).text)) first--
  let last = here
  while (last < doc.lines && isRowLine(doc.line(last + 1).text)) last++
  if (last - first < 1 || !DELIMITER_ROW_RE.test(doc.line(first + 1).text)) return null
  return { first, last }
}

/** Which cell of `lineText` the column `col` is in (the indentation before the first `|` counts as cell 0). */
function cellIndexAt(lineText: string, col: number): number {
  const { starts } = splitRow(lineText)
  let idx = 0
  for (let i = 0; i < starts.length; i++) if (col >= starts[i]!) idx = i
  return idx
}

export const formatTable: StateCommand = ({ state, dispatch }) => {
  const pos = state.selection.main.head
  const found = isMarkdownDoc(state) && !inCode(state, pos) ? tableAt(state, pos) : null
  if (!found) {
    toast.info('No table at cursor')
    return true
  }
  const doc = state.doc
  const lines: string[] = []
  for (let n = found.first; n <= found.last; n++) lines.push(doc.line(n).text)
  const { lines: out, contentStarts } = formatTableLines(lines)
  if (out.every((l, i) => l === lines[i])) return true // already formatted: no change, no history entry

  const cursorLine = doc.lineAt(pos)
  const rowIdx = cursorLine.number - found.first
  const cols = contentStarts[rowIdx]!.length
  const cell = Math.min(cellIndexAt(cursorLine.text, pos - cursorLine.from), cols - 1)
  const from = doc.line(found.first).from
  const to = doc.line(found.last).to
  let lineStart = from
  for (let r = 0; r < rowIdx; r++) lineStart += out[r]!.length + 1
  dispatch(state.update({
    changes: { from, to, insert: out.join('\n') },
    selection: EditorSelection.cursor(lineStart + contentStarts[rowIdx]![cell]!),
    scrollIntoView: true,
    annotations: [ownUndoStep, Transaction.userEvent.of('input.format.table')],
  }))
  return true
}

export const tablePaste: Extension = [
  tablePasteHandler,
  Prec.high(keymap.of([{ key: 'Shift-Alt-f', run: formatTable, preventDefault: true }])),
]
