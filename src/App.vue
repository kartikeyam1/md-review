<script setup lang="ts">
import { ref, shallowRef, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import type { AppMode, PaneMode, CommentCategory, ApprovalInfo, ContentType, Comment } from '@/types'
import { useComments } from '@/composables/useComments'
import { usePersistence, useThemePersistence } from '@/composables/usePersistence'
import { useShare } from '@/composables/useShare'
import { detectContentType } from '@/composables/useContentType'
import { useSync } from '@/composables/useSync'
import { useReviewer } from '@/composables/useReviewer'
import { useRevisions, summarizeSince, type SinceSummary } from '@/composables/useRevisions'
import type { RevisionEntry } from '@/composables/useShare'
import ChangesBanner from '@/components/ChangesBanner.vue'
import HeaderBar from '@/components/HeaderBar.vue'
import FileUpload from '@/components/FileUpload.vue'
import EditorPane from '@/components/EditorPane.vue'
import PreviewPane from '@/components/PreviewPane.vue'
import CommentsSidebar from '@/components/CommentsSidebar.vue'
import SelectionActionBar from '@/components/SelectionActionBar.vue'
import CommentPopover from '@/components/CommentPopover.vue'
import PromptModal from '@/components/PromptModal.vue'
import ShareModal from '@/components/ShareModal.vue'
import ApprovalBanner from '@/components/ApprovalBanner.vue'
import SummaryPanel from '@/components/SummaryPanel.vue'
import DashboardView from '@/components/DashboardView.vue'
import RouteNotFound from '@/components/RouteNotFound.vue'
import { useRouter, resolveView, routeKey, type Route, type RouterLocation } from '@/composables/useRouter'

// Carries the diff library — only loaded when someone opens History.
const RevisionsModal = defineAsyncComponent(() => import('@/components/RevisionsModal.vue'))

// ── Routing (spec #4) ─────────────────────────────────────────────────────
// bootstrap() strips ?edit=, applies the legacy #shared=/#dashboard redirects
// and canonical rewrites with replaceState — before the first render.
const router = useRouter()
const { redirected: legacyRedirected } = router.bootstrap()
/**
 * While the unsaved-changes guard decides whether a shared doc may be left
 * (rule 13), the screen keeps showing that doc: `held` is its location.
 */
const held = shallowRef<RouterLocation | null>(null)
/** The location the screen renders: the held doc during a leave decision, else the URL's. */
const viewLoc = computed(() => held.value ?? router.current.value)
const route = computed<Route>(() => viewLoc.value.route)
const isEmbed = (loc: RouterLocation) => new URLSearchParams(loc.search).get('embed') === '1'
const isReadOnly = (loc: RouterLocation) => isEmbed(loc) || loc.route.kind === 'pinned' || loc.route.kind === 'file'
const embed = computed(() => isEmbed(viewLoc.value))
/** Pinned revisions, file routes and embeds are read-only (capability viewer, 00 §1.2). */
const readOnly = computed(() => isReadOnly(viewLoc.value))
const NO_COMMENTS: Comment[] = []
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

const { reviewerName, setReviewerName, authorField } = useReviewer()

const { comments, addComment, editComment, deleteComment, clearComments, loadComments, addReply, editReply, deleteReply, resolveComment, unresolveComment } = useComments()

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

function handleViewChanges() {
  openHistory()
}

function handleDismissChanges() {
  acknowledge(sync.serverHash.value)
}

function handleRestoreRevision(oldMarkdown: string, entry: RevisionEntry | null) {
  if (!confirmDiscardIfDirty()) return
  showHistory.value = false
  markdown.value = oldMarkdown
  const when = entry ? new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'an earlier version'
  notice.value = `Restored the version from ${when} as unsaved edits — it will autosave shortly. Use History again to go back.`
}

const { theme, setTheme } = useThemePersistence()

const { clearPersisted, takeRestoredDraft, restoredInfo, loadLocalDraft, forgetLocalDraft, restored, persistError } = usePersistence(
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
    paused: () => isReadOnly(router.current.value) || screenKey.value !== router.current.value.key,
  },
)

const { sharing, shareError, createShare, loadShareDetailed, fetchGithub, getShareUrls, getRevision, loadSessionFile, sessionFileUrl, getApproval, putApproval } = useShare()

const approvalInfo = ref<ApprovalInfo | null>(null)

const unresolvedMustFixCount = computed(() =>
  comments.value.filter(c => c.category === 'must-fix' && c.resolved !== true).length
)

