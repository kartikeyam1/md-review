import type MarkdownIt from 'markdown-it'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'

// Spec #16 rules 10–15: the inline RAG badge `:rag-<green|amber|red>[label]`.
// The label is plain text up to the first unescaped `]` (≤ 80 chars, one
// line, HTML escaped, markdown not parsed); an empty label shows the colour
// name. Anything else stays literal source text. The token's child text is the
// visible label, so heading ids / TOC text / docTitle (all from token plain
// text, #3 rule 2) read "Status On track", never the syntax or the sr-only
// "Green: " prefix. This is the single definition used by #12 and #27.

export const RAG_COLOURS = ['green', 'amber', 'red'] as const
export type RagColour = (typeof RAG_COLOURS)[number]
export const RAG_LABEL_MAX = 80

const OPEN_RE = /^:rag-(green|amber|red)\[/i
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function ragRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x3a /* : */) return false
  const m = OPEN_RE.exec(state.src.slice(start, start + 12))
  if (!m) return false
  const colour = m[1]!.toLowerCase() as RagColour
  let pos = start + m[0].length
  let raw = ''
  for (;;) {
    if (pos >= state.posMax) return false
    const ch = state.src[pos]!
    if (ch === '\n') return false
    if (ch === '\\' && pos + 1 < state.posMax && state.src[pos + 1] !== '\n') {
      raw += ch + state.src[pos + 1]
      pos += 2
      continue
    }
    if (ch === ']') break
    raw += ch
    pos++
  }
  // Backslash escapes only: the label is plain text, so `&amp;` stays as typed.
  const label = raw.replace(/\\([!-/:-@[-`{-~])/g, '$1')
  if ([...label].length > RAG_LABEL_MAX) return false
  if (!silent) {
    const token = state.push('rag', 'span', 0)
    token.meta = { colour }
    token.markup = state.src.slice(start, pos + 1)
    const text = new state.Token('text', '', 0)
    text.content = label || cap(colour)
    token.children = [text]
    token.content = text.content
  }
  state.pos = pos + 1
  return true
}

export function rag(md: MarkdownIt) {
  md.inline.ruler.after('text', 'rag', ragRule)
  md.renderer.rules.rag = (tokens, idx) => {
    const t = tokens[idx]!
    const colour = (t.meta as { colour: RagColour }).colour
    // title: the full label stays readable when a long one is cut to the column width.
    return `<span class="rag rag-${colour}" data-rag="${colour}" data-testid="rag-badge" title="${md.utils.escapeHtml(t.content)}">`
      + '<span class="rag-dot" aria-hidden="true"></span>'
      + `<span class="sr-only">${cap(colour)}: </span><span class="rag-label">${md.utils.escapeHtml(t.content)}</span></span>`
  }
}
