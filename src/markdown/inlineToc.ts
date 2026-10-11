import type MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'
import { plainText } from './plainText'

// Spec #12 rule 18: a paragraph that is exactly `[[toc]]` (any case, surrounding
// whitespace allowed) renders an inline table of contents of the doc's H2 and
// H3 headings, H3s nested under the H2 before them. Ids are #3's (set by
// headingIds before this rule runs); link text is #3 rule-2 plain text after
// typographer replacements, like the TOC rail. `[[toc]]` in code or inside a
// longer paragraph is not a paragraph of its own and stays literal. The nav
// replaces the paragraph, so it keeps that paragraph's source line range.

const TOC_RE = /^\s*\[\[toc\]\]\s*$/i

interface Entry { level: 2 | 3; id: string; text: string }

function collect(tokens: Token[]): Entry[] {
  const out: Entry[] = []
  tokens.forEach((t, i) => {
    if (t.type !== 'heading_open' || (t.tag !== 'h2' && t.tag !== 'h3')) return
    out.push({ level: t.tag === 'h2' ? 2 : 3, id: t.attrGet('id') ?? '', text: plainText(tokens[i + 1]?.children) })
  })
  return out
}

function renderList(entries: Entry[], esc: (s: string) => string): string {
  if (!entries.length) return '<p class="inline-toc-empty">No headings yet</p>'
  const link = (e: Entry) => `<a href="#${esc(encodeURIComponent(e.id))}" data-testid="inline-toc-link">${esc(e.text)}</a>`
  let html = '<ul>'
  let sub = false // an H3 list is open inside the current H2 item
  let item = false // an <li> is open
  for (const e of entries) {
    if (e.level === 3 && item && !sub) { html += '<ul>'; sub = true }
    if (e.level === 3 && sub) { html += `<li>${link(e)}</li>`; continue }
    if (sub) { html += '</ul>'; sub = false }
    if (item) html += '</li>'
    html += `<li>${link(e)}`
    // An H3 before any H2 is a top-level entry of its own; H3s never open a sublist under it.
    item = e.level === 2
    if (!item) html += '</li>'
  }
  if (sub) html += '</ul>'
  if (item) html += '</li>'
  return html + '</ul>'
}

export function inlineToc(md: MarkdownIt) {
  md.core.ruler.push('inline_toc', (state: StateCore) => {
    const tokens = state.tokens
    let entries: Entry[] | null = null
    for (let i = 0; i + 2 < tokens.length; i++) {
      const [open, inline, close] = [tokens[i]!, tokens[i + 1]!, tokens[i + 2]!]
      if (open.type !== 'paragraph_open' || inline.type !== 'inline' || close.type !== 'paragraph_close') continue
      if (!TOC_RE.test(inline.content)) continue
      entries ??= collect(tokens)
      const nav = new state.Token('inline_toc', 'nav', 0)
      nav.block = true
      nav.level = open.level
      nav.map = open.map
      nav.meta = { entries }
      tokens.splice(i, 3, nav)
    }
  })
  md.renderer.rules.inline_toc = (tokens, idx) => {
    const t = tokens[idx]!
    const lines = t.map ? ` data-line-start="${t.map[0]}" data-line-end="${t.map[1]}"` : ''
    const entries = (t.meta as { entries: Entry[] }).entries
    return `<nav class="inline-toc" data-testid="inline-toc" aria-label="Table of contents"${lines}>`
      + renderList(entries, md.utils.escapeHtml) + '</nav>\n'
  }
}
