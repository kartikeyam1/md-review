<script setup lang="ts">
import { useDocState } from '@/composables/useDocState'

const { revisionList, changeSummary, openHistory } = useDocState()
</script>

<template>
  <button
    class="btn btn-ghost btn-history"
    :class="{ unseen: !!changeSummary }"
    :title="changeSummary ? 'The document changed since you last looked — open history to see what' : 'Revision history: compare or restore earlier versions'"
    data-testid="history-button"
    @click="openHistory()"
  >
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    History<span v-if="revisionList.length" class="history-count">{{ revisionList.length }}</span><span v-if="changeSummary" class="history-dot" aria-label="unseen changes"></span>
  </button>
</template>

<style scoped>
.btn-history {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  position: relative;
}

.history-count {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.history-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #2563eb;
  display: inline-block;
}
</style>