async function refreshApproval() {
  if (pasteId.value) {
    approvalInfo.value = await getApproval(pasteId.value)
  }
}

async function handleApprove(approvedBy: string) {
  if (!pasteId.value) return
  setReviewerName(approvedBy)
  const result = await putApproval(pasteId.value, 'approved', approvedBy)
  if (result && !result.error) approvalInfo.value = result
  else if (result?.error) alert(result.error)
}

async function handleRequestChanges(approvedBy: string) {
  if (!pasteId.value) return
  setReviewerName(approvedBy)
  const result = await putApproval(pasteId.value, 'changes_requested', approvedBy)
  if (result && !result.error) approvalInfo.value = result
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

function handleSaveMarkdown() {
  flushAutosave()
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && appMode.value === 'review') {
    e.preventDefault()
    if (sync.isShared.value) flushAutosave()
  }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!sync.isShared.value) return
  if (sync.isDirty.value || sync.conflict.value || sync.saveState.value === 'saving') {
    e.preventDefault()
    e.returnValue = ''
  }
}

function onPageHide() {
  if (sync.isShared.value && sync.isDirty.value && !sync.conflict.value) flushAutosave({ keepalive: true })
}

function onVisibilityChange() {
  if (document.hidden) onPageHide()
}

/** Ask before an action that would throw away unsaved edits to a shared document. */
function confirmDiscardIfDirty(): boolean {
  if (!sync.isShared.value || !(sync.isDirty.value || sync.conflict.value)) return true
  return window.confirm('You have unsaved changes to this shared document. Discard them?')
}

// Load file from ?filePath= URL param (dev server only)
const filePathParam = ref<string | null>(null)

async function loadFromFilePath() {
  const filePath = filePathParam.value
  if (!filePath) return

  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
    if (!res.ok) return
    const { content, filename: name } = await res.json()
    handleFileLoaded(content, name)
  } catch {
    // API not available (production build) — ignore
  }
}

async function handleShare() {
  // Already shared: make sure the server has the latest text, then just show the links.
  if (pasteId.value) {
    if (sync.isDirty.value) await flushAutosave()
    shareResult.value = getShareUrls(pasteId.value)
    showShareModal.value = true
    return
  }
  const created = await createShare(markdown.value, filename.value, comments.value, undefined, contentType.value, reviewerName.value || undefined)
  if (created) {
    // Rule 11: the URL becomes d/<slug||id> (replaceState), preferring the slug.
    const key = created.slug || created.id
    pasteId.value = key
    screenKey.value = routeKey({ kind: 'doc', id: key })
    router.replace(`${router.base}d/${key}`)
    // It is a shared doc now, no longer the never-shared local draft.
    forgetLocalDraft()
    sync.setBaseline({ markdown: markdown.value, filename: filename.value })
    shareResult.value = getShareUrls(key)
    showShareModal.value = true
    refreshApproval()
  } else {
    alert(shareError.value || 'Failed to create share link.')
  }
}

function detachFromShare() {
  pasteId.value = null
  approvalInfo.value = null
}

/** Put on screen something that is not a live shared doc (pinned revision, file). */
function showReadOnlyContent(content: string, name: string, type: ContentType) {
  detachFromShare()
  pinnedInfo.value = null
  setFileView(null)
  clearComments()
  dismissAll()
  notice.value = null
  markdown.value = content
  filename.value = name
  contentType.value = type
  appMode.value = 'review'
}

let navToken = 0
const isStale = (token: number) => token !== navToken

