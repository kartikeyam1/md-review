// ── Reader-header meta (spec #2 rule 8) ──────────────────────────────────────
// Pure helpers: doc mode validation (shared with the server, 00 §4.8) and the
// "Updated 3 h ago by agent" line.

import type { DocMode } from '@/types'
import { DOC_MODES, isDocMode, modeOf } from '@shared/docMode.mjs'

export type { DocMode }
export { DOC_MODES, isDocMode }

/** A shared payload's mode; absent or invalid reads as `review` (00 §1.4). */
export function payloadMode(v: unknown): DocMode {
  return modeOf(v)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `<rel>`: < 60 s "just now"; < 60 min "N min ago"; < 24 h "N h ago"; else "MMM D" (+ ", YYYY" in another year). */
export function relativeTime(atMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - atMs)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`
  const d = new Date(atMs)
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === new Date(nowMs).getFullYear() ? label : `${label}, ${d.getFullYear()}`
}

/** "Updated <rel>[ by <name>]", or null when `at` is missing/invalid. */
export function updatedLabel(at: string | null | undefined, by: string | null | undefined, nowMs: number): string | null {
  if (!at) return null
  const t = Date.parse(at)
  if (Number.isNaN(t)) return null
  const who = (by ?? '').trim()
  return `Updated ${relativeTime(t, nowMs)}${who ? ` by ${who}` : ''}`
}
