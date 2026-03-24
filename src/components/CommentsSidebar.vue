<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Comment, CommentCategory } from '@/types'
import { COMMENT_CATEGORIES, getCategoryMeta } from '@/types'

const props = defineProps<{
  comments: Comment[]
}>()

const emit = defineEmits<{
  delete: [id: string]
  edit: [id: string, updates: { body?: string; category?: CommentCategory }]
  'scroll-to': [line: number]
  'export-comments': []
  'import-comments': []
}>()

const collapsed = ref(false)
const filterCategory = ref<CommentCategory | null>(null)
const editingId = ref<string | null>(null)
const editBody = ref('')

const filteredComments = computed(() => {
  if (!filterCategory.value) return props.comments
  return props.comments.filter((c) => c.category === filterCategory.value)
})

function startEdit(comment: Comment) {
  editingId.value = comment.id
  editBody.value = comment.body
}

function saveEdit(id: string) {
  const trimmed = editBody.value.trim()
  if (!trimmed) return
  emit('edit', id, { body: trimmed })
  editingId.value = null
}

function cancelEdit() {
  editingId.value = null
}

function toggleFilter(cat: CommentCategory) {
  filterCategory.value = filterCategory.value === cat ? null : cat
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-header-left">
        <button
          class="collapse-toggle"
          :class="{ collapsed }"
          title="Toggle comments"
          @click="collapsed = !collapsed"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <span class="sidebar-title">Comments</span>
        <span v-if="comments.length" class="badge">{{ comments.length }}</span>
      </div>
      <div v-if="!collapsed" class="sidebar-header-actions">
        <button
          class="sidebar-action-btn"
          title="Import comments (.json)"
          @click="emit('import-comments')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button
          v-if="comments.length"
          class="sidebar-action-btn"
          title="Export comments (.json)"
          @click="emit('export-comments')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </button>
      </div>
    </div>

    <template v-if="!collapsed">
    <div v-if="comments.length > 0" class="filter-row">
      <button
        v-for="cat in COMMENT_CATEGORIES"
        :key="cat.value"
        class="filter-btn"
        :class="{ active: filterCategory === cat.value }"
        :style="filterCategory === cat.value ? { background: cat.color, color: '#fff', borderColor: cat.color } : {}"
        @click="toggleFilter(cat.value)"
      >
        {{ cat.label }}
      </button>
    </div>

    <div v-if="filteredComments.length === 0 && comments.length === 0" class="sidebar-empty">
      Select text in the document to add a comment
    </div>

    <div v-else-if="filteredComments.length === 0" class="sidebar-empty">
      No comments match this filter
    </div>

    <div v-else class="comment-list">
      <div
        v-for="comment in filteredComments"
        :key="comment.id"
        class="comment-card"
        @click="emit('scroll-to', comment.startLine)"
      >
        <div class="comment-top-row">
          <div class="comment-line">
            L{{ comment.startLine + 1 }}{{ comment.endLine > comment.startLine + 1 ? `-${comment.endLine}` : '' }}
          </div>
          <span
            class="category-tag"
            :style="{ background: getCategoryMeta(comment.category).color, color: '#fff' }"
          >
            {{ getCategoryMeta(comment.category).label }}
          </span>
        </div>
        <div class="comment-quote">"{{ comment.selectedText }}"</div>

        <div v-if="editingId === comment.id" class="edit-area" @click.stop>
          <textarea
            v-model="editBody"
            class="edit-input"
            rows="2"
            @keydown.enter.meta="saveEdit(comment.id)"
            @keydown.enter.ctrl="saveEdit(comment.id)"
            @keydown.escape="cancelEdit"
          />
          <div class="edit-actions">
            <button class="btn btn-ghost btn-xs" @click="cancelEdit">Cancel</button>
            <button class="btn btn-primary btn-xs" @click="saveEdit(comment.id)">Save</button>
          </div>
        </div>

        <div v-else class="comment-body" @dblclick.stop="startEdit(comment)">{{ comment.body }}</div>

        <div class="comment-actions">
          <button
            class="comment-action-btn"
            title="Edit comment"
            @click.stop="startEdit(comment)"
          >
            Edit
          </button>
          <button
            class="comment-action-btn"
            title="Delete comment"
            @click.stop="emit('delete', comment.id)"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
    </template>
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
  margin-bottom: 12px;
}

.sidebar-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-header-actions {
  display: flex;
  gap: 2px;
}

.sidebar-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 3px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.sidebar-action-btn:hover {
  color: var(--text-primary);
  background: var(--bg-surface);
}

.collapse-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: transform 0.15s, color 0.15s;
  padding: 0;
  flex-shrink: 0;
}

.collapse-toggle:hover {
  color: var(--text-primary);
  background: var(--bg-surface);
}

.collapse-toggle.collapsed {
  transform: rotate(-90deg);
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
  color: #fff;
  font-size: 11px;
  min-width: 20px;
  height: 20px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
}

.filter-row {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.filter-btn {
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 500;
  font-family: var(--font-body);
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.1s;
}

.filter-btn:hover {
  border-color: var(--text-muted);
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
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  padding: 10px;
  cursor: pointer;
  transition: box-shadow 0.15s;
}

.comment-card:hover {
  box-shadow: 0 1px 4px var(--shadow-color, rgba(26, 22, 18, 0.08));
}

.comment-top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.comment-line {
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
}

.category-tag {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 1px 6px;
  border-radius: 2px;
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

.comment-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  opacity: 0;
  transition: opacity 0.15s;
}

.comment-card:hover .comment-actions {
  opacity: 1;
}

.comment-action-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 11px;
  padding: 0;
  cursor: pointer;
  font-family: var(--font-body);
}

.comment-action-btn:hover {
  color: var(--accent);
}

.edit-area {
  margin-top: 4px;
}

.edit-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px;
  font-size: 13px;
  font-family: var(--font-body);
  background: var(--bg-page);
  color: var(--text-primary);
  resize: vertical;
  min-height: 40px;
}

.edit-input:focus {
  outline: none;
  border-color: var(--text-muted);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 4px;
}

.btn-xs {
  padding: 2px 8px;
  font-size: 11px;
}
</style>
