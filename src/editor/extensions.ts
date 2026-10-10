import type { Extension } from '@codemirror/state'
import { drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { historyExtension } from '@/editor/history'
import { svgPaste } from '@/editor/svgPaste'
import { imagePaste } from '@/editor/imagePaste'
import { markdownCommands } from '@/editor/markdownCommands'

/**
 * The editor's feature extensions, in one list (00 §4.7). Feature items add
 * their module here instead of editing EditorPane: `markdownCommands` (#9),
 * `imagePaste` (#10), `tablePaste` (#11), `slashMenu` (#12). Paste handlers run
 * in list order: plain-text chord → image → SVG text → table → default.
 * EditorPane adds only what is bound to its instance (language, comment
 * decorations, theme, listeners).
 */
export function editorExtensions(opts: { restoredHistory?: Extension | null } = {}): Extension[] {
  return [
    // History first: its keymap wins over anything later binding Mod-Z/Y.
    historyExtension(opts.restoredHistory ?? null),
    lineNumbers(),
    drawSelection(),
    search(),
    markdownCommands,
    keymap.of([...defaultKeymap, ...searchKeymap]),
    imagePaste,
    svgPaste,
  ]
}
