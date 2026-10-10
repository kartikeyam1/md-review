<script setup lang="ts">
import type { PaneMode } from '@/types'
import { useDocState } from '@/composables/useDocState'

const { paneMode } = useDocState()
const emit = defineEmits<{ change: [mode: PaneMode] }>()
</script>

<template>
  <div class="toggle">
    <button
      class="toggle-btn"
      :class="{ active: paneMode === 'edit' }"
      @click="emit('change', 'edit')"
    >
      Edit
    </button>
    <button
      class="toggle-btn"
      :class="{ active: paneMode === 'preview' }"
      @click="emit('change', 'preview')"
    >
      Preview
    </button>
  </div>
</template>

<style scoped>
.toggle {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.toggle-btn {
  padding: 4px 14px;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-body);
}

.toggle-btn.active {
  background: var(--text-primary);
  color: var(--bg-surface);
}

.toggle-btn + .toggle-btn {
  border-left: 1px solid var(--border);
}
</style>
