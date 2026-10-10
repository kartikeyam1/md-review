<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import type { PaneMode, CommentCategory } from '@/types'
import type { RevisionEntry } from '@/composables/useShare'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'
import ChangesBanner from '@/components/ChangesBanner.vue'
import DocHeader from '@/components/DocHeader.vue'
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
import RouteNotFound from '@/components/RouteNotFound.vue'

// The doc layout (00 §4.2): header, banners, content + comments, modals.
// App.vue is the router shell; this renders landing/doc/pinned/file routes.

// Carries the diff library — only loaded when someone opens History.
const RevisionsModal = defineAsyncComponent(() => import('@/components/RevisionsModal.vue'))

const doc = useDocState()
const actions = useDocActions()
const {
  router, route, embed, readOnly, docMissing, pinnedInfo, fileView, onScreen, booted,
  paneMode, markdown, filename, contentType, pasteId, NO_COMMENTS,
  showPromptModal, sidebarHidden, notice, showShareModal, shareResult,
  reviewerName, setReviewerName, authorField, comments, loadComments, sync,
  revisionList, showHistory, historyFrom, changeSummary, acknowledge, openHistory,
  theme, approvalInfo, unresolvedMustFixCount,
  flushAutosave, confirmDiscardIfDirty,
  selection, showActionBar, showPopover, editorRef, previewRef, dismissAll,
} = doc
const persistError = doc.persistence.persistError

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

async function handleApprove(approvedBy: string) {
  if (!pasteId.value) return
  setReviewerName(approvedBy)
  const result = await doc.share.putApproval(pasteId.value, 'approved', approvedBy)
  if (result && !result.error) approvalInfo.value = result
  else if (result?.error) alert(result.error)
}

async function handleRequestChanges(approvedBy: string) {
  if (!pasteId.value) return
  setReviewerName(approvedBy)
  const result = await doc.share.putApproval(pasteId.value, 'changes_requested', approvedBy)
  if (result && !result.error) approvalInfo.value = result
}

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
    <DocHeader v-if="showHeader" @update:pane-mode="onPaneModeChange" />

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

    <div v-if="notice" class="notice-bar" role="status">
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

    <RouteNotFound v-if="docMissing" :kind="docMissing === 'revision-gone' ? 'revision-gone' : 'doc'" :home="router.base" @home="goHome" />

    <FileUpload v-else-if="route.kind === 'landing' && booted && !onScreen" @file-loaded="actions.handleFileLoaded" />

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
