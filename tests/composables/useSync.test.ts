import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { useSync } from '@/composables/useSync'
import type { Comment } from '@/types'

const mockPostComment = vi.fn()
const mockPutComment = vi.fn()
const mockDeleteCommentApi = vi.fn()
const mockPutMarkdown = vi.fn()
const mockPollPaste = vi.fn()
const mockPostReply = vi.fn()
const mockPutReply = vi.fn()
const mockDeleteReplyApi = vi.fn()
const mockResolveCommentApi = vi.fn()
const mockUnresolveCommentApi = vi.fn()

vi.mock('@/composables/useShare', () => ({
  useShare: () => ({
    postComment: mockPostComment,
    putComment: mockPutComment,
    deleteCommentApi: mockDeleteCommentApi,
    putMarkdown: mockPutMarkdown,
    pollPaste: mockPollPaste,
    postReply: mockPostReply,
    putReply: mockPutReply,
    deleteReplyApi: mockDeleteReplyApi,
    resolveCommentApi: mockResolveCommentApi,
    unresolveCommentApi: mockUnresolveCommentApi,
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
    replies: [],
    ...overrides,
  }
}

function makeLocalOps(comments: { value: Comment[] }) {
  return {
    addComment: vi.fn((input: any) => {
      comments.value = [...comments.value, { ...input, id: crypto.randomUUID(), createdAt: Date.now(), replies: [] }]
    }),
    editComment: vi.fn((id: string, updates: any) => {
      comments.value = comments.value.map(c => c.id === id ? { ...c, ...updates } : c)
    }),
    deleteComment: vi.fn((id: string) => {
      comments.value = comments.value.filter(c => c.id !== id)
    }),
    loadComments: vi.fn((c: Comment[]) => { comments.value = c }),
    addReply: vi.fn((commentId: string, input: any) => {
      const reply = { id: crypto.randomUUID(), createdAt: Date.now(), ...input }
      comments.value = comments.value.map(c =>
        c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c
      )
      return reply
    }),
    editReply: vi.fn((commentId: string, replyId: string, body: string) => {
      comments.value = comments.value.map(c =>
        c.id === commentId
          ? { ...c, replies: c.replies.map(r => r.id === replyId ? { ...r, body } : r) }
          : c
      )
    }),
    deleteReply: vi.fn((commentId: string, replyId: string) => {
      comments.value = comments.value.map(c =>
        c.id === commentId
          ? { ...c, replies: c.replies.filter(r => r.id !== replyId) }
          : c
      )
    }),
    resolveComment: vi.fn((id: string) => {
      comments.value = comments.value.map(c => c.id === id ? { ...c, resolved: true } : c)
    }),
    unresolveComment: vi.fn((id: string) => {
      comments.value = comments.value.map(c => c.id === id ? { ...c, resolved: false } : c)
    }),
  }
}

const okPut = { ok: true, status: 200, contentHash: 'h2' }
const failPut = { ok: false, status: 0 }
const serverState = (markdown: string, comments: Comment[] = [], content_hash = 'h1', etag = '"e1"') => ({
  data: { markdown, filename: 'test.md', comments, sharedAt: '', content_hash },
  etag, notModified: false, status: 200,
})
const notModified = { data: null, etag: null, notModified: true, status: 304 }

describe('useSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockPollPaste.mockResolvedValue(notModified)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Comment ops ──────────────────────────────────────────────────────────

  it('in local mode, addComment delegates to localOps', () => {
    const pasteId = ref<string | null>(null)
    const comments = ref<Comment[]>([])
    const ops = makeLocalOps(comments)
    const sync = useSync(pasteId, comments, ref(''), ops)

    sync.addComment({ startLine: 0, endLine: 1, selectedText: 'Hi', body: 'nice', category: 'suggestion' })

    expect(ops.addComment).toHaveBeenCalled()
    expect(mockPostComment).not.toHaveBeenCalled()
  })

  it('in shared mode, addComment calls API and swaps the optimistic comment for the server one', async () => {
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([])
    const ops = makeLocalOps(comments)
    const serverComment = makeComment({ id: 'server-id', body: 'nice' })
    mockPostComment.mockResolvedValue(serverComment)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.addComment({ startLine: 0, endLine: 1, selectedText: 'Hi', body: 'nice', category: 'suggestion' })

    expect(mockPostComment).toHaveBeenCalledWith('abc123', expect.objectContaining({ body: 'nice' }))
    expect(comments.value).toHaveLength(1)
    expect(comments.value[0].id).toBe('server-id')
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
    expect(comments.value[0].body).toBe('updated')
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
    expect(comments.value).toHaveLength(0)
  })

  it('syncStatus is "local" when pasteId is null', () => {
    const sync = useSync(ref(null), ref([]), ref(''), makeLocalOps(ref([])))
    expect(sync.syncStatus.value).toBe('local')
  })

  it('syncStatus is "synced" in shared mode', () => {
    const sync = useSync(ref('abc'), ref([]), ref(''), makeLocalOps(ref([])))
    expect(sync.syncStatus.value).toBe('synced')
  })

  it('keeps the comment locally and reports an error when addComment fails', async () => {
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([])
    const ops = makeLocalOps(comments)
    mockPostComment.mockResolvedValue(null)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.addComment({ startLine: 0, endLine: 1, selectedText: 'Hi', body: 'x', category: 'nit' })

    expect(ops.addComment).toHaveBeenCalled()
    expect(comments.value).toHaveLength(1)
    expect(sync.syncStatus.value).toBe('error')
    expect(sync.pendingCount.value).toBe(1)
  })

  it('keeps a failed edit locally and reports an error', async () => {
    const existing = makeComment({ id: 'c1', body: 'original' })
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockPutComment.mockResolvedValue(null)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.editComment('c1', { body: 'updated' })

    expect(comments.value[0].body).toBe('updated')
    expect(sync.syncStatus.value).toBe('error')
  })

  it('keeps a failed delete locally and reports an error', async () => {
    const existing = makeComment({ id: 'c1' })
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockDeleteCommentApi.mockResolvedValue(false)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.deleteComment('c1')

    expect(comments.value).toHaveLength(0)
    expect(sync.syncStatus.value).toBe('error')
  })

  it('isShared is false in local mode and true in shared mode', () => {
    const localSync = useSync(ref(null), ref([]), ref(''), makeLocalOps(ref([])))
    expect(localSync.isShared.value).toBe(false)

    const sharedSync = useSync(ref('abc'), ref([]), ref(''), makeLocalOps(ref([])))
    expect(sharedSync.isShared.value).toBe(true)
  })

  // ── Outbox: failed comment ops survive polls and are retried ─────────────

  it('a poll does not wipe a comment whose POST failed, and retries it', async () => {
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([])
    const ops = makeLocalOps(comments)
    const markdown = ref('')
    mockPollPaste.mockResolvedValue(serverState('doc', []))
    const sync = useSync(pasteId, comments, markdown, ops)
    await vi.advanceTimersByTimeAsync(0)

    mockPostComment.mockResolvedValueOnce(null)
    await sync.addComment({ startLine: 0, endLine: 1, selectedText: 'Hi', body: 'offline comment', category: 'nit' })
    expect(sync.pendingCount.value).toBe(1)
    const localId = comments.value[0].id

    // Server still knows nothing about it; the poll must keep it.
    mockPollPaste.mockResolvedValue(serverState('doc', [], 'h1', '"e2"'))
    mockPostComment.mockResolvedValueOnce(null)
    await vi.advanceTimersByTimeAsync(5000)
    expect(comments.value.map(c => c.body)).toEqual(['offline comment'])

    // Network is back: the retry succeeds and the server id replaces the local one.
    const serverComment = makeComment({ id: 'srv-1', body: 'offline comment' })
    mockPostComment.mockResolvedValueOnce(serverComment)
    mockPollPaste.mockResolvedValue(serverState('doc', [serverComment], 'h1', '"e3"'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(sync.pendingCount.value).toBe(0)
    expect(comments.value.map(c => c.id)).toEqual(['srv-1'])
    expect(comments.value.find(c => c.id === localId)).toBeUndefined()
    expect(sync.syncStatus.value).toBe('synced')
  })

  it('a poll does not resurrect a comment whose DELETE is still pending', async () => {
    const existing = makeComment({ id: 'c1' })
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockPollPaste.mockResolvedValue(serverState('doc', [existing]))
    const sync = useSync(pasteId, comments, ref('doc'), ops)
    await vi.advanceTimersByTimeAsync(0)

    mockDeleteCommentApi.mockResolvedValue(false)
    await sync.deleteComment('c1')
    mockPollPaste.mockResolvedValue(serverState('doc', [existing], 'h1', '"e2"'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(comments.value).toHaveLength(0)
  })

  // ── Document save ────────────────────────────────────────────────────────

  it('saveMarkdown returns false in local mode', async () => {
    const sync = useSync(ref(null), ref([]), ref('# Hello'), makeLocalOps(ref([])))
    const result = await sync.saveMarkdown()
    expect(result).toBe(false)
    expect(mockPutMarkdown).not.toHaveBeenCalled()
  })

  it('saveMarkdown PUTs with If-Match set to the baseline hash and updates the baseline', async () => {
    const pasteId = ref<string | null>('abc123')
    const markdown = ref('# Updated')
    const sync = useSync(pasteId, ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: '# Original', contentHash: 'h1' })
    mockPutMarkdown.mockResolvedValue(okPut)

    expect(sync.isDirty.value).toBe(true)
    expect(sync.saveState.value).toBe('dirty')
    const result = await sync.saveMarkdown()

    expect(mockPutMarkdown).toHaveBeenCalledWith('abc123', '# Updated', undefined, expect.objectContaining({ ifMatch: 'h1' }))
    expect(result).toBe(true)
    expect(sync.isDirty.value).toBe(false)
    expect(sync.saveState.value).toBe('saved')
  })

  it('saveMarkdown is a no-op when nothing changed', async () => {
    const sync = useSync(ref('abc123'), ref([]), ref('same'), makeLocalOps(ref([])))
    sync.setBaseline({ markdown: 'same', contentHash: 'h1' })
    expect(await sync.saveMarkdown()).toBe(true)
    expect(mockPutMarkdown).not.toHaveBeenCalled()
  })

  it('saveMarkdown also sends a changed filename', async () => {
    const filename = ref('renamed.md')
    const sync = useSync(ref('abc123'), ref([]), ref('doc'), makeLocalOps(ref([])), { filename })
    sync.setBaseline({ markdown: 'doc', filename: 'old.md', contentHash: 'h1' })
    mockPutMarkdown.mockResolvedValue(okPut)
    expect(sync.isDirty.value).toBe(true)
    await sync.saveMarkdown()
    expect(mockPutMarkdown).toHaveBeenCalledWith('abc123', 'doc', 'renamed.md', expect.anything())
    expect(sync.isDirty.value).toBe(false)
  })

  it('a failed save keeps local edits, reports error, and the next save retries', async () => {
    const markdown = ref('local edits')
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: 'server', contentHash: 'h1' })
    mockPutMarkdown.mockResolvedValueOnce(failPut)
    expect(await sync.saveMarkdown()).toBe(false)
    expect(sync.saveState.value).toBe('error')
    expect(markdown.value).toBe('local edits')

    mockPutMarkdown.mockResolvedValueOnce(okPut)
    expect(await sync.saveMarkdown()).toBe(true)
    expect(sync.saveState.value).toBe('saved')
  })

  it('a 412 on save becomes a conflict: local edits kept, server copy exposed', async () => {
    const markdown = ref('mine')
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: 'base', contentHash: 'h1' })
    mockPutMarkdown.mockResolvedValueOnce({ ok: false, status: 412, conflict: true, remoteMarkdown: 'theirs', remoteHash: 'h9' })

    expect(await sync.saveMarkdown()).toBe(false)
    expect(sync.saveState.value).toBe('conflict')
    expect(sync.conflict.value).toBe(true)
    expect(sync.remoteMarkdown.value).toBe('theirs')
    expect(markdown.value).toBe('mine')

    // Plain save refuses while in conflict; the user must choose.
    expect(await sync.saveMarkdown()).toBe(false)
    expect(mockPutMarkdown).toHaveBeenCalledTimes(1)
  })

  it('adoptRemote discards local edits and clears the conflict', async () => {
    const markdown = ref('mine')
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: 'base', contentHash: 'h1' })
    mockPutMarkdown.mockResolvedValueOnce({ ok: false, status: 412, conflict: true, remoteMarkdown: 'theirs', remoteHash: 'h9' })
    await sync.saveMarkdown()

    sync.adoptRemote()
    expect(markdown.value).toBe('theirs')
    expect(sync.conflict.value).toBe(false)
    expect(sync.saveState.value).toBe('saved')
  })

  it('overwriteRemote force-saves local edits without If-Match', async () => {
    const markdown = ref('mine')
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: 'base', contentHash: 'h1' })
    mockPutMarkdown.mockResolvedValueOnce({ ok: false, status: 412, conflict: true, remoteMarkdown: 'theirs', remoteHash: 'h9' })
    await sync.saveMarkdown()

    mockPutMarkdown.mockResolvedValueOnce(okPut)
    expect(await sync.overwriteRemote()).toBe(true)
    expect(mockPutMarkdown).toHaveBeenLastCalledWith('abc123', 'mine', undefined, expect.objectContaining({ ifMatch: null }))
    expect(sync.conflict.value).toBe(false)
    expect(sync.saveState.value).toBe('saved')
  })

  // ── Polling ──────────────────────────────────────────────────────────────

  it('polling calls pollPaste when pasteId is set', async () => {
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([])
    const ops = makeLocalOps(comments)

    useSync(pasteId, comments, ref(''), ops)

    await vi.advanceTimersByTimeAsync(0)
    expect(mockPollPaste).toHaveBeenCalledWith('abc123', null)
  })

  it('first poll adopts server comments and markdown as the baseline', async () => {
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([])
    const markdown = ref('old content')
    const ops = makeLocalOps(comments)
    const serverComment = makeComment({ id: 'srv1', body: 'from server' })
    mockPollPaste.mockResolvedValue(serverState('new content', [serverComment]))

    const sync = useSync(pasteId, comments, markdown, ops)

    await vi.advanceTimersByTimeAsync(0)
    expect(ops.loadComments).toHaveBeenCalledWith([serverComment])
    expect(markdown.value).toBe('new content')
    expect(sync.saveState.value).toBe('saved')
  })

  it('REGRESSION: a poll after a comment is added must not overwrite unsaved local edits', async () => {
    const pasteId = ref<string | null>('abc123')
    const comments = ref<Comment[]>([])
    const markdown = ref('')
    const ops = makeLocalOps(comments)
    mockPollPaste.mockResolvedValue(serverState('original', []))
    const sync = useSync(pasteId, comments, markdown, ops)
    await vi.advanceTimersByTimeAsync(0)
    expect(markdown.value).toBe('original')

    // User edits for a while without saving.
    markdown.value = 'original + 20 minutes of edits'
    expect(sync.isDirty.value).toBe(true)

    // Adding a comment changes the server ETag → the next poll returns the full doc.
    const serverComment = makeComment({ id: 'srv1' })
    mockPostComment.mockResolvedValue(serverComment)
    await sync.addComment({ startLine: 0, endLine: 1, selectedText: 'x', body: 'c', category: 'nit' })
    mockPollPaste.mockResolvedValue(serverState('original', [serverComment], 'h1', '"e2"'))
    await vi.advanceTimersByTimeAsync(5000)

    expect(markdown.value).toBe('original + 20 minutes of edits')
    expect(sync.isDirty.value).toBe(true)
    expect(sync.conflict.value).toBe(false) // server content itself did not change
    expect(comments.value.map(c => c.id)).toEqual(['srv1'])
  })

  it('a poll that sees changed server content while local is dirty flags a conflict and keeps local', async () => {
    const markdown = ref('')
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    mockPollPaste.mockResolvedValue(serverState('v1'))
    await vi.advanceTimersByTimeAsync(0)

    markdown.value = 'v1 + mine'
    mockPollPaste.mockResolvedValue(serverState('v2 from agent', [], 'h2', '"e2"'))
    await vi.advanceTimersByTimeAsync(5000)

    expect(markdown.value).toBe('v1 + mine')
    expect(sync.conflict.value).toBe(true)
    expect(sync.remoteMarkdown.value).toBe('v2 from agent')
    expect(sync.saveState.value).toBe('conflict')
  })

  it('a poll adopts server content when local is clean', async () => {
    const markdown = ref('')
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    mockPollPaste.mockResolvedValue(serverState('v1'))
    await vi.advanceTimersByTimeAsync(0)
    mockPollPaste.mockResolvedValue(serverState('v2', [], 'h2', '"e2"'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(markdown.value).toBe('v2')
    expect(sync.saveState.value).toBe('saved')
  })

  it('a poll that fails marks the session offline until the next success', async () => {
    const sync = useSync(ref('abc123'), ref([]), ref(''), makeLocalOps(ref([])))
    mockPollPaste.mockResolvedValue({ data: null, etag: null, notModified: false, status: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.syncStatus.value).toBe('error')
    mockPollPaste.mockResolvedValue(notModified)
    await vi.advanceTimersByTimeAsync(5000)
    expect(sync.syncStatus.value).toBe('synced')
  })

  it('setBaseline right after setting pasteId is not wiped by the pasteId watcher', async () => {
    const pasteId = ref<string | null>(null)
    const markdown = ref('doc')
    const sync = useSync(pasteId, ref([]), markdown, makeLocalOps(ref([])))
    pasteId.value = 'new-id'
    sync.setBaseline({ markdown: 'doc', contentHash: 'h1', etag: '"e1"' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.saveState.value).toBe('saved')
    expect(mockPollPaste).toHaveBeenCalledWith('new-id', '"e1"')
  })

  it('restoreDraft re-applies unsaved edits; flags conflict only if the server moved since', async () => {
    const markdown = ref('server v1')
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: 'server v1', contentHash: 'h1' })

    sync.restoreDraft('server v1 + draft', 'server v1')
    expect(markdown.value).toBe('server v1 + draft')
    expect(sync.isDirty.value).toBe(true)
    expect(sync.conflict.value).toBe(false)

    sync.setBaseline({ markdown: 'server v2', contentHash: 'h2' })
    markdown.value = 'server v2'
    sync.restoreDraft('server v1 + draft', 'server v1')
    expect(markdown.value).toBe('server v1 + draft')
    expect(sync.conflict.value).toBe(true)
  })

  it('polling stops when pasteId is cleared', async () => {
    const pasteId = ref<string | null>('abc123')
    const ops = makeLocalOps(ref([]))

    useSync(pasteId, ref([]), ref(''), ops)

    await vi.advanceTimersByTimeAsync(0)
    mockPollPaste.mockClear()

    pasteId.value = null
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockPollPaste).not.toHaveBeenCalled()
  })

  // ── Replies ──────────────────────────────────────────────────────────────

  it('in local mode, addReply delegates to localOps', () => {
    const pasteId = ref<string | null>(null)
    const existing = makeComment({ id: 'c1' })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    const sync = useSync(pasteId, comments, ref(''), ops)

    sync.addReply('c1', { body: 'reply text' })

    expect(ops.addReply).toHaveBeenCalledWith('c1', { body: 'reply text' })
    expect(mockPostReply).not.toHaveBeenCalled()
  })

  it('in shared mode, addReply calls API and swaps in the server reply', async () => {
    const pasteId = ref<string | null>('abc123')
    const existing = makeComment({ id: 'c1' })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    const serverReply = { id: 'r1', body: 'reply text', createdAt: Date.now() }
    mockPostReply.mockResolvedValue(serverReply)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.addReply('c1', { body: 'reply text' })

    expect(mockPostReply).toHaveBeenCalledWith('abc123', 'c1', { body: 'reply text' })
    expect(comments.value[0].replies.map(r => r.id)).toEqual(['r1'])
  })

  it('in shared mode, editReply calls PUT API', async () => {
    const pasteId = ref<string | null>('abc123')
    const reply = { id: 'r1', body: 'original', createdAt: Date.now() }
    const existing = makeComment({ id: 'c1', replies: [reply] })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockPutReply.mockResolvedValue({ ...reply, body: 'updated' })

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.editReply('c1', 'r1', 'updated')

    expect(mockPutReply).toHaveBeenCalledWith('abc123', 'c1', 'r1', { body: 'updated' })
  })

  it('in shared mode, deleteReply calls DELETE API', async () => {
    const pasteId = ref<string | null>('abc123')
    const reply = { id: 'r1', body: 'text', createdAt: Date.now() }
    const existing = makeComment({ id: 'c1', replies: [reply] })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockDeleteReplyApi.mockResolvedValue(true)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.deleteReply('c1', 'r1')

    expect(mockDeleteReplyApi).toHaveBeenCalledWith('abc123', 'c1', 'r1')
  })

  it('keeps a failed reply locally and reports an error', async () => {
    const pasteId = ref<string | null>('abc123')
    const existing = makeComment({ id: 'c1' })
    const comments = ref<Comment[]>([existing])
    const ops = makeLocalOps(comments)
    mockPostReply.mockResolvedValue(null)

    const sync = useSync(pasteId, comments, ref(''), ops)
    await sync.addReply('c1', { body: 'reply' })

    expect(ops.addReply).toHaveBeenCalledWith('c1', { body: 'reply' })
    expect(comments.value[0].replies).toHaveLength(1)
    expect(sync.syncStatus.value).toBe('error')
  })
})

