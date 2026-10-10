import { ref } from 'vue'
import type { Comment, Reply, ApprovalInfo, ContentType, DocMode } from '@/types'
import type { TextDelta } from '@/composables/useDelta'
import { docShareUrl, encodeFilePath } from '@/composables/useRouter'
import { editHeaders, settleAccess, checkWriteStatus, saveToken, type DocAccess } from '@/composables/useEditToken'
import { PASTE_API } from '@/composables/pasteApi'

/** Identifies content writes from the browser UI in the revision history. */
const CLIENT_HEADER = { 'X-MdReview-Client': 'ui' }

export interface RevisionEntry {
  hash: string
  /** ISO time of the (first) write in this revision. */
  at: string
  /** ISO time of the last write when several were folded into one revision. */
  at_end?: string | null
  by: string | null
  client: 'ui' | 'mcp' | 'api' | null
  size: number | null
  parent: string | null
  writes?: number
  /** Seeded from a session that predates revision history. */
  seeded?: boolean
}

export interface RevisionContent extends RevisionEntry {
  markdown: string
  is_current: boolean
  /** The doc's current mode and name (#2; additive, absent on older servers). */
  mode?: DocMode
  sessionName?: string | null
  filename?: string | null
}

export interface SharedPayload {
  markdown: string
  filename: string
  comments: Comment[]
  sharedAt: string
  sessionName?: string
  contentType?: ContentType
  slug?: string | null
  /** Per-doc mode (#2); absent on sessions that predate it (reads as review). */
  mode?: DocMode
  /** Latest content revision (server summary). */
  latest_revision?: { hash: string; at: string; by: string | null; client: string | null } | null
  /** Server-side hash of the stored markdown — the If-Match token for writes. */
  content_hash?: string
  /** ETag of the GET that produced this payload (attached client-side). */
  etag?: string | null
  /** The session id (#23; additive, absent on older servers). */
  id?: string
  /** Edit access for this browser (#23 rule 6; absent on older servers). */
  access?: DocAccess
  /** ISO expiry, absent/null = never (#23 expiry picker). */
  expires_at?: string | null
}

export interface PutMarkdownResult {
  ok: boolean
  status: number
  /** New content_hash after a successful write. */
  contentHash?: string | null
  /** True when the server rejected the write because its content moved (412). */
  conflict?: boolean
  /** On conflict: what the server currently holds. */
  remoteMarkdown?: string | null
  remoteFilename?: string | null
  remoteHash?: string | null
  /** A delta was sent but the server did not understand it (old server). */
  deltaIgnored?: boolean
}

export interface PutMarkdownOptions {
  /** Only write if the server still holds this content_hash. */
  ifMatch?: string | null
  /** Let the request outlive the page (pagehide / tab close). */
  keepalive?: boolean
  /** Reviewer name recorded on the revision this write creates. */
  author?: string
  /**
   * Send only the changed span instead of the whole document. Requires
   * `ifMatch`. A server that predates deltas answers 200 without a
   * content_hash; the result then carries `deltaIgnored` so the caller can
   * resend the full document.
   */
  delta?: TextDelta
}

// keepalive requests are capped at ~64 KB by browsers; above that fall back to
// a normal fetch (which the browser may cancel on unload — best effort).
const KEEPALIVE_MAX_BYTES = 60 * 1024

