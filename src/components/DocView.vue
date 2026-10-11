<script setup lang="ts">
import { ref, computed, defineAsyncComponent, nextTick, onMounted, onBeforeUnmount, onUnmounted, watch } from 'vue'
import type { RevisionEntry } from '@/composables/useShare'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'
import { markExternalChange } from '@/composables/useExternalChange'
import { setAttachmentHost } from '@/composables/attachments'
import { docIdOf } from '@/composables/useEditToken'
import DocHeader from '@/components/DocHeader.vue'
import DocBanners from '@/components/DocBanners.vue'
import CommentsLayer from '@/components/CommentsLayer.vue'
import LazyEditor from '@/components/LazyEditor.vue'
import PreviewPane from '@/components/PreviewPane.vue'
import SplitView from '@/components/SplitView.vue'
import RouteNotFound from '@/components/RouteNotFound.vue'
import TocPanel from '@/components/TocPanel.vue'
import { focusActive, setFocusAllowed, setFocusMode, toggleFocusMode } from '@/composables/useFocusMode'
import { useGlobalShortcuts } from '@/composables/useGlobalShortcuts'
import { provideToc } from '@/composables/useToc'
import { useActiveHeading } from '@/composables/useActiveHeading'
import { useBreakpoint } from '@/composables/useBreakpoint'
import ReactionBar from '@/components/ReactionBar.vue'
import ReactionOverlays from '@/components/ReactionOverlays.vue'

// The doc layout (00 §4.2): header, the below-header stack (DocBanners), the
// body, and the modals. App.vue is the router shell; this renders the
// landing/doc/pinned/file routes. The body has three regions; later items add
// one line in theirs:
//   rail    — #3 toc-panel
//   content — the doc (file view | editor | preview); #24 reaction-bar after it
//   aside   — review-mode comments (CommentsLayer)

// Carries the diff library — only loaded when someone opens History.
const RevisionsModal = defineAsyncComponent(() => import('@/components/RevisionsModal.vue'))
// Off the entry chunk (the #6 AC-06.8 budget): dialogs and the landing upload screen
// render on demand; each chunk loads when DocView first renders it.
const PromptModal = defineAsyncComponent(() => import('@/components/PromptModal.vue'))
const ShareModal = defineAsyncComponent(() => import('@/components/ShareModal.vue'))
const ShareRequiredDialog = defineAsyncComponent(() => import('@/components/ShareRequiredDialog.vue'))
const FileUpload = defineAsyncComponent(() => import('@/components/FileUpload.vue'))
// #13: rendered only in focus mode.
const FocusControls = defineAsyncComponent(() => import('@/components/FocusControls.vue'))
// #28: the "N agent-only sections hidden" line, only for docs that have any.
const AgentSectionsNotice = defineAsyncComponent(() => import('@/components/AgentSectionsNotice.vue'))
// #29: the deck, only for ?view=slides.
const SlidesView = defineAsyncComponent(() => import('@/components/SlidesView.vue'))

const doc = useDocState()
const actions = useDocActions()
const {
  router, route, embed, readOnly, docMissing, fileView, onScreen, booted, screenKey,
  view, mode, capability, reviewUI, historyId, historyCurrent, historyLive,
  paneMode, markdown, filename, contentType, pasteId, NO_COMMENTS,
  showPromptModal, sidebarHidden, notice, showShareModal, shareResult,
  comments, revisionList, showHistory, historyFrom, acknowledge,
  theme, confirmDiscardIfDirty, handleSelection, handleSelectionClear, setHighlightClearer, reactions,
  agentSectionCount, rawMarkdownUrl,
} = doc

// The panes belong to the layout; the selection flow only needs to clear the preview's highlight.
const editorRef = ref<InstanceType<typeof LazyEditor>>()
const previewRef = ref<InstanceType<typeof PreviewPane>>()
onMounted(() => setHighlightClearer(() => previewRef.value?.clearSelectionHighlight()))

