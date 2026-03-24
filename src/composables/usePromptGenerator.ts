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
      const end = c.endLine + 1
      const lineRef = start === end ? `Line ${start}` : `Lines ${start}-${end}`
      return `${i + 1}. On: "${c.selectedText}" (${lineRef})\n   Comment: ${c.body}`
    })
    .join('\n\n')

  return `Please revise the document "${filename}" based on the following review comments:\n\n${commentLines}\n\n---\nFull document:\n${content}`
}
