<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import type { CommentCategory } from '@/types'
import { useDocState } from '@/composables/useDocState'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { toast } from '@/composables/useToast'
import { focusActive } from '@/composables/useFocusMode'
import CommentsSidebar from '@/components/CommentsSidebar.vue'
import SelectionActionBar from '@/components/SelectionActionBar.vue'
import CommentPopover from '@/components/CommentPopover.vue'

// Review-mode comment UI (#2 rules 6–7): the sidebar (+ its collapse strip),
// the selection action bar and the comment popover. DocView mounts it in the
// body's aside region only in review mode; scrolling to a comment's line needs
// the panes, so that goes back up as `scroll-to`.
// Below 1100px (#5 rule 8) the rail becomes a bottom sheet: a fixed
// `comments-toggle` opens `comments-drawer` holding the same sidebar.
const emit = defineEmits<{ 'scroll-to': [line: number] }>()

const bp = useBreakpoint()
const drawerMode = computed(() => bp.value !== 'desktop')
const drawerOpen = ref(false)
const drawerRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
const toggleRef = ref<HTMLButtonElement | null>(null)

function openDrawer() {
  drawerOpen.value = true
}

function closeDrawer() {
  drawerOpen.value = false
}

// Focus moves to the close button, stays in the sheet, and returns to the toggle (useFocusTrap).
useFocusTrap(drawerRef, drawerOpen, { initialFocus: () => closeRef.value, returnFocus: () => toggleRef.value })

// Esc closes the drawer (00 §3.4 layer 4) unless an inner layer took it first.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  e.preventDefault()
  closeDrawer()
}
watch(drawerOpen, (open) => {
  if (open) document.addEventListener('keydown', onKeydown)
  else document.removeEventListener('keydown', onKeydown)
})
// Back to desktop width: the rail is back, the sheet goes.
watch(drawerMode, (m) => { if (!m) closeDrawer() })
// #13: focus mode hides the comments, so an open sheet closes (no hidden focus trap).
watch(focusActive(), (on) => { if (on) closeDrawer() })
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

/** A comment tapped in the sheet: close it so the line it scrolls to is visible. */
function scrollTo(line: number) {
  if (drawerMode.value) closeDrawer()
  emit('scroll-to', line)
}

const doc = useDocState()
const {
  sidebarHidden, comments, loadComments, filename, sync, reviewerName, authorField, flushAutosave,
  selection, showActionBar, showPopover, dismissAll, openComment, dismissActionBar,
} = doc

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

/** The sidebar's props and handlers, shared by the rail and the drawer. */
const sidebarBindings = computed(() => ({
  comments: comments.value,
  onDelete: sync.deleteComment,
  onEdit: sync.editComment,
  onScrollTo: scrollTo,
  onExportComments: handleExportComments,
  onImportComments: handleImportComments,
  onAddReply: handleAddReply,
  onEditReply: sync.editReply,
  onDeleteReply: sync.deleteReply,
  onResolve: handleResolve,
  onUnresolve: sync.unresolveComment,
}))

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
          toast.error('Invalid comment file format.')
          return
        }
        const normalized = imported.map((c: any) => ({
          ...c,
          replies: Array.isArray(c.replies) ? c.replies : [],
        }))
        loadComments(normalized)
      } catch {
        toast.error('Could not parse comment file.')
      }
    }
    reader.readAsText(file)
  }
  input.click()
}
</script>

<template>
  <template v-if="!drawerMode">
    <button
      class="sidebar-toggle"
      :class="{ collapsed: sidebarHidden }"
      :title="sidebarHidden ? 'Show comments panel' : 'Hide comments panel'"
      :aria-label="sidebarHidden ? 'Show comments panel' : 'Hide comments panel'"
      :aria-expanded="sidebarHidden ? 'false' : 'true'"
      @click="sidebarHidden = !sidebarHidden"
    >
      <span class="sidebar-toggle-grip"></span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
      <span class="sidebar-toggle-grip"></span>
    </button>
    <CommentsSidebar
      v-show="!sidebarHidden"
      v-bind="sidebarBindings"
    />
  </template>
  <template v-else>
    <button
      ref="toggleRef"
      type="button"
      class="comments-toggle"
      data-testid="comments-toggle"
      aria-controls="md-review-comments-drawer"
      :aria-expanded="drawerOpen ? 'true' : 'false'"
      @click="drawerOpen ? closeDrawer() : openDrawer()"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Comments · {{ comments.length }}
    </button>
    <div v-if="drawerOpen" class="comments-backdrop" data-testid="comments-backdrop" @click="closeDrawer()"></div>
    <div
      v-if="drawerOpen"
      id="md-review-comments-drawer"
      ref="drawerRef"
      class="comments-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Comments"
      data-testid="comments-drawer"
    >
      <button
        ref="closeRef"
        type="button"
        class="comments-drawer-close"
        aria-label="Close comments"
        data-testid="comments-drawer-close"
        @click="closeDrawer()"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
      <CommentsSidebar v-bind="sidebarBindings" />
    </div>
  </template>

  <SelectionActionBar
    :visible="showActionBar"
    :coords="selection?.coords ?? { x: 0, y: 0 }"
    @comment="openComment"
    @dismiss="dismissActionBar"
  />

  <CommentPopover
    :visible="showPopover"
    :selected-text="selection?.selectedText ?? ''"
    :coords="selection?.coords ?? { x: 0, y: 0 }"
    :author="reviewerName"
    @add="handleAddComment"
    @cancel="dismissAll"
  />
</template>

<style scoped>
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
  color: var(--text-meta);
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

/* ── Phone / tablet: toggle + bottom sheet (#5 rule 8) ── */
.comments-toggle {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 150;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  box-shadow: 0 4px 16px var(--shadow-color);
}

.comments-toggle:focus-visible,
.comments-drawer-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.comments-backdrop {
  position: fixed;
  inset: 0;
  touch-action: none;
  z-index: 300;
  background: var(--overlay-bg);
}

.comments-drawer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 300;
  display: flex;
  flex-direction: column;
  max-height: 80vh;
  max-height: 80dvh;
  background: var(--bg-page);
  border-top: 1px solid var(--border);
  border-radius: 12px 12px 0 0;
  box-shadow: 0 -8px 24px var(--shadow-color);
}

.comments-drawer-close {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-secondary);
}

.comments-drawer > :deep(.sidebar) {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  border-left: 0;
}

/* Room for the close button at the sheet's top-right. */
.comments-drawer :deep(.sidebar-header) {
  padding-right: 44px;
}
</style>
