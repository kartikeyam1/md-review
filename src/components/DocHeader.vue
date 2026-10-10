<script setup lang="ts">
import { ref, computed } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'
import { useBreakpoint } from '@/composables/useBreakpoint'
import FilenameField from '@/components/FilenameField.vue'
import ReviewerName from '@/components/ReviewerName.vue'
import DocStats from '@/components/DocStats.vue'
import DocUpdated from '@/components/DocUpdated.vue'
import ViewToggle from '@/components/ViewToggle.vue'
import SyncIndicator from '@/components/SyncIndicator.vue'
import SaveState from '@/components/SaveState.vue'
import CopyLinkButton from '@/components/CopyLinkButton.vue'
import ThemeSwitcher from '@/components/ThemeSwitcher.vue'
import HeaderOverflowMenu from '@/components/HeaderOverflowMenu.vue'
import { truncateTitle } from '@/composables/useDocTitle'
import { useToc } from '@/composables/useToc'

// The doc header (00 §2): one line, never wraps. `reader` in the read view,
// `editor` in the edit view (editors only). Order and per-width placement are
// 00 §2.2; a control demoted at a width lives in the overflow menu instead,
// under the same testid. Below 1100px the meta items sit in doc-meta-row.
const doc = useDocState()
const actions = useDocActions()
const { router, onScreen, capability, view, reviewUI, pasteId, docLink, docTitle } = doc
const bp = useBreakpoint()
const toc = useToc()

const editor = computed(() => capability.value === 'editor')
const variant = computed(() => (onScreen.value && view.value === 'edit' ? 'editor' : 'reader'))
const isLocal = computed(() => onScreen.value && !pasteId.value && !docLink.value)
const phone = computed(() => bp.value === 'phone')
const desktop = computed(() => bp.value === 'desktop')
const sharing = computed(() => doc.share.sharing.value)

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
}))

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
  <header class="header" data-testid="doc-header" :data-variant="variant" :data-breakpoint="bp">
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
      :class="{ 'icon-only': !desktop }"
      :href="router.base"
      title="md-review home"
      aria-label="md-review home"
      data-testid="app-home-link"
      @click="onHomeClick"
    >
      <span v-if="desktop">mdreview<span class="logo-accent">.oss</span></span>
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
      <span v-if="desktop">Library</span>
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
        <template v-if="onScreen && desktop">
          <DocUpdated v-if="!isLocal" />
          <span v-else-if="editor" class="badge local-badge" data-testid="doc-local-badge">Not shared</span>
          <span v-if="reviewUI" class="badge mode-badge" data-testid="doc-mode-badge">Review</span>
        </template>
      </div>
    </template>

    <ReviewerName
      v-if="onScreen && reviewUI && (reviewerInBar || editingNameFromMenu)"
      :auto-edit="!reviewerInBar"
      @done="editingNameFromMenu = false"
    />
    <ViewToggle v-if="onScreen && editor" :compact="phone" @change="actions.setView($event)" />
    <button
      v-if="onScreen && editor && !phone"
      type="button"
      class="btn btn-ghost share-btn"
      :disabled="sharing"
      data-testid="share-btn"
      @click="actions.handleShare()"
    >{{ sharing ? 'Sharing…' : 'Share' }}</button>
    <CopyLinkButton v-if="!phone" :icon-only="!desktop" />
    <ThemeSwitcher />
    <HeaderOverflowMenu :demoted="demoted" :sheet="phone" @edit-reviewer="editingNameFromMenu = true" />
  </header>
  <div v-if="variant === 'reader' && onScreen && !desktop" class="doc-meta-row" data-testid="doc-meta-row">
    <DocUpdated v-if="!isLocal" />
    <span v-else-if="editor" class="badge local-badge" data-testid="doc-local-badge">Not shared</span>
    <span v-if="reviewUI" class="badge mode-badge" data-testid="doc-mode-badge">Review</span>
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

/* Let an open header menu (overflow, Style) escape the header box. */
.header:has([role='menu']) {
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
  color: var(--text-muted);
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
