<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import type { AppMode, PaneMode, CommentCategory, ApprovalInfo, ContentType } from '@/types'
import { useComments } from '@/composables/useComments'
import { usePersistence, useThemePersistence } from '@/composables/usePersistence'
import { useShare } from '@/composables/useShare'
import { detectContentType } from '@/composables/useContentType'
import { useSync } from '@/composables/useSync'
import { useReviewer } from '@/composables/useReviewer'
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
}, { filename })

const { theme, setTheme } = useThemePersistence()

const { clearPersisted, takeRestoredDraft, restored, persistError } = usePersistence(
  markdown,
  filename,
  comments,
  contentType,
  loadComments,
  (mode) => { appMode.value = mode },
  { pasteId, serverMarkdown: sync.serverMarkdown },
)

const { sharing, shareError, createShare, loadShareDetailed, fetchGithub, getShareIdFromHash, setShareHash, clearShareHash, getShareUrls, getApproval, putApproval } = useShare()

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
  const id = await createShare(markdown.value, filename.value, comments.value, undefined, contentType.value)
  if (id) {
    setShareHash(id)
    pasteId.value = id
    sync.setBaseline({ markdown: markdown.value, filename: filename.value })
    shareResult.value = getShareUrls(id)
    showShareModal.value = true
    refreshApproval()
  } else {
    alert(shareError.value || 'Failed to create share link.')
  }
}

function detachFromShare() {
  pasteId.value = null
  approvalInfo.value = null
  clearShareHash()
}

async function loadSharedDoc() {
  const shareId = getShareIdFromHash()
  if (!shareId) return
  // Already attached to this session (hash re-fired) — do not reload over local edits.
  if (pasteId.value === shareId) return

  const { data, status } = await loadShareDetailed(shareId)
  if (getShareIdFromHash() !== shareId) return // navigated away meanwhile

  if (!data) {
    const draft = takeRestoredDraft(shareId)
    if (status === 404 || status === 410) {
      // Session gone. Keep whatever is on screen as a plain local document.
      detachFromShare()
      notice.value = status === 410
        ? 'This shared session has expired. Showing your local copy.'
        : 'This shared session no longer exists. Showing your local copy.'
      if (!markdown.value) appMode.value = 'upload'
      return
    }
    // Server unreachable. If the persisted copy belongs to this session, stay
    // attached so polling/autosave resume when it comes back.
    notice.value = 'Cannot reach the review server. Showing your local copy; it will sync when the server is back.'
    if (draft) {
      pasteId.value = shareId
      if (draft.baseMarkdown !== null) {
        sync.setBaseline({ markdown: draft.baseMarkdown, filename: draft.filename })
      } else {
        sync.expectDraft()
      }
    }
    return
  }

  handleFileLoaded(data.markdown, data.filename, data.contentType, { shared: true })
  if (data.comments?.length) {
    loadComments(data.comments)
  }
  pasteId.value = shareId
  sync.setBaseline({
    markdown: data.markdown,
    filename: data.filename,
    contentHash: data.content_hash ?? null,
    etag: data.etag ?? null,
  })
  // A reload with unsaved edits: put them back on top of the fresh server copy.
  const draft = takeRestoredDraft(shareId)
  if (draft && !draft.clean && draft.markdown !== data.markdown) {
    sync.restoreDraft(draft.markdown, draft.baseMarkdown)
    notice.value = sync.conflict.value
      ? 'Restored your unsaved edits, but the server copy changed in the meantime — choose a version below.'
      : 'Restored your unsaved edits from this browser.'
  }
  paneMode.value = 'preview'
  refreshApproval()
}

