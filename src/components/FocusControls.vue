<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { SAVE_LABEL, SAVE_TITLE } from '@/composables/saveStateLabels'

// Focus mode's floating cluster (spec #13 rule 5): the save status (same labels
// as the header's save-state; nothing for an unshared local doc) and the way
// out. Fixed at the top-right over the rightmost top bar (editor toolbar,
// preview bar or split tabs), which reserves room for it through
// --focus-controls-w so it never covers a control or the first line of text.

const emit = defineEmits<{ exit: [] }>()
const { sync, flushAutosave } = useDocState()
const saveState = computed(() => (sync.isShared.value ? sync.saveState.value : 'idle'))

const root = ref<HTMLElement | null>(null)
let obs: ResizeObserver | null = null
function publishWidth() {
  const w = root.value?.getBoundingClientRect().width ?? 0
  document.documentElement.style.setProperty('--focus-controls-w', `${Math.ceil(w)}px`)
}
onMounted(() => {
  publishWidth()
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    obs = new ResizeObserver(publishWidth)
    obs.observe(root.value)
  }
})
onUnmounted(() => {
  obs?.disconnect()
  document.documentElement.style.removeProperty('--focus-controls-w')
})
</script>

<template>
  <div ref="root" class="focus-controls" data-testid="focus-controls">
    <!-- A failed save can be retried from here: the header's Retry is hidden in focus mode. -->
    <button
      v-if="saveState === 'error'"
      type="button"
      class="focus-save-state error"
      :title="SAVE_TITLE.error"
      data-testid="focus-save-state"
      @click="flushAutosave()"
    >{{ SAVE_LABEL.error }}</button>
    <span
      v-else-if="saveState !== 'idle'"
      class="focus-save-state"
      :class="saveState"
      :title="SAVE_TITLE[saveState]"
      role="status"
      data-testid="focus-save-state"
    >{{ SAVE_LABEL[saveState] }}</span>
    <button
      type="button"
      class="focus-exit"
      aria-label="Exit focus mode"
      title="Exit focus mode (Esc)"
      data-testid="focus-exit-btn"
      @click="emit('exit')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>
  </div>
</template>

<style scoped>
.focus-controls {
  position: fixed;
  /* DocView moves the cluster below the split tabs (--focus-controls-top). */
  top: calc(var(--focus-controls-top, 0px) + 4px);
  right: 8px;
  z-index: 150;
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0.35;
  transition: opacity 150ms ease;
  font-family: var(--font-body);
}

.focus-controls:hover,
.focus-controls:focus-within {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .focus-controls { transition: none; }
}

.focus-save-state {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-surface);
}

button.focus-save-state {
  border: 1px solid currentColor;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.focus-save-state.dirty { color: var(--text-primary); }
.focus-save-state.error,
.focus-save-state.conflict { color: #dc2626; font-weight: 600; }

.focus-exit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
}

.focus-exit:hover {
  color: var(--text-primary);
}

.focus-exit:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* Phones and touch screens: a 40×40 target (rule 11). */
@media (max-width: 640.98px), (hover: none) {
  .focus-controls { top: calc(var(--focus-controls-top, 0px) + 2px); right: 4px; }
  .focus-exit { width: 40px; height: 40px; }
}
</style>
