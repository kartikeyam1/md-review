import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'

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
    html: false,
    linkify: true,
    typographer: true,
    highlight(str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang }).value
        } catch {
          // fall through to default escaping
        }
      }
      return '' // use default escaping
    },
  })
  md.use(lineDataPlugin)

  function renderHtml(source: string): string {
    return md.render(source)
  }

  function getLineMap(source: string): LineMapEntry[] {
    const tokens = md.parse(source, {})
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

  return { renderHtml, getLineMap, md }
}