async function loadFromGithubHash() {
  const hash = window.location.hash
  const match = hash.match(/^#github=(.+)$/)
  if (!match) return

  const githubUrl = decodeURIComponent(match[1])
  const data = await fetchGithub(githubUrl)
  if (data) {
    handleFileLoaded(data.content, data.filename)
  }
}

function checkDashboardHash(): boolean {
  if (window.location.hash === '#dashboard') {
    appMode.value = 'dashboard'
    return true
  }
  return false
}

function onHashChange() {
  if (checkDashboardHash()) return
  loadSharedDoc()
  loadFromGithubHash()
}

onMounted(async () => {
  filePathParam.value = new URLSearchParams(window.location.search).get('filePath')
  // Put the previous draft back first: loadSharedDoc() reconciles it against
  // the server copy and the upload screen must not flash over a restored doc.
  await restored
  booted.value = true
  if (!checkDashboardHash()) {
    loadFromFilePath()
    loadSharedDoc()
    loadFromGithubHash()
  }
  window.addEventListener('hashchange', onHashChange)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange)
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
  }
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
  clearComments()
  clearPersisted()
  dismissAll()
  notice.value = null
  markdown.value = ''
  filename.value = ''
  contentType.value = 'markdown'
  pasteId.value = null
  approvalInfo.value = null
  appMode.value = 'upload'
  if (window.location.search || window.location.hash) {
    window.history.replaceState({}, '', window.location.pathname)
  }
}

function handleSelection(info: {
  startLine: number
  endLine: number
  selectedText: string
  coords: { x: number; y: number }
}) {
  if (showPopover.value) return
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
  <div class="app">
    <HeaderBar
      v-if="appMode !== 'dashboard'"
      :filename="filename"
      :pane-mode="paneMode"
      :comment-count="comments.length"
      :theme="theme"
      :word-count="wordCount"
      :char-count="charCount"
      :can-refresh="!!filePathParam"
      :sharing="sharing"
      :sync-status="sync.syncStatus.value"
      :save-state="sync.saveState.value"
      :pending-count="sync.pendingCount.value"
      :paste-id="pasteId"
      :reviewer-name="reviewerName"
      @update:pane-mode="paneMode = $event"
      @update:theme="setTheme"
      @update:filename="filename = $event"
      @open-file="handleOpenFile"
      @new-doc="handleNewDoc"
      @generate-prompt="showPromptModal = true"
      @refresh="loadFromFilePath"
      @share="handleShare"
      @save-markdown="handleSaveMarkdown"
      @update:reviewer-name="setReviewerName"
    />

    <DashboardView v-if="appMode === 'dashboard'" @new-doc="handleNewDoc" />

    <FileUpload v-if="appMode === 'upload' && booted" @file-loaded="handleFileLoaded" />

    <ApprovalBanner
      v-if="appMode === 'review' && pasteId && approvalInfo"
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
      v-if="appMode === 'review' && pasteId"
      :filename="filename"
      :comments="comments"
      :approval-status="approvalInfo?.approval_status"
    />

    <div v-if="notice" class="notice-bar" role="status">
      <span>{{ notice }}</span>
      <button class="btn btn-ghost btn-sm" @click="notice = null">Dismiss</button>
    </div>

    <div v-if="appMode === 'review' && persistError" class="notice-bar warn" role="status" data-testid="persist-error">
      <span>{{ persistError }}</span>
    </div>

    <div v-if="appMode === 'review' && sync.conflict.value" class="conflict-bar" role="alert" data-testid="conflict-bar">
      <span class="conflict-text">
        <strong>Conflict:</strong> this document changed on the server while you had unsaved edits.
        Your edits are kept here until you choose.
      </span>
      <span class="conflict-actions">
        <button class="btn btn-ghost btn-sm" title="Discard your local edits and load the server copy" @click="sync.adoptRemote()">Use server version</button>
        <button class="btn btn-primary btn-sm" title="Overwrite the server copy with your edits" @click="sync.overwriteRemote()">Keep my version</button>
      </span>
    </div>

    <div v-if="appMode === 'review'" class="review-layout">
      <div class="main-pane">
        <EditorPane
          v-if="paneMode === 'edit'"
          ref="editorRef"
          v-model="markdown"
          :comments="comments"
          :content-type="contentType"
          @selection="handleSelection"
          @selection-clear="handleSelectionClear"
        />
        <PreviewPane
          v-if="paneMode === 'preview'"
          ref="previewRef"
          :content="markdown"
          :comments="comments"
          :theme="theme"
          :content-type="contentType"
          @selection="handleSelection"
          @selection-clear="handleSelectionClear"
        />
      </div>
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
    </div>

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
