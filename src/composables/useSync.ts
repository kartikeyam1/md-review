import { ref, computed, watch, onUnmounted, type Ref } from 'vue'
import type { Comment, Reply } from '@/types'
import { useShare, type SharedPayload } from '@/composables/useShare'
import { computeDelta, deltaSize } from '@/composables/useDelta'

type NewComment = Omit<Comment, 'id' | 'createdAt' | 'replies'>

/**
 * Where the local document stands relative to the server copy.
 *  idle     — not a shared session (or baseline not loaded yet)
 *  saved    — local == server
 *  dirty    — local has edits not yet written
 *  saving   — a write is in flight
 *  error    — the last write failed (network / 5xx); edits are kept locally
 *  conflict — the server copy changed while local had unsaved edits
 */
export type SaveState = 'idle' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

export interface SyncBaseline {
  markdown: string
  filename?: string | null
  contentHash?: string | null
  etag?: string | null
}

interface PendingOp {
  kind: 'add' | 'edit' | 'delete' | 'reply' | 'resolve'
  /** Server-side comment id this op targets (absent for a not-yet-created comment). */
  commentId?: string
  /** Client-generated id of a comment awaiting creation. */
  localCommentId?: string
  attempts: number
  run: () => Promise<boolean>
}

const MAX_OP_ATTEMPTS = 12 // ~1 minute of polls before giving up on one op

