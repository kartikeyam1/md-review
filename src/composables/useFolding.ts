// Fold-by-heading (spec #17): the pure section/level/key logic plus the
// per-doc persistence. The DOM side is src/preview/folding.ts; TocPanel reads
// `foldUi` to show and drive Collapse all / Expand all.

export const FOLD_KEY_PREFIX = 'md-review-fold:'

export interface FoldSection {
  /** Index of the heading among the top-level blocks. */
  index: number
  level: number
  /** Exclusive end: the next heading of level ≤ `level`, or the block count. */
  end: number
}

/**
 * Rules 3–4. `levels[i]` = heading level of the i-th top-level block (null =
 * not a heading). One section per H1–H4 with at least one block before the
 * next heading of the same or a higher level.
 */
export function foldSections(levels: Array<number | null>): FoldSection[] {
  const out: FoldSection[] = []
  // Stack of open headings: each closes at the next heading of level ≤ its own.
  const open: { index: number; level: number }[] = []
  const close = (at: number, level: number) => {
    while (open.length && open[open.length - 1]!.level >= level) {
      const h = open.pop()!
      if (h.level <= 4 && at > h.index + 1) out.push({ index: h.index, level: h.level, end: at })
    }
  }
  levels.forEach((level, i) => {
    if (level === null) return
    close(i, level)
    open.push({ index: i, level })
  })
  close(levels.length, 0)
  return out.sort((a, b) => a.index - b.index)
}

/** Rule 9: the smallest level occurring ≥ 2 times among foldable headings, else the smallest present. */
export function collapseAllLevel(levels: number[]): number | null {
  if (!levels.length) return null
  const counts = new Map<number, number>()
  for (const l of levels) counts.set(l, (counts.get(l) ?? 0) + 1)
  const repeated = [...counts].filter(([, n]) => n >= 2).map(([l]) => l)
  return Math.min(...(repeated.length ? repeated : levels))
}

/** Rule 11: backend id (pinned revisions share it), `<id>/<file>` for a file route, `local:<filename>` otherwise. */
export function foldDocKey(o: { pasteId: string | null; route: { kind: string; file?: string }; filename: string }): string {
  if (!o.pasteId) return `local:${o.filename}`
  return o.route.kind === 'file' && o.route.file ? `${o.pasteId}/${o.route.file}` : o.pasteId
}

export function readFolds(docKey: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLD_KEY_PREFIX + docKey) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function writeFolds(docKey: string, ids: string[]) {
  try { localStorage.setItem(FOLD_KEY_PREFIX + docKey, JSON.stringify(ids)) } catch { /* folds just don't persist */ }
}

// The TOC ↔ preview bridge lives in its own tiny module (TocPanel is in the entry chunk,
// the folding enhancer is lazy); re-exported here for callers of this module.
export { foldUi, type FoldController } from './foldUi'
