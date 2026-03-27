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

  it('renders YAML frontmatter as a key-value table', () => {
    const { renderHtml } = useMarkdown()
    const md = `---
document_id: TMS-REF-DISC-15
version: 1.0.0
status: Draft
owner: Pradyumna
---

# Title
`
    const html = renderHtml(md)
    // Should contain a frontmatter table
    expect(html).toContain('frontmatter')
    expect(html).toContain('document_id')
    expect(html).toContain('TMS-REF-DISC-15')
    expect(html).toContain('version')
    expect(html).toContain('1.0.0')
    // Should NOT produce an <hr> from the opening ---
    expect(html).not.toMatch(/<hr/)
    // The actual heading should still render
    expect(html).toContain('<h1')
    expect(html).toContain('Title')
  })

  it('renders markdown without frontmatter normally', () => {
    const { renderHtml } = useMarkdown()
    const md = '# Just a heading\n\nSome text.\n'
    const html = renderHtml(md)
    expect(html).not.toContain('frontmatter')
    expect(html).toContain('<h1')
  })

  it('still syntax-highlights non-mermaid code blocks', () => {
    const { renderHtml } = useMarkdown()
    const md = '```python\nprint("hello")\n```\n'
    const html = renderHtml(md)
    expect(html).toContain('hljs-')
  })
})
