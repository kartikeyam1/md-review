import { diffLines } from 'diff'
import { computeDelta } from '@/composables/useDelta'

/**
 * Writes to the document that do not come from typing in the editor (spec #8).
 *
 * The editor applies every such write as a minimal change, but what it does
 * with its undo history depends on where the write came from:
 *  - 'remote' — the server (poll adopting a remote copy, "Use server version",
 *    draft-vs-server reconciliation on load) or a document switch: not added to
 *    history, and the history is cleared (rule 4e: a barrier, so a local undo
 *    can never revert or resurrect text another writer changed).
 *  - 'local'  — a user action outside the editor (revision restore): one undo step.
 *
 * Writers say so explicitly with `markExternalChange(text, origin)` right
 * before they assign the text; an unmarked external write is treated as
 * 'remote', the safe default. This module is pure (no CodeMirror import) so
 * the sync layer can use it without pulling in the editor chunk (#6).
 */
export type ExternalOrigin = 'remote' | 'local'

export interface TextChange {
  from: number
  to: number
  insert: string
}

/**
 * The single change that turns `oldText` into `newText`: the common prefix
 * and suffix are kept, only the span between them is replaced. `null` when the
 * texts are equal. Offsets are UTF-16 code units in `oldText` (a CodeMirror
 * ChangeSpec).
 */
export function minimalChange(oldText: string, newText: string): TextChange | null {
  if (oldText === newText) return null
  const d = computeDelta(oldText, newText)
  return { from: d.keepStart, to: oldText.length - d.keepEnd, insert: d.insert }
}

/** Beyond this many changed lines a line diff is not worth it: one span is applied instead. */
const MAX_EDIT_LINES = 2000

/**
 * The changes that turn `oldText` into `newText`, one per changed region (a
 * line diff of the span between the common prefix and suffix, each hunk then
 * trimmed to the characters that differ). Offsets are all in `oldText`,
 * sorted and non-overlapping — one CodeMirror transaction applies them, so a
 * caret or scroll anchor between two distant edits maps through untouched.
 * `[]` when the texts are equal. Falls back to `minimalChange`'s single span
 * when the middle has no line structure or the diff would be too large.
 */
export function minimalChanges(oldText: string, newText: string): TextChange[] {
  const single = minimalChange(oldText, newText)
  if (!single) return []
  const oldMid = oldText.slice(single.from, single.to)
  const newMid = single.insert
  if (!oldMid.includes('\n') || !newMid.includes('\n')) return [single]
  const parts = diffLines(oldMid, newMid, { maxEditLength: MAX_EDIT_LINES })
  if (!parts) return [single]

  const out: TextChange[] = []
  let pos = single.from // offset in oldText
  let hunk: { from: number; to: number; insert: string } | null = null
  const flush = () => {
    if (!hunk) return
    const local = minimalChange(oldText.slice(hunk.from, hunk.to), hunk.insert)
    if (local) out.push({ from: hunk.from + local.from, to: hunk.from + local.to, insert: local.insert })
    hunk = null
  }
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush()
      pos += part.value.length
    } else {
      hunk ??= { from: pos, to: pos, insert: '' }
      if (part.removed) { pos += part.value.length; hunk.to = pos } else hunk.insert += part.value
    }
  }
  flush()
  return out
}

let pending: { text: string; origin: ExternalOrigin } | null = null
let epoch = 0

/** Announce that the document is about to be set to `text` from outside the editor. */
export function markExternalChange(text: string, origin: ExternalOrigin) {
  pending = { text, origin }
  if (origin === 'remote') epoch++
}

/**
 * The origin of an external write of `text` (consumed once). Unmarked writes,
 * and marks for some other text, are 'remote'.
 */
export function takeExternalOrigin(text: string): ExternalOrigin {
  const p = pending
  pending = null
  return p && p.text === text ? p.origin : 'remote'
}

const barrierListeners = new Set<() => void>()

/**
 * A history barrier happened somewhere (remote write, document switch) — bumps
 * the epoch so an editor that is not mounted right now drops the history it
 * kept for the old content, and tells a mounted editor to drop its live
 * history (#6 keeps one editor instance across a local file replacement, whose
 * text may even be identical, so the content watcher alone would not notice).
 */
export function historyBarrier() {
  epoch++
  for (const fn of barrierListeners) fn()
}

/** Subscribe a mounted editor to barriers; returns the unsubscribe function. */
export function onHistoryBarrier(fn: () => void): () => void {
  barrierListeners.add(fn)
  return () => { barrierListeners.delete(fn) }
}

export function historyEpoch(): number {
  return epoch
}
