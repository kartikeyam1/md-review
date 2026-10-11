/**
 * Pure table functions for #11 (no CodeMirror): parse a TSV/CSV clipboard,
 * turn it into an aligned GFM table, and re-align an existing GFM table.
 * Re-exported by `tablePaste.ts`, the editor extension.
 */

export type Delimiter = '\t' | ','
type Align = 'none' | 'left' | 'right' | 'center'

/** Rule 5: column width bounds. */
const MIN_WIDTH = 3
const MAX_WIDTH = 40

/** Rule 6: a numeric body cell. */
const NUMERIC_RE = /^[-+]?[$€£₹]?\d[\d,]*(\.\d+)?%?$/
/** Rule 3: a CSV record may not start like a markdown block. */
const BLOCK_MARKER_RE = /^(#|>|- |\* |\+ |\||`|\d+\. )/
/** Rule 12: a GFM delimiter row. */
export const DELIMITER_ROW_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const cpLen = (s: string) => [...s].length

function pad(s: string, width: number, align: Align): string {
  const gap = width - cpLen(s)
  if (gap <= 0) return s
  if (align === 'right') return ' '.repeat(gap) + s
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + s + ' '.repeat(gap - left)
  }
  return s + ' '.repeat(gap)
}

function delimiterCell(width: number, align: Align): string {
  switch (align) {
    case 'left': return ':' + '-'.repeat(width - 1)
    case 'right': return '-'.repeat(width - 1) + ':'
    case 'center': return ':' + '-'.repeat(width - 2) + ':'
    default: return '-'.repeat(width)
  }
}

const row = (cells: string[]) => `| ${cells.join(' | ')} |`

/**
 * Rule 2: records and fields, RFC 4180 quoting (a field wrapped in `"` may hold
 * the delimiter, newlines and `""`). One trailing newline is dropped and
 * `\r\n` normalised. Null when a quoted field is never closed.
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] | null {
  let s = text.replace(/\r\n?/g, '\n')
  if (s.endsWith('\n')) s = s.slice(0, -1)
  const records: string[][] = []
  let fields: string[] = []
  let i = 0
  for (;;) {
    let field = ''
    if (s[i] === '"') {
      i++
      for (;;) {
        if (i >= s.length) return null
        if (s[i] === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue }
          i++
          break
        }
        field += s[i++]
      }
      // Anything after the closing quote up to the delimiter is kept (lenient).
      while (i < s.length && s[i] !== delimiter && s[i] !== '\n') field += s[i++]
    } else {
      while (i < s.length && s[i] !== delimiter && s[i] !== '\n') field += s[i++]
    }
    fields.push(field)
    if (i >= s.length) { records.push(fields); return records }
    if (s[i] === '\n') { records.push(fields); fields = [] }
    i++
  }
}

const rectangular = (rows: string[][] | null): rows is string[][] =>
  !!rows && rows.length >= 2 && rows[0]!.length >= 2 && rows.every((r) => r.length === rows[0]!.length)

/** Rule 3: TSV, else (harder gated) CSV, else null. */
export function detectTable(text: string): { rows: string[][]; delimiter: Delimiter } | null {
  if (text.includes('\t')) {
    const rows = parseDelimited(text, '\t')
    if (rectangular(rows)) return { rows, delimiter: '\t' }
  }
  if (text.includes(',')) {
    const rows = parseDelimited(text, ',')
    if (rectangular(rows) && (rows[0]!.length >= 3 || rows.length >= 3)
      && !rows.some((r) => BLOCK_MARKER_RE.test(r[0]!.trimStart()))) {
      return { rows, delimiter: ',' }
    }
  }
  return null
}

/** Rule 4: trim, escape unescaped pipes, newlines → `<br>`. */
function escapeCell(cell: string): string {
  const t = cell.trim()
  let out = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!
    if (c === '|' && t[i - 1] !== '\\') out += '\\|'
    else if (c === '\n') out += '<br>'
    else out += c
  }
  return out
}