async function loadSharedDoc(shareId: string, token: number) {
  const key = routeKey({ kind: 'doc', id: shareId })
  // Already attached to this session (Back/Forward, library and back) — do
  // not reload over local edits.
  if (pasteId.value === shareId && screenKey.value === key) { applyViewParam(); return }
  if (pasteId.value) detachFromShare()

  const { data, status } = await loadShareDetailed(shareId)
  if (isStale(token)) return // navigated away meanwhile

  if (!data) {
    const draft = takeRestoredDraft(shareId)
    if (status === 404 || status === 410) {
      if (!draft || embed.value) {
        // Rule 10: no local copy — a definitive "not found", never the upload screen.
        docMissing.value = 'missing'
        return
      }
      // Session gone, but this browser has a copy: keep it as a plain local document.
      handleFileLoaded(draft.markdown, draft.filename, undefined, { shared: true })
      screenKey.value = 'landing'
      router.replace(router.base)
      notice.value = status === 410
        ? 'This shared session has expired. Showing your local copy.'
        : 'This shared session no longer exists. Showing your local copy.'
      return
    }
    // Server unreachable (offline is not "not found"). If the persisted copy
    // belongs to this session, stay attached so polling/autosave resume when
    // it comes back.
    if (draft) {
      handleFileLoaded(draft.markdown, draft.filename, undefined, { shared: true })
      pasteId.value = shareId
      screenKey.value = key
      if (draft.baseMarkdown !== null) {
        sync.setBaseline({ markdown: draft.baseMarkdown, filename: draft.filename })
      } else {
        sync.expectDraft()
      }
    }
    // After handleFileLoaded, which clears notices.
    notice.value = draft
      ? 'Cannot reach the review server. Showing your local copy; it will sync when the server is back.'
      : 'Cannot reach the review server. This document will load when the server is back — try again shortly.'
    return
  }

  handleFileLoaded(data.markdown, data.filename, data.contentType, { shared: true })
  if (data.comments?.length) {
    loadComments(data.comments)
  }
  pasteId.value = shareId
  screenKey.value = key
  sync.setBaseline({
    markdown: data.markdown,
    filename: data.filename,
    contentHash: data.content_hash ?? null,
    etag: data.etag ?? null,
  })
  // A reload with unsaved edits: put them back on top of the fresh server copy.
  const draft = takeRestoredDraft(shareId)
  if (draft && !draft.clean && draft.markdown !== data.markdown && !embed.value) {
    sync.restoreDraft(draft.markdown, draft.baseMarkdown)
    notice.value = sync.conflict.value
      ? 'Restored your unsaved edits, but the server copy changed in the meantime — choose a version below.'
      : 'Restored your unsaved edits from this browser.'
  }
  applyViewParam()
  refreshApproval()
}

/** Rule 7: a pinned revision, read-only. Never GET /paste/<ID>. */
async function loadPinned(id: string, rev: string, token: number) {
  const key = routeKey({ kind: 'pinned', id, rev })
  if (screenKey.value === key) { applyViewParam(); return }
  const { data, status } = await getRevision(id, rev)
  if (isStale(token)) return
  if (!data) {
    if (status === 404) docMissing.value = 'missing'
    else if (status === 410) docMissing.value = 'revision-gone'
    else notice.value = 'Cannot reach the review server. Try again when it is back.'
    return
  }
  showReadOnlyContent(data.markdown, id, detectContentType('', data.markdown))
  fileView.value = null
  pinnedInfo.value = { id, at: data.at }
  screenKey.value = key
  applyViewParam()
}

const MARKDOWN_FILE = /\.(md|markdown|txt)$/i
const HTML_FILE = /\.html?$/i
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i
let fileObjectUrl: string | null = null

function setFileView(next: typeof fileView.value) {
  if (fileObjectUrl) { URL.revokeObjectURL(fileObjectUrl); fileObjectUrl = null }
  if (next?.kind === 'image') fileObjectUrl = next.url
  fileView.value = next
}

/** Rule 8: one file of a multi-file session, read-only. */
async function loadFile(id: string, file: string, token: number) {
  const key = routeKey({ kind: 'file', id, file })
  if (screenKey.value === key) { applyViewParam(); return }
  const res = await loadSessionFile(id, file)
  if (isStale(token)) return
  if (!res.blob) {
    if (res.status === 404 || res.status === 410) docMissing.value = 'missing'
    else notice.value = 'Cannot reach the review server. Try again when it is back.'
    return
  }
  const name = file.split('/').pop() || file
  pinnedInfo.value = null
  if (MARKDOWN_FILE.test(file) || HTML_FILE.test(file)) {
    const text = await res.blob.text()
    if (isStale(token)) return
    showReadOnlyContent(text, name, HTML_FILE.test(file) ? 'html' : 'markdown')
    setFileView(null)
  } else {
    showReadOnlyContent('', name, 'markdown')
    setFileView(IMAGE_FILE.test(file) || res.type.startsWith('image/')
      ? { kind: 'image', url: URL.createObjectURL(res.blob), name }
      : { kind: 'download', url: sessionFileUrl(id, file), name })
  }
  screenKey.value = key
  applyViewParam()
}

/**
 * Legacy `#github=<url>` on the landing route (rule 4): open the file as a
 * local doc, then drop the fragment. On failure show the error, URL → base.
 */
