/**
 * The rows of the keyboard-shortcuts overlay (spec #9 rule 11b), as data so later
 * items append theirs (#11 "Format table", #13 "Focus mode"). No CodeMirror import:
 * this module is also reachable from the app shell.
 *
 * A combo is written CodeMirror-style: `Mod-Shift-x`, `Alt-ArrowUp`, `Escape Tab`
 * (space = "then"), `?`. `formatCombo` renders it with platform labels.
 */
export interface ShortcutRow {
  label: string
  /** One or more alternative combos ("Mod-y" or "Mod-Shift-z"). */
  keys: string[]
  /** Where it applies, when not everywhere in the editor. */
  note?: string
}

export const SHORTCUT_ROWS: ShortcutRow[] = [
  { label: 'Bold', keys: ['Mod-b'] },
  { label: 'Italic', keys: ['Mod-i'] },
  { label: 'Strikethrough', keys: ['Mod-Shift-x'] },
  { label: 'Inline code / code block', keys: ['Mod-e'] },
  { label: 'Link', keys: ['Mod-k'] },
  { label: 'Continue list or quote', keys: ['Enter'] },
  { label: 'Remove list marker', keys: ['Backspace'], note: 'right after the marker' },
  { label: 'Indent / nest list item', keys: ['Tab'] },
  { label: 'Outdent list item', keys: ['Shift-Tab'] },
  { label: 'Move line up / down', keys: ['Alt-ArrowUp', 'Alt-ArrowDown'] },
  { label: 'Duplicate line up / down', keys: ['Shift-Alt-ArrowUp', 'Shift-Alt-ArrowDown'] },
  { label: 'Toggle HTML comment', keys: ['Mod-/'] },
  { label: 'Format table', keys: ['Shift-Alt-f'], note: 'cursor in a table' },
  { label: 'Paste as plain text', keys: ['Mod-Shift-v'] },
  { label: 'Undo', keys: ['Mod-z'] },
  { label: 'Redo', keys: ['Mod-Shift-z', 'Mod-y'] },
  { label: 'Find', keys: ['Mod-f'] },
  { label: 'Save', keys: ['Mod-s'] },
  { label: 'Leave the editor', keys: ['Escape Tab'], note: 'Tab within 2 s' },
  { label: 'Show keyboard shortcuts', keys: ['?'], note: 'outside the editor' },
]

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '')
}

const MAC: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
const OTHER: Record<string, string> = { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
const NAMED: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc',
}
/** macOS lists modifiers in this order (⌃⌥⇧⌘). */
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod']

/** One key press, e.g. `Mod-Shift-x` → `Ctrl+Shift+X` / `⇧⌘X`. */
function formatChord(chord: string, mac: boolean): string {
  const parts = chord === '-' ? ['-'] : chord.split(/-(?!$)/)
  const key = parts.pop()!
  const mods = mac ? MAC_ORDER.filter((m) => parts.includes(m)) : parts
  const keyLabel = NAMED[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  const table = mac ? MAC : OTHER
  const labels = mods.map((m) => table[m] ?? m)
  return mac ? labels.join('') + keyLabel : [...labels, keyLabel].join('+')
}

/** A combo (chords separated by spaces, meaning "then") with platform labels. */
export function formatCombo(combo: string, mac = isMacPlatform()): string {
  return combo.split(' ').map((c) => formatChord(c, mac)).join(' then ')
}
