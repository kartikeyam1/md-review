import { ref, shallowRef, computed, watch, provide } from 'vue'
import type { AppMode, PaneMode, ContentType, Comment, ApprovalInfo, DocMode } from '@/types'
import { useComments } from '@/composables/useComments'
import { usePersistence, useThemePersistence } from '@/composables/usePersistence'
import { useShare } from '@/composables/useShare'
import { useSync } from '@/composables/useSync'
import { useReviewer } from '@/composables/useReviewer'
import { docShareUrl, type Router, type RouterLocation, type Route } from '@/composables/useRouter'
import { useDocAxes, isEmbedLocation, isReadOnlyLocation, DOC_STATE, type ReaderView } from '@/composables/useDocState'
import { useRevisionTracking } from '@/composables/useRevisionTracking'
import { useAutosave } from '@/composables/useAutosave'
import { useCommentSelection } from '@/composables/useCommentSelection'
import { useDocModeSync } from '@/composables/useDocModeSync'
import { onTokenRejected, sameDoc, docIdOf, type DocAccess } from '@/composables/useEditToken'
import { saveLocalCopy, clearLocalCopy, type LocalCopy } from '@/composables/localCopy'
import { toast } from '@/composables/useToast'
import { markExternalChange } from '@/composables/useExternalChange'
import { createReactions } from '@/composables/useReactions'
import { createViews } from '@/composables/useViews'
import type { SharedPayload } from '@/composables/useShare'
import { docTitle as computeDocTitle } from '@/composables/useDocTitle'
import { PASTE_API } from '@/composables/pasteApi'
import { countAgentSections } from '@shared/agentSections.mjs'

/** How long the tab title waits after the last keystroke in the editor (#5 rule 18: within 1 s). */
const TITLE_TYPING_DELAY_MS = 300

// ── Doc state assembly (spec #2, 00 §4.1) ────────────────────────────────────
// Everything a document on screen is made of: its content, the shared session
// it is attached to (sync, comments, revisions, approval) and the axes. App
// creates it once (provideDocState) so it survives route changes (library and
// back keeps the attached doc); DocView, the header controls and the loaders
// inject it with useDocState(). Each concern is its own composable; this file
// only owns the base refs and wires the parts together.

