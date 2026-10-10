<script setup lang="ts">
// The editor's toolbar row (00 §3.3). Left → right: Undo, Redo (#8) |
// shortcuts (#9) | spacer | focus mode (#13). Buttons never take focus away
// from the editor: the pane runs the command and refocuses the editor. The
// shortcuts button is the exception: its overlay returns focus to it (AC-09.16).
import { computed, inject, ref } from 'vue'
import ShortcutsOverlay from '@/components/ShortcutsOverlay.vue'
import { formatCombo } from '@/editor/shortcutList'
import { closeShortcutsOverlay, openShortcutsOverlay, useShortcutsOverlayHost } from '@/composables/useShortcutsOverlay'
import { focusActive, toggleFocusMode } from '@/composables/useFocusMode'
import { DOC_STATE } from '@/composables/useDocState'

defineProps<{
  canUndo: boolean
  canRedo: boolean
}>()

const emit = defineEmits<{
  undo: []
  redo: []
}>()

// Same labels and order as the shortcuts overlay rows (shortcutList.ts).
const undoTitle = `Undo (${formatCombo('Mod-z')})`
const redoTitle = `Redo (${formatCombo('Mod-Shift-z')} or ${formatCombo('Mod-y')})`

// #13: DocView moves keyboard focus into the editor on every toggle (rule 8).
const focusOn = focusActive()
// #13 rule 4: History stays reachable while the header is hidden (shared docs, as menu-history).
const doc = inject(DOC_STATE, null)
const historyShown = computed(() => focusOn.value && !!doc?.historyId.value)
function openHistory() {
  doc?.openHistory()
}
const focusTitle = `Focus mode (${formatCombo('Mod-Shift-Enter')})`

const bar = ref<HTMLElement | null>(null)
const shortcutsOpen = useShortcutsOverlayHost(bar)

function openShortcuts(e: MouseEvent) {
  openShortcutsOverlay(e.currentTarget as HTMLElement)
}
</script>

<template>
  <div ref="bar" class="editor-toolbar" role="toolbar" aria-label="Editor" data-testid="editor-toolbar">
    <button
      type="button"
      class="tb-btn"
      aria-label="Undo"
      :title="undoTitle"
      :disabled="!canUndo"
      data-testid="editor-undo-btn"
      @mousedown.prevent
      @click="emit('undo')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
    </button>
    <button
      type="button"
      class="tb-btn"
      aria-label="Redo"
      :title="redoTitle"
      :disabled="!canRedo"
      data-testid="editor-redo-btn"
      @mousedown.prevent
      @click="emit('redo')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
    </button>
    <span class="tb-sep" aria-hidden="true" />
    <button
      type="button"
      class="tb-btn"
      aria-label="Keyboard shortcuts"
      title="Keyboard shortcuts (?)"
      aria-haspopup="dialog"
      :aria-expanded="shortcutsOpen"
      data-testid="editor-shortcuts-btn"
      @click="openShortcuts"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>
    </button>
    <span class="tb-spacer" />
    <button
      v-if="historyShown"
      type="button"
      class="tb-btn"
      aria-label="History"
      title="Revision history: compare or restore earlier versions"
      aria-haspopup="dialog"
      data-testid="focus-history-btn"
      @click="openHistory()"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>
    </button>
    <button
      type="button"
      class="tb-btn"
      :class="{ active: focusOn }"
      aria-label="Focus mode"
      :title="focusTitle"
      :aria-pressed="focusOn ? 'true' : 'false'"
      data-testid="focus-mode-btn"
      @mousedown.prevent
      @click="toggleFocusMode()"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <template v-if="focusOn"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" /></template>
        <template v-else><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></template>
      </svg>
    </button>
    <ShortcutsOverlay v-if="shortcutsOpen" @close="closeShortcutsOverlay" />
  </div>
</template>

<style scoped>
.editor-toolbar {
  flex: 0 0 36px;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
}

.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
}

.tb-btn:hover:not(:disabled) {
  background: var(--bg-page);
  color: var(--text-primary);
}

.tb-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.tb-btn.active {
  color: var(--text-primary);
  background: var(--bg-page);
}

.tb-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.tb-sep {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--border);
}

.tb-spacer {
  flex: 1;
}
</style>
