<script setup lang="ts">
import { ref, computed, defineAsyncComponent, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'
import { useBreakpoint } from '@/composables/useBreakpoint'
import FilenameField from '@/components/FilenameField.vue'
import ReviewerName from '@/components/ReviewerName.vue'
import DocStats from '@/components/DocStats.vue'
import DocUpdated from '@/components/DocUpdated.vue'
import ViewStats from '@/components/ViewStats.vue'
import ViewToggle from '@/components/ViewToggle.vue'
import SyncIndicator from '@/components/SyncIndicator.vue'
import SaveState from '@/components/SaveState.vue'
import CopyLinkButton from '@/components/CopyLinkButton.vue'
import ThemeSwitcher from '@/components/ThemeSwitcher.vue'
import HeaderOverflowMenu from '@/components/HeaderOverflowMenu.vue'
import { truncateTitle } from '@/composables/useDocTitle'
import { useToc } from '@/composables/useToc'

// #18 reading settings and #19 Download menu load on demand (the #6 entry budget).
const ReaderSettings = defineAsyncComponent(() => import('@/components/ReaderSettings.vue'))
const DownloadMenu = defineAsyncComponent(() => import('@/components/DownloadMenu.vue'))
// #29: Present (desktop bar).
const SlidesEnterButton = defineAsyncComponent(() => import('@/components/SlidesEnterButton.vue'))

// The doc header (00 §2): one line, never wraps. `reader` in the read view,
// `editor` in the edit view (editors only). Order and per-width placement are
// 00 §2.2; a control demoted at a width lives in the overflow menu instead,
// under the same testid. Below 1100px the meta items sit in doc-meta-row.
const doc = useDocState()
const actions = useDocActions()
const { router, onScreen, capability, view, reviewUI, pasteId, docLink, docTitle, contentType } = doc
const bp = useBreakpoint()
const toc = useToc()

const editor = computed(() => capability.value === 'editor')
// 00 §2.1: `editor` = the edit and split views.
const variant = computed(() => (onScreen.value && (view.value === 'edit' || view.value === 'split') ? 'editor' : 'reader'))
const isLocal = computed(() => onScreen.value && !pasteId.value && !docLink.value)
const phone = computed(() => bp.value === 'phone')
const desktop = computed(() => bp.value === 'desktop')
const sharing = computed(() => doc.share.sharing.value)
/** #29 rule 1: Present — reader variant of a markdown doc in the read or agent view, not on a file route. */
const canPresent = computed(() => onScreen.value && variant.value === 'reader' && contentType.value === 'markdown'
  && (view.value === 'read' || view.value === 'agent') && doc.routeKind.value !== 'file' && doc.routeKind.value !== 'embed')

/** reviewer-name sits in the bar on desktop only (00 §2.2). */
const reviewerInBar = computed(() => desktop.value)
/** Opened from the overflow menu at a narrower width: edit inline in the bar, then go back. */
const editingNameFromMenu = ref(false)

const demoted = computed(() => ({
  reviewer: !reviewerInBar.value,
  share: phone.value,
  copyLink: phone.value,
  library: phone.value,
  home: phone.value,
  download: !desktop.value,
  reader: phone.value,
  slides: !desktop.value,
}))

// A crowded desktop bar (review mode with its name field, view toggle, Present, Share…) must never
// squeeze the doc title out. Level 1 moves the meta items (updated, badges, views) to doc-meta-row,
// as below 1100px; level 2 also shows Home, Library and Copy link as icons. Measured whenever the
// bar's size or content changes, synchronously before paint (no flicker).
const headerRef = ref<HTMLElement | null>(null)
const squeeze = ref(0)
/** The title shows at least this much of itself (all of it when shorter). */
const TITLE_MIN = 160
function barFits(): boolean {
  const h = headerRef.value
  if (!h) return true
  if (h.scrollWidth > h.clientWidth + 1) return false
  const t = h.querySelector<HTMLElement>('.doc-title')
  return !t || t.clientWidth >= Math.min(TITLE_MIN, t.scrollWidth) - 1
}
let measuring = false
let mutations: MutationObserver | null = null
let resizes: ResizeObserver | null = null
async function measureBar() {
  if (measuring) return
  measuring = true
  try {
    if (!desktop.value || variant.value !== 'reader') { squeeze.value = 0; return }
    squeeze.value = 0
    await nextTick()
    while (!barFits() && squeeze.value < 2) {
      squeeze.value++
      await nextTick()
    }
  } finally {
    mutations?.takeRecords()
    measuring = false
  }
}
let raf = 0
const scheduleMeasure = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; void measureBar() }) }
watch([desktop, variant, () => docTitle.value, reviewUI], () => { void measureBar() })
onMounted(() => {
  const h = headerRef.value
  if (!h) return
  if (typeof ResizeObserver === 'function') { resizes = new ResizeObserver(scheduleMeasure); resizes.observe(h) }
  mutations = new MutationObserver(() => { if (!measuring) scheduleMeasure() })
  mutations.observe(h, { childList: true, subtree: true, characterData: true })
  void measureBar()
})
onBeforeUnmount(() => { resizes?.disconnect(); mutations?.disconnect(); if (raf) cancelAnimationFrame(raf) })
const metaInBar = computed(() => desktop.value && squeeze.value === 0)
const iconLabels = computed(() => !desktop.value || squeeze.value >= 2)

function onHomeClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  router.push(router.base)
}

function onLibraryClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  router.push(`${router.base}library`)
}
</script>

<template>
  <header ref="headerRef" class="header" data-testid="doc-header" :data-variant="variant" :data-breakpoint="bp">
    <!-- #3: first in the left group; opens the drawer (< 1100px) or reopens the collapsed rail. -->
    <button
      v-if="toc?.toggleShown.value"
      type="button"
      class="btn btn-ghost toc-toggle"
      title="Contents"
      aria-label="Table of contents"
      :aria-expanded="toc.drawerMode.value && toc.drawerOpen.value ? 'true' : 'false'"
      :aria-controls="toc.drawerMode.value ? 'md-review-toc-drawer' : undefined"
      data-testid="toc-toggle"
      @click="toc.toggle()"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></svg>
    </button>
    <a
      v-if="!phone"
      class="logo"
      :class="{ 'icon-only': iconLabels }"
      :href="router.base"
      title="md-review home"
      aria-label="md-review home"
      data-testid="app-home-link"
      @click="onHomeClick"
    >
      <span v-if="!iconLabels">mdreview<span class="logo-accent">.oss</span></span>
      <span v-else class="logo-mark">md</span>
    </a>
    <a
      v-if="variant === 'reader' && !phone"
      class="btn btn-ghost nav-library"
      :href="`${router.base}library`"
      title="Library"
      aria-label="Library"
      data-testid="nav-library"
      @click="onLibraryClick"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      <span v-if="!iconLabels">Library</span>
    </a>

    <template v-if="variant === 'editor'">
      <template v-if="!phone">
        <FilenameField />
        <SyncIndicator />
        <DocStats v-if="desktop" />
      </template>
      <SaveState :compact="phone" />
      <span class="spacer"></span>
    </template>
    <template v-else>
      <div class="doc-title-group">
        <span v-if="onScreen" class="doc-title" data-testid="doc-title" :title="docTitle">{{ truncateTitle(docTitle) }}</span>
        <template v-if="onScreen && metaInBar">
          <DocUpdated v-if="!isLocal" />
          <span v-else-if="editor" class="badge local-badge" data-testid="doc-local-badge">Not shared</span>
          <span v-if="reviewUI" class="badge mode-badge" data-testid="doc-mode-badge">Review</span>
          <ViewStats v-if="!isLocal" />
        </template>
      </div>
    </template>

    <ReviewerName
      v-if="onScreen && reviewUI && (reviewerInBar || editingNameFromMenu)"
      :auto-edit="!reviewerInBar"
      @done="editingNameFromMenu = false"
    />
    <!-- #26: a file route has the doc's capability but only the read view (00 §1.3). -->
    <ViewToggle v-if="onScreen && editor && doc.routeKind.value !== 'file'" :compact="phone" @change="actions.setView($event)" />
    <SlidesEnterButton v-if="canPresent && desktop" />
    <button
      v-if="onScreen && editor && !phone"
      type="button"
      class="btn btn-ghost share-btn"
      :disabled="sharing"
      data-testid="share-btn"
      @click="actions.handleShare()"
    >{{ sharing ? 'Sharing…' : 'Share' }}</button>
    <CopyLinkButton v-if="!phone" :icon-only="iconLabels" />
    <DownloadMenu v-if="onScreen && desktop" />
    <ThemeSwitcher />
    <ReaderSettings v-if="onScreen" :sheet="phone" :html="contentType === 'html'" />
    <HeaderOverflowMenu :demoted="demoted" :can-present="canPresent" :sheet="phone" @edit-reviewer="editingNameFromMenu = true" />
  </header>
  <div v-if="variant === 'reader' && onScreen && !metaInBar" class="doc-meta-row" data-testid="doc-meta-row">
    <DocUpdated v-if="!isLocal" />
    <span v-else-if="editor" class="badge local-badge" data-testid="doc-local-badge">Not shared</span>
    <span v-if="reviewUI" class="badge mode-badge" data-testid="doc-mode-badge">Review</span>
    <ViewStats v-if="!isLocal" />
  </div>
