import MarkdownIt from 'markdown-it'

export interface LineMapEntry {
  startLine: number
  endLine: number
  htmlIndex: number
}

// Plugin that injects data-line-start/data-line-end into block-level opening tags
function lineDataPlugin(md: MarkdownIt) {
  const originalRender = md.renderer.renderToken.bind(md.renderer)
  md.renderer.renderToken = function (tokens, idx, options) {
    const token = tokens[idx]
    if (token.map && token.nesting === 1) {
      token.attrSet('data-line-start', String(token.map[0]))
      token.attrSet('data-line-end', String(token.map[1]))
    }
    return originalRender(tokens, idx, options)
  }
}

export function useMarkdown() {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
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
