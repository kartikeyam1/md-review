<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { viewStatsLabel } from '@/composables/useViews'
import ReadersPanel from '@/components/ReadersPanel.vue'

// #25 rule 5: "{n} views · {m} readers" in the reader header (after doc-updated
// on desktop, in doc-meta-row below 1100px). Hidden while nothing was viewed.
// For editors (the stats came with `readers`) it is a button opening the
// readers panel; for viewers plain text, not focusable.
const { views } = useDocState()
const stats = views.stats
const label = computed(() => viewStatsLabel(stats.value))
const isEditor = computed(() => Array.isArray(stats.value?.readers))
const open = ref(false)
const btn = ref<HTMLButtonElement | null>(null)

// The panel belongs to the doc it was opened for.
watch(stats, (s) => { if (!s || !Array.isArray(s.readers)) open.value = false })

function close(restoreFocus: boolean) {
  open.value = false
  if (restoreFocus) nextTick(() => btn.value?.focus())
}
</script>

<template>
  <template v-if="label">
    <button
      v-if="isEditor"
      ref="btn"
      type="button"
      class="view-stats view-stats-btn"
      data-testid="view-stats"
      aria-haspopup="dialog"
      :aria-expanded="open ? 'true' : 'false'"
      title="Who read this doc"
      @click="open = !open"
    >{{ label }}</button>
    <span v-else class="view-stats" data-testid="view-stats">{{ label }}</span>
    <ReadersPanel v-if="open && isEditor && stats" :stats="stats" :anchor="btn" @close="close" />
  </template>
</template>

<style scoped>
.view-stats {
  font-size: 12px;
  color: var(--text-meta);
  white-space: nowrap;
}

.view-stats-btn {
  border: none;
  background: transparent;
  padding: 2px 4px;
  margin: -2px 0;
  border-radius: 4px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.view-stats-btn:hover { color: var(--text-primary); }
.view-stats-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