</template>

<style scoped>
.header {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  height: var(--header-h);
  min-width: 0;
  overflow: hidden;
  /* Sticks in the document-scrolling read view (#5 rule 2); a no-op in the fixed layouts. */
  position: sticky;
  top: 0;
  flex-shrink: 0;
  z-index: 100;
}

/* Phone (#5 rule 6): every control is at least 40×40, a tighter gutter. */
.header[data-breakpoint='phone'] {
  gap: 6px;
  padding: 0 8px;
}

.header[data-breakpoint='phone'] :deep(button),
.header[data-breakpoint='phone'] :deep(a[href]),
.header[data-breakpoint='phone'] :deep(input) {
  min-width: 40px;
  min-height: 40px;
}

/* Touch (a coarse pointer at any width, e.g. a tablet): every header control is a 44px target. */
@media (pointer: coarse) {
  .header[data-breakpoint] :deep(button),
  .header[data-breakpoint] :deep(a[href]) {
    min-width: 44px;
    min-height: 44px;
  }
}

/* …but a sheet menu's items keep their 44px touch rows (#5 rule 7, #19 AC-19.14); tablets
   (often touch) get the same rows in the overflow menu. */
.header[data-breakpoint='phone'] :deep(.app-menu-sheet .app-menu-item),
.header[data-breakpoint='tablet'] :deep([data-testid='header-overflow-menu'] .app-menu-item) {
  min-height: 44px;
}

/* Let an open header menu (overflow, Style) or the reading-settings panel escape the header box. */
.header:has([role='menu'], [role='dialog']) {
  overflow: visible;
}

.header > * {
  flex-shrink: 0;
}

.toc-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
}

.logo {
  font-family: var(--font-heading);
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  text-decoration: none;
  margin-right: 4px;
  white-space: nowrap;
}

.logo-accent {
  color: var(--accent-text);
}

.logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg-page);
  border: 1px solid var(--border);
}

.nav-library {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  text-decoration: none;
}

.doc-title-group {
  flex: 1 1 auto;
  flex-shrink: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}

.doc-title {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.doc-title-group > :not(.doc-title) {
  flex-shrink: 0;
}

.spacer {
  flex: 1 1 auto;
  flex-shrink: 1;
  min-width: 0;
}

.header > :deep(.filename) {
  flex-shrink: 1;
}

.badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
  border: 1px solid var(--border);
  color: var(--text-meta);
}

.mode-badge {
  color: var(--accent-text);
  border-color: var(--accent-text);
}

.share-btn {
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.doc-meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 16px;
  min-height: 28px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}

.doc-meta-row:empty {
  display: none;
}
</style>
