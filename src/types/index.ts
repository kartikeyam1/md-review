export type CommentCategory = 'suggestion' | 'question' | 'must-fix' | 'nit'

export interface CategoryMeta { value: CommentCategory; label: string; color: string }

export const COMMENT_CATEGORIES: CategoryMeta[] = [
  { value: 'suggestion', label: 'Suggestion', color: '#2563eb' },
  { value: 'question', label: 'Question', color: '#7c3aed' },
  { value: 'must-fix', label: 'Must Fix', color: '#dc2626' },
  { value: 'nit', label: 'Nit', color: '#8a8480' },
]

export const DEFAULT_CATEGORY: CommentCategory = COMMENT_CATEGORIES[0].value

const CATEGORY_MAP = new Map<CommentCategory, CategoryMeta>(
  COMMENT_CATEGORIES.map((c) => [c.value, c])
)

export function getCategoryMeta(cat: CommentCategory): CategoryMeta {
  return CATEGORY_MAP.get(cat)!
}

export interface Reply {
  id: string
  body: string
  author?: string
  createdAt: number
}

export interface Comment {
  id: string
  startLine: number
  endLine: number
  selectedText: string
  body: string
  category: CommentCategory
  createdAt: number
  author?: string
  replies: Reply[]
}

export type AppMode = 'upload' | 'review'
export type PaneMode = 'edit' | 'preview'
export type ThemeMode = 'light' | 'dark' | 'github-light' | 'github-dark'
