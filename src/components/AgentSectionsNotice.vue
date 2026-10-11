<script setup lang="ts">
import { computed } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { useDocActions } from '@/composables/useDocLoader'

// #28 rule 10: in the human view, one subtle line above the document saying
// how many agent-only sections are hidden, with a Show button that switches to
// ?view=agent (replaceState, other params and the fragment kept, no reload).
// Lazy (off the #6 entry chunk); DocView renders it only when N ≥ 1.
const { agentSectionCount } = useDocState()
const actions = useDocActions()
const text = computed(() => `${agentSectionCount.value} agent-only section${agentSectionCount.value === 1 ? '' : 's'} hidden`)
</script>

<template>
  <div class="agent-notice" data-testid="agent-sections-notice">
    <span>{{ text }}</span>
    <button type="button" class="agent-notice-show" data-testid="agent-sections-show" @click="actions.setView('agent')">Show</button>
  </div>
</template>

<style scoped>
/* Lined up with the reading column (.preview-pane: 50em + its side padding, #18 Wide lifts the cap). */
.agent-notice {
  --read-pad: 32px;
  box-sizing: border-box;
  max-width: calc(50em + 2 * var(--read-pad));
  margin: 0 auto;
  padding: 10px var(--read-pad) 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  /* The preview's base size, so 50em matches its column; the line itself is 13px. */
  font-size: calc(15px * var(--reader-scale, 1));
  line-height: 1.4;
  color: var(--text-secondary);
  background: var(--bg-surface);
}

html[data-reader-width='wide'] .agent-notice {
  max-width: none;
}

@media (max-width: 1099.98px) {
  .agent-notice { --read-pad: 24px; }
}

@media (max-width: 640.98px) {
  .agent-notice { --read-pad: 16px; }
}

.agent-notice > * {
  font-size: 13px;
}

.agent-notice-show {
  padding: 2px 8px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: transparent;
  /* Body text colour: ≥ 4.5:1 in every theme (the accent is not, in `dark`). */
  color: var(--text-primary);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.agent-notice-show:hover {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.agent-notice-show:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media print {
  .agent-notice { display: none; }
}
</style>
