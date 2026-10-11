<script setup lang="ts">
import { useDocActions } from '@/composables/useDocLoader'

// #29 rule 1: "Present" in the reader header (desktop; the overflow menu below
// 1100px). Lazy, off the #6 entry chunk.
const actions = useDocActions()
</script>

<template>
  <button type="button" class="btn btn-ghost slides-enter-btn" title="Present as slides" data-testid="slides-enter-btn" @click="actions.setView('slides')">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1" /><path d="M12 16v4M8 20h8" /></svg>
    <span>Present</span>
  </button>
</template>

<style scoped>
.slides-enter-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  flex-shrink: 0;
}
</style>