// #6: the editor is lazy. Its slot mounts the first time the doc is shown in
// edit or split view (which fetches the chunk) and then stays mounted, hidden
// with v-show, so read ↔ edit ↔ split keeps the same editor instance (rule 5) —
// for the lifetime of the open document only: `docKey` changes with the doc on
// screen, which drops the slot (and with it any per-doc editor state, e.g. #8 history).
const editorShown = computed(() => paneMode.value !== 'preview' && capability.value === 'editor' && !readOnly.value && !fileView.value)
/** #7: editor and preview side by side (or as tabs below 960px). */
const splitShown = computed(() => editorShown.value && paneMode.value === 'split')
const previewShown = computed(() => !fileView.value && (!editorShown.value || splitShown.value))
const docKey = computed(() => `${screenKey.value ?? ''}|${pasteId.value ?? ''}`)
const editorMounted = ref(false)
watch(editorShown, (shown) => { if (shown) editorMounted.value = true }, { immediate: true })
watch(docKey, () => { editorMounted.value = editorShown.value })
// #23: a viewer never keeps a hidden editor — losing edit access drops the kept slot.
watch(capability, (c) => { if (c !== 'editor') editorMounted.value = false })

// ── #13 focus mode ───────────────────────────────────────────────────────────
// Only in the edit and split views, for editors, never in an embed (rule 1).
// In memory: off on load, on leaving the editing views or the document (rule 10).
const focusAllowed = computed(() => onScreen.value && editorShown.value && !embed.value)
const focusShown = focusActive()
setFocusMode(false)
watch(focusAllowed, (ok) => {
  setFocusAllowed(ok)
  // Fetch the (lazy) floating controls while focus mode is merely possible, so they draw at once.
  if (ok) void import('@/components/FocusControls.vue')
}, { immediate: true })
watch(docKey, () => setFocusMode(false))
onUnmounted(() => setFocusAllowed(false))
// Rule 8: entering (and leaving) keeps keyboard focus in the editor, caret and scroll untouched.
watch(focusShown, () => nextTick(() => editorRef.value?.focus()))

const OPEN_LAYERS = '.modal-overlay, [aria-modal="true"], [data-testid="slash-menu"], [data-testid="zoom-viewer"]'
const layerOpen = () => !!document.querySelector(OPEN_LAYERS)

useGlobalShortcuts([
  // Mod+Shift+Enter, whatever has focus (00 §3.5) — not under an open dialog; a held key toggles once.
  { key: 'Enter', mod: true, shift: true, alt: false, when: () => focusAllowed.value && !layerOpen(), run: (e) => { if (!e.repeat) toggleFocusMode() } },
])

/**
 * Rule 9 / 00 §3.4: Esc leaves focus mode only once every inner layer has had
 * it. Layers that handle Esc themselves mark the event (preventDefault /
 * stopPropagation: CodeMirror's search panel and selection simplify, the
 * shortcuts overlay, drawers); dialogs that only close on it are still in the
 * DOM while this bubble-phase listener runs. A held Esc closes one layer only.
 *
 * The comment action bar and popover (layer 5, in every editing or reading
 * view) sit above CodeMirror's own layers, so they close in the capture phase,
 * before the editor sees the key — except a popover holding a typed comment,
 * which Esc never throws away (in focus mode that Esc is swallowed, so it does
 * not leave focus mode either).
 */
const isEsc = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !e.isComposing
const popoverDraft = () => !!(document.querySelector<HTMLTextAreaElement>('.popover-input')?.value.trim())
// Dialogs that close on Esc in their own listener are gone from the DOM by the
// time a window bubble listener runs (Vue patches in the microtask between
// listeners), so "was a layer open?" is decided when the key arrives.
const escHadLayer = new WeakSet<Event>()
function onFocusEscapeCapture(e: KeyboardEvent) {
  if (!isEsc(e)) return
  if (layerOpen()) { escHadLayer.add(e); return }
  if (!(doc.showPopover.value || doc.showActionBar.value)) return
  if (doc.showPopover.value && popoverDraft()) {
    if (focusShown.value) { e.preventDefault(); e.stopPropagation() }
    return
  }
  e.preventDefault()
  e.stopPropagation()
  if (!e.repeat) doc.dismissAll()
}
function onFocusEscape(e: KeyboardEvent) {
  if (!isEsc(e) || !focusShown.value || escHadLayer.has(e) || layerOpen()) return
  e.preventDefault()
  if (!e.repeat) setFocusMode(false)
}
onMounted(() => {
  window.addEventListener('keydown', onFocusEscapeCapture, true)
  window.addEventListener('keydown', onFocusEscape)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onFocusEscapeCapture, true)
  window.removeEventListener('keydown', onFocusEscape)
})