async function loadFromGithubHash() {
  const match = window.location.hash.match(/^#github=(.+)$/)
  if (!match) return

  let githubUrl: string
  try { githubUrl = decodeURIComponent(match[1]) } catch { githubUrl = match[1] }
  const data = await fetchGithub(githubUrl)
  if (data) {
    handleFileLoaded(data.content, data.filename)
    const l = window.location
    router.replace(l.pathname + l.search)
  } else {
    notice.value = shareError.value || 'Could not load the file from GitHub.'
    router.replace(router.base)
  }
}

/**
 * Rule 5 / 00 §1.3: resolve ?view= against what is on screen. Disallowed or
 * unknown values render read and are rewritten to view=read (replaceState).
 * (UI view toggles do not write ?view= yet — see DECISIONS #4.)
 */
function applyViewParam() {
  const r = route.value
  const routeKind = embed.value ? 'embed' : r.kind === 'pinned' ? 'pinned' : r.kind === 'file' ? 'file' : 'doc'
  const { view, rewrite } = resolveView(router.query('view'), {
    capability: readOnly.value ? 'viewer' : 'editor',
    routeKind,
    contentType: contentType.value,
  })
  paneMode.value = view === 'edit' ? 'edit' : 'preview'
  if (rewrite) router.setQueryParam('view', 'read')
}

/** Empty landing state (New, or navigating back to the landing route). */
function resetToEmpty() {
  clearComments()
  dismissAll()
  notice.value = null
  markdown.value = ''
  filename.value = ''
  contentType.value = 'markdown'
  pasteId.value = null
  approvalInfo.value = null
  pinnedInfo.value = null
  setFileView(null)
  appMode.value = 'upload'
  screenKey.value = 'landing'
}

/** Resolves to `fallback` when `p` takes longer than `ms` (a stalled save). */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(fallback) })
  })
}

/** The user chose to leave a shared doc with unsaved edits: drop them for good. */
function discardAttached() {
  detachFromShare()
  screenKey.value = null
  // The persisted draft holds exactly those edits; keep the local draft slot.
  clearPersisted({ keepLocal: true })
}

const pathOf = (href: string) => { const u = new URL(href); return u.pathname + u.search + u.hash }

/**
 * Rule 13: any navigation away from the attached shared doc while it has
 * unsaved changes — a link, Back/Forward, the library, New — flushes autosave
 * (briefly), and if that cannot finish, asks. The doc stays on screen while
 * deciding. Cancel puts the doc's URL back; accepting discards the edits so
 * later navigation does not ask again.
 */
async function guardLeave(to: RouterLocation, from: RouterLocation, token: number): Promise<boolean> {
  const attached = pasteId.value
  if (!attached || !sync.isShared.value) return true
  const attachedKey = routeKey({ kind: 'doc', id: attached })
  if (to.key === attachedKey) return true
  const unsaved = () => sync.isDirty.value || !!sync.conflict.value || sync.saveState.value === 'saving'
  if (!unsaved()) return true
  const showing = from.key === attachedKey && screenKey.value === attachedKey
  if (showing) held.value = from
  try {
    if (!sync.conflict.value) await withTimeout(flushAutosave(), LEAVE_FLUSH_MS, false)
    if (isStale(token)) return false
    if (!unsaved()) return true
    if (window.confirm('Your changes to this shared document could not be saved yet. Leave anyway and discard them?')) {
      discardAttached()
      return true
    }
    router.push(showing ? pathOf(from.href) : `${router.base}d/${attached}`)
    return false
  } finally {
    if (held.value === from) held.value = null
  }
}
const LEAVE_FLUSH_MS = 1500

/** Put the never-shared local draft on screen (landing route), if there is one. */
async function enterLanding(token: number) {
  if (screenKey.value === 'landing') return
  if (pasteId.value) detachFromShare()
  const local = await loadLocalDraft()
  if (isStale(token) || screenKey.value === 'landing') return
  if (!local) { resetToEmpty(); return }
  clearComments()
  dismissAll()
  notice.value = null
  pinnedInfo.value = null
  setFileView(null)
  markdown.value = local.markdown
  filename.value = local.filename
  contentType.value = local.contentType ?? 'markdown'
  loadComments(local.comments)
  appMode.value = 'review'
  screenKey.value = 'landing'
  applyViewParam()
}

async function applyRoute(to: RouterLocation, from: RouterLocation | null) {
  const token = ++navToken
  if (from && !(await guardLeave(to, from, token))) return
  if (isStale(token)) return
  docMissing.value = null
  const r = to.route
  switch (r.kind) {
    case 'landing':
      return enterLanding(token)
    case 'library':
    case 'not-found':
      return
    case 'doc':
      return loadSharedDoc(r.id, token)
    case 'pinned':
      return loadPinned(r.id, r.rev, token)
    case 'file':
      return loadFile(r.id, r.file, token)
  }
}

