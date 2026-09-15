<script setup lang="ts">
import { computed } from 'vue'
import type { SinceSummary } from '@/composables/useRevisions'

const props = defineProps<{
  summary: SinceSummary
}>()

const emit = defineEmits<{
  view: []
  dismiss: []
}>()

function formatWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return sameDay ? `today ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

const headline = computed(() => {
  const s = props.summary
  const n = s.count
  const who = s.authors.length ? ` by ${s.authors.join(', ')}` : ''
  if (!s.sinceKnown) return `Changed since you last looked${who}`
  return `${n} change${n === 1 ? '' : 's'} since you last looked${who}`
})

const detail = computed(() => {
  const s = props.summary
  const range = s.from && s.to && s.from !== s.to ? `${formatWhen(s.from)} – ${formatWhen(s.to)}` : formatWhen(s.to || s.from)
  const note = s.sinceKnown ? '' : ' · the exact version you saw is no longer stored, showing changes since the oldest kept revision'
  return `${range}${note}`
})
</script>

<template>
  <div class="changes-bar" role="status" data-testid="changes-banner">
    <span class="changes-text">
      <strong>{{ headline }}</strong>
      <span v-if="detail" class="changes-detail"> · {{ detail }}</span>
    </span>
    <span class="changes-actions">
      <button class="btn btn-ghost btn-sm" @click="emit('dismiss')">Dismiss</button>
      <button class="btn btn-primary btn-sm" data-testid="view-changes" @click="emit('view')">View changes</button>
    </span>
  </div>
</template>

<style scoped>
.changes-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  font-size: 13px;
  border-bottom: 1px solid rgba(37, 99, 235, 0.35);
  background: rgba(37, 99, 235, 0.08);
  color: var(--text-primary);
}

.changes-detail {
  color: var(--text-muted);
}

.changes-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
</style>
