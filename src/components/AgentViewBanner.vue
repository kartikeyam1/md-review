<script setup lang="ts">
import { computed } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'

// #28 rule 11: the agent view's banner (00 §2.4 slot 3) — how many sections
// are shown, "Reader view" (drops ?view, back to the human view) and, for a
// shared doc, the raw markdown on the API. Lazy (off the #6 entry chunk).
const { agentSectionCount, rawMarkdownUrl } = useDocState()
const actions = useDocActions()
const text = computed(() => `Agent view — showing ${agentSectionCount.value} agent-only section${agentSectionCount.value === 1 ? '' : 's'}`)
</script>

<template>
  <div class="notice-bar agent-banner" role="status" data-testid="agent-view-banner">
    <span class="agent-banner-text">{{ text }}</span>
    <span class="agent-banner-actions">
      <a
        v-if="rawMarkdownUrl"
        class="btn btn-ghost btn-sm"
        data-testid="agent-raw-link"
        :href="rawMarkdownUrl"
        target="_blank"
        rel="noopener"
      >Raw markdown</a>
      <button type="button" class="btn btn-ghost btn-sm" data-testid="agent-view-exit" @click="actions.setView('read', { removeParam: true })">Reader view</button>
    </span>
  </div>
</template>

<style scoped>
.notice-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  flex-wrap: wrap;
  padding: 8px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-page);
  color: var(--text-secondary);
}

.agent-banner-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.agent-banner-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

@media print {
  .agent-banner { display: none; }
}
</style>
