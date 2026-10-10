<script setup lang="ts">
import type { CommentCategory } from '@/types'
import { useDocState } from '@/composables/useDocState'
import { toast } from '@/composables/useToast'
import CommentsSidebar from '@/components/CommentsSidebar.vue'
import SelectionActionBar from '@/components/SelectionActionBar.vue'
import CommentPopover from '@/components/CommentPopover.vue'

// Review-mode comment UI (#2 rules 6–7): the sidebar (+ its collapse strip),
// the selection action bar and the comment popover. DocView mounts it in the
// body's aside region only in review mode; scrolling to a comment's line needs
// the panes, so that goes back up as `scroll-to`.
const emit = defineEmits<{ 'scroll-to': [line: number] }>()

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
    :comments="comments"
    @delete="sync.deleteComment"
    @edit="sync.editComment"
    @scroll-to="emit('scroll-to', $event)"
    @export-comments="handleExportComments"
    @import-comments="handleImportComments"
    @add-reply="handleAddReply"
    @edit-reply="sync.editReply"
    @delete-reply="sync.deleteReply"
    @resolve="handleResolve"
    @unresolve="sync.unresolveComment"
  />

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
</style>
