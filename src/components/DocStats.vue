<script setup lang="ts">
import { useDocState } from '@/composables/useDocState'

const { wordCount, charCount } = useDocState()
</script>

<template>
  <span class="doc-stats">
    <span class="doc-stats-sep">·</span>
    <span class="doc-stats-num">{{ wordCount.toLocaleString() }}</span> words
    <span class="doc-stats-sep">·</span>
    <span class="doc-stats-num">{{ charCount.toLocaleString() }}</span> chars
  </span>
</template>

<style scoped>
.doc-stats {
  color: var(--text-meta);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.doc-stats-sep {
  color: var(--text-meta);
  opacity: 0.5;
}

.doc-stats-num {
  font-family: var(--font-mono);
}
</style>