// Every route change (push, replace, Back/Forward). Same key = same content:
// a fragment or query change, handled by PreviewPane / applyViewParam.
watch(() => router.current.value, (to, from) => {
  if (!booted.value) return
  if (to.key === from.key) {
    // A `#github=` pasted while already on the landing route (rule 4).
    if (to.route.kind === 'landing' && to.source === 'pop' && /^#github=/.test(new URL(to.href).hash)) loadFromGithubHash()
    return
  }
  applyRoute(to, from)
})

/** The route's content is what the doc state holds. */
const onScreen = computed(() => appMode.value === 'review' && screenKey.value === viewLoc.value.key)

/**
 * A UI view change. Until #2 writes ?view= (DECISIONS #4), it drops any
 * `view` param so a reload or copied URL cannot reopen a stale view.
 */
function onPaneModeChange(mode: PaneMode) {
  paneMode.value = mode
  if (router.query('view') !== null) router.setQueryParam('view', null)
}

function goHome() {
  router.push(router.base)
}

const isDocRoute = computed(() => ['doc', 'pinned', 'file'].includes(route.value.kind))
const showHeader = computed(() => route.value.kind !== 'library' && route.value.kind !== 'not-found' && !docMissing.value)

const pinnedWhen = computed(() => {
  const at = pinnedInfo.value?.at
  if (!at) return 'an earlier point'
  const d = new Date(at)
  return isNaN(d.getTime()) ? at : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
})

/** Rule 16: the same URL without `embed`, for "Open in md-review". */
const embedOpenHref = computed(() => {
  const u = new URL(router.current.value.href)
  u.searchParams.delete('embed')
  return u.href
})

/** Plain left click on an in-app link → pushState; modified clicks keep the browser default. */
function onAppLinkClick(e: MouseEvent, path: string) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  router.push(path)
}

onMounted(async () => {
  // Put the previous draft back first: loadSharedDoc() reconciles it against
  // the server copy and the upload screen must not flash over a restored doc.
  await restored
  const info = restoredInfo()
  if (info) screenKey.value = info.pasteId ? routeKey({ kind: 'doc', id: info.pasteId }) : 'landing'
  const hasGithub = /^#github=/.test(window.location.hash)
  if (route.value.kind === 'landing') {
    filePathParam.value = router.query('filePath')
    // Rule 9: only unsaved edits to a shared doc hijack the landing route.
    if (!legacyRedirected && !filePathParam.value && !hasGithub && info?.pasteId && info.dirty) {
      router.replace(`${router.base}d/${info.pasteId}${window.location.search}`)
    }
  }
  booted.value = true
  if (route.value.kind === 'landing') {
    loadFromFilePath()
    loadFromGithubHash()
    if (!filePathParam.value && !hasGithub) {
      // A restored shared draft is not shown here; the local draft (if any) is.
      if (screenKey.value === 'landing') applyViewParam()
      else enterLanding(++navToken)
    }
  } else {
    applyRoute(router.current.value, null)
  }
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('pagehide', onPageHide)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

const selection = ref<{
  startLine: number
  endLine: number
  selectedText: string
  coords: { x: number; y: number }
} | null>(null)

const showActionBar = ref(false)
const showPopover = ref(false)

const editorRef = ref<InstanceType<typeof EditorPane>>()
const previewRef = ref<InstanceType<typeof PreviewPane>>()

function dismissAll() {
  showActionBar.value = false
  showPopover.value = false
  selection.value = null
  previewRef.value?.clearSelectionHighlight()
}

/**
 * Put a document on screen. Anything that is not the shared session itself
 * (file picker, drop, paste, GitHub, ?filePath=) detaches from the current
 * share first — otherwise the old session's polling would keep writing over
 * the new document, and Save would push the new document into the old session.
 */
function handleFileLoaded(content: string, name: string, type?: ContentType, opts: { shared?: boolean } = {}) {
  if (!opts.shared) {
    if (!confirmDiscardIfDirty()) return
    detachFromShare()
    // A local doc lives on the landing route.
    screenKey.value = 'landing'
    if (route.value.kind !== 'landing') router.replace(router.base)
  }
  // Whatever was on screen before (a pinned banner, a file's image) goes.
  pinnedInfo.value = null
  setFileView(null)
  clearComments()
  dismissAll()
  notice.value = null
  markdown.value = content
  filename.value = name
  contentType.value = type ?? detectContentType(name, content)
  appMode.value = 'review'
}

function handleNewDoc() {
  if (!confirmDiscardIfDirty()) return
  // New from a shared doc keeps the (unrelated) local draft in storage.
  clearPersisted({ keepLocal: screenKey.value !== 'landing' })
  resetToEmpty()
  filePathParam.value = null
  // Rule 11: New → landing (pushState); already there → just drop query/fragment.
  if (route.value.kind === 'landing') router.replace(router.base)
  else router.push(router.base)
}

function handleSelection(info: {
  startLine: number
  endLine: number
  selectedText: string
  coords: { x: number; y: number }
}) {
  if (showPopover.value || readOnly.value) return
  selection.value = info
  showActionBar.value = true
}

function handleOpenComment() {
  showActionBar.value = false
  showPopover.value = true
}

function handleDismissActionBar() {
  showActionBar.value = false
  // Keep selection alive briefly in case popover is opening
  setTimeout(() => {
    if (!showPopover.value && !showActionBar.value) {
      selection.value = null
      previewRef.value?.clearSelectionHighlight()
    }
  }, 100)
}

function handleSelectionClear() {
  setTimeout(() => {
    if (!showPopover.value && !showActionBar.value) {
      selection.value = null
    }
  }, 200)
}

async function handleAddComment(body: string, category: CommentCategory) {
  if (!selection.value) return
  const anchor = {
    startLine: selection.value.startLine,
    endLine: selection.value.endLine,
    selectedText: selection.value.selectedText,
  }
  dismissAll()
  // The comment's line numbers refer to the text on screen — make sure that is
  // what the server holds before the comment lands next to it.
  if (sync.isShared.value && sync.isDirty.value) await flushAutosave()
  sync.addComment({ ...anchor, body, category, ...authorField() })
}

function handleAddReply(commentId: string, input: { body: string }) {
  sync.addReply(commentId, { ...input, ...authorField() })
}

function handleResolve(commentId: string) {
  sync.resolveComment(commentId, reviewerName.value || undefined)
}

function handleCancelPopover() {
  dismissAll()
}

function handleScrollTo(line: number) {
  if (paneMode.value === 'edit') {
    editorRef.value?.scrollToLine(line)
  } else {
    previewRef.value?.scrollToLine(line)
  }
}

function handleOpenFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.md,.markdown,.txt,.html,.htm'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      handleFileLoaded(reader.result as string, file.name)
    }
    reader.readAsText(file)
  }
  input.click()
}

