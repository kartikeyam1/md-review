<script setup lang="ts">
import { useDocState } from '@/composables/useDocState'
import { copyDocLink } from '@/composables/useCopyLink'

// Copies <origin><base>d/<slug||id> (00 §6) and confirms with a toast.
defineProps<{ iconOnly?: boolean }>()
const { docLink } = useDocState()
</script>

<template>
  <button
    v-if="docLink"
    type="button"
    class="btn btn-ghost copy-link"
    :class="{ 'icon-only': iconOnly }"
    title="Copy a link to this document"
    :aria-label="iconOnly ? 'Copy link' : undefined"
    data-testid="copy-link-btn"
    @click="copyDocLink(docLink)"
  >
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
    <span v-if="!iconOnly">Copy link</span>
  </button>
</template>

<style scoped>
.copy-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  flex-shrink: 0;
}
</style>
