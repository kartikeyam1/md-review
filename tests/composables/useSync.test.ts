import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { useSync } from '@/composables/useSync'
import type { Comment } from '@/types'

const mockPostComment = vi.fn()
const mockPutComment = vi.fn()
const mockDeleteCommentApi = vi.fn()
const mockPutMarkdown = vi.fn()
const mockPollPaste = vi.fn()

vi.mock('@/composables/useShare', () => ({
  useShare: () => ({
    postComment: mockPostComment,
    putComment: mockPutComment,
    deleteCommentApi: mockDeleteCommentApi,
    putMarkdown: mockPutMarkdown,
    pollPaste: mockPollPaste,
    loadShare: vi.fn(),
    sharing: ref(false),
    shareError: ref(null),
    createShare: vi.fn(),
    fetchGithub: vi.fn(),
    getShareIdFromHash: vi.fn(),
    setShareHash: vi.fn(),
    getShareUrls: vi.fn(),
  }),
}))

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1', startLine: 0, endLine: 1, selectedText: 'text',
    body: 'test', category: 'suggestion', createdAt: Date.now(),
    ...overrides,
  }
}

function makeLocalOps(comments: { value: Comment[] }) {
  return {
    addComment: vi.fn((input: any) => {
      comments.value = [...comments.value, { ...input, id: crypto.randomUUID(), createdAt: Date.now() }]
    }),
    editComment: vi.fn((id: string, updates: any) => {
      comments.value = comments.value.map(c => c.id === id ? { ...c, ...updates } : c)
    }),
    deleteComment: vi.fn((id: string) => {
      comments.value = comments.value.filter(c => c.id !== id)
    }),
    loadComments: vi.fn((c: Comment[]) => { comments.value = c }),
  }
}

describe('useSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    // Default: polling returns not-modified so shared-mode tests don't blow up
    mockPollPaste.mockResolvedValue({ data: null, etag: null, notModified: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('in local mode, addComment delegates to localOps', () => {
    const pasteId = ref<string | null>(null)
    const comments = ref<Comment[]>([])
    const ops = makeLocalOps(comments)
    const sync = useSync(pasteId, comments, ref(''), ops)

    sync.addComment({ startLine: 0, endLine: 1, selectedText: 'Hi', body: 'nice', category: 'suggestion' })

    expect(ops.addComment).toHaveBeenCalled()
    expect(mockPostComment).not.toHaveBeenCalled()
  })

  it('in shared mode, addComment calls API and updates via loadComments', async () => {
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([])
    const ops = makeLocalOps(comments)
    const serverComment = makeComment({ id: 'server-id', body: 'nice' })
    mockPostComment.mockResolvedValue(serverComment)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.addComment({ startLine: 0, endLine: 1, selectedText: 'Hi', body: 'nice', category: 'suggestion' })

    expect(mockPostComment).toHaveBeenCalledWith('abc123', expect.objectContaining({ body: 'nice' }))
    expect(ops.loadComments).toHaveBeenCalled()
  })

  it('in shared mode, editComment calls PUT API', async () => {
    const existing = makeComment({ id: 'c1', body: 'original' })
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockPutComment.mockResolvedValue({ ...existing, body: 'updated' })

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.editComment('c1', { body: 'updated' })

    expect(mockPutComment).toHaveBeenCalledWith('abc123', 'c1', { body: 'updated' })
  })

  it('in shared mode, deleteComment calls DELETE API', async () => {
    const existing = makeComment({ id: 'c1' })
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockDeleteCommentApi.mockResolvedValue(true)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.deleteComment('c1')

    expect(mockDeleteCommentApi).toHaveBeenCalledWith('abc123', 'c1')
  })

  it('in shared mode, saveMarkdown calls PUT API', async () => {
    const pasteId = ref<string | null>('abc123')
    const markdown = ref('# Updated')
    const ops = makeLocalOps(ref([]))
    mockPutMarkdown.mockResolvedValue(true)

    const sync = useSync(pasteId, ref([]), markdown, ops)
    const result = await sync.saveMarkdown()

    expect(mockPutMarkdown).toHaveBeenCalledWith('abc123', '# Updated', undefined)
    expect(result).toBe(true)
  })

  it('syncStatus is "local" when pasteId is null', () => {
    const sync = useSync(ref(null), ref([]), ref(''), makeLocalOps(ref([])))
    expect(sync.syncStatus.value).toBe('local')
  })

  it('syncStatus is "synced" in shared mode', () => {
    const sync = useSync(ref('abc'), ref([]), ref(''), makeLocalOps(ref([])))
    expect(sync.syncStatus.value).toBe('synced')
  })

  it('falls back to local on API failure and sets error status', async () => {
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([])
    const ops = makeLocalOps(comments)
    mockPostComment.mockResolvedValue(null) // API failure

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.addComment({ startLine: 0, endLine: 1, selectedText: 'Hi', body: 'x', category: 'nit' })

    expect(ops.addComment).toHaveBeenCalled() // fallback to local
    expect(sync.syncStatus.value).toBe('error')
  })
})
