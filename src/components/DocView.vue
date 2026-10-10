<script setup lang="ts">
import { ref, computed, defineAsyncComponent, onMounted } from 'vue'
import type { RevisionEntry } from '@/composables/useShare'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'
import DocHeader from '@/components/DocHeader.vue'
import DocBanners from '@/components/DocBanners.vue'
import CommentsLayer from '@/components/CommentsLayer.vue'
import FileUpload from '@/components/FileUpload.vue'
import EditorPane from '@/components/EditorPane.vue'
import PreviewPane from '@/components/PreviewPane.vue'
import PromptModal from '@/components/PromptModal.vue'
import ShareModal from '@/components/ShareModal.vue'
import RouteNotFound from '@/components/RouteNotFound.vue'

// The doc layout (00 §4.2): header, the below-header stack (DocBanners), the
// body, and the modals. App.vue is the router shell; this renders the
// landing/doc/pinned/file routes. The body has three regions; later items add
// one line in theirs:
//   rail    — #3 toc-panel
//   content — the doc (file view | editor | preview); #24 reaction-bar after it
//   aside   — review-mode comments (CommentsLayer)

// Carries the diff library — only loaded when someone opens History.
const RevisionsModal = defineAsyncComponent(() => import('@/components/RevisionsModal.vue'))

const doc = useDocState()
const actions = useDocActions()
const {
  router, route, embed, readOnly, docMissing, fileView, onScreen, booted,
  view, mode, capability, reviewUI, historyId, historyCurrent, historyLive,
  paneMode, markdown, filename, contentType, pasteId, NO_COMMENTS,
  showPromptModal, sidebarHidden, notice, showShareModal, shareResult,
  comments, revisionList, showHistory, historyFrom, acknowledge,
  theme, confirmDiscardIfDirty, handleSelection, handleSelectionClear, setHighlightClearer,
} = doc

// The panes belong to the layout; the selection flow only needs to clear the preview's highlight.
const editorRef = ref<InstanceType<typeof EditorPane>>()
const previewRef = ref<InstanceType<typeof PreviewPane>>()
onMounted(() => setHighlightClearer(() => previewRef.value?.clearSelectionHighlight()))

function handleRestoreRevision(oldMarkdown: string, entry: RevisionEntry | null) {
  if (!confirmDiscardIfDirty()) return
  showHistory.value = false
  markdown.value = oldMarkdown
  const when = entry ? new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'an earlier version'
  notice.value = `Restored the version from ${when} as unsaved edits — it will autosave shortly. Use History again to go back.`
}

function scrollToLine(line: number) {
  if (paneMode.value === 'edit') editorRef.value?.scrollToLine(line)
  else previewRef.value?.scrollToLine(line)
}

function goHome() {
  router.push(router.base)
}

const isDocRoute = computed(() => ['doc', 'pinned', 'file'].includes(route.value.kind))
const showHeader = computed(() => route.value.kind !== 'library' && route.value.kind !== 'not-found' && !docMissing.value)

/** Rule 16: the same URL without `embed`, for "Open in md-review". */
const embedOpenHref = computed(() => {
  const u = new URL(router.current.value.href)
  u.searchParams.delete('embed')
  return u.href
})
</script>

<template>
  <div v-if="embed" class="app embed" :data-view="view" :data-mode="mode" :data-capability="capability">
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
  <div v-else class="app" :data-view="view" :data-mode="mode" :data-capability="capability">
    <DocHeader v-if="showHeader" />
    <DocBanners />

    <RouteNotFound v-if="docMissing" :kind="docMissing === 'revision-gone' ? 'revision-gone' : 'doc'" :home="router.base" @home="goHome" />
    <FileUpload v-else-if="route.kind === 'landing' && booted && !onScreen" @file-loaded="actions.handleFileLoaded" />

    <div v-if="onScreen" class="doc-body review-layout">
      <div class="doc-rail"><!-- #3 toc-panel --></div>
      <main class="doc-content main-pane">
        <div v-if="fileView" class="file-view">
          <img v-if="fileView.kind === 'image'" :src="fileView.url" :alt="fileView.name" />
          <a v-else class="btn btn-primary" :href="fileView.url" :download="fileView.name">Download {{ fileView.name }}</a>
        </div>
        <EditorPane
          v-else-if="paneMode === 'edit' && !readOnly"
          ref="editorRef"
          v-model="markdown"
          :comments="reviewUI ? comments : NO_COMMENTS"
          :content-type="contentType"
          @selection="handleSelection"
          @selection-clear="handleSelectionClear"
        />
        <PreviewPane
          v-else
          ref="previewRef"
          :content="markdown"
          :comments="reviewUI ? comments : NO_COMMENTS"
          :commenting="reviewUI && !readOnly"
          :theme="theme"
          :content-type="contentType"
          @selection="handleSelection"
          @selection-clear="handleSelectionClear"
        />
        <!-- #24 reaction-bar -->
      </main>
      <aside class="doc-aside" :class="{ collapsed: sidebarHidden }"><CommentsLayer v-if="reviewUI" @scroll-to="scrollToLine" /></aside>
    </div>
    <div v-else-if="isDocRoute && !docMissing" class="doc-loading" aria-busy="true"></div>

    <PromptModal
      :visible="showPromptModal && reviewUI"
      :filename="filename"
      :comments="comments"
      :content="markdown"
      @close="showPromptModal = false"
    />

    <RevisionsModal
      :visible="showHistory"
      :paste-id="historyId"
      :revisions="revisionList"
      :current-hash="historyCurrent"
      :live-hash="historyLive"
      :initial-from="historyFrom"
      :allow-restore="capability === 'editor'"
      @close="showHistory = false"
      @restore="handleRestoreRevision"
      @acknowledged="acknowledge"
    />

    <ShareModal
      :visible="showShareModal"
      :filename="filename"
      :urls="shareResult"
      :comment-count="comments.length"
      :paste-id="pasteId"
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

/* Body regions: rail | content | aside. */
.doc-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

.doc-rail,
.doc-aside {
  display: flex;
  min-height: 0;
}

.doc-rail:empty,
.doc-aside:empty {
  display: none;
}

.doc-content {
  flex: 7;
  min-width: 0;
  overflow: hidden;
}

/* The comments sidebar keeps its old share of the row: 30%, 260–340px (+ the 16px strip). */
.doc-aside {
  flex: 3;
  max-width: 356px;
  min-width: 276px;
}

.doc-aside.collapsed {
  flex: none;
  min-width: 0;
}

.doc-aside > :deep(.sidebar) {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
