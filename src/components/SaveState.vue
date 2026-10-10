<script setup lang="ts">
import { computed } from 'vue'
import type { SaveState } from '@/composables/useSync'
import { useDocState } from '@/composables/useDocState'

// Where the document stands against the server, plus Save / Retry save.
// Quiet when all is well (#2 rule 5): nothing shows while idle or saved.
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
    :class="saveState"
    :title="SAVE_TITLE[saveState]"
    data-testid="save-state"
  >
    {{ SAVE_LABEL[saveState] }}
  </span>
  <button
    v-if="saveState === 'dirty' || saveState === 'error'"
    class="btn btn-primary btn-save"
    :title="saveState === 'error' ? 'Retry saving to the server' : 'Save to the server now (Ctrl/Cmd+S)'"
    @click="flushAutosave()"
  >
    {{ saveState === 'error' ? 'Retry save' : 'Save' }}
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

</style>
