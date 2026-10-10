import { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'

/**
 * Pasting an SVG source inserts it on its own lines (so the preview renders
 * it). Tagged as a paste, so history isolates it into one undo step (#8).
 */
export const svgPaste = EditorView.domEventHandlers({
  paste(event, view) {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!(text.trimStart().startsWith('<svg') && text.trimEnd().endsWith('</svg>'))) return false
    event.preventDefault()
    const cursor = view.state.selection.main.head
    view.dispatch({
      changes: { from: cursor, insert: `\n${text.trim()}\n` },
      annotations: Transaction.userEvent.of('input.paste'),
    })
    return true
  },
})
