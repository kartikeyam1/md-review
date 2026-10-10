<script setup lang="ts">
import { computed } from 'vue'
import type { SaveState } from '@/composables/useSync'
import { useDocState } from '@/composables/useDocState'

// Where the document stands against the server, plus Save / Retry save.
// Quiet when all is well (#2 rule 5): nothing shows while idle or saved.
defineProps<{ /** Phone (00 §2.2 "✓ (icon)"): a status dot + an icon Save button, labels kept for AT. */ compact?: boolean }>()
const { sync, flushAutosave } = useDocState()
const saveState = computed(() => sync.saveState.value)

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Save failed',
  conflict: 'Conflict',
}
const SAVE_TITLE: Record<SaveState, string> = {
  idle: '',
  saved: 'All changes are on the server',
  dirty: 'Edits not yet saved to the server — they autosave shortly, or press Save (Ctrl/Cmd+S)',
  saving: 'Writing to the server…',
  error: 'The last save failed. Your edits are kept locally — click to retry',
  conflict: 'The server copy changed while you had unsaved edits — choose a version below',
}
</script>

<template>
  <span
    v-if="saveState !== 'idle' && saveState !== 'saved'"
    class="save-state"
    :class="[saveState, { compact }]"
    :title="SAVE_TITLE[saveState]"
    data-testid="save-state"
  >
    <template v-if="compact"><span class="save-dot" aria-hidden="true"></span><span class="sr-only">{{ SAVE_LABEL[saveState] }}</span></template>
    <template v-else>{{ SAVE_LABEL[saveState] }}</template>
  </span>
  <button
    v-if="saveState === 'dirty' || saveState === 'error'"
    class="btn btn-primary btn-save"
    :class="{ compact }"
    :title="saveState === 'error' ? 'Retry saving to the server' : 'Save to the server now (Ctrl/Cmd+S)'"
    :aria-label="compact ? (saveState === 'error' ? 'Retry save' : 'Save') : undefined"
    @click="flushAutosave()"
  >
    <svg v-if="compact" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    <template v-else>{{ saveState === 'error' ? 'Retry save' : 'Save' }}</template>
  </button>
</template>

<style scoped>
.btn-save {
  padding: 4px 14px;
  font-size: 13px;
  white-space: nowrap;
}

.save-state {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
}

.save-state.dirty { color: var(--text-primary); }
.save-state.saving { opacity: 0.8; }
.save-state.error { color: #dc2626; font-weight: 500; }
.save-state.conflict { color: #dc2626; font-weight: 600; background: rgba(220, 38, 38, 0.08); }

.btn-save.compact {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.save-state.compact { padding: 0 4px; }
.save-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

</style>