const widthOf = (cells: string[]) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ...cells.map(cpLen)))

/** Rules 4–7: a column-aligned GFM table (first record = header), no trailing newline. */
export function toMarkdownTable(rows: string[][]): string {
  const cells = rows.map((r) => r.map(escapeCell))
  const cols = Math.max(...cells.map((r) => r.length))
  for (const r of cells) while (r.length < cols) r.push('')
  const widths: number[] = []
  const aligns: Align[] = []
  for (let c = 0; c < cols; c++) {
    const column = cells.map((r) => r[c]!)
    widths.push(widthOf(column))
    const body = column.slice(1).filter((x) => x !== '')
    aligns.push(body.length && body.every((x) => NUMERIC_RE.test(x)) ? 'right' : 'none')
  }
  const lines = cells.map((r) => row(r.map((x, c) => pad(x, widths[c]!, aligns[c]!))))
  lines.splice(1, 0, row(widths.map((w, c) => delimiterCell(w, aligns[c]!))))
  return lines.join('\n')
}

/** Split a GFM row into trimmed cells on unescaped `|` (rule 13). Also returns where each cell starts in the line. */
export function splitRow(line: string): { indent: string; cells: string[]; starts: number[] } {
  const indent = /^\s*/.exec(line)![0]
  let i = indent.length
  if (line[i] === '|') i++
  let end = line.length
  while (end > i && /\s/.test(line[end - 1]!)) end--
  if (end > i && line[end - 1] === '|' && line[end - 2] !== '\\') end--
  const cells: string[] = []
  const starts: number[] = []
  let start = i
  for (let j = i; j <= end; j++) {
    if (j === end || (line[j] === '|' && line[j - 1] !== '\\')) {
      cells.push(line.slice(start, j).trim())
      starts.push(start)
      start = j + 1
    }
  }
  return { indent, cells, starts }
}

function alignOf(marker: string): Align {
  const m = marker.trim()
  const l = m.startsWith(':')
  const r = m.endsWith(':') && m.length > 1
  return l && r ? 'center' : l ? 'left' : r ? 'right' : 'none'
}

/**
 * Rules 12–13: re-align a GFM table (lines[1] is its delimiter row). Returns the
 * new lines and, per row, the offset in the new line where each cell's content starts.
 */
export function formatTableLines(lines: string[]): { lines: string[]; contentStarts: number[][] } {
  const parsed = lines.map(splitRow)
  const indent = parsed[0]!.indent
  const cols = Math.max(...parsed.map((p) => p.cells.length))
  const grid = parsed.map((p) => [...p.cells, ...Array<string>(cols - p.cells.length).fill('')])
  const aligns = grid[1]!.map((m) => (m ? alignOf(m) : 'none'))
  const widths: number[] = []
  for (let c = 0; c < cols; c++) widths.push(widthOf(grid.filter((_, r) => r !== 1).map((g) => g[c]!)))
  const out: string[] = []
  const contentStarts: number[][] = []
  grid.forEach((g, r) => {
    const cells = r === 1 ? widths.map((w, c) => delimiterCell(w, aligns[c]!)) : g.map((x, c) => pad(x, widths[c]!, aligns[c]!))
    const starts: number[] = []
    let at = indent.length + 2 // after "| "
    cells.forEach((cell, c) => {
      // Padding is ASCII spaces, so its UTF-16 length is its character count.
      const lead = r === 1 || !g[c] ? 0 : cell.length - cell.trimStart().length
      starts.push(at + lead)
      at += cell.length + 3 // " | "
    })
    out.push(indent + row(cells))
    contentStarts.push(starts)
  })
  return { lines: out, contentStarts }
}

/** Rules 12–13 as one string (lines joined with `\n`). */
export function formatMarkdownTable(lines: string[]): string {
  return formatTableLines(lines).lines.join('\n')
}
