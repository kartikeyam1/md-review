import { computed, ref } from 'vue'
import type { Comment, Reply } from '@/types'

type NewComment = Omit<Comment, 'id' | 'createdAt' | 'replies'>

export function useComments() {
  const _comments = ref<Comment[]>([])

  const comments = computed(() =>
    [..._comments.value].sort((a, b) => a.startLine - b.startLine)
  )

  function addComment(input: NewComment) {
    _comments.value.push({
      ...input,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      replies: [],
    })
  }

  function editComment(id: string, updates: Partial<Pick<Comment, 'body' | 'category'>>) {
    const idx = _comments.value.findIndex((c) => c.id === id)
    if (idx !== -1) {
      _comments.value[idx] = { ..._comments.value[idx], ...updates }
    }
  }

  function deleteComment(id: string) {
    _comments.value = _comments.value.filter((c) => c.id !== id)
  }

  function clearComments() {
    _comments.value = []
  }

  function loadComments(loaded: Comment[]) {
    _comments.value = loaded.map((c) => ({
      ...c,
      replies: c.replies ?? [],
    }))
  }

  function addReply(commentId: string, input: { body: string; author?: string }): Reply {
    const idx = _comments.value.findIndex((c) => c.id === commentId)
    if (idx === -1) throw new Error(`Comment ${commentId} not found`)
    const reply: Reply = {
      id: crypto.randomUUID(),
      body: input.body,
      createdAt: Date.now(),
      ...(input.author !== undefined && { author: input.author }),
    }
    _comments.value[idx] = {
      ..._comments.value[idx],
      replies: [..._comments.value[idx].replies, reply],
    }
    return reply
  }

  function editReply(commentId: string, replyId: string, body: string) {
    const idx = _comments.value.findIndex((c) => c.id === commentId)
    if (idx === -1) return
    _comments.value[idx] = {
      ..._comments.value[idx],
      replies: _comments.value[idx].replies.map((r) =>
        r.id === replyId ? { ...r, body } : r
      ),
    }
  }

  function resolveComment(id: string, resolvedBy?: string) {
    const idx = _comments.value.findIndex((c) => c.id === id)
    if (idx !== -1) {
      _comments.value[idx] = { ..._comments.value[idx], resolved: true, resolved_by: resolvedBy || null, resolved_at: Date.now() }
    }
  }

  function unresolveComment(id: string) {
    const idx = _comments.value.findIndex((c) => c.id === id)
    if (idx !== -1) {
      _comments.value[idx] = { ..._comments.value[idx], resolved: false, resolved_by: null, resolved_at: null }
    }
  }

  function deleteReply(commentId: string, replyId: string) {
    const idx = _comments.value.findIndex((c) => c.id === commentId)
    if (idx === -1) return
    _comments.value[idx] = {
      ..._comments.value[idx],
      replies: _comments.value[idx].replies.filter((r) => r.id !== replyId),
    }
  }

  return {
    comments, addComment, editComment, deleteComment,
    clearComments, loadComments,
    addReply, editReply, deleteReply,
    resolveComment, unresolveComment,
  }
}
