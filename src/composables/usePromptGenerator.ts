import type { Comment } from '@/types'

export interface PromptOptions {
  includeFullDocument?: boolean
}

export function generatePrompt(
  filename: string,
  comments: Comment[],
  content: string,
  options: PromptOptions = {}
): string {
  if (comments.length === 0) return ''

  const { includeFullDocument = true } = options

  const sorted = [...comments].sort((a, b) => a.startLine - b.startLine)

  const commentLines = sorted
    .map((c, i) => {
      const start = c.startLine + 1
      const isSingleLine = c.endLine <= c.startLine + 1
      const lineRef = isSingleLine ? `Line ${start}` : `Lines ${start}-${c.endLine}`
      const tag = `[${c.category}]`
      return `${i + 1}. ${tag} On: "${c.selectedText}" (${lineRef})\n   Comment: ${c.body}`
    })
    .join('\n\n')

  if (includeFullDocument) {
    return `Please revise the document "${filename}" based on the following review comments:\n\n${commentLines}\n\n---\nFull document:\n${content}`
  }

  return `Please revise the document "${filename}" based on the following review comments:\n\n${commentLines}`
}