export function useSync(
  pasteId: Ref<string | null>,
  comments: Ref<Comment[]>,
  markdown: Ref<string>,
  localOps: {
    addComment: (input: NewComment) => void
    editComment: (id: string, updates: Partial<Pick<Comment, 'body' | 'category'>>) => void
    deleteComment: (id: string) => void
    loadComments: (comments: Comment[]) => void
    addReply: (commentId: string, input: { body: string; author?: string }) => Reply
    editReply: (commentId: string, replyId: string, body: string) => void
    deleteReply: (commentId: string, replyId: string) => void
    resolveComment: (id: string, resolvedBy?: string) => void
    unresolveComment: (id: string) => void
  },
  options: {
    /** Tracked alongside markdown so renames are saved too. */
    filename?: Ref<string>
    pollIntervalMs?: number
  } = {},
) {
  const {
    postComment, putComment, deleteCommentApi, postReply, putReply, deleteReplyApi,
    putMarkdown, pollPaste, resolveCommentApi, unresolveCommentApi,
  } = useShare()

  const filenameRef = options.filename
  const pollIntervalMs = options.pollIntervalMs ?? 5000

  // ── Server baseline ──────────────────────────────────────────────────────
  // What we last knew the server to hold. `null` until the first load — until
  // then we cannot tell local edits from "not loaded yet", so we neither save
  // nor detect conflicts.
  const serverMarkdown = ref<string | null>(null)
  const serverFilename = ref<string | null>(null)
  let contentHash: string | null = null
  let etag: string | null = null

  /** Server content observed while local had unsaved edits (conflict). */
  const remoteMarkdown = ref<string | null>(null)
  let remoteHash: string | null = null

  const saving = ref(false)
  const saveError = ref(false)
  const conflict = ref(false)
  const syncError = ref(false)
  const pending: PendingOp[] = []
  const pendingCount = ref(0)

  const isShared = computed(() => !!pasteId.value)

  const isDirty = computed(() => {
    if (!pasteId.value || serverMarkdown.value === null) return false
    if (markdown.value !== serverMarkdown.value) return true
    if (filenameRef && serverFilename.value !== null && filenameRef.value !== serverFilename.value) return true
    return false
  })

  const saveState = computed<SaveState>(() => {
    if (!pasteId.value) return 'idle'
    if (conflict.value) return 'conflict'
    if (saving.value) return 'saving'
    if (saveError.value) return 'error'
    if (isDirty.value) return 'dirty'
    return serverMarkdown.value === null ? 'idle' : 'saved'
  })

  // "Offline" while the last request failed OR while any comment change is
  // still waiting in the outbox — a reachable server does not mean we are in sync.
  const syncStatus = computed<'local' | 'synced' | 'error'>(() => {
    if (!pasteId.value) return 'local'
    return (syncError.value || pendingCount.value > 0) ? 'error' : 'synced'
  })

  // Which session the current baseline belongs to. Lets a caller set pasteId
  // and the baseline back-to-back without the pasteId watcher wiping it.
  let baselineId: string | null = null
  // Set when a locally persisted draft is on screen but its server baseline is
  // unknown (e.g. restored while offline): the first poll must not clobber it.
  let expectingDraft = false

  function setBaseline(base: SyncBaseline) {
    baselineId = pasteId.value
    expectingDraft = false
    serverMarkdown.value = base.markdown
    serverFilename.value = base.filename ?? null
    contentHash = base.contentHash ?? null
    etag = base.etag ?? null
    conflict.value = false
    remoteMarkdown.value = null
    remoteHash = null
    saveError.value = false
  }

  function expectDraft() {
    baselineId = pasteId.value
    expectingDraft = true
  }

  function resetBaseline() {
    expectingDraft = false
    serverMarkdown.value = null
    serverFilename.value = null
    contentHash = null
    etag = null
    conflict.value = false
    remoteMarkdown.value = null
    remoteHash = null
    saveError.value = false
    syncError.value = false
    pending.length = 0
    pendingCount.value = 0
  }

  /**
   * Re-apply a locally persisted draft on top of a freshly loaded baseline.
   * If the server still holds what the draft was based on, the draft simply
   * becomes unsaved edits (autosave will write it). If the server moved on,
   * keep the draft locally and flag a conflict for the user to resolve.
   */
  function restoreDraft(draftMarkdown: string, draftBase: string | null) {
    if (draftMarkdown === markdown.value) return
    markdown.value = draftMarkdown
    if (draftBase !== null && serverMarkdown.value !== null && draftBase !== serverMarkdown.value) {
      conflict.value = true
      remoteMarkdown.value = serverMarkdown.value
      remoteHash = contentHash
    }
  }

  // ── Comment ops with an outbox ───────────────────────────────────────────
  // Every mutation is applied locally first, then sent. On failure the op is
  // queued and retried on each poll; while queued, the server's copy of that
  // comment never overwrites the local one.

  function updatePendingCount() { pendingCount.value = pending.length }

  async function attempt(op: Omit<PendingOp, 'attempts'>) {
    const ok = await op.run()
    if (ok) {
      syncError.value = false
      return
    }
    syncError.value = true
    pending.push({ ...op, attempts: 1 })
    updatePendingCount()
  }

  async function drainPending() {
    if (pending.length === 0) return
    for (const op of [...pending]) {
      const ok = await op.run()
      const idx = pending.indexOf(op)
      if (ok) {
        if (idx !== -1) pending.splice(idx, 1)
      } else {
        op.attempts++
        if (op.attempts >= MAX_OP_ATTEMPTS) {
          console.warn('[md-review] giving up on unsynced comment change', op.kind, op.commentId ?? op.localCommentId)
          if (idx !== -1) pending.splice(idx, 1)
        }
        break // network is probably still down — try the rest next poll
      }
    }
    updatePendingCount()
  }

  function mergeComments(server: Comment[]): Comment[] {
    if (pending.length === 0) return server
    const localById = new Map(comments.value.map(c => [c.id, c]))
    const touched = new Set<string>()
    const deleted = new Set<string>()
    for (const op of pending) {
      if (op.commentId) touched.add(op.commentId)
      if (op.localCommentId) touched.add(op.localCommentId)
      if (op.kind === 'delete' && op.commentId) deleted.add(op.commentId)
    }
    const merged = server
      .filter(c => !deleted.has(c.id))
      .map(c => (touched.has(c.id) && localById.has(c.id)) ? localById.get(c.id)! : c)
    const present = new Set(merged.map(c => c.id))
    for (const op of pending) {
      if (op.kind === 'add' && op.localCommentId && !present.has(op.localCommentId)) {
        const local = localById.get(op.localCommentId)
        if (local) { merged.push(local); present.add(local.id) }
      }
    }
    return merged
  }

  function replaceComment(id: string, next: Comment) {
    localOps.loadComments(comments.value.map(c => c.id === id ? next : c))
  }

  async function addComment(input: NewComment) {
    if (!pasteId.value) {
      localOps.addComment(input)
      return
    }
    const id = pasteId.value
    const before = new Set(comments.value.map(c => c.id))
    localOps.addComment(input)
    const local = comments.value.find(c => !before.has(c.id))
    const localId = local?.id
    await attempt({
      kind: 'add',
      localCommentId: localId,
      run: async () => {
        const result = await postComment(id, input)
        if (!result) return false
        if (localId) replaceComment(localId, result)
        else localOps.loadComments([...comments.value, result])
        return true
      },
    })
  }

  async function editComment(id: string, updates: Partial<Pick<Comment, 'body' | 'category'>>) {
    if (!pasteId.value) {
      localOps.editComment(id, updates)
      return
    }
    const paste = pasteId.value
    localOps.editComment(id, updates)
    await attempt({
      kind: 'edit',
      commentId: id,
      run: async () => {
        const result = await putComment(paste, id, updates)
        if (!result) return false
        replaceComment(id, result)
        return true
      },
    })
  }

  async function deleteComment(id: string) {
    if (!pasteId.value) {
      localOps.deleteComment(id)
      return
    }
    const paste = pasteId.value
    localOps.deleteComment(id)
    await attempt({
      kind: 'delete',
      commentId: id,
      run: () => deleteCommentApi(paste, id),
    })
  }

  async function addReply(commentId: string, input: { body: string; author?: string }) {
    if (!pasteId.value) {
      localOps.addReply(commentId, input)
      return
    }
    const paste = pasteId.value
    const localReply = localOps.addReply(commentId, input)
    await attempt({
      kind: 'reply',
      commentId,
      run: async () => {
        const result = await postReply(paste, commentId, input)
        if (!result) return false
        localOps.loadComments(comments.value.map(c =>
          c.id === commentId
            ? { ...c, replies: c.replies.map(r => r.id === localReply.id ? result : r) }
            : c
        ))
        return true
      },
    })
  }

  async function editReply(commentId: string, replyId: string, body: string) {
    if (!pasteId.value) {
      localOps.editReply(commentId, replyId, body)
      return
    }
    const paste = pasteId.value
    localOps.editReply(commentId, replyId, body)
    await attempt({
      kind: 'reply',
      commentId,
      run: async () => {
        const result = await putReply(paste, commentId, replyId, { body })
        if (!result) return false
        localOps.loadComments(comments.value.map(c =>
          c.id === commentId
            ? { ...c, replies: c.replies.map(r => r.id === replyId ? result : r) }
            : c
        ))
        return true
      },
    })
  }

  async function deleteReply(commentId: string, replyId: string) {
    if (!pasteId.value) {
      localOps.deleteReply(commentId, replyId)
      return
    }
    const paste = pasteId.value
    localOps.deleteReply(commentId, replyId)
    await attempt({
      kind: 'reply',
      commentId,
      run: () => deleteReplyApi(paste, commentId, replyId),
    })
  }

  async function resolveComment(commentId: string, resolvedBy?: string) {
    if (!pasteId.value) {
      localOps.resolveComment(commentId, resolvedBy)
      return
    }
    const paste = pasteId.value
    localOps.resolveComment(commentId, resolvedBy)
    await attempt({
      kind: 'resolve',
      commentId,
      run: async () => {
        const result = await resolveCommentApi(paste, commentId, resolvedBy)
        if (!result) return false
        replaceComment(commentId, result)
        return true
      },
    })
  }

  async function unresolveComment(commentId: string) {
    if (!pasteId.value) {
      localOps.unresolveComment(commentId)
      return
    }
    const paste = pasteId.value
    localOps.unresolveComment(commentId)
    await attempt({
      kind: 'resolve',
      commentId,
      run: async () => {
        const result = await unresolveCommentApi(paste, commentId)
        if (!result) return false
        replaceComment(commentId, result)
        return true
      },
    })
  }

  // ── Document save ────────────────────────────────────────────────────────

  let inflight: Promise<boolean> | null = null

  /**
   * Write the local document to the server.
   *  - No-op (returns true) when the baseline is known and nothing changed.
   *  - Sends If-Match so a server copy that moved is never overwritten
   *    silently: that becomes `conflict` and the local edits are kept.
   *  - `force` overwrites regardless (used by "keep my version").
   *  - `keepalive` lets the write outlive the page (tab close).
   */
  async function saveMarkdown(opts: { force?: boolean; keepalive?: boolean; filename?: string } = {}): Promise<boolean> {
    if (!pasteId.value) return false
    if (inflight) await inflight.catch(() => false)
    if (!opts.force && serverMarkdown.value !== null && !isDirty.value && !saveError.value && !conflict.value) return true
    if (conflict.value && !opts.force) return false

    inflight = doSave(opts)
    try { return await inflight } finally { inflight = null }
  }

  async function doSave(opts: { force?: boolean; keepalive?: boolean; filename?: string }): Promise<boolean> {
    const id = pasteId.value!
    const snapshotMarkdown = markdown.value
    const snapshotFilename = opts.filename ?? filenameRef?.value
    const sendFilename = snapshotFilename && snapshotFilename !== serverFilename.value ? snapshotFilename : undefined

    saving.value = true
    const result = await putDocument(id, snapshotMarkdown, sendFilename, opts)
    saving.value = false

    if (pasteId.value !== id) return false // session changed under us

    if (result.ok) {
      serverMarkdown.value = snapshotMarkdown
      if (sendFilename) serverFilename.value = sendFilename
      contentHash = result.contentHash ?? null
      etag = null // let the next poll pick up the new server ETag
      conflict.value = false
      remoteMarkdown.value = null
      remoteHash = null
      saveError.value = false
      syncError.value = false
      return true
    }
    if (result.conflict) {
      conflict.value = true
      remoteMarkdown.value = result.remoteMarkdown ?? null
      remoteHash = result.remoteHash ?? null
      return false
    }
    saveError.value = true
    syncError.value = true
    return false
  }

  /**
   * Write the document, sending only the changed span when we know the exact
   * server base (content_hash + baseline text) and that is cheaper than the
   * full document. Falls back to the full document when the server ignores
   * (older server) or rejects the delta — everything else about the write
   * (If-Match, 412 → conflict) is unchanged.
   */
  async function putDocument(id: string, snapshotMarkdown: string, sendFilename: string | undefined, opts: { force?: boolean; keepalive?: boolean }) {
    const ifMatch = opts.force ? null : contentHash
    const base = serverMarkdown.value
    if (ifMatch && base !== null && base !== snapshotMarkdown) {
      const delta = computeDelta(base, snapshotMarkdown)
      if (deltaSize(delta) < snapshotMarkdown.length) {
        const viaDelta = await putMarkdown(id, snapshotMarkdown, sendFilename, { ifMatch, keepalive: opts.keepalive, delta })
        const rejectedDelta = !viaDelta.ok && !viaDelta.conflict && (viaDelta.status === 400 || viaDelta.status === 409)
        if (!viaDelta.deltaIgnored && !rejectedDelta) return viaDelta
        // Old server (saved nothing of the content) or delta refused: send it all.
      }
    }
    return putMarkdown(id, snapshotMarkdown, sendFilename, { ifMatch, keepalive: opts.keepalive })
  }

  /** Conflict resolution: discard local edits, take the server copy. */
  function adoptRemote() {
    const remote = remoteMarkdown.value ?? serverMarkdown.value
    if (remote === null) return
    markdown.value = remote
    serverMarkdown.value = remote
    if (remoteHash) contentHash = remoteHash
    conflict.value = false
    remoteMarkdown.value = null
    remoteHash = null
    saveError.value = false
  }

  /** Conflict resolution: keep local edits, overwrite the server copy. */
  function overwriteRemote(): Promise<boolean> {
    return saveMarkdown({ force: true })
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  function applyServerState(data: SharedPayload) {
    localOps.loadComments(mergeComments(data.comments || []))

    const remoteMd = data.markdown ?? ''
    const remoteName = data.filename ?? null
    const hash = data.content_hash ?? null

    const firstLoad = serverMarkdown.value === null
    if (firstLoad && expectingDraft && markdown.value && markdown.value !== remoteMd) {
      // A restored draft is on screen and we only now learned what the server
      // holds: keep the draft, take the server copy as baseline, let the user decide.
      expectingDraft = false
      serverMarkdown.value = remoteMd
      serverFilename.value = remoteName
      contentHash = hash
      conflict.value = true
      remoteMarkdown.value = remoteMd
      remoteHash = hash
      return
    }
    expectingDraft = false
    if (firstLoad || !isDirty.value || remoteMd === markdown.value) {
      // Local is clean (or already equals the server) — adopt the server copy.
      if (markdown.value !== remoteMd) markdown.value = remoteMd
      if (filenameRef && remoteName && !filenameDirty() && filenameRef.value !== remoteName) filenameRef.value = remoteName
      serverMarkdown.value = remoteMd
      serverFilename.value = remoteName
      contentHash = hash ?? contentHash
      conflict.value = false
      remoteMarkdown.value = null
      remoteHash = null
      return
    }

    // Local has unsaved edits.
    if (remoteMd !== serverMarkdown.value) {
      // The server moved while we were editing — never clobber; flag it.
      conflict.value = true
      remoteMarkdown.value = remoteMd
      remoteHash = hash
    } else {
      // Only comments/meta changed; the content baseline is still ours.
      contentHash = hash ?? contentHash
    }
  }

  function filenameDirty(): boolean {
    return !!filenameRef && serverFilename.value !== null && filenameRef.value !== serverFilename.value
  }

  let polling = false
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function poll() {
    const id = pasteId.value
    if (!id || polling) return
    polling = true
    try {
      await drainPending()
      if (pasteId.value !== id) return
      const result = await pollPaste(id, etag)
      if (pasteId.value !== id) return
      if (result.notModified) {
        syncError.value = false
        return
      }
      if (!result.data) {
        syncError.value = true
        return
      }
      etag = result.etag
      applyServerState(result.data)
      syncError.value = false
    } finally {
      polling = false
    }
  }

  function startPolling() {
    stopPolling()
    poll()
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      poll()
    }, pollIntervalMs)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function onVisibilityChange() {
    if (!document.hidden && pasteId.value) poll()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  watch(pasteId, (id) => {
    if (id !== baselineId) {
      resetBaseline()
      baselineId = id
    }
    if (id) startPolling()
    else stopPolling()
  }, { immediate: true })

  onUnmounted(() => {
    stopPolling()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })

  return {
    addComment, editComment, deleteComment,
    addReply, editReply, deleteReply,
    resolveComment, unresolveComment,
    saveMarkdown, adoptRemote, overwriteRemote,
    setBaseline, expectDraft, restoreDraft, pollNow: poll,
    syncStatus, saveState, isShared, isDirty, conflict, remoteMarkdown, serverMarkdown, pendingCount,
  }
}
