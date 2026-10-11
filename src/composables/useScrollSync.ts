// ── Split view: synced scrolling + divider maths (spec #7 rules 4, 8, 9, 11) ──
// Pure functions only; SplitView.vue does the DOM side. Unit-tested in
// tests/items/07-split-view.test.ts.

/** A rendered preview block: its source lines [start, end) and its box (px, in scroll-content coordinates). */
export interface LineBlock { start: number; end: number; top: number; bottom: number }
/** One point of the line ↔ offset map. */
export interface Anchor { line: number; offset: number }

/**
 * The line ↔ offset map (rule 8) as piecewise-linear anchors, sorted by line,
 * offsets never decreasing. Each block contributes (start, top) and
 * (end, bottom); a line where one block ends and another starts uses the
 * starting block's top, so a heading's first line maps to the heading's top
 * edge. Interpolating between consecutive anchors is the same as interpolating
 * inside the deepest block containing a line (its children add their own
 * anchors), and it also covers blank lines between blocks. Anchors that would
 * go back up (floats, odd positioning) are dropped so both directions stay
 * monotonic and invert each other.
 */
export function buildAnchors(blocks: LineBlock[]): Anchor[] {
  const starts = new Map<number, number>()
  const ends = new Map<number, number>()
  for (const b of blocks) {
    if (!(b.end > b.start) || !Number.isFinite(b.top) || !Number.isFinite(b.bottom)) continue
    starts.set(b.start, Math.min(starts.get(b.start) ?? Infinity, b.top))
    ends.set(b.end, Math.max(ends.get(b.end) ?? -Infinity, b.bottom))
  }
  const lines = [...new Set([...starts.keys(), ...ends.keys()])].sort((a, b) => a - b)
  const out: Anchor[] = []
  for (const line of lines) {
    const offset = starts.get(line) ?? ends.get(line)!
    const prev = out[out.length - 1]
    if (prev && offset < prev.offset) continue
    out.push({ line, offset })
  }
  return out
}

/** Source line (fractional) → preview offset. Before the first block → 0; past the last → its bottom. */
export function lineToOffset(anchors: Anchor[], line: number): number {
  if (!anchors.length || line < anchors[0].line) return 0
  const last = anchors[anchors.length - 1]
  if (line >= last.line) return last.offset
  let lo = 0
  let hi = anchors.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (anchors[mid].line <= line) lo = mid
    else hi = mid
  }
  const a = anchors[lo]
  const b = anchors[hi]
  return a.offset + ((line - a.line) / (b.line - a.line)) * (b.offset - a.offset)
}

/** Preview offset → source line (fractional), the inverse of lineToOffset; clamps at both ends. */
export function offsetToLine(anchors: Anchor[], offset: number): number {
  if (!anchors.length) return 0
  if (offset <= anchors[0].offset) return anchors[0].line
  const last = anchors[anchors.length - 1]
  if (offset >= last.offset) return last.line
  // The last anchor at or above `offset` (flat stretches resolve to their far end).
  let lo = 0
  let hi = anchors.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (anchors[mid].offset <= offset) lo = mid
    else hi = mid
  }
  const a = anchors[lo]
  const b = anchors[hi]
  if (b.offset === a.offset) return b.line
  return a.line + ((offset - a.offset) / (b.offset - a.offset)) * (b.line - a.line)
}

/** Rule 9: scrollTop / (scrollHeight − clientHeight), clamped to 0..1; 0 when nothing scrolls. */
export function scrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const max = scrollHeight - clientHeight
  if (max <= 0) return 0
  return Math.min(1, Math.max(0, scrollTop / max))
}

export function ratioToScrollTop(ratio: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, scrollHeight - clientHeight)
  return Math.min(1, Math.max(0, ratio)) * max
}

// ── Divider (rule 4) ─────────────────────────────────────────────────────────

export const SPLIT_DEFAULT = 50
export const SPLIT_MIN_PANE_PX = 240
export const SPLIT_STEP = 5
export const SPLIT_RATIO_KEY = 'md-review-split-ratio'
export const SPLIT_SYNC_KEY = 'md-review-split-sync'

/** Editor-share bounds in percent for a container `width` px wide (both panes ≥ minPane). */
export function splitBounds(width: number, minPane = SPLIT_MIN_PANE_PX): { min: number; max: number } {
  if (!(width > 0) || width < 2 * minPane) return { min: SPLIT_DEFAULT, max: SPLIT_DEFAULT }
  const min = (minPane / width) * 100
  return { min, max: 100 - min }
}

export function clampSplit(ratio: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, ratio))
}

/** The stored reader preference; invalid or missing → 50. */
export function parseSplitRatio(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === '') return SPLIT_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n < 100 ? n : SPLIT_DEFAULT
}

/** Keyboard on the separator: ←/→ move 5 points, Home/End jump to the bounds; null = not handled. */
export function stepSplit(ratio: number, key: string, bounds: { min: number; max: number }): number | null {
  switch (key) {
    case 'ArrowLeft': return clampSplit(ratio - SPLIT_STEP, bounds)
    case 'ArrowRight': return clampSplit(ratio + SPLIT_STEP, bounds)
    case 'Home': return bounds.min
    case 'End': return bounds.max
    default: return null
  }
}

/** Rule 11: `"0"` is off; anything else (incl. missing) is on. */
export function parseSyncPref(raw: string | null | undefined): boolean {
  return raw !== '0'
}

export function readPref(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

export function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* storage blocked: the preference just isn't kept */ }
}
