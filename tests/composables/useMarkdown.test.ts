import { describe, it, expect } from 'vitest'
import { useMarkdown } from '@/composables/useMarkdown'

const sampleMd = `# Title

Some paragraph text here.

## Section

- Item one
- Item two
`

describe('useMarkdown', () => {
  it('renders markdown to HTML with line data attributes', () => {
    const { renderHtml } = useMarkdown()
    const html = renderHtml(sampleMd)
    expect(html).toContain('>Title</h1>')
    expect(html).toContain('>Section</h2>')
    expect(html).toContain('>Item one</li>')
    // Line data injected by plugin
    expect(html).toContain('data-line-start="0"')
    expect(html).toContain('data-line-end="1"')
  })

  it('builds a line map from tokens', () => {
    const { getLineMap } = useMarkdown()
    const lineMap = getLineMap(sampleMd)
    expect(lineMap.length).toBeGreaterThan(0)
    expect(lineMap[0]).toHaveProperty('startLine')
    expect(lineMap[0]).toHaveProperty('endLine')
    expect(lineMap[0]).toHaveProperty('htmlIndex')
  })

  it('line map entries are 0-indexed', () => {
    const { getLineMap } = useMarkdown()
    const lineMap = getLineMap(sampleMd)
    const headingEntry = lineMap.find((e) => e.startLine === 0)
    expect(headingEntry).toBeTruthy()
  })

  it('renders mermaid blocks with class "mermaid" and raw content, not hljs', () => {
    const { renderHtml } = useMarkdown()
    const md = '```mermaid\ngraph LR\n    A --> B\n```\n'
    const html = renderHtml(md)
    // Should have a container with class mermaid
    expect(html).toContain('class="mermaid"')
    // Should contain the raw diagram text, not hljs-highlighted spans
    expect(html).toContain('graph LR')
    expect(html).not.toContain('hljs-')
  })

  it('still syntax-highlights non-mermaid code blocks', () => {
    const { renderHtml } = useMarkdown()
    const md = '```python\nprint("hello")\n```\n'
    const html = renderHtml(md)
    expect(html).toContain('hljs-')
  })
})
