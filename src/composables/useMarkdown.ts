import MarkdownIt from 'markdown-it'
// Syntax highlighting (highlight.js core, eager + per-language lazy chunks) lives in src/markdown/highlight.ts.
import { highlightCode, highlightRevision } from '@/markdown/highlight'
export { FENCE_LANGUAGES, type FenceLanguage } from '@/markdown/highlight'
import taskLists from 'markdown-it-task-lists'
import { tableScroll } from '@/markdown/tableScroll'
import { headingIds, type HeadingInfo } from '@/markdown/headingIds'
import { autolink } from '@/markdown/autolink'
import { codeBlock } from '@/markdown/codeBlock'
import { alerts } from '@/markdown/alerts'
import { rag } from '@/markdown/rag'
import { inlineToc } from '@/markdown/inlineToc'
import { agentSections, type AgentView, type AgentEnv } from '@/markdown/agentSections'
import { parseFrontMatter, frontMatterTable, bodyWithAbsoluteLines } from '@/markdown/frontMatter'

export interface RenderResult {
  html: string
  headings: HeadingInfo[]
  /** #28: agent sections in the source (both views). */
  agentSections: number
  /** #28 human view: ids of the headings inside hidden sections. */
  hiddenIds: string[]
  /** #28 human view: hidden source line ranges (inclusive). */
  hiddenRanges: { start: number; end: number }[]
}

export interface LineMapEntry {
  startLine: number
  endLine: number
  htmlIndex: number
}

function lineAttrs(map: [number, number]): string {
  return ` data-line-start="${map[0]}" data-line-end="${map[1]}"`
}

// Plugin that injects data-line-start/data-line-end into block-level elements
function lineDataPlugin(md: MarkdownIt) {
  // Handle normal block tokens (headings, paragraphs, lists, tables, etc.)
  const originalRender = md.renderer.renderToken.bind(md.renderer)
  md.renderer.renderToken = function (tokens, idx, options) {
    const token = tokens[idx]
    if (token.map && token.nesting === 1) {
      token.attrSet('data-line-start', String(token.map[0]))
      token.attrSet('data-line-end', String(token.map[1]))
    }
    return originalRender(tokens, idx, options)
  }

  // Handle fenced code blocks (``` ... ```) — these bypass renderToken
  const originalFence = md.renderer.rules.fence!
  md.renderer.rules.fence = function (tokens, idx, options, env, slf) {
    const token = tokens[idx]
    const attrs = token.map ? lineAttrs(token.map) : ''

    // Mermaid blocks: render as <div class="mermaid"> with raw content
    if (token.info.trim().toLowerCase() === 'mermaid') {
      const escaped = md.utils.escapeHtml(token.content)
      return `<div${attrs} class="mermaid">${escaped}</div>\n`
    }

    const result = originalFence(tokens, idx, options, env, slf)
    // Inject attrs into the opening <pre> tag
    return result.replace(/^<pre/, `<pre${attrs}`)
  }

  // Handle indented code blocks — these also bypass renderToken
  const originalCodeBlock = md.renderer.rules.code_block!
  md.renderer.rules.code_block = function (tokens, idx, options, env, slf) {
    const token = tokens[idx]
    const attrs = token.map ? lineAttrs(token.map) : ''
    const result = originalCodeBlock(tokens, idx, options, env, slf)
    return result.replace(/^<pre/, `<pre${attrs}`)
  }
}

export function useMarkdown() {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight: highlightCode,
  })
  // Markdown plugins (00 §4.4): one file each under src/markdown/, registered here.
  const PLUGINS: ((md: MarkdownIt) => void)[] = [
    headingIds, // #3 rules 1–7
    lineDataPlugin,
    (m) => m.use(taskLists, { enabled: true }),
    tableScroll, // #5 rule 5
    autolink, // #5 rule 15
    codeBlock, // #14 rules 1–3 (wraps lineDataPlugin's fence/code_block output)
    alerts, // #16 rules 1–9
    rag, // #16 rules 10–15
    inlineToc, // #12 rule 18
    agentSections, // #28 rules 1–9 (after headingIds: ids over the full source)
  ]
  for (const plugin of PLUGINS) plugin(md)

  // Front matter renders as a table; the body keeps absolute line numbers (#5 rule 20).
  // `frontMatter: false` drops the table (a viewer's publish-mode reading page) — the body keeps its absolute lines.
  function renderHtml(source: string, env: object = {}, frontMatter = true): string {
    // A computed render re-runs when a lazy highlight.js language arrives.
    void highlightRevision.value
    const fm = parseFrontMatter(source)
    if (fm) return (frontMatter ? frontMatterTable(fm) : '') + md.render(bodyWithAbsoluteLines(fm), env)
    return md.render(source, env)
  }

  /**
   * The HTML plus what the same parse found (one parse): the headings it
   * carries (ids + plain text, #3) and the #28 agent sections — their count
   * and, in the human view (default), the heading ids and lines it hid.
   */
  function renderWithHeadings(source: string, o: { agentView?: AgentView; frontMatter?: boolean } = {}): RenderResult {
    const env: { headings?: HeadingInfo[] } & AgentEnv = { agentView: o.agentView ?? 'human' }
    const html = renderHtml(source, env, o.frontMatter ?? true)
    return {
      html,
      headings: env.headings ?? [],
      agentSections: env.agentSections ?? 0,
      hiddenIds: env.hiddenIds ?? [],
      hiddenRanges: env.hiddenRanges ?? [],
    }
  }

  function getLineMap(source: string): LineMapEntry[] {
    const fm = parseFrontMatter(source)
    const tokens = md.parse(fm ? bodyWithAbsoluteLines(fm) : source, {})
    const entries: LineMapEntry[] = []
    let htmlIndex = 0

    for (const token of tokens) {
      if (token.type.endsWith('_open') && token.map) {
        entries.push({
          startLine: token.map[0],
          endLine: token.map[1],
          htmlIndex: htmlIndex++,
        })
      }
    }

    return entries
  }

  return { renderHtml, renderWithHeadings, getLineMap, md }
}
