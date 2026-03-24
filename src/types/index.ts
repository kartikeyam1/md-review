export interface Comment {
  id: string
  startLine: number
  endLine: number
  selectedText: string
  body: string
  createdAt: number
}

export type AppMode = 'upload' | 'review'
export type PaneMode = 'edit' | 'preview'
