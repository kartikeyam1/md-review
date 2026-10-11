import type Token from 'markdown-it/lib/token.mjs'
import { useMarkdown } from '@/composables/useMarkdown'
import { parseFrontMatter, bodyWithAbsoluteLines } from '@/markdown/frontMatter'
import { plainText } from '@/markdown/plainText'
import { findNotesSections } from '@shared/agentSections.mjs'
import { highlightRevision } from '@/markdown/highlight'

// Slides (spec #29 rules 2–5, 12): the doc split into slides on the #28 human
// view token stream — the same parse as the read view, so heading ids, code
// highlighting, callouts and tables are identical. Loaded with SlidesView only.
//
//   • a new slide at every top-level H1, H2 (ATX or setext) and thematic break;
//     H3–H6 and anything nested in lists/blockquotes never split; the `hr` is
//     not rendered;
//   • content before the first boundary is the first slide; slides with nothing
//     visible are dropped (so `---` right before `## X` adds no blank slide);
//   • an H1 starts a title slide; agent-only sections never appear;
//   • `<!-- notes -->…<!-- /notes -->` (same grammar as #28) is lifted off the
//     canvas into the slide's speaker notes; front matter is not shown.

export interface Slide {
  kind: 'title' | 'content'
  /** First source line of the slide (0-based, full source). */
  startLine: number
  /** The id of the heading that starts the slide, if any. */
  headingId: string | null
  /** Plain text of that heading ('' if none). */
  headingText: string
  /** Every heading id on the slide (deep links, rule 12). */
  headingIds: string[]
  html: string
  /** Speaker notes rendered as markdown ('' when the slide has none). */
  notesHtml: string
}

let shared: ReturnType<typeof useMarkdown> | null = null
const markdown = () => (shared ??= useMarkdown())

/** A top-level token that shows nothing: a break, or an HTML block holding only comments/whitespace. */
function invisible(t: Token): boolean {
  if (t.type === 'hr') return true
  if (t.type === 'html_block') return t.content.replace(/<!--[\s\S]*?-->/g, '').trim() === ''
  return false
}

interface Draft { tokens: Token[]; notes: Token[]; start: number; head: Token | null; headInline: Token | null }

export function splitSlides(source: string): Slide[] {
  const { md } = markdown()
  // A computed split re-runs when a lazy highlight.js language arrives (like the read view's render).
  void highlightRevision.value
  const fm = parseFrontMatter(source)
  const body = fm ? bodyWithAbsoluteLines(fm) : source
  const env = { agentView: 'human' as const }
  const tokens = md.parse(body, env)
  const notes = findNotesSections(body)
  const inNotes = (line: number) => notes.some((n) => line >= n.start && line <= n.end)

  // Group top-level blocks (an open token through its matching close, or one leaf).
  const blocks: Token[][] = []
  for (let i = 0; i < tokens.length;) {
    const t = tokens[i]!
    let j = i
    if (t.nesting === 1) {
      let depth = 0
      for (; j < tokens.length; j++) {
        depth += tokens[j]!.nesting
        if (depth === 0) break
      }
    }
    blocks.push(tokens.slice(i, j + 1))
    i = j + 1
  }

  const drafts: Draft[] = []
  let cur: Draft = { tokens: [], notes: [], start: fm ? fm.endLine : 0, head: null, headInline: null }
  const flush = () => { drafts.push(cur) }
  for (const block of blocks) {
    const first = block[0]!
    const line = first.map?.[0] ?? cur.start
    if (first.map && inNotes(line)) {
      // Notes markers (comment blocks) and the lines between them.
      if (!invisible(first)) cur.notes.push(...block)
      continue
    }
    const isHeading = first.type === 'heading_open' && (first.tag === 'h1' || first.tag === 'h2')
    if (isHeading || first.type === 'hr') {
      flush()
      cur = { tokens: [], notes: [], start: line, head: null, headInline: null }
      if (first.type === 'hr') continue
      cur.head = first
      cur.headInline = block[1] ?? null
    }
    cur.tokens.push(...block)
  }
  flush()

  const slides: Slide[] = []
  for (const d of drafts) {
    if (!d.tokens.some((t) => t.level === 0 && !invisible(t))) continue
    const ids = d.tokens.filter((t) => t.type === 'heading_open').map((t) => t.attrGet('id') ?? '').filter(Boolean)
    slides.push({
      kind: d.head?.tag === 'h1' ? 'title' : 'content',
      startLine: d.start,
      headingId: d.head?.attrGet('id') ?? null,
      headingText: d.headInline ? plainText(d.headInline.children) : '',
      headingIds: ids,
      html: md.renderer.render(d.tokens, md.options, env),
      notesHtml: d.notes.length ? md.renderer.render(d.notes, md.options, env) : '',
    })
  }
  // Rule 3 / AC-29.18: an empty doc is still one (empty) slide.
  if (!slides.length) {
    slides.push({ kind: 'content', startLine: 0, headingId: null, headingText: '', headingIds: [], html: '', notesHtml: '' })
  }
  return slides
}

/** Rule 12: index of the slide holding heading `id`, or -1. */
export function slideForHeading(slides: readonly Slide[], id: string): number {
  return slides.findIndex((s) => s.headingIds.includes(id))
}

/** Rule 12: the 1-based slide from `?slide=` — missing/invalid/non-integer → 1, out of range → clamped. */
export function clampSlide(raw: string | null, total: number): number {
  if (raw === null || !/^-?\d+$/.test(raw.trim())) return 1
  const n = Number(raw)
  return Math.min(Math.max(1, n), Math.max(1, total))
}
