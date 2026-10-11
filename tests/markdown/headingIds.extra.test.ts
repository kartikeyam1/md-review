import { describe, it, expect } from 'vitest'
import { extractHeadings } from '@/markdown/headingIds'
import { useMarkdown } from '@/composables/useMarkdown'

// #3 rule 3: ids are GitHub-compatible even where typographer rewrites the text.
describe('heading ids before typographer', () => {
  const cases: Array<[string, string, string]> = [
    ['foo--bar', 'foo--bar', 'foo–bar'],
    ['a -- b', 'a----b', 'a – b'],
    ['(c) note', 'c-note', '© note'],
    ["What's new?", 'whats-new', 'What’s new?'],
  ]
  for (const [src, id, text] of cases) {
    it(`## ${src} -> #${id}, text "${text}"`, () => {
      const [h] = extractHeadings(`## ${src}\n`)
      expect(h).toEqual({ level: 2, id, text })
      const html = useMarkdown().renderHtml(`## ${src}\n`)
      expect(html).toContain(`id="${id}"`)
    })
  }

  it('renderWithHeadings lists the same headings as extractHeadings', () => {
    const src = '# T\n\n## foo--bar\n\n> ### Quoted\n'
    expect(useMarkdown().renderWithHeadings(src).headings).toEqual(extractHeadings(src))
  })
})
