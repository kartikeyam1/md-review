import type MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'

// Spec #16 rules 1–9: GitHub alerts. A blockquote whose first line is
// `[!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` (case-insensitive) becomes
//   <div class="markdown-alert markdown-alert-<type> callout" data-callout data-testid="callout" role="note" data-line-*>
//     <p class="markdown-alert-title" data-testid="callout-title"><svg class="octicon" aria-hidden="true">…</svg>Title</p>
//     …body…
//   </div>
// GitHub's classes, so github-markdown-css styles the GitHub themes; `callout`
// for ours. The wrapper keeps the blockquote's line range (it replaces that
// token, 00 §4.4); the title has none; body blocks keep their own ranges.
// Text after the marker is a custom title (inline markdown allowed).

export const CALLOUT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type CalloutType = (typeof CALLOUT_TYPES)[number]

const MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i

// The icon is an empty <svg class="octicon octicon-…"> painted by a CSS mask of
// GitHub's octicon (info, light-bulb, report, alert, stop) in currentColor —
// src/styles/preview.css. The path data lives in CSS, not in the entry JS (#6 budget).
const ICON_NAMES: Record<CalloutType, string> = { note: 'info', tip: 'light-bulb', important: 'report', warning: 'alert', caution: 'stop' }
const icon = (type: CalloutType) =>
  `<svg class="octicon octicon-${ICON_NAMES[type]}" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"></svg>`

const TITLES: Record<CalloutType, string> = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }

/** The blockquote_close matching the blockquote_open at `open`. */
function closeOf(tokens: Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.type === 'blockquote_open') depth++
    else if (t.type === 'blockquote_close' && --depth === 0) return i
  }
  return -1
}

function inlineToken(state: StateCore, content: string, level: number): Token {
  const t = new state.Token('inline', '', 0)
  t.content = content
  t.level = level
  t.children = []
  state.md.inline.parse(content, state.md, state.env, t.children)
  return t
}

function calloutRule(state: StateCore) {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i]!
    if (open.type !== 'blockquote_open') continue
    // The marker must be on the blockquote's first line: its first child is a paragraph starting with it.
    const pOpen = tokens[i + 1]
    const inline = tokens[i + 2]
    if (pOpen?.type !== 'paragraph_open' || inline?.type !== 'inline') continue
    if (open.map && pOpen.map && pOpen.map[0] !== open.map[0]) continue
    const nl = inline.content.indexOf('\n')
    const first = nl === -1 ? inline.content : inline.content.slice(0, nl)
    const m = MARKER_RE.exec(first)
    if (!m) continue
    const close = closeOf(tokens, i)
    if (close === -1) continue
    const type = m[1]!.toLowerCase() as CalloutType
    const custom = m[2]!.trim()

    open.tag = 'div'
    open.attrJoin('class', `markdown-alert markdown-alert-${type} callout`)
    open.attrSet('data-callout', type)
    open.attrSet('data-testid', 'callout')
    open.attrSet('role', 'note')
    tokens[close]!.tag = 'div'

    // Title paragraph (no line range of its own): icon + custom or default title.
    const level = pOpen.level
    const tOpen = new state.Token('paragraph_open', 'p', 1)
    tOpen.block = true
    tOpen.level = level
    tOpen.attrSet('class', 'markdown-alert-title')
    tOpen.attrSet('data-testid', 'callout-title')
    const tInline = inlineToken(state, custom || TITLES[type], level + 1)
    const iconToken = new state.Token('html_inline', '', 0)
    iconToken.content = icon(type)
    tInline.children!.unshift(iconToken)
    const tClose = new state.Token('paragraph_close', 'p', -1)
    tClose.block = true
    tClose.level = level

    const rest = nl === -1 ? '' : inline.content.slice(nl + 1)
    if (rest.trim()) {
      // The body keeps the paragraph, minus its first (marker) line.
      inline.content = rest
      inline.children = []
      state.md.inline.parse(rest, state.md, state.env, inline.children)
      if (pOpen.map) pOpen.map = [pOpen.map[0] + 1, pOpen.map[1]]
      if (inline.map) inline.map = [inline.map[0] + 1, inline.map[1]]
      tokens.splice(i + 1, 0, tOpen, tInline, tClose)
    } else {
      tokens.splice(i + 1, 3, tOpen, tInline, tClose)
    }
  }
}

export function alerts(md: MarkdownIt) {
  // After inline parsing (the marker check reads the paragraph's source) and
  // before linkify/typographer, so the rebuilt title/body get them too.
  md.core.ruler.after('inline', 'callouts', calloutRule)
}
