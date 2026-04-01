<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Comment, ApprovalStatus } from '@/types'
import { COMMENT_CATEGORIES } from '@/types'

const props = defineProps<{
  filename: string
  sessionName?: string
  createdAt?: string
  comments: Comment[]
  approvalStatus?: ApprovalStatus
}>()

const collapsed = ref(false)

const categoryCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const cat of COMMENT_CATEGORIES) counts[cat.value] = 0
  for (const c of props.comments) {
    if (counts[c.category] !== undefined) counts[c.category]++
  }
  return counts
})

const resolvedCount = computed(() => props.comments.filter(c => c.resolved).length)

const unresolvedMustFix = computed(() =>
  props.comments.filter(c => c.category === 'must-fix' && c.resolved !== true)
)
</script>

<template>
  <div class="summary-panel" :class="{ collapsed }">
    <button class="summary-toggle" @click="collapsed = !collapsed">
      <span class="summary-title">Review Summary</span>
      <span class="toggle-icon">{{ collapsed ? '+' : '-' }}</span>
    </button>
    <div v-if="!collapsed" class="summary-content">
      <div class="summary-meta">
        <span v-if="sessionName" class="meta-item"><strong>{{ sessionName }}</strong></span>
        <span class="meta-item">{{ filename }}</span>
        <span v-if="createdAt" class="meta-item">{{ new Date(createdAt).toLocaleDateString() }}</span>
        <span class="meta-item">{{ resolvedCount }}/{{ comments.length }} resolved</span>
      </div>
      <div class="category-badges">
        <span
          v-for="cat in COMMENT_CATEGORIES"
          :key="cat.value"
          class="cat-badge"
          :style="{ '--cat-color': cat.color }"
        >
          {{ categoryCounts[cat.value] }} {{ cat.label }}
        </span>
      </div>
      <div v-if="unresolvedMustFix.length > 0" class="attention">
        <div class="attention-header">Needs attention ({{ unresolvedMustFix.length }})</div>
        <div v-for="c in unresolvedMustFix" :key="c.id" class="attention-item">
          <span class="attention-line">L{{ c.startLine + 1 }}</span>
          <span class="attention-text">{{ c.body.slice(0, 80) }}{{ c.body.length > 80 ? '...' : '' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.summary-panel {
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
}
.summary-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 13px;
}
.summary-title { font-weight: 600; }
.toggle-icon { font-size: 16px; opacity: 0.5; }
.summary-content { padding: 0 16px 10px; }
.summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 8px;
}
.category-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.cat-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--cat-color);
  color: var(--cat-color);
}
.attention {
  background: var(--attention-bg, #fef2f2);
  border: 1px solid var(--attention-border, #fecaca);
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
}
:root[data-theme="dark"] .attention,
:root[data-theme="github-dark"] .attention {
  --attention-bg: rgba(220, 38, 38, 0.1);
  --attention-border: rgba(220, 38, 38, 0.25);
}
.attention-header {
  font-weight: 600;
  color: #dc2626;
  margin-bottom: 4px;
}
:root[data-theme="dark"] .attention-header,
:root[data-theme="github-dark"] .attention-header {
  color: #f87171;
}
.attention-item {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  color: var(--text-primary);
}
.attention-line {
  font-family: monospace;
  color: #dc2626;
  min-width: 36px;
}
.attention-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
