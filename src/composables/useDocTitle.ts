import MarkdownIt from 'markdown-it'
import { parseFrontMatter, frontMatterTitle, bodyWithAbsoluteLines } from '@/markdown/frontMatter'
import { plainText } from '@/markdown/plainText'

// ── docTitle (00 §5; FE owner #5) ────────────────────────────────────────────
// The one title rule for a doc — the tab, the reader header's doc-title, and
// later #19/#26/#27 — the first non-empty of:
//   1. sessionName
//   2. markdown front-matter `title:` (quotes stripped) | HTML <title>
//   3. plain text of the first H1 (#3 rule 2) | HTML first <h1>
//   4. filename without .md/.markdown/.txt/.html/.htm
//   5. 'Untitled'
// Whitespace collapsed; not truncated (consumers truncate, see truncateTitle).

export interface DocTitleInput {
  sessionName?: string | null
  content?: string | null
  /** The app's ContentType; absent means markdown. */
  contentType?: string | null
  filename?: string | null
}

export const APP_NAME = 'md-review'
export const TITLE_MAX = 80

const collapse = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

// Block structure only matters here (which line is the first H1); the inline
// rules match the preview's so link text / entities read the same.
let parser: MarkdownIt | null = null
function titleParser(): MarkdownIt {
  parser ??= new MarkdownIt({ html: true, linkify: true, typographer: true })
  return parser
}

/** Markdown: [front-matter title, first H1 plain text]. */
function markdownTitles(source: string): [string, string] {
  const fm = parseFrontMatter(source)
  const tokens = titleParser().parse(fm ? bodyWithAbsoluteLines(fm) : source, {})
  let h1 = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.type === 'heading_open' && t.tag === 'h1') {
      h1 = plainText(tokens[i + 1]?.children)
      if (collapse(h1)) break
    }
  }
  return [frontMatterTitle(fm), h1]
}

/** HTML: [<title>, first <h1>] — parsed inert with DOMParser (no scripts, no loads). */
function htmlTitles(source: string): [string, string] {
  if (typeof DOMParser === 'undefined') return ['', '']
  const d = new DOMParser().parseFromString(source, 'text/html')
  // `head > title` skips an SVG <title> in the body; a commented-out one is no element.
  return [d.querySelector('head > title')?.textContent ?? '', d.querySelector('h1')?.textContent ?? '']
}

const FILE_EXT_RE = /\.(md|markdown|txt|html|htm)$/i

export function docTitle(input: DocTitleInput): string {
  const session = collapse(input.sessionName)
  if (session) return session
  const content = input.content ?? ''
  if (content) {
    const [explicit, heading] = input.contentType === 'html' ? htmlTitles(content) : markdownTitles(content)
    const t = collapse(explicit) || collapse(heading)
    if (t) return t
  }
  return collapse((input.filename ?? '').trim().replace(FILE_EXT_RE, '')) || 'Untitled'
}

/** Longer than `max` characters → the first `max` + '…' (code points, so an emoji is never split). */
export function truncateTitle(title: string, max = TITLE_MAX): string {
  const chars = Array.from(title)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : title
}

/** The tab title of an open doc: `<docTitle, truncated> · md-review`. */
export function formatDocumentTitle(title: string): string {
  return `${truncateTitle(title)} · ${APP_NAME}`
}
