/**
 * Line diff for the revision viewer. Built on jsdiff (loaded on demand so the
 * main bundle does not carry it). Consecutive removed/added blocks of equal
 * length are paired line by line and given word-level segments so a one-word
 * change in a paragraph is visible without reading the whole line.
 */
export type DiffRowType = 'context' | 'add' | 'del' | 'skip'

export interface DiffSegment { text: string; changed: boolean }

export interface DiffRow {
  type: DiffRowType
  oldNo: number | null
  newNo: number | null
  text: string
  /** Word-level segments for paired changed lines. */
  segments?: DiffSegment[]
  /** For 'skip' rows: the unchanged rows that were folded away. */
  hidden?: DiffRow[]
}

export interface DiffStats { added: number; removed: number }

const MAX_PAIRED_LINES = 200
const MAX_WORD_DIFF_CHARS = 4000

function splitLines(value: string): string[] {
  return value.replace(/\n$/, '').split('\n')
}

export async function buildLineDiff(
  oldText: string,
  newText: string,
  opts: { context?: number } = {},
): Promise<{ rows: DiffRow[]; stats: DiffStats }> {
  const context = opts.context ?? 3
  const { diffLines, diffWordsWithSpace } = await import('diff')
  const parts = diffLines(oldText, newText)

  const rows: DiffRow[] = []
  let oldNo = 1
  let newNo = 1
  const stats: DiffStats = { added: 0, removed: 0 }

  const wordSegments = (a: string, b: string): [DiffSegment[], DiffSegment[]] | null => {
    if (a.length + b.length > MAX_WORD_DIFF_CHARS) return null
    const wp = diffWordsWithSpace(a, b)
    const del: DiffSegment[] = []
    const add: DiffSegment[] = []
    for (const w of wp) {
      if (w.added) add.push({ text: w.value, changed: true })
      else if (w.removed) del.push({ text: w.value, changed: true })
      else { del.push({ text: w.value, changed: false }); add.push({ text: w.value, changed: false }) }
    }
    return [del, add]
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part.added && !part.removed) {
      for (const line of splitLines(part.value)) {
        rows.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: line })
      }
      continue
    }
    if (part.removed) {
      const removedLines = splitLines(part.value)
      const next = parts[i + 1]
      if (next && next.added) {
        const addedLines = splitLines(next.value)
        const paired = removedLines.length === addedLines.length && removedLines.length <= MAX_PAIRED_LINES
        const delRows: DiffRow[] = removedLines.map(line => ({ type: 'del', oldNo: oldNo++, newNo: null, text: line }))
        const addRows: DiffRow[] = addedLines.map(line => ({ type: 'add', oldNo: null, newNo: newNo++, text: line }))
        if (paired) {
          for (let k = 0; k < delRows.length; k++) {
            const seg = wordSegments(delRows[k].text, addRows[k].text)
            if (seg) { delRows[k].segments = seg[0]; addRows[k].segments = seg[1] }
          }
        }
        rows.push(...delRows, ...addRows)
        stats.removed += delRows.length
        stats.added += addRows.length
        i++ // consumed the added part
      } else {
        for (const line of removedLines) rows.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line })
        stats.removed += removedLines.length
      }
      continue
    }
    // added only
    const addedLines = splitLines(part.value)
    for (const line of addedLines) rows.push({ type: 'add', oldNo: null, newNo: newNo++, text: line })
    stats.added += addedLines.length
  }

  return { rows: collapseContext(rows, context), stats }
}

/** Fold unchanged runs longer than 2*context+1 into a single expandable 'skip' row. */
export function collapseContext(rows: DiffRow[], context: number): DiffRow[] {
  const out: DiffRow[] = []
  let run: DiffRow[] = []
  const isFirstRun = () => out.length === 0

  const flush = (atEnd: boolean) => {
    if (run.length === 0) return
    const keepBefore = isFirstRun() ? 0 : context // nothing to lead into at the very start
    const keepAfter = atEnd ? 0 : context
    if (run.length <= keepBefore + keepAfter + 1) {
      out.push(...run)
    } else {
      out.push(...run.slice(0, keepBefore))
      const hidden = run.slice(keepBefore, run.length - keepAfter)
      out.push({ type: 'skip', oldNo: null, newNo: null, text: '', hidden })
      if (keepAfter) out.push(...run.slice(run.length - keepAfter))
    }
    run = []
  }

  for (const row of rows) {
    if (row.type === 'context') { run.push(row); continue }
    flush(false)
    out.push(row)
  }
  flush(true)
  return out
}