const wordCount = computed(() => {
  if (!markdown.value) return 0
  return markdown.value.split(/\s+/).filter(w => w.length > 0).length
})

const charCount = computed(() => markdown.value.length)

// ── Export / Import comments ──────────────────────────────────

function handleExportComments() {
  if (comments.value.length === 0) return

  const data = {
    version: 1,
    filename: filename.value,
    exportedAt: new Date().toISOString(),
    comments: comments.value,
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const baseName = filename.value.replace(/\.[^.]+$/, '')
  a.download = `${baseName}.comments.json`
  a.click()
  URL.revokeObjectURL(url)
}

function handleImportComments() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        const imported = Array.isArray(data.comments) ? data.comments : Array.isArray(data) ? data : null
        if (!imported || !imported.every((c: any) => typeof c.startLine === 'number' && typeof c.body === 'string')) {
          alert('Invalid comment file format.')
          return
        }
        const normalized = imported.map((c: any) => ({
          ...c,
          replies: Array.isArray(c.replies) ? c.replies : [],
        }))
        loadComments(normalized)
      } catch {
        alert('Could not parse comment file.')
      }
    }
    reader.readAsText(file)
  }
  input.click()
}
</script>

<template>
  <div v-if="embed" class="app embed">
    <!-- Rule 16: ?embed=1 — the content and one link out, nothing else. -->
    <RouteNotFound v-if="route.kind === 'not-found' || route.kind === 'landing' || route.kind === 'library'" kind="route" :home="router.base" @home="goHome" />
    <RouteNotFound v-else-if="docMissing" :kind="docMissing === 'revision-gone' ? 'revision-gone' : 'doc'" :home="router.base" @home="goHome" />
    <div v-else-if="onScreen" class="main-pane embed-pane">
      <div v-if="fileView" class="file-view">
        <img v-if="fileView.kind === 'image'" :src="fileView.url" :alt="fileView.name" />
        <a v-else :href="fileView.url" :download="fileView.name">Download {{ fileView.name }}</a>
      </div>
      <PreviewPane v-else ref="previewRef" :content="markdown" :comments="NO_COMMENTS" :theme="theme" :content-type="contentType" />
    </div>
    <div class="embed-footer">
      <a class="embed-open-link" data-testid="embed-open-link" :href="embedOpenHref" target="_blank" rel="noopener">Open in md-review</a>
    </div>
  </div>
  <div v-else class="app">
    <HeaderBar
      v-if="showHeader"
      :filename="onScreen ? filename : ''"
      :pane-mode="paneMode"
      :comment-count="comments.length"
      :theme="theme"
      :word-count="wordCount"
      :char-count="charCount"
      :can-refresh="!!filePathParam && onScreen && route.kind === 'landing'"
      :sharing="sharing"
      :sync-status="sync.syncStatus.value"
      :save-state="sync.saveState.value"
      :pending-count="sync.pendingCount.value"
      :paste-id="onScreen ? pasteId : null"
      :reviewer-name="reviewerName"
      :revision-count="revisionList.length"
      :has-unseen-changes="!!changeSummary"
      :read-only="readOnly"
      @update:pane-mode="onPaneModeChange"
      @update:theme="setTheme"
      @update:filename="filename = $event"
      @open-file="handleOpenFile"
      @new-doc="handleNewDoc"
      @generate-prompt="showPromptModal = true"
      @refresh="loadFromFilePath"
      @share="handleShare"
      @save-markdown="handleSaveMarkdown"
      @update:reviewer-name="setReviewerName"
      @open-history="openHistory"
    />

    <div
      v-if="onScreen && pinnedInfo && route.kind === 'pinned'"
      class="notice-bar pinned-banner"
      role="status"
      data-testid="pinned-revision-banner"
    >
      <span>You're viewing a version from {{ pinnedWhen }}.</span>
      <a
        class="btn btn-ghost btn-sm"
        data-testid="pinned-revision-latest-link"
        :href="`${router.base}d/${pinnedInfo.id}`"
        @click="onAppLinkClick($event, `${router.base}d/${pinnedInfo.id}`)"
      >View the latest version</a>
    </div>

    <ApprovalBanner
      v-if="onScreen && pasteId && approvalInfo"
      :approval-status="approvalInfo.approval_status"
      :approved-by="approvalInfo.approved_by"
      :approved-at="approvalInfo.approved_at"
      :unresolved-must-fix-count="unresolvedMustFixCount"
      :paste-id="pasteId"
      :default-reviewer="reviewerName"
      @approve="handleApprove"
      @request-changes="handleRequestChanges"
    />

    <SummaryPanel
      v-if="onScreen && pasteId"
      :filename="filename"
      :comments="comments"
      :approval-status="approvalInfo?.approval_status"
    />

    <ChangesBanner
      v-if="onScreen && pasteId && changeSummary"
      :summary="changeSummary"
      @view="handleViewChanges"
      @dismiss="handleDismissChanges"
    />

    <div v-if="notice && route.kind !== 'library' && route.kind !== 'not-found'" class="notice-bar" role="status">
      <span>{{ notice }}</span>
      <button class="btn btn-ghost btn-sm" @click="notice = null">Dismiss</button>
    </div>

    <div v-if="onScreen && persistError" class="notice-bar warn" role="status" data-testid="persist-error">
      <span>{{ persistError }}</span>
    </div>

    <div v-if="onScreen && sync.conflict.value" class="conflict-bar" role="alert" data-testid="conflict-bar">
      <span class="conflict-text">
        <strong>Conflict:</strong> this document changed on the server while you had unsaved edits.
        Your edits are kept here until you choose.
      </span>
      <span class="conflict-actions">
        <button class="btn btn-ghost btn-sm" title="Discard your local edits and load the server copy" @click="sync.adoptRemote()">Use server version</button>
        <button class="btn btn-primary btn-sm" title="Overwrite the server copy with your edits" @click="sync.overwriteRemote()">Keep my version</button>
      </span>
    </div>

    <RouteNotFound v-if="route.kind === 'not-found'" kind="route" :home="router.base" @home="goHome" />

    <DashboardView v-else-if="route.kind === 'library'" @new-doc="handleNewDoc" />

    <RouteNotFound v-else-if="docMissing" :kind="docMissing === 'revision-gone' ? 'revision-gone' : 'doc'" :home="router.base" @home="goHome" />

    <FileUpload v-else-if="route.kind === 'landing' && booted && !onScreen" @file-loaded="handleFileLoaded" />

    <div v-if="onScreen" class="review-layout">
      <div class="main-pane">
        <div v-if="fileView" class="file-view">
          <img v-if="fileView.kind === 'image'" :src="fileView.url" :alt="fileView.name" />
          <a v-else class="btn btn-primary" :href="fileView.url" :download="fileView.name">Download {{ fileView.name }}</a>
        </div>
        <EditorPane
          v-else-if="paneMode === 'edit' && !readOnly"
          ref="editorRef"
          v-model="markdown"
          :comments="comments"
          :content-type="contentType"
          @selection="handleSelection"
          @selection-clear="handleSelectionClear"
        />
        <PreviewPane
          v-else
          ref="previewRef"
          :content="markdown"
          :comments="comments"
          :theme="theme"
          :content-type="contentType"
          @selection="handleSelection"
          @selection-clear="handleSelectionClear"
        />
      </div>
      <template v-if="!readOnly">
        <button
          class="sidebar-toggle"
          :class="{ collapsed: sidebarHidden }"
          :title="sidebarHidden ? 'Show comments panel' : 'Hide comments panel'"
          @click="sidebarHidden = !sidebarHidden"
        >
          <span class="sidebar-toggle-grip"></span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          <span class="sidebar-toggle-grip"></span>
        </button>
        <CommentsSidebar
          v-show="!sidebarHidden"
          :comments="comments"
          @delete="sync.deleteComment"
          @edit="sync.editComment"
          @scroll-to="handleScrollTo"
          @export-comments="handleExportComments"
          @import-comments="handleImportComments"
          @add-reply="handleAddReply"
          @edit-reply="sync.editReply"
          @delete-reply="sync.deleteReply"
          @resolve="handleResolve"
          @unresolve="sync.unresolveComment"
        />
      </template>
    </div>
    <div v-else-if="isDocRoute && !docMissing" class="doc-loading" aria-busy="true"></div>

    <SelectionActionBar
      :visible="showActionBar"
      :coords="selection?.coords ?? { x: 0, y: 0 }"
      @comment="handleOpenComment"
      @dismiss="handleDismissActionBar"
    />

    <CommentPopover
      :visible="showPopover"
      :selected-text="selection?.selectedText ?? ''"
      :coords="selection?.coords ?? { x: 0, y: 0 }"
      :author="reviewerName"
      @add="handleAddComment"
      @cancel="handleCancelPopover"
    />

    <PromptModal
      :visible="showPromptModal"
      :filename="filename"
      :comments="comments"
      :content="markdown"
      @close="showPromptModal = false"
    />

    <RevisionsModal
      :visible="showHistory"
      :paste-id="pasteId"
      :revisions="revisionList"
      :current-hash="sync.serverHash.value"
      :initial-from="historyFrom"
      @close="showHistory = false"
      @restore="handleRestoreRevision"
      @acknowledged="acknowledge"
    />

    <ShareModal
      :visible="showShareModal"
      :filename="filename"
      :urls="shareResult"
      :comment-count="comments.length"
      @close="showShareModal = false"
    />
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.notice-bar,
.conflict-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.notice-bar {
  background: var(--bg-page);
  color: var(--text-muted);
}

