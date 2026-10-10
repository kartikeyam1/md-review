<script setup lang="ts">
import { useDocState, type DocViewName } from '@/composables/useDocState'

// The view toggle (00 §2.2, editors only). Text labels; `compact` (phone)
// shows icons with aria-labels instead. One entry per view — #7 adds
// `{ id: 'split', label: 'Split', icon: … }` here.
interface ViewEntry { id: DocViewName; label: string; /** SVG path data (24×24, stroked). */ icon: string[] }
const VIEWS: ViewEntry[] = [
  { id: 'read', label: 'Read', icon: ['M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z', 'M22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z'] },
  { id: 'edit', label: 'Edit', icon: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'] },
]

defineProps<{ compact?: boolean }>()
const { view } = useDocState()
const emit = defineEmits<{ change: [view: DocViewName] }>()
</script>

<template>
  <div class="toggle" role="group" aria-label="View" data-testid="view-toggle">
    <button
      v-for="v in VIEWS"
      :key="v.id"
      type="button"
      class="toggle-btn"
      :class="{ active: view === v.id, compact }"
      :aria-pressed="view === v.id ? 'true' : 'false'"
      :aria-label="compact ? v.label : undefined"
      :title="v.label"
      :data-testid="`view-toggle-${v.id}`"
      @click="emit('change', v.id)"
    >
      <svg v-if="compact" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path v-for="d in v.icon" :key="d" :d="d" /></svg>
      <template v-else>{{ v.label }}</template>
    </button>
  </div>
</template>

<style scoped>
.toggle {
  display: flex;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.toggle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 14px;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-body);
}

.toggle-btn.compact {
  padding: 4px 8px;
}

.toggle-btn.active {
  background: var(--text-primary);
  color: var(--bg-surface);
}

.toggle-btn + .toggle-btn {
  border-left: 1px solid var(--border);
}
</style>
