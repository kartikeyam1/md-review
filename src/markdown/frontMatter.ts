// YAML front matter (spec #5 rules 17, 20). A leading `---` … `---` block is
// shown as a key/value table and is never parsed as markdown. Line numbers
// stay absolute: the body is rendered with the front-matter lines blanked, so
// every body block keeps the line it has in the full source.
import { TABLE_SCROLL_OPEN, TABLE_SCROLL_CLOSE } from './tableScroll'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export interface FrontMatter {
  /** `key: value` rows, in order (lines without a colon are skipped). */
  rows: { key: string; value: string }[]
  /** Number of source lines the block spans (the body starts on this line). */
  endLine: number
  /** The source after the block. */
  body: string
}

/** The leading front-matter block of `source`, or null when there is none (or it has no rows). */
export function parseFrontMatter(source: string): FrontMatter | null {
  const match = source.match(FRONTMATTER_RE)
  if (!match) return null
  const rows = match[1]!
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf(':')
      if (idx === -1) return null
      return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() }
    })
    .filter((r): r is { key: string; value: string } => r !== null)
  if (!rows.length) return null
  return { rows, endLine: match[0].split('\n').length - 1, body: source.slice(match[0].length) }
}

/** The front-matter `title:` with one pair of surrounding quotes stripped; '' when absent/empty. */
export function frontMatterTitle(fm: FrontMatter | null): string {
  const raw = fm?.rows.find((r) => r.key === 'title')?.value ?? ''
  const m = raw.match(/^(["'])([\s\S]*)\1$/)
  return (m ? m[2]! : raw).trim()
}

/** The body with the front-matter lines blanked out, so its line numbers are those of the full source. */
export function bodyWithAbsoluteLines(fm: FrontMatter): string {
  return '\n'.repeat(fm.endLine) + fm.body
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The front-matter table (lines 0..endLine), wrapped like every other table. */
export function frontMatterTable(fm: FrontMatter): string {
  const trs = fm.rows.map((r) => `<tr><td>${escape(r.key)}</td><td>${escape(r.value)}</td></tr>`).join('\n')
  return `${TABLE_SCROLL_OPEN}<table class="frontmatter" data-line-start="0" data-line-end="${fm.endLine}">
<thead><tr><th>Field</th><th>Value</th></tr></thead>
<tbody>\n${trs}\n</tbody></table>${TABLE_SCROLL_CLOSE}\n`
}