export function createDocState(router: Router) {
  /**
   * While the unsaved-changes guard decides whether a shared doc may be left
   * (rule 13), the screen keeps showing that doc: `held` is its location.
   */
  const held = shallowRef<RouterLocation | null>(null)
  /** The location the screen renders: the held doc during a leave decision, else the URL's. */
  const viewLoc = computed(() => held.value ?? router.current.value)
  const route = computed<Route>(() => viewLoc.value.route)
  const embed = computed(() => isEmbedLocation(viewLoc.value))
  /** Pinned revisions, file routes and embeds are read-only (capability viewer, 00 §1.2). */
  const readOnly = computed(() => isReadOnlyLocation(viewLoc.value))
  /** routeKey() of the content currently in the editor/preview state ('landing' = a local doc). */
  const screenKey = ref<string | null>(null)
  /** The current doc route answered 404/410 (rule 10) — 'expired-revision' for a pinned 410. */
  const docMissing = ref<null | 'missing' | 'revision-gone'>(null)
  /** Pinned revision on screen (rule 7). */
  const pinnedInfo = ref<{ id: string; at: string | null } | null>(null)
  /** Non-text file on a file route (rule 8): an image or a download link. */
  const fileView = ref<null | { kind: 'image' | 'download'; url: string; name: string }>(null)

  const appMode = ref<AppMode>('upload')
  const paneMode = ref<PaneMode>('preview')
  /** #28/#29: read, agent or slides (the reader's view while paneMode is 'preview'; set from ?view=). */
  const readerView = ref<ReaderView>('read')
  const markdown = ref('')
  const filename = ref('')
  const contentType = ref<ContentType>('markdown')
  const pasteId = ref<string | null>(null)
  /** Per-doc mode (00 §1.4 defaults are applied by the loaders). */
  const mode = ref<DocMode>('publish')
  const showPromptModal = ref(false)
  const sidebarHidden = ref(false)
  /** One-line, dismissible status message (session gone, server unreachable…). */
  const notice = ref<string | null>(null)
  /** False until the previous draft has been restored from local storage. */
  const booted = ref(false)
  /** Dev-only ?filePath= loader (the e2e fixture harness). */
  const filePathParam = ref<string | null>(null)

  /** #23: edit access for the attached shared doc, from the latest GET (null = unknown/older server → editable). */
  const access = ref<DocAccess | null>(null)
  const canEdit = computed(() => !pasteId.value || access.value === null || access.value.can_edit)

  const axes = useDocAxes({ route, embed, paneMode, pasteId, mode, canEdit, readerView })
  const { capability, reviewUI } = axes

  const share = useShare()
  const modeSync = useDocModeSync({ mode, pasteId, share, canChange: () => capability.value === 'editor' })
  const { docMeta } = modeSync

  /** A server payload for the attached doc: header meta, mode and (#23) edit access. */
  function applyServerMeta(data: SharedPayload, requestedAt: number, o: { initial?: boolean } = {}) {
    const wasEditor = access.value === null || access.value.can_edit
    if (data.access) access.value = { ...data.access }
    modeSync.applyServerMeta(data, requestedAt, o)
    // A poll says this browser can no longer edit (token rotated elsewhere): same as a refused write.
    if (!o.initial && wasEditor && data.access?.protected && !data.access.can_edit) loseEditAccess(true)
  }

  /** Edits that never reached the server, set aside when the doc turned view-only (#23). */
  const localCopy = ref<LocalCopy | null>(null)

  /** Keep `text` as the doc's unsaved local copy (persisted, so a reload still offers it). */
  function setLocalCopy(text: string, name: string, reason?: LocalCopy['reason']) {
    const id = pasteId.value
    if (!id) return
    const copy: LocalCopy = { markdown: text, filename: name, at: new Date().toISOString() }
    if (reason) copy.reason = reason
    localCopy.value = copy
    saveLocalCopy(docIdOf(id), copy)
  }

  function discardLocalCopy() {
    if (pasteId.value) clearLocalCopy(docIdOf(pasteId.value))
    localCopy.value = null
  }

  /**
   * Conflict → "Use server version" (QA M6): the local edits are not thrown away but
   * set aside as a local copy (banner + History row), so the losing side stays recoverable.
   */
  function useServerVersion() {
    const server = sync.remoteMarkdown.value ?? sync.serverMarkdown.value
    if (server !== null && markdown.value !== server) setLocalCopy(markdown.value, filename.value, 'conflict')
    sync.adoptRemote()
  }

  /** Put the set-aside copy back in the editor as unsaved edits (one undo step), then drop it. */
  function restoreLocalCopy() {
    const copy = localCopy.value
    if (!copy || axes.capability.value !== 'editor') return
    markExternalChange(copy.markdown, 'local')
    markdown.value = copy.markdown
    discardLocalCopy()
    notice.value = 'Your set-aside edits are back in the editor as unsaved edits. They will autosave shortly.'
  }

  /**
   * #23 rule 9: this browser lost edit access (a write got 401/403, or a poll
   * says can_edit: false). Switch to viewer and the read view (rewriting
   * ?view=edit|split to read), set unsaved edits aside as a local copy — the
   * screen shows the server version — and say so once.
   */
  function loseEditAccess(wasEditor = access.value === null || access.value.can_edit) {
    access.value = { protected: true, can_edit: false }
    paneMode.value = 'preview'
    const v = router.query('view')
    if (v === 'edit' || v === 'split') router.setQueryParam('view', 'read')
    const server = sync.serverMarkdown.value
    if (server !== null && markdown.value !== server) {
      setLocalCopy(markdown.value, filename.value)
      sync.adoptRemote()
    }
    if (wasEditor) toast.info('This link is view-only', { key: 'view-only' })
  }

  // A write refused with 401/403 (the token is already dropped).
  onTokenRejected((key) => { if (sameDoc(key, pasteId.value)) loseEditAccess() })

  const reviewer = useReviewer()
  const commentsApi = useComments()
  const { comments, addComment, editComment, deleteComment, loadComments, addReply, editReply, deleteReply, resolveComment, unresolveComment } = commentsApi

  /** #24: reactions on a shared doc's own route (not embeds, pinned revisions or file routes). */
  const reactions = createReactions({ docId: pasteId, active: computed(() => !!pasteId.value && !embed.value && route.value.kind === 'doc') })

  const sync = useSync(pasteId, comments, markdown, {
    addComment, editComment, deleteComment, loadComments,
    addReply, editReply, deleteReply,
    resolveComment, unresolveComment,
  }, { filename, author: reviewer.reviewerName, onServerState: (data, at) => applyServerMeta(data, at), onPoll: () => reactions.refresh() })

  const revisions = useRevisionTracking({
    pasteId, serverHash: sync.serverHash, serverHashOrigin: sync.serverHashOrigin, pinnedInfo, route,
  })

  const { theme, setTheme } = useThemePersistence()

  const persistence = usePersistence(
    markdown,
    filename,
    comments,
    contentType,
    loadComments,
    (m) => { appMode.value = m === 'review' ? 'doc' : m },
    {
      pasteId,
      serverMarkdown: sync.serverMarkdown,
      baseHash: sync.baseHash,
      conflict: sync.conflict,
      mode,
      // Only what the current route shows is persisted: never a read-only view,
      // a doc being left, or a restored draft the landing route is not showing.
      paused: () => isReadOnlyLocation(router.current.value) || screenKey.value !== router.current.value.key,
    },
  )

  const approvalInfo = ref<ApprovalInfo | null>(null)

  const unresolvedMustFixCount = computed(() =>
    comments.value.filter(c => c.category === 'must-fix' && c.resolved !== true).length
  )

  async function refreshApproval() {
    if (pasteId.value) {
      approvalInfo.value = await share.getApproval(pasteId.value)
    }
  }

  const showShareModal = ref(false)
  const shareResult = ref<{ ui: string; api: string; comments: string; markdown: string } | null>(null)

  const autosave = useAutosave({ sync, markdown, filename, paneMode, canWrite: () => capability.value === 'editor', flushDraft: persistence.flushDraft })

  const commentSelection = useCommentSelection({ reviewUI, readOnly })

  /** Publish hides every review surface: drop a half-made comment with it. */
  watch(mode, (m) => { if (m === 'publish') commentSelection.dismissAll() })

  /**
   * The text docTitle reads (#5 rule 18): the markdown on screen, followed with
   * a short delay while typing in the editor (one parse per pause, not per key)
   * and immediately otherwise (loads, polls, doc switches).
   */
  const titleSource = ref(markdown.value)
  let titleTimer: ReturnType<typeof setTimeout> | null = null
  watch(markdown, (text) => {
    if (titleTimer) { clearTimeout(titleTimer); titleTimer = null }
    if (paneMode.value !== 'preview') titleTimer = setTimeout(() => { titleTimer = null; titleSource.value = markdown.value }, TITLE_TYPING_DELAY_MS)
    else titleSource.value = text
  })

  /** docTitle (00 §5, #5): the reader header's doc-title and the tab title. */
  const docTitle = computed(() => computeDocTitle({
    sessionName: docMeta.value.sessionName,
    content: titleSource.value,
    contentType: contentType.value,
    filename: docMeta.value.filename || filename.value,
  }))

  /** #28: agent-only sections in the markdown on screen (0 for HTML docs). Lazy: read only where shown. */
  const agentSectionCount = computed(() => (contentType.value === 'markdown' ? countAgentSections(markdown.value) : 0))
  /**
   * #28 rule 11/14: the shared markdown doc's raw source on the API
   * (`<API>/d/<slug||id>.md`), else null — never for a pinned revision (the
   * raw endpoint serves the latest version; revisions are out of scope).
   */
  const rawMarkdownUrl = computed(() =>
    pasteId.value && contentType.value === 'markdown' && route.value.kind === 'doc' && !pinnedInfo.value
      ? `${PASTE_API}/d/${encodeURIComponent(docMeta.value.slug || pasteId.value)}.md` : null)

  /** FE-built link to the doc on screen (00 §6): <origin><base>d/<slug||id>; null for a local doc. */
  const docLink = computed(() => {
    if (pasteId.value) return docShareUrl(docMeta.value.slug || pasteId.value)
    if (pinnedInfo.value) return docShareUrl(pinnedInfo.value.id)
    return null
  })

  // ── File route content ───────────────────────────────────────────────────
  let fileObjectUrl: string | null = null

  function setFileView(next: typeof fileView.value) {
    if (fileObjectUrl) { URL.revokeObjectURL(fileObjectUrl); fileObjectUrl = null }
    if (next?.kind === 'image') fileObjectUrl = next.url
    fileView.value = next
  }

  /** The route's content is what the doc state holds. */
  const onScreen = computed(() => appMode.value === 'doc' && screenKey.value === viewLoc.value.key)

  /** #25: view counts for the shared doc or pinned revision on screen (never embeds or local docs). */
  const viewDocId = computed(() => pasteId.value ?? pinnedInfo.value?.id ?? null)
  const views = createViews({
    docId: viewDocId,
    revision: computed(() => {
      const r = route.value
      if (r.kind === 'pinned') return r.rev // the router only matches a full content hash (REV_RE)
      return sync.serverHash.value
    }),
    eligible: computed(() => onScreen.value && !embed.value && !!viewDocId.value && (route.value.kind === 'doc' || route.value.kind === 'pinned')),
    // Stats differ by edit access (editors get the reader list): reload when it changes.
    accessKey: computed(() => (access.value ? `${access.value.protected}:${access.value.can_edit}` : '')),
  })

  const wordCount = computed(() => {
    if (!markdown.value) return 0
    return markdown.value.split(/\s+/).filter(w => w.length > 0).length
  })

  const charCount = computed(() => markdown.value.length)

  const NO_COMMENTS: Comment[] = []

  return {
    router,
    // route / screen
    held, viewLoc, route, embed, readOnly, screenKey, docMissing, pinnedInfo, fileView, setFileView, onScreen, booted,
    filePathParam,
    // axes (00 §1) + mode
    ...axes, mode, ...modeSync, applyServerMeta, access, localCopy, setLocalCopy, discardLocalCopy, useServerVersion, restoreLocalCopy, docTitle, docLink,
    // content
    appMode, paneMode, readerView, agentSectionCount, rawMarkdownUrl, markdown, filename, contentType, pasteId, wordCount, charCount, NO_COMMENTS,
    // UI state
    showPromptModal, sidebarHidden, notice, showShareModal, shareResult,
    // reviewer + comments + sync + reactions (#24)
    ...reviewer, ...commentsApi, sync, reactions, views,
    // revisions
    ...revisions,
    // theme, persistence, share, approval
    theme, setTheme, persistence, share, approvalInfo, unresolvedMustFixCount, refreshApproval,
    // autosave
    ...autosave,
    // selection → comment
    ...commentSelection,
  }
}

export type DocState = ReturnType<typeof createDocState>

/** App: create the doc state once and make it available to every doc component. */
export function provideDocState(router: Router): DocState {
  const state = createDocState(router)
  provide(DOC_STATE, state)
  return state
}
