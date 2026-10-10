<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { updatedLabel } from '@/composables/docMeta'

// "Updated 3 h ago by agent" (#2 rule 8): latest revision, else sharedAt.
const { docMeta } = useDocState()
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 30_000) })
onUnmounted(() => { if (timer) clearInterval(timer) })

const at = computed(() => docMeta.value.latest?.at ?? docMeta.value.sharedAt)
const by = computed(() => (docMeta.value.latest ? docMeta.value.latest.by : null))
const label = computed(() => updatedLabel(at.value, by.value, now.value))
const absolute = computed(() => {
  const t = at.value ? Date.parse(at.value) : NaN
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
})
</script>

<template>
  <time v-if="label" class="doc-updated" data-testid="doc-updated" :datetime="at ?? undefined" :title="absolute">{{ label }}</time>
</template>

<style scoped>
.doc-updated {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}
</style>
