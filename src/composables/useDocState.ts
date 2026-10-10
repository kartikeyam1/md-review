import { ref, shallowRef, computed, watch, inject, provide, type InjectionKey } from 'vue'
import type { AppMode, PaneMode, ContentType, Comment, ApprovalInfo } from '@/types'
import type PreviewPaneType from '@/components/PreviewPane.vue'
import type EditorPaneType from '@/components/EditorPane.vue'
import { useComments } from '@/composables/useComments'
import { usePersistence, useThemePersistence } from '@/composables/usePersistence'
import { useShare, type RevisionEntry } from '@/composables/useShare'
import { useSync } from '@/composables/useSync'
import { useReviewer } from '@/composables/useReviewer'
import { useRevisions, summarizeSince, type SinceSummary } from '@/composables/useRevisions'
import type { Router, RouterLocation, Route } from '@/composables/useRouter'

// ── Doc state (spec #2, 00 §4.1) ─────────────────────────────────────────────
// Everything a document on screen is made of: its content, the shared session
// it is attached to (sync, comments, revisions, approval), and the axes every
// piece of UI reads — view, capability, routeKind, isShared. App creates it
// once (provideDocState) so it survives route changes (library and back keeps
// the attached doc); DocView, the header controls and the loaders inject it.

export type RouteKind = 'doc' | 'pinned' | 'file' | 'embed'
export type Capability = 'viewer' | 'editor'
export type DocViewName = 'read' | 'edit'

export interface DocAxesInput {
  routeKind: Route['kind']
  embed: boolean
  paneMode: PaneMode
  pasteId: string | null
}

export interface DocAxes {
  /** doc | pinned | file | embed — the landing route's local doc counts as `doc`. */
  routeKind: RouteKind
  capability: Capability
  view: DocViewName
  isShared: boolean
}

/** Pure: the axes for one screen state (00 §1). */
export function resolveDocAxes(input: DocAxesInput): DocAxes {
  const routeKind: RouteKind = input.embed ? 'embed'
    : input.routeKind === 'pinned' ? 'pinned'
      : input.routeKind === 'file' ? 'file'
        : 'doc'
  // Pinned revisions, file routes and embeds are read-only (00 §1.2).
  const capability: Capability = routeKind === 'doc' ? 'editor' : 'viewer'
  const view: DocViewName = capability === 'editor' && input.paneMode === 'edit' ? 'edit' : 'read'
  return { routeKind, capability, view, isShared: !!input.pasteId }
}

