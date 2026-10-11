<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import AppMenu, { type AppMenuEntry } from '@/components/AppMenu.vue'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'
import { copyDocLink } from '@/composables/useCopyLink'
import { saveAsTemplate } from '@/composables/templateEntry'

// The header overflow menu (00 §2.3), fixed order, items only when they apply:
// controls demoted at this width → history → prompt → Document mode → save as template → open/new/refresh.
const props = defineProps<{
  /** Bar controls that live in this menu at the current width (00 §2.2). */
  demoted: { reviewer?: boolean; share?: boolean; copyLink?: boolean; library?: boolean; home?: boolean; download?: boolean; reader?: boolean; slides?: boolean }
  /** #29: the doc can be presented (the bar's Present button, demoted below 1100px). */
  canPresent?: boolean
  /** Phone: open as a full-width sheet (#5 rule 7). */
  sheet?: boolean
}>()
const emit = defineEmits<{ 'edit-reviewer': [] }>()

// Entries for lazy header controls (#19 Download group, #18 reading settings) come from a lazy chunk (#6 budget).
const extras = shallowRef<typeof import('@/components/headerMenuExtras') | null>(null)
import('@/components/headerMenuExtras').then((m) => { extras.value = m }, () => {})

const doc = useDocState()
const actions = useDocActions()
const { router, onScreen, capability, reviewUI, mode, comments, historyId, docLink, reviewerName, route, revisionList, changeSummary } = doc

/**
 * #26: a file route shows a read-only file, not the doc — History (restore) and
 * Document mode would change the doc out of sight, so they live on its primary tab.
 */
const onFile = computed(() => route.value.kind === 'file')
/** Mirrors menu-history's unseen-changes dot on the trigger, so it is visible with the menu closed. */
const unseen = computed(() => onScreen.value && !onFile.value && !!changeSummary.value)
const triggerLabel = computed(() => (unseen.value ? 'More actions (the document changed since you last looked)' : 'More actions'))

const entries = computed<AppMenuEntry[]>(() => {
  const out: AppMenuEntry[] = []
  const editor = capability.value === 'editor'
  const docOpen = onScreen.value
  // 1. Demoted bar controls, in 00 §2.2 order.
  if (props.demoted.reviewer && docOpen && reviewUI.value) {
    out.push({ type: 'item', id: 'reviewer', testid: 'reviewer-name', label: reviewerName.value ? `Name: ${reviewerName.value}` : 'Set your name', onSelect: () => emit('edit-reviewer') })
  }
  if (props.demoted.slides && props.canPresent) {
    out.push({ type: 'item', id: 'slides', testid: 'slides-enter-btn', label: 'Present', onSelect: () => actions.setView('slides') })
  }
  if (props.demoted.share && docOpen && editor) {
    out.push({ type: 'item', id: 'share', testid: 'share-btn', label: 'Share…', disabled: doc.share.sharing.value, onSelect: () => actions.handleShare() })
  }
  if (props.demoted.copyLink && docLink.value) {
    const url = docLink.value
    out.push({ type: 'item', id: 'copy', testid: 'copy-link-btn', label: 'Copy link', onSelect: () => { copyDocLink(url) } })
  }
  const x = extras.value
  const download = x?.downloadGroup({ demoted: props.demoted, docOpen, doc, setView: actions.setView })
  if (download) out.push(download)
  const reader = x?.readerEntry({ demoted: props.demoted, docOpen })
  if (reader) out.push(reader)
  if (props.demoted.library) {
    out.push({ type: 'item', id: 'library', testid: 'nav-library', label: 'Library', onSelect: () => router.push(`${router.base}library`) })
  }
  if (props.demoted.home) {
    out.push({ type: 'item', id: 'home', testid: 'app-home-link', label: 'Home', onSelect: () => router.push(router.base) })
  }
  // 2. History (shared docs, pinned revisions included).
  if (docOpen && historyId.value && !onFile.value) {
    out.push({
      type: 'item', id: 'history', testid: 'menu-history', label: 'History',
      title: changeSummary.value ? 'The document changed since you last looked — open history to see what' : 'Revision history: compare or restore earlier versions',
      badge: revisionList.value.length ? String(revisionList.value.length) : undefined,
      dot: !!changeSummary.value, dotLabel: 'unseen changes',
      onSelect: () => { doc.openHistory() },
    })
  }
  // 3. Prompt generator (review mode).
  if (docOpen && reviewUI.value) {
    out.push({ type: 'item', id: 'prompt', testid: 'menu-generate-prompt', label: 'Generate prompt', onSelect: () => { doc.showPromptModal.value = true } })
  }
  // 4. Document mode (editors).
  if (docOpen && editor && !onFile.value) {
    const hidden = mode.value === 'publish' ? comments.value.length : 0
    out.push({
      type: 'group',
      id: 'mode',
      label: 'Document mode',
      entries: [
        { type: 'radio', id: 'publish', testid: 'doc-mode-publish', label: 'Publish — reading page', checked: mode.value === 'publish', onSelect: () => { doc.setDocMode('publish') } },
        { type: 'radio', id: 'review', testid: 'doc-mode-review', label: 'Review — comments and approval', checked: mode.value === 'review', onSelect: () => { doc.setDocMode('review') } },
      ],
      note: hidden > 0
        ? { text: `${hidden} comment${hidden === 1 ? '' : 's'} hidden in Publish mode`, testid: 'doc-mode-hidden-comments' }
        : null,
    })
  }
  // 5. Save as template (#27): anyone who can view (it copies), not on file routes or pinned revisions.
  if (docOpen && route.value.kind !== 'file' && route.value.kind !== 'pinned') {
    out.push({ type: 'item', id: 'tpl', testid: 'doc-save-as-template', label: 'Save as template…', onSelect: () => { void saveAsTemplate(doc) } })
  }
  // 6. Open / New / Refresh.
  // Opening a local file is an author's action: not offered to a view-link reader of a shared doc.
  const tail: AppMenuEntry[] = []
  if (!docOpen || editor) tail.push({ type: 'item', id: 'open', testid: 'menu-open-file', label: 'Open file…', onSelect: () => actions.handleOpenFile() })
  if (docOpen && editor) tail.push({ type: 'item', id: 'new', testid: 'menu-new-doc', label: 'New document', onSelect: () => actions.handleNewDoc() })
  if (docOpen && doc.filePathParam.value && route.value.kind === 'landing') {
    tail.push({ type: 'item', id: 'refresh', testid: 'menu-refresh', label: 'Reload from disk', title: 'Reload file from disk and reset comments', onSelect: () => { actions.loadFromFilePath() } })
  }
  if (out.length && tail.length) out.push({ type: 'separator', id: 'sep-tail' })
  out.push(...tail)
  return out
})
</script>

<template>
  <!-- Persona-QA m5: no items (a viewer on a file route at desktop width) → no dead button. -->
  <AppMenu
    v-if="entries.length"
    :entries="entries"
    :label="triggerLabel"
    trigger-class="btn btn-ghost overflow-btn"
    :trigger-title="triggerLabel"
    trigger-testid="header-overflow-btn"
    menu-testid="header-overflow-menu"
    :sheet="sheet"
  >
    <template #trigger>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
      <span v-if="unseen" class="overflow-dot" aria-hidden="true"></span>
    </template>
  </AppMenu>
</template>

<style scoped>
:deep(.overflow-btn) {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
}
.overflow-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--unseen-dot);
}
</style>
