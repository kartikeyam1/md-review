import type MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'
import { findAgentSections } from '@shared/agentSections.mjs'

// Agent-only sections (spec #28 rules 1–9). Which lines form a section is
// decided by shared/agentSections.mjs — the same scan the server strips with —
// and this core rule applies it to the full-source token stream:
//   human view (default): the sections' top-level blocks and their markers are
//     removed — no DOM at all, so find/copy/print/TOC/folds never see them;
//   agent view: each section is wrapped in <section class="agent-only"> with a
//     label chip, the markers dropped.
// It runs after heading ids are assigned (ids are computed over the whole
// document, so they never change between views) and before the heading list
// (TOC, docTitle), which then lists only what the view shows. Block tokens keep
// their full-source line maps (rule 8).

export type AgentView = 'human' | 'agent'

/** What the render env carries in and out (md.render(src, env)). */
export interface AgentEnv {
  /** In: which view to render (absent = human). */
  agentView?: AgentView
  /** Out: number of agent sections in the source. */
  agentSections?: number
  /** Out (human view): ids of the headings that were hidden. */
  hiddenIds?: string[]
  /** Out (human view): the hidden line ranges, inclusive. */
  hiddenRanges?: { start: number; end: number }[]
}

const LABEL = 'Agent-only'

export function agentSections(md: MarkdownIt) {
  md.core.ruler.before('heading_list', 'agent_sections', (state: StateCore) => {
    const env = (state.env && typeof state.env === 'object' ? state.env : {}) as AgentEnv
    const sections = findAgentSections(state.src)
    env.agentSections = sections.length
    env.hiddenIds = []
    env.hiddenRanges = []
    if (!sections.length) return
    const human = env.agentView !== 'agent'
    if (human) env.hiddenRanges = sections.map((s) => ({ start: s.start, end: s.end }))
    const markers = new Set<number>()
    for (const s of sections) {
      markers.add(s.start)
      if (s.closed) markers.add(s.end)
    }
    const sectionAt = (line: number) => sections.findIndex((s) => line >= s.start && line <= s.end)

    const out: Token[] = []
    /** Section of the current top-level block (-1 = none); deeper and close tokens inherit it. */
    let cur = -1
    /** Agent view: the section whose wrapper is open. */
    let open = -1
    const closeWrapper = () => {
      if (open < 0) return
      const t = new state.Token('agent_section_close', 'section', -1)
      t.block = true
      out.push(t)
      open = -1
    }
    for (const token of state.tokens) {
      if (token.level === 0 && token.map) cur = sectionAt(token.map[0])
      const isMarker = cur >= 0 && token.level === 0 && token.type === 'html_block' && !!token.map && markers.has(token.map[0])
      if (human) {
        if (cur < 0) out.push(token)
        else if (token.type === 'heading_open') env.hiddenIds.push(token.attrGet('id') ?? '')
        continue
      }
      if (cur !== open) {
        closeWrapper()
        if (cur >= 0) {
          const t = new state.Token('agent_section_open', 'section', 1)
          t.block = true
          t.meta = { index: cur, label: sections[cur]!.label }
          out.push(t)
          open = cur
        }
      }
      if (!isMarker) out.push(token)
    }
    closeWrapper()
    state.tokens = out
  })

  md.renderer.rules.agent_section_open = (tokens, idx) => {
    const { index, label } = tokens[idx]!.meta as { index: number; label: string }
    const text = label ? `${LABEL} · ${label}` : LABEL
    return `<section class="agent-only" data-testid="agent-section" data-agent-index="${index}">`
      + `<div class="agent-section-label" data-testid="agent-section-label">${md.utils.escapeHtml(text)}</div>\n`
  }
  md.renderer.rules.agent_section_close = () => '</section>\n'
}
