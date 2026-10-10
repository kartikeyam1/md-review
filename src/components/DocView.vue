<script setup lang="ts">
import { ref, computed, defineAsyncComponent, onMounted, watch } from 'vue'
import type { RevisionEntry } from '@/composables/useShare'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'
import { markExternalChange } from '@/composables/useExternalChange'
import DocHeader from '@/components/DocHeader.vue'
import DocBanners from '@/components/DocBanners.vue'
import CommentsLayer from '@/components/CommentsLayer.vue'
import FileUpload from '@/components/FileUpload.vue'
import LazyEditor from '@/components/LazyEditor.vue'
import PreviewPane from '@/components/PreviewPane.vue'
import PromptModal from '@/components/PromptModal.vue'
import ShareModal from '@/components/ShareModal.vue'
import RouteNotFound from '@/components/RouteNotFound.vue'
import TocPanel from '@/components/TocPanel.vue'
import { provideToc } from '@/composables/useToc'
import { useActiveHeading } from '@/composables/useActiveHeading'
import { useBreakpoint } from '@/composables/useBreakpoint'

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
  router, route, embed, readOnly, docMissing, fileView, onScreen, booted, screenKey,
  view, mode, capability, reviewUI, historyId, historyCurrent, historyLive,
  paneMode, markdown, filename, contentType, pasteId, NO_COMMENTS,
  showPromptModal, sidebarHidden, notice, showShareModal, shareResult,
  comments, revisionList, showHistory, historyFrom, acknowledge,
  theme, confirmDiscardIfDirty, handleSelection, handleSelectionClear, setHighlightClearer,
} = doc

// The panes belong to the layout; the selection flow only needs to clear the preview's highlight.
const editorRef = ref<InstanceType<typeof LazyEditor>>()
const previewRef = ref<InstanceType<typeof PreviewPane>>()
onMounted(() => setHighlightClearer(() => previewRef.value?.clearSelectionHighlight()))

// #6: the editor is lazy. Its slot mounts the first time the doc is shown in
// edit view (which fetches the chunk) and then stays mounted, hidden with
// v-show, so read ↔ edit keeps the same editor instance (rule 5) — for the
// lifetime of the open document only: `docKey` changes with the doc on screen,
// which drops the slot (and with it any per-doc editor state, e.g. #8 history).
const editorShown = computed(() => paneMode.value === 'edit' && capability.value === 'editor' && !readOnly.value && !fileView.value)
const docKey = computed(() => `${screenKey.value ?? ''}|${pasteId.value ?? ''}`)
const editorMounted = ref(false)
watch(editorShown, (shown) => { if (shown) editorMounted.value = true }, { immediate: true })
watch(docKey, () => { editorMounted.value = editorShown.value })
// #23: a viewer never keeps a hidden editor — losing edit access drops the kept slot.
watch(capability, (c) => { if (c !== 'editor') editorMounted.value = false })

function handleRestoreRevision(oldMarkdown: string, entry: RevisionEntry | null) {
  if (!confirmDiscardIfDirty()) return
  showHistory.value = false
  markExternalChange(oldMarkdown, 'local') // one undo step back (#8 rule 6)
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

/**
 * #5 rule 2: the read view of a markdown doc scrolls the document itself (the
 * header is sticky); edit view, HTML (iframe) docs and file views keep the
 * fixed-viewport layout with internally scrolling panes.
 */
const docScroll = computed(() => onScreen.value && !editorShown.value && !fileView.value && contentType.value !== 'html')

// #3: the TOC — read view of a markdown doc only (never edit view, HTML, files or embeds).
const breakpoint = useBreakpoint()
const toc = provideToc({ markdown, enabled: docScroll, breakpoint })
const activeHeading = useActiveHeading({ entries: toc.entries, activeId: toc.activeId, enabled: toc.visible })

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
  <div v-else class="app" :class="{ 'doc-scroll': docScroll }" :data-view="view" :data-mode="mode" :data-capability="capability">
    <DocHeader v-if="showHeader" />
    <DocBanners />

    <RouteNotFound v-if="docMissing" :kind="docMissing === 'revision-gone' ? 'revision-gone' : 'doc'" :home="router.base" @home="goHome" />
    <FileUpload v-else-if="route.kind === 'landing' && booted && !onScreen" @file-loaded="actions.handleFileLoaded" />

    <div v-if="onScreen" class="doc-body review-layout">
      <div class="doc-rail"><TocPanel v-if="toc.railShown.value" :toc="toc" variant="rail" @pin="activeHeading.pin" /></div>
      <main class="doc-content main-pane">
        <div v-if="fileView" class="file-view">
          <img v-if="fileView.kind === 'image'" :src="fileView.url" :alt="fileView.name" />
          <a v-else class="btn btn-primary" :href="fileView.url" :download="fileView.name">Download {{ fileView.name }}</a>
        </div>
        <LazyEditor
          v-if="editorMounted && !fileView"
          v-show="editorShown"
          :key="docKey"
          ref="editorRef"
          v-model="markdown"
          :active="editorShown"
          :comments="reviewUI ? comments : NO_COMMENTS"
          :content-type="contentType"
          @selection="handleSelection"
          @selection-clear="handleSelectionClear"
        />
        <PreviewPane
          v-if="!fileView && !editorShown"
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
    <TocPanel v-if="toc.visible.value && toc.drawerMode.value" :toc="toc" variant="drawer" @pin="activeHeading.pin" />

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
  height: 100dvh;
  display: flex;
  flex-direction: column;
}

/* #5 rule 2: document scroll in the read view; the header sticks (DocHeader). */
.app.doc-scroll {
  height: auto;
  min-height: 100vh;
  min-height: 100dvh;
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

/* The TOC rail (#3) sticks inside its full-height column. */
.doc-rail {
  flex-shrink: 0;
  align-items: flex-start;
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

.doc-scroll .doc-body {
  flex: 1 0 auto;
  overflow: visible;
}

.doc-scroll .doc-content {
  overflow: visible;
  background: var(--bg-surface);
}

.doc-scroll .doc-content :deep(.preview-pane) {
  height: auto;
  overflow: visible;
}

/* The desktop comments rail stays in view while the document scrolls under it. */
.doc-scroll .doc-aside {
  position: sticky;
  top: var(--header-h);
  align-self: flex-start;
  height: calc(100vh - var(--header-h));
  height: calc(100dvh - var(--header-h));
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

/* #5 rule 8: below 1100px the comments are a bottom-sheet drawer (CommentsLayer):
   no rail and no toggle strip take width from the doc. */
@media (max-width: 1099.98px) {
  .doc-aside,
  .doc-scroll .doc-aside {
    display: contents;
  }
}
</style>
