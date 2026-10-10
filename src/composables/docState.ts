import { ref, shallowRef, computed, watch, provide } from 'vue'
import type { AppMode, PaneMode, ContentType, Comment, ApprovalInfo, DocMode } from '@/types'
import { useComments } from '@/composables/useComments'
import { usePersistence, useThemePersistence } from '@/composables/usePersistence'
import { useShare } from '@/composables/useShare'
import { useSync } from '@/composables/useSync'
import { useReviewer } from '@/composables/useReviewer'
import { docShareUrl, type Router, type RouterLocation, type Route } from '@/composables/useRouter'
import { useDocAxes, isEmbedLocation, isReadOnlyLocation, DOC_STATE } from '@/composables/useDocState'
import { useRevisionTracking } from '@/composables/useRevisionTracking'
import { useAutosave } from '@/composables/useAutosave'
import { useCommentSelection } from '@/composables/useCommentSelection'
import { useDocModeSync } from '@/composables/useDocModeSync'

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

  const axes = useDocAxes({ route, embed, paneMode, pasteId, mode })
  const { capability, reviewUI } = axes

  const share = useShare()
  const modeSync = useDocModeSync({ mode, pasteId, share, canChange: () => capability.value === 'editor' })
  const { docMeta } = modeSync

  const reviewer = useReviewer()
  const commentsApi = useComments()
  const { comments, addComment, editComment, deleteComment, loadComments, addReply, editReply, deleteReply, resolveComment, unresolveComment } = commentsApi

  const sync = useSync(pasteId, comments, markdown, {
    addComment, editComment, deleteComment, loadComments,
    addReply, editReply, deleteReply,
    resolveComment, unresolveComment,
  }, { filename, author: reviewer.reviewerName, onServerState: (data, at) => modeSync.applyServerMeta(data, at) })

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

  const autosave = useAutosave({ sync, markdown, filename, paneMode })

  const commentSelection = useCommentSelection({ reviewUI, readOnly })

  /** Publish hides every review surface: drop a half-made comment with it. */
  watch(mode, (m) => { if (m === 'publish') commentSelection.dismissAll() })

  /** Reader header title (00 §5 until #5 supplies docTitle): sessionName, else filename. */
  const docTitle = computed(() => {
    const name = docMeta.value.sessionName?.replace(/\s+/g, ' ').trim()
    return name || docMeta.value.filename?.trim() || filename.value.trim() || 'Untitled'
  })

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
    ...axes, mode, ...modeSync, docTitle, docLink,
    // content
    appMode, paneMode, markdown, filename, contentType, pasteId, wordCount, charCount, NO_COMMENTS,
    // UI state
    showPromptModal, sidebarHidden, notice, showShareModal, shareResult,
    // reviewer + comments + sync
    ...reviewer, ...commentsApi, sync,
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