describe('useSync — delta saves', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockPollPaste.mockResolvedValue(notModified)
  })
  afterEach(() => { vi.useRealTimers() })

  it('sends only the changed span when the base hash is known', async () => {
    const big = 'x'.repeat(5000)
    const markdown = ref(big)
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: big, contentHash: 'h1' })
    markdown.value = big.slice(0, 2500) + 'NEW' + big.slice(2500)
    mockPutMarkdown.mockResolvedValue(okPut)

    expect(await sync.saveMarkdown()).toBe(true)
    expect(mockPutMarkdown).toHaveBeenCalledTimes(1)
    const opts = mockPutMarkdown.mock.calls[0][3]
    expect(opts.ifMatch).toBe('h1')
    expect(opts.delta).toEqual({ keepStart: 2500, keepEnd: 2500, insert: 'NEW' })
    expect(sync.saveState.value).toBe('saved')
  })

  it('falls back to the full document when the server ignores the delta (older server)', async () => {
    const markdown = ref('base text that is long enough to make a delta worthwhile ' + 'y'.repeat(200))
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: markdown.value, contentHash: 'h1' })
    markdown.value = markdown.value + '!'
    mockPutMarkdown
      .mockResolvedValueOnce({ ok: true, status: 200, contentHash: null, deltaIgnored: true })
      .mockResolvedValueOnce(okPut)

    expect(await sync.saveMarkdown()).toBe(true)
    expect(mockPutMarkdown).toHaveBeenCalledTimes(2)
    expect(mockPutMarkdown.mock.calls[0][3].delta).toBeDefined()
    expect(mockPutMarkdown.mock.calls[1][3].delta).toBeUndefined()
    expect(sync.saveState.value).toBe('saved')
  })

  it('falls back to the full document when the server rejects the delta (409)', async () => {
    const markdown = ref('z'.repeat(300))
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: markdown.value, contentHash: 'h1' })
    markdown.value = 'Q' + markdown.value
    mockPutMarkdown
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValueOnce(okPut)
    expect(await sync.saveMarkdown()).toBe(true)
    expect(mockPutMarkdown).toHaveBeenCalledTimes(2)
    expect(mockPutMarkdown.mock.calls[1][3].delta).toBeUndefined()
  })

  it('a 412 on a delta save is a conflict, not a fallback', async () => {
    const markdown = ref('w'.repeat(300))
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: markdown.value, contentHash: 'h1' })
    markdown.value = markdown.value + 'mine'
    mockPutMarkdown.mockResolvedValueOnce({ ok: false, status: 412, conflict: true, remoteMarkdown: 'theirs', remoteHash: 'h9' })
    expect(await sync.saveMarkdown()).toBe(false)
    expect(mockPutMarkdown).toHaveBeenCalledTimes(1)
    expect(sync.saveState.value).toBe('conflict')
  })

  it('sends the full document when the base hash is unknown, when forcing, or when the delta is not smaller', async () => {
    const markdown = ref('short')
    const sync = useSync(ref('abc123'), ref([]), markdown, makeLocalOps(ref([])))
    sync.setBaseline({ markdown: 'base' }) // no hash
    mockPutMarkdown.mockResolvedValue(okPut)
    await sync.saveMarkdown()
    expect(mockPutMarkdown.mock.calls[0][3].delta).toBeUndefined()

    markdown.value = 'completely different tiny doc'
    await sync.overwriteRemote()
    expect(mockPutMarkdown.mock.calls[1][3].delta).toBeUndefined()
  })
})
