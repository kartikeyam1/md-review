import type MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import { plainText } from './plainText'
import { parseFrontMatter, bodyWithAbsoluteLines } from './frontMatter'
import { useMarkdown } from '@/composables/useMarkdown'

// Heading ids (spec #3 rules 1–7) and the TOC built from them (rules 8–9).
// Every markdown heading token — any level, inside blockquotes/lists too — gets
// a GitHub-compatible id from its token plain text; raw-HTML headings are not
// touched. Ids are assigned over the whole source in order, so they are the
// same on every render, poll and reload.

export interface HeadingInfo {
  level: number
  id: string
  /** Rule-2 plain text (token-derived, never DOM text). */
  text: string
}

export interface TocEntry extends HeadingInfo {
  /** level − the shallowest listed level: 0..2. */
  depth: number
}

/** Not a letter, mark, number, connector punctuation (`_`), hyphen or space. */
const STRIP_RE = /[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu

/** Rules 3–4: github-slugger v2 `slug()`; an empty result becomes `section`. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(STRIP_RE, '').replace(/ /g, '-') || 'section'
}

/** Rule 5: slugify each text; a taken id gets the first `-1`, `-2`, … not used by an earlier id. */
export function assignIds(texts: string[]): string[] {
  const used = new Set<string>()
  return texts.map((text) => {
    const base = slugify(text)
    let id = base
    for (let n = 1; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    return id
  })
}

/**
 * markdown-it plugin: sets `id` on every heading_open and lists the headings in
 * env.headings. Ids are slugged from the text *before* typographer replacements
 * (`foo--bar` stays `foo--bar`, `(c)` stays `c`, as on GitHub); the listed text
 * is the rendered one (after them), so the TOC reads like the headings.
 */
export function headingIds(md: MarkdownIt) {
  md.core.ruler.before('replacements', 'heading_ids', (state: StateCore) => {
    const opens = state.tokens.flatMap((token, i) =>
      token.type === 'heading_open' ? [{ token, text: plainText(state.tokens[i + 1]?.children) }] : [])
    const ids = assignIds(opens.map((o) => o.text))
    opens.forEach((o, i) => o.token.attrSet('id', ids[i]!))
  })
  md.core.ruler.push('heading_list', (state: StateCore) => {
    if (!state.env || typeof state.env !== 'object') return
    const headings: HeadingInfo[] = []
    state.tokens.forEach((token, i) => {
      if (token.type !== 'heading_open') return
      headings.push({ level: Number(token.tag.slice(1)), id: token.attrGet('id') ?? '', text: plainText(state.tokens[i + 1]?.children) })
    })
    ;(state.env as { headings?: HeadingInfo[] }).headings = headings
  })
}

let parser: MarkdownIt | null = null

/**
 * Every markdown heading of `source` that `view` shows (#28: the human view,
 * by default, leaves out headings inside agent-only sections), with the id the
 * preview renders and its plain text.
 */
export function extractHeadings(source: string, view: 'human' | 'agent' = 'human'): HeadingInfo[] {
  // The preview's own parser (same plugins), so ids and text can never drift from the render.
  parser ??= useMarkdown().md
  const fm = parseFrontMatter(source)
  const env: { headings?: HeadingInfo[]; agentView?: 'human' | 'agent' } = { agentView: view }
  parser.parse(fm ? bodyWithAbsoluteLines(fm) : source, env)
  return env.headings ?? []
}

/**
 * Rules 8–9: levels 1–3 in order; a lone H1 that is the first heading is the
 * title and is left out; depth is relative to the shallowest listed level.
 * Fewer than 2 entries → [] (no TOC).
 */
export function buildToc(headings: HeadingInfo[]): TocEntry[] {
  const h1s = headings.filter((h) => h.level === 1)
  const dropTitle = h1s.length === 1 && headings[0]?.level === 1
  const listed = headings.filter((h, i) => h.level <= 3 && !(dropTitle && i === 0))
  if (listed.length < 2) return []
  const top = Math.min(...listed.map((h) => h.level))
  return listed.map((h) => ({ ...h, depth: h.level - top }))
}