function handleRestoreRevision(oldMarkdown: string, entry: RevisionEntry | null) {
  if (!confirmDiscardIfDirty()) return
  showHistory.value = false
  markExternalChange(oldMarkdown, 'local') // one undo step back (#8 rule 6)
  markdown.value = oldMarkdown
  const when = entry ? new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'an earlier version'
  notice.value = `Restored the version from ${when} as unsaved edits — it will autosave shortly. Use History again to go back.`
}

// #10: the editor's image paste/drop asks this layout for the doc it uploads
// to, and — for a never-shared doc — to share it first (rule 14).
const currentDoc = () => (pasteId.value ? { key: pasteId.value, id: docIdOf(pasteId.value) } : null)
/** The open share-required prompt's answer callback (null when closed). */
const shareAsk = ref<((ok: boolean) => void) | null>(null)
const stopHost = setAttachmentHost({
  doc: currentDoc,
  contentType: () => contentType.value,
  requestShare: () => new Promise((resolve) => {
    shareAsk.value?.(false)
    shareAsk.value = async (ok) => {
      shareAsk.value = null
      if (!ok) return resolve(null)
      // Share keeps the author in the editor they pasted into, edit or split (the share URL has no `view`).
      const wasView = paneMode.value
      try {
        await actions.handleShare()
      } catch {
        return resolve(null)
      }
      const shared = currentDoc()
      if (shared && wasView !== 'preview') actions.setView(wasView)
      resolve(shared)
    }
  }),
})
onBeforeUnmount(() => { shareAsk.value?.(false); stopHost() })
// Another doc while the prompt is open: nothing is inserted anywhere.
watch(docKey, () => shareAsk.value?.(false))

function scrollToLine(line: number) {
  // #7 rule 13: split view scrolls both panes.
  if (editorShown.value) editorRef.value?.scrollToLine(line)
  if (previewShown.value) previewRef.value?.scrollToLine(line)
}

function goHome() {
  router.push(router.base)
}

/**
 * #5 rule 2: the read view of a markdown doc scrolls the document itself (the
 * header is sticky); edit view, HTML (iframe) docs and file views keep the
 * fixed-viewport layout with internally scrolling panes.
 */
// #29: the deck replaces the header, banners and body (declared before anything that reads it).
const slidesShown = computed(() => onScreen.value && view.value === 'slides' && contentType.value === 'markdown' && !fileView.value && !docMissing.value)
const docScroll = computed(() => onScreen.value && !editorShown.value && !fileView.value && contentType.value !== 'html' && !slidesShown.value)

// #3: the TOC — read view of a markdown doc only (never edit view, HTML, files or embeds).
const breakpoint = useBreakpoint()
const toc = provideToc({ markdown, enabled: docScroll, breakpoint, agentView: computed(() => view.value === 'agent') })
const activeHeading = useActiveHeading({ entries: toc.entries, activeId: toc.activeId, enabled: toc.visible })

// ── #28 human view vs agent view ─────────────────────────────────────────────
/** The preview shows agent-only sections: agent view, and split view's preview (rule 6). */
const previewAgent = computed(() => view.value === 'agent' || splitShown.value)
/** Rule 10: the hidden-sections line — human (read) view of a markdown doc with ≥ 1 section. */
const noticeShown = computed(() => onScreen.value && view.value === 'read' && previewShown.value && contentType.value === 'markdown' && agentSectionCount.value > 0)
/** Rule 12: a heading/line inside a hidden section was targeted — switch to agent view (replaceState, fragment kept). */
function revealAgent() {
  if (view.value === 'read' && contentType.value === 'markdown' && route.value.kind !== 'file') actions.setView('agent')
}

