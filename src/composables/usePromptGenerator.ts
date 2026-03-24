import type { Comment } from '@/types'

export function generatePrompt(
  filename: string,
  comments: Comment[],
  content: string
): string {
  if (comments.length === 0) return ''

  const sorted = [...comments].sort((a, b) => a.startLine - b.startLine)

  const commentLines = sorted
    .map((c, i) => {
      const start = c.startLine + 1 // 1-indexed
      // endLine is end-exclusive, so the last included line (1-indexed) is c.endLine
      const isSingleLine = c.endLine <= c.startLine + 1
      const lineRef = isSingleLine ? `Line ${start}` : `Lines ${start}-${c.endLine}`
      return `${i + 1}. On: "${c.selectedText}" (${lineRef})\n   Comment: ${c.body}`
    })
    .join('\n\n')

  return `Please revise the document "${filename}" based on the following review comments:\n\n${commentLines}\n\n---\nFull document:\n${content}`
}