export const isEmbedLocation = (loc: RouterLocation) => new URLSearchParams(loc.search).get('embed') === '1'
export const isReadOnlyLocation = (loc: RouterLocation) =>
  isEmbedLocation(loc) || loc.route.kind === 'pinned' || loc.route.kind === 'file'

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
  const markdown = ref('')
  const filename = ref('')
  const contentType = ref<ContentType>('markdown')
  const pasteId = ref<string | null>(null)
  const showPromptModal = ref(false)
  const sidebarHidden = ref(false)
  /** One-line, dismissible status message (session gone, server unreachable…). */
  const notice = ref<string | null>(null)
  /** False until the previous draft has been restored from local storage. */
  const booted = ref(false)
  /** Dev-only ?filePath= loader (the e2e fixture harness). */
  const filePathParam = ref<string | null>(null)

  const axes = computed(() => resolveDocAxes({
    routeKind: route.value.kind,
    embed: embed.value,
    paneMode: paneMode.value,
    pasteId: pasteId.value,
  }))
  const routeKind = computed(() => axes.value.routeKind)
  const capability = computed(() => axes.value.capability)
  const view = computed(() => axes.value.view)
  const isShared = computed(() => axes.value.isShared)

  const reviewer = useReviewer()
  const { reviewerName } = reviewer

  const commentsApi = useComments()
  const { comments, addComment, editComment, deleteComment, loadComments, addReply, editReply, deleteReply, resolveComment, unresolveComment } = commentsApi

  const sync = useSync(pasteId, comments, markdown, {
    addComment, editComment, deleteComment, loadComments,
    addReply, editReply, deleteReply,
    resolveComment, unresolveComment,
  }, { filename, author: reviewerName })

  // ── Revision history / "what changed since I last looked" ─────────────────
  // The browser remembers the last content hash the reader ACKNOWLEDGED (wrote,
  // dismissed, or opened the diff for). Any other hash arriving on screen —
  // on open, on return, or live via polling — raises the changes banner, which
  // keeps pointing at the acknowledged hash until the reader acts on it.
  const revisionsApi = useRevisions()
  const revisionList = ref<RevisionEntry[]>([])
  const showHistory = ref(false)
  const historyFrom = ref<string | null>(null)
  const seenHash = ref<string | null>(null)
  let seenLoadedFor: string | null = null
  const pendingSince = ref<string | null>(null)
  const changeSummary = ref<SinceSummary | null>(null)

  function resetRevisionState() {
    revisionList.value = []
    showHistory.value = false
    historyFrom.value = null
    seenHash.value = null
    seenLoadedFor = null
    pendingSince.value = null
    changeSummary.value = null
  }

  async function refreshRevisions() {
    const id = pasteId.value
    if (!id) return
    const list = await revisionsApi.fetchList(id)
    if (!list || pasteId.value !== id) return
    revisionList.value = list.revisions
    updateSummary()
  }

  function updateSummary() {
    const current = sync.serverHash.value
    if (!pendingSince.value || !current) { changeSummary.value = null; return }
    const summary = summarizeSince(revisionList.value, pendingSince.value, current)
    if (!summary) pendingSince.value = null
    changeSummary.value = summary
  }

  /** The reader has looked at (or written) `hash`: remember it, drop the banner. */
  function acknowledge(hash: string | null) {
    const id = pasteId.value
    if (!id || !hash) return
    seenHash.value = hash
    pendingSince.value = null
    changeSummary.value = null
    revisionsApi.setSeen(id, hash)
  }

  function raiseBanner(since: string | null) {
    if (!since || since === sync.serverHash.value) return
    if (!pendingSince.value) pendingSince.value = since
    refreshRevisions()
  }

  async function initSeen(id: string) {
    const rec = await revisionsApi.getSeen(id)
    if (pasteId.value !== id) return
    seenLoadedFor = id
    seenHash.value = rec?.hash ?? null
    const current = sync.serverHash.value
    if (!current) return // reconciled by the serverHash watcher once known
    if (!seenHash.value) acknowledge(current) // first visit: nothing to compare against
    else if (seenHash.value !== current) raiseBanner(seenHash.value)
    refreshRevisions()
  }

  watch(pasteId, (id) => {
    resetRevisionState()
    if (id) initSeen(id)
  })

  watch(sync.serverHash, (hash, prev) => {
    const id = pasteId.value
    if (!id || !hash) return
    const origin = sync.serverHashOrigin.value
    if (origin === 'save') { acknowledge(hash); refreshRevisions(); return }
    if (seenLoadedFor !== id) return // initSeen will reconcile against this hash
    if (origin === 'remote') raiseBanner(prev ?? seenHash.value)
    else if (seenHash.value && seenHash.value !== hash) raiseBanner(seenHash.value)
    else if (!seenHash.value) acknowledge(hash)
    refreshRevisions()
  })

  function openHistory() {
    historyFrom.value = pendingSince.value
    showHistory.value = true
  }

  const { theme, setTheme } = useThemePersistence()

  const persistence = usePersistence(
    markdown,
    filename,
    comments,
    contentType,
    loadComments,
    (mode) => { appMode.value = mode },
    {
      pasteId,
      serverMarkdown: sync.serverMarkdown,
      // Only what the current route shows is persisted: never a read-only view,
      // a doc being left, or a restored draft the landing route is not showing.
      paused: () => isReadOnlyLocation(router.current.value) || screenKey.value !== router.current.value.key,
    },
  )

  const share = useShare()

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

  // ── Autosave ──────────────────────────────────────────────────────────────
  // In a shared session the document autosaves: ~2 s after the last keystroke,
  // immediately when leaving the editor for the preview, before a comment is
  // anchored (so its line numbers refer to what the server holds), when the tab
  // is hidden or closed, and on Ctrl/Cmd+S. Saves carry If-Match, so a copy
  // changed elsewhere is never overwritten silently — it surfaces as a conflict.
  const AUTOSAVE_IDLE_MS = 2000
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null
      if (sync.isShared.value && sync.isDirty.value) sync.saveMarkdown()
    }, AUTOSAVE_IDLE_MS)
  }

  function flushAutosave(opts: { keepalive?: boolean } = {}): Promise<boolean> {
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
    if (!sync.isShared.value) return Promise.resolve(false)
    return sync.saveMarkdown(opts)
  }

  watch(markdown, () => { if (sync.isShared.value && sync.isDirty.value) scheduleAutosave() })
  watch(filename, () => { if (sync.isShared.value && sync.isDirty.value) scheduleAutosave() })

  watch(paneMode, (mode, prev) => {
    if (prev === 'edit' && mode === 'preview' && sync.isShared.value && sync.isDirty.value) {
      flushAutosave()
    }
  })

  /** Ask before an action that would throw away unsaved edits to a shared document. */
  function confirmDiscardIfDirty(): boolean {
    if (!sync.isShared.value || !(sync.isDirty.value || sync.conflict.value)) return true
    return window.confirm('You have unsaved changes to this shared document. Discard them?')
  }

  // ── Selection → comment flow ──────────────────────────────────────────────
  const selection = ref<{
    startLine: number
    endLine: number
    selectedText: string
    coords: { x: number; y: number }
  } | null>(null)

  const showActionBar = ref(false)
  const showPopover = ref(false)

  const editorRef = ref<InstanceType<typeof EditorPaneType>>()
  const previewRef = ref<InstanceType<typeof PreviewPaneType>>()

  function dismissAll() {
    showActionBar.value = false
    showPopover.value = false
    selection.value = null
    previewRef.value?.clearSelectionHighlight()
  }

  // ── File route content ───────────────────────────────────────────────────
  let fileObjectUrl: string | null = null

  function setFileView(next: typeof fileView.value) {
    if (fileObjectUrl) { URL.revokeObjectURL(fileObjectUrl); fileObjectUrl = null }
    if (next?.kind === 'image') fileObjectUrl = next.url
    fileView.value = next
  }

  /** The route's content is what the doc state holds. */
  const onScreen = computed(() => appMode.value === 'review' && screenKey.value === viewLoc.value.key)

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
    // axes (00 §1)
    routeKind, capability, view, isShared,
    // content
    appMode, paneMode, markdown, filename, contentType, pasteId, wordCount, charCount, NO_COMMENTS,
    // UI state
    showPromptModal, sidebarHidden, notice, showShareModal, shareResult,
    // reviewer + comments + sync
    ...reviewer, ...commentsApi, sync,
    // revisions
    revisionsApi, revisionList, showHistory, historyFrom, changeSummary, acknowledge, openHistory,
    // theme, persistence, share, approval
    theme, setTheme, persistence, share, approvalInfo, unresolvedMustFixCount, refreshApproval,
    // autosave
    flushAutosave, confirmDiscardIfDirty,
    // selection
    selection, showActionBar, showPopover, editorRef, previewRef, dismissAll,
  }
}

export type DocState = ReturnType<typeof createDocState>

const DOC_STATE: InjectionKey<DocState> = Symbol('md-review-doc-state')

/** App: create the doc state once and make it available to every doc component. */
export function provideDocState(router: Router): DocState {
  const state = createDocState(router)
  provide(DOC_STATE, state)
  return state
}

/** Any component under App: the doc state. */
export function useDocState(): DocState {
  const state = inject(DOC_STATE)
  if (!state) throw new Error('useDocState() called outside of a provideDocState() tree')
  return state
}