// Rule 14: <link rel="alternate" type="text/markdown"> to the raw source while a shared markdown doc is on screen.
const alternateHref = computed(() => (onScreen.value && route.value.kind === 'doc' && !docMissing.value ? rawMarkdownUrl.value : null))
let alternateLink: HTMLLinkElement | null = null
watch(alternateHref, (href) => {
  if (!href) { alternateLink?.remove(); alternateLink = null; return }
  if (!alternateLink) {
    alternateLink = document.createElement('link')
    alternateLink.rel = 'alternate'
    alternateLink.type = 'text/markdown'
    document.head.appendChild(alternateLink)
  }
  alternateLink.href = href
}, { immediate: true })
onUnmounted(() => { alternateLink?.remove(); alternateLink = null })

const isDocRoute = computed(() => ['doc', 'pinned', 'file'].includes(route.value.kind))
const showHeader = computed(() => route.value.kind !== 'library' && route.value.kind !== 'not-found' && !docMissing.value && !slidesShown.value)

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
  <div
    v-else
    class="app"
    :class="{ 'doc-scroll': docScroll }"
    :data-view="view"
    :data-mode="mode"
    :data-capability="capability"
    :data-focus-mode="focusShown ? 'true' : undefined"
  >
    <!-- Focus mode hides the header but keeps it mounted (a filename edit in progress survives). -->
    <div v-if="showHeader" v-show="!focusShown" class="doc-header-slot"><DocHeader /></div>
    <DocBanners v-if="!slidesShown" />
    <SlidesView v-if="slidesShown" />

    <RouteNotFound v-if="docMissing" :kind="docMissing === 'revision-gone' ? 'revision-gone' : 'doc'" :home="router.base" @home="goHome" />
    <FileUpload v-else-if="route.kind === 'landing' && booted && !onScreen" @file-loaded="actions.handleFileLoaded" />

    <div v-if="onScreen && !slidesShown" class="doc-body review-layout">
      <div class="doc-rail"><TocPanel v-if="toc.railShown.value" :toc="toc" variant="rail" @pin="activeHeading.pin" /></div>
      <main class="doc-content main-pane">
        <AgentSectionsNotice v-if="noticeShown && !fileView" />
        <div v-if="fileView" class="file-view">
          <img v-if="fileView.kind === 'image'" :src="fileView.url" :alt="fileView.name" />
          <a v-else class="btn btn-primary" :href="fileView.url" :download="fileView.name">Download {{ fileView.name }}</a>
        </div>
        <!-- #7: both panes render through SplitView in every view, so a view switch never remounts
             the editor; the preview mounts with the read and split views. -->
        <SplitView
          v-else
          :split="splitShown"
          :editor="editorRef"
          :preview="previewRef"
          :content="markdown"
          :html="contentType === 'html'"
        >
          <template #editor>
            <LazyEditor
              v-if="editorMounted"
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
          </template>
          <template #preview>
            <PreviewPane
              v-if="previewShown"
              ref="previewRef"
              :content="markdown"
              :comments="reviewUI ? comments : NO_COMMENTS"
              :commenting="reviewUI && !readOnly"
              :theme="theme"
              :content-type="contentType"
              :reload-delay="splitShown ? 400 : 0"
              :agent-view="previewAgent"
              @selection="handleSelection"
              @selection-clear="handleSelectionClear"
              @reveal-agent="revealAgent"
            />
          </template>
        </SplitView>
        <ReactionBar v-if="reactions.active.value && !fileView && !editorShown" />
      </main>
      <aside class="doc-aside" :class="{ collapsed: sidebarHidden }"><CommentsLayer v-if="reviewUI" @scroll-to="scrollToLine" /></aside>
    </div>
    <div v-else-if="!onScreen && isDocRoute && !docMissing" class="doc-loading" aria-busy="true"></div>
    <TocPanel v-if="toc.visible.value && toc.drawerMode.value" :toc="toc" variant="drawer" @pin="activeHeading.pin" />
    <FocusControls v-if="focusShown" @exit="setFocusMode(false)" />

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

    <ShareRequiredDialog v-if="shareAsk" @confirm="shareAsk?.(true)" @cancel="shareAsk?.(false)" />
    <ReactionOverlays v-if="reactions.active.value" />

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
/* The header's slot takes no box: the header stays a direct flex/sticky child in layout. */
.doc-header-slot {
  display: contents;
}

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
  /* The doc pane fills the column; #24's reaction bar sits under it. */
  display: flex;
  flex-direction: column;
}

