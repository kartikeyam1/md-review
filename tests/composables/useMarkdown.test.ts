import { describe, it, expect } from 'vitest'
import { useMarkdown } from '@/composables/useMarkdown'

const sampleMd = `# Title

Some paragraph text here.

## Section

- Item one
- Item two
`

describe('useMarkdown', () => {
  it('renders markdown to HTML', () => {
    const { renderHtml } = useMarkdown()
    const html = renderHtml(sampleMd)
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<h2>Section</h2>')
    expect(html).toContain('<li>Item one</li>')
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
})
