import { ref } from 'vue'
import type { Comment, Reply, ApprovalInfo } from '@/types'

const PASTE_API = import.meta.env.VITE_PASTE_API_URL || ''

export interface SharedPayload {
  markdown: string
  filename: string
  comments: Comment[]
  sharedAt: string
  sessionName?: string
}

export function useShare() {
  const sharing = ref(false)
  const shareError = ref<string | null>(null)

  async function createShare(markdown: string, filename: string, comments: Comment[], sessionName?: string): Promise<string | null> {
    sharing.value = true
    shareError.value = null

    const payload: SharedPayload = {
      markdown,
      filename,
      comments,
      sharedAt: new Date().toISOString(),
    }
    if (sessionName) payload.sessionName = sessionName

    try {
      const res = await fetch(`${PASTE_API}/paste`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        shareError.value = `Server error (${res.status})`
        return null
      }

      const { id } = await res.json()
      return id as string
    } catch (e) {
      shareError.value = 'Could not reach paste service. Are you on VPN?'
      return null
    } finally {
      sharing.value = false
    }
  }

  async function loadShare(id: string): Promise<SharedPayload | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(id)}`)
      if (!res.ok) return null
      return await res.json() as SharedPayload
    } catch {
      return null
    }
  }

  function getShareIdFromHash(): string | null {
    const hash = window.location.hash
    const match = hash.match(/^#shared=([a-zA-Z0-9][a-zA-Z0-9-]*)$/)
    return match ? match[1] : null
  }

  function setShareHash(id: string) {
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}#shared=${id}`)
  }

  function getShareUrls(id: string) {
    const ui = `${window.location.origin}${window.location.pathname}#shared=${id}`
    const api = `${PASTE_API}/paste/${id}`
    return { ui, api, comments: `${api}/comments`, markdown: `${api}/markdown` }
  }

  async function fetchGithub(githubUrl: string): Promise<{ content: string; filename: string } | null> {
    try {
      const res = await fetch(`${PASTE_API}/github?url=${encodeURIComponent(githubUrl)}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }))
        shareError.value = data.error || `Server error (${res.status})`
        return null
      }
      return await res.json() as { content: string; filename: string }
    } catch {
      shareError.value = 'Could not reach server. Are you on VPN?'
      return null
    }
  }

  async function postComment(pasteId: string, comment: {
    startLine: number; endLine: number; selectedText: string;
    body: string; category: string; author?: string
  }): Promise<Comment | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comment),
      })
      if (!res.ok) return null
      return await res.json() as Comment
    } catch { return null }
  }

  async function putComment(pasteId: string, commentId: string, updates: {
    body?: string; category?: string
  }): Promise<Comment | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/comments/${commentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!res.ok) return null
      return await res.json() as Comment
    } catch { return null }
  }

  async function deleteCommentApi(pasteId: string, commentId: string): Promise<boolean> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/comments/${commentId}`, {
        method: 'DELETE',
      })
      return res.status === 204
    } catch { return false }
  }

  async function postReply(pasteId: string, commentId: string, reply: {
    body: string; author?: string
  }): Promise<Reply | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/comments/${commentId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reply),
      })
      if (!res.ok) return null
      return await res.json() as Reply
    } catch { return null }
  }

  async function putReply(pasteId: string, commentId: string, replyId: string, updates: {
    body: string
  }): Promise<Reply | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/comments/${commentId}/replies/${replyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!res.ok) return null
      return await res.json() as Reply
    } catch { return null }
  }

  async function deleteReplyApi(pasteId: string, commentId: string, replyId: string): Promise<boolean> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/comments/${commentId}/replies/${replyId}`, {
        method: 'DELETE',
      })
      return res.status === 204
    } catch { return false }
  }

  async function putMarkdown(pasteId: string, markdown: string, filename?: string): Promise<boolean> {
    try {
      const body: Record<string, string> = { markdown }
      if (filename) body.filename = filename
      const res = await fetch(`${PASTE_API}/paste/${pasteId}/markdown`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.ok
    } catch { return false }
  }

  async function getApproval(pasteId: string): Promise<ApprovalInfo | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(pasteId)}/approval`)
      if (!res.ok) return null
      return await res.json() as ApprovalInfo
    } catch { return null }
  }

  async function putApproval(pasteId: string, status: string, approvedBy?: string): Promise<any> {
    try {
      const body: Record<string, string> = { status }
      if (approvedBy) body.approved_by = approvedBy
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(pasteId)}/approval`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return await res.json()
    } catch { return null }
  }

  async function resolveCommentApi(pasteId: string, commentId: string, resolvedBy?: string): Promise<Comment | null> {
    try {
      const body: Record<string, string> = {}
      if (resolvedBy) body.resolved_by = resolvedBy
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(pasteId)}/comments/${commentId}/resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return null
      return await res.json() as Comment
    } catch { return null }
  }

  async function unresolveCommentApi(pasteId: string, commentId: string): Promise<Comment | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(pasteId)}/comments/${commentId}/unresolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) return null
      return await res.json() as Comment
    } catch { return null }
  }

  async function pollPaste(pasteId: string, etag: string | null): Promise<{
    data: SharedPayload | null; etag: string | null; notModified: boolean
  }> {
    try {
      const headers: Record<string, string> = {}
      if (etag) headers['If-None-Match'] = etag
      const res = await fetch(`${PASTE_API}/paste/${pasteId}`, { headers })
      if (res.status === 304) return { data: null, etag, notModified: true }
      if (!res.ok) return { data: null, etag: null, notModified: false }
      const newEtag = res.headers.get('etag')
      const data = await res.json() as SharedPayload
      return { data, etag: newEtag, notModified: false }
    } catch { return { data: null, etag: null, notModified: false } }
  }

  return {
    sharing, shareError, createShare, loadShare, fetchGithub,
    getShareIdFromHash, setShareHash, getShareUrls,
    postComment, putComment, deleteCommentApi,
    postReply, putReply, deleteReplyApi,
    putMarkdown, pollPaste,
    getApproval, putApproval, resolveCommentApi, unresolveCommentApi,
  }
}
