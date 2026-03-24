<script setup lang="ts">
import type { Comment } from '@/types'

defineProps<{
  comments: Comment[]
}>()

const emit = defineEmits<{
  delete: [id: string]
  'scroll-to': [line: number]
}>()
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">Comments</span>
      <span v-if="comments.length" class="badge">{{ comments.length }}</span>
    </div>

    <div v-if="comments.length === 0" class="sidebar-empty">
      Select text in the document to add a comment
    </div>

    <div v-else class="comment-list">
      <div
        v-for="comment in comments"
        :key="comment.id"
        class="comment-card"
        @click="emit('scroll-to', comment.startLine)"
      >
        <div class="comment-line">
          L{{ comment.startLine + 1 }}{{ comment.endLine > comment.startLine + 1 ? `-${comment.endLine}` : '' }}
        </div>
        <div class="comment-quote">"{{ comment.selectedText }}"</div>
        <div class="comment-body">{{ comment.body }}</div>
        <button
          class="comment-delete"
          title="Delete comment"
          @click.stop="emit('delete', comment.id)"
        >
          &times;
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  background: var(--bg-page);
  height: 100%;
  overflow-y: auto;
  padding: 16px;
  border-left: 1px solid var(--border);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.sidebar-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.badge {
  background: var(--accent);
  color: var(--bg-surface);
  font-size: 11px;
  min-width: 20px;
  height: 20px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
}

.sidebar-empty {
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
  padding: 40px 16px;
}

.comment-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.comment-card {
  position: relative;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  padding: 10px;
  cursor: pointer;
  transition: box-shadow 0.15s;
}

.comment-card:hover {
  box-shadow: 0 1px 4px rgba(26, 22, 18, 0.08);
}

.comment-line {
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  margin-bottom: 4px;
}

.comment-quote {
  color: var(--text-muted);
  font-size: 12px;
  font-style: italic;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.comment-body {
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.4;
}

.comment-delete {
  position: absolute;
  top: 6px;
  right: 8px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  padding: 2px 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.comment-card:hover .comment-delete {
  opacity: 1;
}

.comment-delete:hover {
  color: var(--accent);
}
</style>
