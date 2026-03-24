import { describe, it, expect } from 'vitest'
import { generatePrompt } from '@/composables/usePromptGenerator'
import type { Comment } from '@/types'

describe('generatePrompt', () => {
  const sampleContent = '# Title\n\nSome text\n\n## Section\n\n- Item'

  it('generates prompt with comments and full document', () => {
    const comments: Comment[] = [
      {
        id: '1',
        startLine: 4,
        endLine: 4,
        selectedText: 'Section',
        body: 'Rename this section',
        createdAt: 1,
      },
    ]
    const result = generatePrompt('readme.md', comments, sampleContent)
    expect(result).toContain('readme.md')
    expect(result).toContain('"Section"')
    expect(result).toContain('Line 5') // 1-indexed
    expect(result).toContain('Rename this section')
    expect(result).toContain(sampleContent)
  })

  it('uses "Lines X-Y" for multi-line comments', () => {
    const comments: Comment[] = [
      {
        id: '1',
        startLine: 2,
        endLine: 5,
        selectedText: 'Some text',
        body: 'Expand this',
        createdAt: 1,
      },
    ]
    const result = generatePrompt('doc.md', comments, sampleContent)
    expect(result).toContain('Lines 3-6') // 1-indexed
  })

  it('returns empty string for no comments', () => {
    const result = generatePrompt('doc.md', [], sampleContent)
    expect(result).toBe('')
  })

  it('sorts comments by line number in output', () => {
    const comments: Comment[] = [
      { id: '2', startLine: 4, endLine: 4, selectedText: 'b', body: 'second', createdAt: 2 },
      { id: '1', startLine: 0, endLine: 0, selectedText: 'a', body: 'first', createdAt: 1 },
    ]
    const result = generatePrompt('doc.md', comments, sampleContent)
    const firstIdx = result.indexOf('first')
    const secondIdx = result.indexOf('second')
    expect(firstIdx).toBeLessThan(secondIdx)
  })
})
