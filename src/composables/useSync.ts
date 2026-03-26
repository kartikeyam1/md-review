import { ref, computed, watch, onUnmounted, type Ref } from 'vue'
import type { Comment, CommentCategory } from '@/types'
import { useShare } from '@/composables/useShare'

type NewComment = Omit<Comment, 'id' | 'createdAt'>

export function useSync(
  pasteId: Ref<string | null>,
  comments: Ref<Comment[]>,
  markdown: Ref<string>,
  localOps: {
    addComment: (input: NewComment) => void
    editComment: (id: string, updates: Partial<Pick<Comment, 'body' | 'category'>>) => void
    deleteComment: (id: string) => void
    loadComments: (comments: Comment[]) => void
  },
) {
  const { postComment, putComment, deleteCommentApi, putMarkdown, pollPaste } = useShare()

  const syncError = ref(false)
  const syncStatus = computed<'local' | 'synced' | 'error'>(() => {
    if (!pasteId.value) return 'local'
    return syncError.value ? 'error' : 'synced'
  })

  let etag: string | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const isShared = computed(() => !!pasteId.value)

  async function addComment(input: NewComment) {
    if (!pasteId.value) {
      localOps.addComment(input)
      return
    }
    const result = await postComment(pasteId.value, input)
    if (result) {
      localOps.loadComments([...comments.value, result])
      syncError.value = false
    } else {
      localOps.addComment(input)
      syncError.value = true
    }
  }

  async function editComment(id: string, updates: Partial<Pick<Comment, 'body' | 'category'>>) {
    if (!pasteId.value) {
      localOps.editComment(id, updates)
      return
    }
    const result = await putComment(pasteId.value, id, updates)
    if (result) {
      localOps.loadComments(comments.value.map(c => c.id === id ? result : c))
      syncError.value = false
    } else {
      localOps.editComment(id, updates)
      syncError.value = true
    }
  }

  async function deleteComment(id: string) {
    if (!pasteId.value) {
      localOps.deleteComment(id)
      return
    }
    const ok = await deleteCommentApi(pasteId.value, id)
    if (ok) {
      localOps.loadComments(comments.value.filter(c => c.id !== id))
      syncError.value = false
    } else {
      localOps.deleteComment(id)
      syncError.value = true
    }
  }

  async function saveMarkdown(filename?: string): Promise<boolean> {
    if (!pasteId.value) return false
    const ok = await putMarkdown(pasteId.value, markdown.value, filename)
    syncError.value = !ok
    return ok
  }

  async function poll() {
    if (!pasteId.value) return
    const result = await pollPaste(pasteId.value, etag)
    if (result.notModified) return
    if (result.data) {
      localOps.loadComments(result.data.comments || [])
      markdown.value = result.data.markdown
      etag = result.etag
      syncError.value = false
    }
  }

  function startPolling() {
    stopPolling()
    poll()
    pollTimer = setInterval(poll, 5000)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  watch(pasteId, (id) => {
    if (id) startPolling()
    else { stopPolling(); etag = null }
  }, { immediate: true })

  onUnmounted(() => stopPolling())

  return { addComment, editComment, deleteComment, saveMarkdown, syncStatus, isShared }
}