.notice-bar.warn {
  color: #b45309;
  background: rgba(245, 158, 11, 0.08);
}

.conflict-bar {
  background: rgba(220, 38, 38, 0.08);
  color: var(--text-primary);
  border-bottom-color: rgba(220, 38, 38, 0.35);
}

.conflict-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.app.embed {
  position: relative;
}

.embed-pane {
  flex: 1;
}

.embed-pane {
  min-height: 0;
}

/* In the flow under the content (never over it, even on a phone). */
.embed-footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-surface);
}

.embed-open-link {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-muted);
  text-decoration: none;
}

.embed-open-link:hover {
  color: var(--text-primary);
}

.pinned-banner {
  color: var(--text-primary);
}

.file-view {
  height: 100%;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-surface);
}

.file-view img {
  max-width: 100%;
  max-height: 100%;
}

.doc-loading {
  flex: 1;
}

.review-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.main-pane {
  flex: 7;
  overflow: hidden;
}

.sidebar-toggle {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 16px;
  flex-shrink: 0;
  border: none;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  background: var(--bg-page);
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  transition: color 0.15s, background 0.15s;
}

.sidebar-toggle:hover {
  color: var(--text-primary);
  background: var(--bg-surface);
}

.sidebar-toggle-grip {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.4;
}

.sidebar-toggle:hover .sidebar-toggle-grip {
  opacity: 0.7;
}

.sidebar-toggle svg {
  transition: transform 0.15s;
}

.sidebar-toggle.collapsed svg {
  transform: rotate(180deg);
}

.review-layout > :deep(.sidebar) {
  flex: 3;
  max-width: 340px;
  min-width: 260px;
}
</style>