/* Only the doc panes share out the height; anything else in the column (#24's
   reaction bar, later #28's notice) takes its natural height. */
.doc-content > * {
  flex: none;
}

.doc-content > .file-view,
.doc-content > .lazy-editor,
.doc-content > :deep(.preview-pane),
.doc-content > :deep(.html-frame),
.doc-content > .panes.split,
.doc-content > .panes:not(.split) .lazy-editor,
.doc-content > .panes:not(.split) :deep(.pane-body > .preview-pane),
.doc-content > .panes:not(.split) :deep(.pane-body > .html-frame) {
  flex: 1 1 0;
  min-height: 0;
}

.doc-scroll .doc-body {
  flex: 1 0 auto;
  overflow: visible;
}

/* Document scroll: plain block flow — the preview takes its natural height and
   #24's reaction bar follows the end of the document. (A flex column here would
   size a centred preview to its min-content width, widening the page on phones.) */
.doc-scroll .doc-content {
  display: block;
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

/* #13 focus mode: no rail, no comments column or toggle (the selection action
   bar and comment popover stay available: they live in CommentsLayer, fixed). */
.app[data-focus-mode='true'] .doc-rail {
  display: none;
}

.app[data-focus-mode='true'] .doc-aside {
  flex: 0 0 0;
  width: 0;
  min-width: 0;
  max-width: 0;
  overflow: visible;
}

.app[data-focus-mode='true'] .doc-aside :deep(.sidebar),
.app[data-focus-mode='true'] .doc-aside :deep(.sidebar-toggle),
.app[data-focus-mode='true'] .doc-aside :deep(.comments-toggle),
.app[data-focus-mode='true'] .doc-aside :deep(.comments-drawer),
.app[data-focus-mode='true'] .doc-aside :deep(.comments-backdrop) {
  display: none !important;
}

/* Edit view: a centred 860px text column, the gutter attached to it (rule 6). */
.app[data-focus-mode='true'][data-view='edit'] :deep(.cm-editor) {
  max-width: 860px;
  margin: 0 auto;
}

/* The floating focus controls sit over the right end of the rightmost toolbar row (the
   editor toolbar, the preview bar in wide split, or the bar under the tabs below 960px —
   the tabs keep their full width), which keeps room for them. */
.app[data-focus-mode='true'] :deep(.panes:not(.split) .editor-toolbar),
.app[data-focus-mode='true'] :deep(.panes.wide .split-preview-bar),
.app[data-focus-mode='true'] :deep(.panes.tabs .editor-toolbar),
.app[data-focus-mode='true'] :deep(.panes.tabs .split-preview-bar) {
  padding-right: calc(var(--focus-controls-w, 40px) + 16px);
}

/* Below the split tabs (their 40px + 1px border). */
.app[data-focus-mode='true']:has(.panes.tabs) {
  --focus-controls-top: 41px;
}

/* Phones and touch screens: the toolbar rows grow to hold the 40×40 exit button. */
@media (max-width: 640.98px), (hover: none) {
  .app[data-focus-mode='true'] :deep(.editor-pane .editor-toolbar),
  .app[data-focus-mode='true'] :deep(.panes .split-preview-bar) {
    flex-basis: 44px;
    height: 44px;
  }
}

/* CodeMirror's dotted focus outline would draw the column's edges. */
.app[data-focus-mode='true'] :deep(.cm-editor.cm-focused) {
  outline: none;
}

/* …and the first line of text starts below them, even on a phone (rule 5). */
.app[data-focus-mode='true'] :deep(.cm-content) {
  padding-top: 12px;
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
