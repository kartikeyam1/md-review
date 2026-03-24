import { describe, it, expect } from 'vitest'
import { generatePrompt } from '@/composables/usePromptGenerator'
import type { Comment } from '@/types'

describe('generatePrompt', () => {
  const sampleContent = '# Title\n\nSome text\n\n## Section\n\n- Item'

  it('generates prompt with single-line comment and category tag', () => {
    const comments: Comment[] = [
      {
        id: '1',
        startLine: 4,
        endLine: 5,
        selectedText: 'Section',
        body: 'Rename this section',
        category: 'suggestion',
        createdAt: 1,
      },
    ]
    const result = generatePrompt('readme.md', comments, sampleContent)
    expect(result).toContain('readme.md')
    expect(result).toContain('"Section"')
    expect(result).toContain('Line 5')
    expect(result).not.toContain('Lines 5-')
    expect(result).toContain('[suggestion]')
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
        category: 'must-fix',
        createdAt: 1,
      },
    ]
    const result = generatePrompt('doc.md', comments, sampleContent)
    expect(result).toContain('Lines 3-5')
    expect(result).toContain('[must-fix]')
  })

  it('returns empty string for no comments', () => {
    const result = generatePrompt('doc.md', [], sampleContent)
    expect(result).toBe('')
  })

  it('sorts comments by line number in output', () => {
    const comments: Comment[] = [
      { id: '2', startLine: 4, endLine: 5, selectedText: 'b', body: 'second', category: 'nit', createdAt: 2 },
      { id: '1', startLine: 0, endLine: 1, selectedText: 'a', body: 'first', category: 'question', createdAt: 1 },
    ]
    const result = generatePrompt('doc.md', comments, sampleContent)
    const firstIdx = result.indexOf('first')
    const secondIdx = result.indexOf('second')
    expect(firstIdx).toBeLessThan(secondIdx)
  })
})
