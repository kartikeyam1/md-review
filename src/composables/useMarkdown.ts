import MarkdownIt from 'markdown-it'

export interface LineMapEntry {
  startLine: number
  endLine: number
  htmlIndex: number
}

export function useMarkdown() {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

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