export function useShare() {
  const sharing = ref(false)
  const shareError = ref<string | null>(null)

  /** Returns the new session's id and slug (null when the server assigned none). The edit token (#23) is stored. */
  async function createShare(markdown: string, filename: string, comments: Comment[], sessionName?: string, contentType?: ContentType, author?: string, mode?: DocMode): Promise<{ id: string; slug: string | null } | null> {
    sharing.value = true
    shareError.value = null

    const payload: SharedPayload & { author?: string } = {
      markdown,
      filename,
      comments,
      sharedAt: new Date().toISOString(),
    }
    if (sessionName) payload.sessionName = sessionName
    if (contentType) payload.contentType = contentType
    if (author) payload.author = author
    if (mode) payload.mode = mode

    try {
      const res = await fetch(`${PASTE_API}/paste`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...CLIENT_HEADER },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        shareError.value = `Server error (${res.status})`
        return null
      }

      const { id, slug, editToken } = await res.json() as { id: string; slug?: string | null; editToken?: string }
      if (editToken) saveToken(id, editToken, slug)
      return { id, slug: slug || null }
    } catch (e) {
      shareError.value = 'Could not reach paste service. Are you on VPN?'
      return null
    } finally {
      sharing.value = false
    }
  }

  /**
   * Load a shared session. Returns the payload (with its ETag attached) or
   * null when unreachable. `status` distinguishes "gone" (404/410) from
   * transient failures so callers can decide whether to detach from the session.
   */
  async function loadShare(id: string): Promise<SharedPayload | null> {
    const result = await loadShareDetailed(id)
    return result.data
  }

  async function loadShareDetailed(id: string): Promise<{ data: SharedPayload | null; status: number }> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(id)}`, { headers: editHeaders(id) })
      if (!res.ok) return { data: null, status: res.status }
      const data = await res.json() as SharedPayload
      data.etag = res.headers.get('etag')
      settleAccess(id, data)
      return { data, status: res.status }
    } catch {
      return { data: null, status: 0 }
    }
  }

  /** Links for a shared doc. `key` is the slug when it has one, else the id (00 §6). */
  function getShareUrls(key: string) {
    const ui = docShareUrl(key)
    const api = `${PASTE_API}/paste/${key}`
    return { ui, api, comments: `${api}/comments`, markdown: `${api}/markdown` }
  }

  /** One file of a multi-file session (route d/<ID>/<FILE>, rule 8). */
  async function loadSessionFile(id: string, file: string): Promise<{ blob: Blob | null; type: string; status: number }> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(id)}/files/${encodeFilePath(file)}`)
      if (!res.ok) return { blob: null, type: '', status: res.status }
      return { blob: await res.blob(), type: res.headers.get('content-type') || '', status: res.status }
    } catch { return { blob: null, type: '', status: 0 } }
  }

  function sessionFileUrl(id: string, file: string): string {
    return `${PASTE_API}/paste/${encodeURIComponent(id)}/files/${encodeFilePath(file)}`
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
      // 404 means it is already gone — treat as success so a retry queue
      // does not spin forever on a comment someone else deleted.
      return res.status === 204 || res.status === 404
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
      return res.status === 204 || res.status === 404
    } catch { return false }
  }

  async function putMarkdown(
    pasteId: string,
    markdown: string,
    filename?: string,
    opts: PutMarkdownOptions = {},
  ): Promise<PutMarkdownResult> {
    try {
      const useDelta = !!opts.delta && !!opts.ifMatch
      const body: Record<string, unknown> = useDelta ? { delta: opts.delta } : { markdown }
      if (filename) body.filename = filename
      if (opts.author) body.author = opts.author
      const payload = JSON.stringify(body)
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...CLIENT_HEADER, ...editHeaders(pasteId) }
      if (opts.ifMatch) headers['If-Match'] = opts.ifMatch
      const init: RequestInit = { method: 'PUT', headers, body: payload }
      if (opts.keepalive && payload.length <= KEEPALIVE_MAX_BYTES) init.keepalive = true

      const res = await fetch(`${PASTE_API}/paste/${pasteId}/markdown`, init)
      checkWriteStatus(pasteId, res.status)
      if (res.status === 412) {
        const remote = await res.json().catch(() => ({})) as { markdown?: string; filename?: string; content_hash?: string }
        return {
          ok: false, status: 412, conflict: true,
          remoteMarkdown: remote.markdown ?? null,
          remoteFilename: remote.filename ?? null,
          remoteHash: remote.content_hash ?? null,
        }
      }
      if (!res.ok) return { ok: false, status: res.status }
      const data = await res.json().catch(() => ({})) as { content_hash?: string }
      const result: PutMarkdownResult = { ok: true, status: res.status, contentHash: data.content_hash ?? null }
      if (useDelta && !data.content_hash) result.deltaIgnored = true
      return result
    } catch { return { ok: false, status: 0 } }
  }

  async function getRevisions(pasteId: string): Promise<{ current: string | null; revisions: RevisionEntry[] } | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(pasteId)}/revisions`)
      if (!res.ok) return null
      return await res.json() as { current: string | null; revisions: RevisionEntry[] }
    } catch { return null }
  }

  /** `status` 410 = the revision is known but its content is no longer stored. */
  async function getRevision(pasteId: string, hash: string | 'current'): Promise<{ data: RevisionContent | null; status: number }> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(pasteId)}/revisions/${hash}`)
      if (!res.ok) return { data: null, status: res.status }
      return { data: await res.json() as RevisionContent, status: res.status }
    } catch { return { data: null, status: 0 } }
  }

  /** PUT /paste/:id/meta — true on 2xx. */
  async function putMeta(pasteId: string, updates: { mode?: DocMode; sessionName?: string; expiry_days?: number | null }): Promise<boolean> {
    return (await putMetaDetailed(pasteId, updates)) !== null
  }

  /** PUT /paste/:id/meta — the response body on 2xx, else null. */
  async function putMetaDetailed(pasteId: string, updates: { mode?: DocMode; sessionName?: string; expiry_days?: number | null }): Promise<{ expires_at?: string | null; expiry_days?: number | null } | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(pasteId)}/meta`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...editHeaders(pasteId) },
        body: JSON.stringify(updates),
      })
      checkWriteStatus(pasteId, res.status)
      if (!res.ok) return null
      return await res.json().catch(() => ({}))
    } catch { return null }
  }

  /**
   * POST /paste/:id/edit-token (#23 rule 7): rotate (with the token we hold) or
   * claim a legacy doc ("Make view-only"). The new token is stored.
   */
  async function claimEditToken(pasteId: string, docId?: string | null, slug?: string | null): Promise<string | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(pasteId)}/edit-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...editHeaders(pasteId) },
        body: '{}',
      })
      checkWriteStatus(pasteId, res.status)
      if (!res.ok) return null
      const { editToken } = await res.json() as { editToken?: string }
      if (!editToken) return null
      saveToken(docId || pasteId, editToken, slug)
      return editToken
    } catch { return null }
  }

  /** Comments of a session without loading the document (pinned revisions). */
  async function getComments(pasteId: string): Promise<Comment[] | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(pasteId)}/comments`)
      if (!res.ok) return null
      const data = await res.json() as { comments?: Comment[] }
      return Array.isArray(data.comments) ? data.comments : []
    } catch { return null }
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
    data: SharedPayload | null; etag: string | null; notModified: boolean; status: number
  }> {
    try {
      const headers: Record<string, string> = { ...editHeaders(pasteId) }
      if (etag) headers['If-None-Match'] = etag
      const res = await fetch(`${PASTE_API}/paste/${pasteId}`, { headers })
      if (res.status === 304) return { data: null, etag, notModified: true, status: 304 }
      if (!res.ok) return { data: null, etag: null, notModified: false, status: res.status }
      const newEtag = res.headers.get('etag')
      const data = await res.json() as SharedPayload
      data.etag = newEtag
      settleAccess(pasteId, data)
      return { data, etag: newEtag, notModified: false, status: res.status }
    } catch { return { data: null, etag: null, notModified: false, status: 0 } }
  }

  return {
    sharing, shareError, createShare, loadShare, loadShareDetailed, fetchGithub,
    getShareUrls, loadSessionFile, sessionFileUrl,
    postComment, putComment, deleteCommentApi,
    postReply, putReply, deleteReplyApi,
    putMarkdown, pollPaste,
    getRevisions, getRevision,
    getApproval, putApproval, resolveCommentApi, unresolveCommentApi,
    putMeta, putMetaDetailed, claimEditToken, getComments,
  }
}
