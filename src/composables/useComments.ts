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

  function deleteComment(id: string) {
    _comments.value = _comments.value.filter((c) => c.id !== id)
  }

  function clearComments() {
    _comments.value = []
  }

  return { comments, addComment, deleteComment, clearComments }
}
