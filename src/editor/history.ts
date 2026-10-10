import { Annotation, Compartment, EditorState, Prec, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { history, historyField, historyKeymap, isolateHistory, redo, undo } from '@codemirror/commands'
import { historyEpoch, minimalChanges, type ExternalOrigin } from '@/composables/useExternalChange'

/**
 * Undo / redo (spec #8, 00 §3.6).
 *
 * - CodeMirror's history, typing grouped at its default 500 ms.
 * - Keys: Mod+Z undo; Mod+Shift+Z and Mod+Y redo on every platform (CM's own
 *   keymap lacks Cmd+Y on mac and Ctrl+Shift+Z on Windows).
 * - Pastes and drops are isolated: never merged with typing before or after.
 * - External writes (`applyExternal`) are minimal changes; remote ones are kept
 *   out of history and clear it (a barrier), local ones are one undo step.
 * - History outlives an unmount of the editor (view switches) via `keepState`.
 */

/** Lives in a compartment so a barrier can drop the history field and re-add it empty. */
const historyCompartment = new Compartment()

/** Tags a transaction that applies an external write (EditorPane does not echo it back). */
export const externalWrite = Annotation.define<ExternalOrigin>()

/**
 * Annotation for programmatic edits that must be exactly one undo step that
 * never merges with adjacent typing (#9 shortcuts, #11 table paste, #12 slash).
 */
export const ownUndoStep = isolateHistory.of('full')

/** `restored` is a history field initialiser from `takeKeptState`. */
export function historyExtension(restored: Extension | null = null): Extension {
  return [
    historyCompartment.of(restored ? [restored, history()] : history()),
    keymap.of([
      { key: 'Mod-z', run: undo, preventDefault: true },
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
      { key: 'Mod-y', run: redo, preventDefault: true },
      ...historyKeymap,
    ]),
    // Chrome sends a native undo/redo pressed in some other text field (the
    // filename or reviewer input) with nothing left to undo there to the last
    // edited contenteditable — this editor — as a historyUndo/historyRedo
    // beforeinput, which CodeMirror's history would run. Undo/redo of the
    // document only ever happens while the editor has focus (or from the toolbar).
    Prec.highest(EditorView.domEventHandlers({
      beforeinput(e, view) {
        if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return false
        if (view.hasFocus) return false
        e.preventDefault()
        return true
      },
    })),
    EditorState.transactionExtender.of((tr) =>
      tr.docChanged && (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop'))
        ? { annotations: ownUndoStep }
        : null,
    ),
  ]
}


/**
 * Bring the editor to `text` with the smallest possible changes (one per
 * changed region, all in one transaction). The selection
 * is mapped through it and nothing scrolls into view. Returns false when the
 * text was already equal (a no-op leaves the history alone).
 */
export function applyExternal(view: EditorView, text: string, origin: ExternalOrigin): boolean {
  const change = minimalChanges(view.state.doc.toString(), text)
  if (!change.length) return false
  if (origin === 'local') {
    view.dispatch({
      changes: change,
      annotations: [externalWrite.of('local'), ownUndoStep, Transaction.userEvent.of('input.restore')],
    })
    return true
  }
  // History barrier: drop the history field first, then apply the change and
  // re-add the field (created empty) in the same transaction. Nothing may be
  // dispatched after the change before CodeMirror measures, or its scroll
  // anchor is taken against the already-grown document and the view jumps.
  view.dispatch({ effects: historyCompartment.reconfigure([]) })
  view.dispatch({
    changes: change,
    effects: historyCompartment.reconfigure(history()),
    annotations: [externalWrite.of('remote'), Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  })
  return true
}

/** Drop the editor's undo/redo history (a barrier with no document change). */
export function clearHistory(view: EditorView) {
  view.dispatch({ effects: historyCompartment.reconfigure([]) })
  view.dispatch({ effects: historyCompartment.reconfigure(history()) })
}

// ── History across unmounts ────────────────────────────────────────────────
// The editor is unmounted when the user switches to the read view. Its
// document, selection and history are kept here and taken back on the next
// mount — but only for the same text and when no barrier (remote write,
// document switch) happened meanwhile.

let kept: { json: unknown; doc: string; epoch: number } | null = null

export function keepState(state: EditorState) {
  try {
    kept = { json: state.toJSON({ history: historyField }), doc: state.doc.toString(), epoch: historyEpoch() }
  } catch {
    kept = null
  }
}

/**
 * The kept selection + history for `doc`, as a field initialiser to put into
 * a fresh state's extensions (or null when nothing usable was kept).
 */
export function takeKeptState(doc: string): { selection: EditorState['selection']; extension: Extension } | null {
  const k = kept
  kept = null
  if (!k || k.doc !== doc || k.epoch !== historyEpoch()) return null
  try {
    const decoded = EditorState.fromJSON(k.json, { extensions: history() }, { history: historyField })
    const value = decoded.field(historyField)
    return { selection: decoded.selection, extension: historyField.init(() => value) }
  } catch {
    return null
  }
}

