export type CommentCategory = 'suggestion' | 'question' | 'must-fix' | 'nit'

/**
 * `color` is the category hue (text on the surface, or a fill) and `onColor`
 * the text drawn on that fill. Both are theme tokens (src/style.css, #1) so
 * every theme keeps them at 4.5:1 or better.
 */
export interface CategoryMeta { value: CommentCategory; label: string; color: string; onColor: string }

export const COMMENT_CATEGORIES: CategoryMeta[] = [
  { value: 'suggestion', label: 'Suggestion', color: 'var(--cat-suggestion)', onColor: 'var(--cat-suggestion-on)' },
  { value: 'question', label: 'Question', color: 'var(--cat-question)', onColor: 'var(--cat-question-on)' },
  { value: 'must-fix', label: 'Must Fix', color: 'var(--cat-must-fix)', onColor: 'var(--cat-must-fix-on)' },
  { value: 'nit', label: 'Nit', color: 'var(--cat-nit)', onColor: 'var(--cat-nit-on)' },
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
  resolved?: boolean
  resolved_by?: string | null
  resolved_at?: number | null
}

export type ApprovalStatus = 'pending' | 'approved' | 'changes_requested'

export interface ApprovalInfo {
  approval_status: ApprovalStatus
  approved_by?: string | null
  approved_at?: string | null
}

export type ContentType = 'markdown' | 'html'

/** Whether a document is open ('doc') — not to be confused with the per-doc mode (DocMode). */
export type AppMode = 'upload' | 'doc' | 'dashboard'
/** Per-doc mode (#2): a reading page, or comments + approval. */
export type DocMode = 'publish' | 'review'
export type PaneMode = 'edit' | 'preview'
export type ThemeMode = 'light' | 'dark' | 'github-light' | 'github-dark' | 'locus-light' | 'locus-dark'

/** A theme is a style × a dark flag (#1). */
export type ThemeStyle = 'default' | 'github' | 'locus'
