import { computed, ref } from 'vue'
import type { Comment } from '@/types'

type NewComment = Omit<Comment, 'id' | 'createdAt'>

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
    _comments.value = loaded
  }

  return { comments, addComment, editComment, deleteComment, clearComments, loadComments }
}
