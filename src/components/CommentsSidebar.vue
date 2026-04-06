<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Comment, CommentCategory, Reply } from '@/types'
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
  'add-reply': [commentId: string, input: { body: string }]
  'edit-reply': [commentId: string, replyId: string, body: string]
  'delete-reply': [commentId: string, replyId: string]
  resolve: [commentId: string]
  unresolve: [commentId: string]
}>()

const collapsed = ref(false)
const filterCategory = ref<CommentCategory | null>(null)
const editingId = ref<string | null>(null)
const editBody = ref('')

const expandedThreads = ref<Set<string>>(new Set())
const replyInputs = ref<Record<string, string>>({})
const editingReplyId = ref<string | null>(null)
const editReplyBody = ref('')

const filteredComments = computed(() => {
  if (!filterCategory.value) return props.comments
  return props.comments.filter((c) => c.category === filterCategory.value)
})

function categoryCount(cat: CommentCategory): number {
  return props.comments.filter((c) => c.category === cat).length
}

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

function toggleThread(commentId: string) {
  const s = new Set(expandedThreads.value)
  if (s.has(commentId)) s.delete(commentId)
  else s.add(commentId)
  expandedThreads.value = s
}

function openReplyInput(commentId: string) {
  const s = new Set(expandedThreads.value)
  s.add(commentId)
  expandedThreads.value = s
  if (!replyInputs.value[commentId]) replyInputs.value[commentId] = ''
}

function submitReply(commentId: string) {
  const body = (replyInputs.value[commentId] || '').trim()
  if (!body) return
  emit('add-reply', commentId, { body })
  replyInputs.value[commentId] = ''
}

function startEditReply(reply: Reply) {
  editingReplyId.value = reply.id
  editReplyBody.value = reply.body
}

function saveEditReply(commentId: string, replyId: string) {
  const trimmed = editReplyBody.value.trim()
  if (!trimmed) return
  emit('edit-reply', commentId, replyId, trimmed)
  editingReplyId.value = null
}

function cancelEditReply() {
  editingReplyId.value = null
}

function formatTimeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-header-left">
        <button
          class="collapse-toggle"
          :title="collapsed ? 'Expand comments' : 'Collapse comments'"
          @click="collapsed = !collapsed"
        >
          <svg v-if="collapsed" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
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
        :class="{ active: filterCategory === cat.value, ['filter-' + cat.value]: filterCategory === cat.value }"
        :style="filterCategory === cat.value ? { '--cat-color': cat.color, background: 'var(--cat-bg, ' + cat.color + ')', color: 'var(--cat-text, #fff)', borderColor: 'var(--cat-bg, ' + cat.color + ')' } : {}"
        @click="toggleFilter(cat.value)"
      >
        {{ cat.label }}<template v-if="categoryCount(cat.value)"> ({{ categoryCount(cat.value) }})</template>
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
        :class="{ resolved: comment.resolved }"
        @click="emit('scroll-to', comment.startLine)"
      >
        <div class="comment-top-row">
          <div class="comment-meta-left">
            <div class="comment-line">
              L{{ comment.startLine + 1 }}{{ comment.endLine > comment.startLine + 1 ? `-${comment.endLine}` : '' }}
            </div>
            <span v-if="comment.author" class="comment-author">{{ comment.author }}</span>
          </div>
          <span
            class="category-tag"
            :class="'cat-' + comment.category"
            :style="{ '--cat-color': getCategoryMeta(comment.category).color }"
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
          <button
            v-if="!comment.resolved"
            class="comment-action-btn resolve-btn"
            title="Mark as resolved"
            @click.stop="emit('resolve', comment.id)"
          >
            Resolve
          </button>
          <button
            v-else
            class="comment-action-btn unresolve-btn"
            title="Mark as unresolved"
            @click.stop="emit('unresolve', comment.id)"
          >
            Unresolve
          </button>
        </div>

        <!-- Reply thread -->
        <div class="reply-section" @click.stop>
          <button
            v-if="comment.replies.length === 0"
            class="reply-link"
            @click="openReplyInput(comment.id)"
          >
            Reply
          </button>
          <button
            v-else
            class="reply-link"
            @click="toggleThread(comment.id)"
          >
            {{ expandedThreads.has(comment.id) ? '▾' : '▸' }}
            {{ comment.replies.length }} {{ comment.replies.length === 1 ? 'reply' : 'replies' }}
          </button>

          <div v-if="expandedThreads.has(comment.id)" class="reply-thread">
            <div
              v-for="reply in comment.replies"
              :key="reply.id"
              class="reply-item"
            >
              <div class="reply-meta">
                <span v-if="reply.author" class="comment-author">{{ reply.author }}</span>
                <span class="reply-time">{{ formatTimeAgo(reply.createdAt) }}</span>
              </div>
              <div v-if="editingReplyId === reply.id" class="edit-area">
                <textarea
                  v-model="editReplyBody"
                  class="edit-input"
                  rows="2"
                  @keydown.enter.meta="saveEditReply(comment.id, reply.id)"
                  @keydown.enter.ctrl="saveEditReply(comment.id, reply.id)"
                  @keydown.escape="cancelEditReply"
                />
                <div class="edit-actions">
                  <button class="btn btn-ghost btn-xs" @click="cancelEditReply">Cancel</button>
                  <button class="btn btn-primary btn-xs" @click="saveEditReply(comment.id, reply.id)">Save</button>
                </div>
              </div>
              <div v-else class="reply-body" @dblclick.stop="startEditReply(reply)">{{ reply.body }}</div>
              <div class="reply-actions">
                <button class="comment-action-btn" @click.stop="startEditReply(reply)">Edit</button>
                <button class="comment-action-btn" @click.stop="emit('delete-reply', comment.id, reply.id)">Delete</button>
              </div>
            </div>

            <div class="reply-input-row">
              <input
                v-model="replyInputs[comment.id]"
                class="reply-input"
                placeholder="Write a reply..."
                @keydown.enter.exact="submitReply(comment.id)"
                @keydown.escape="toggleThread(comment.id)"
              />
              <button class="reply-send-btn" @click="submitReply(comment.id)">Send</button>
            </div>
          </div>
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
  transition: color 0.15s;
  padding: 0;
  flex-shrink: 0;
}

.collapse-toggle:hover {
  color: var(--text-primary);
  background: var(--bg-surface);
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

.comment-card.resolved {
  opacity: 0.7;
  border-left-color: #059669;
}
.comment-card.resolved .comment-body {
  text-decoration: line-through;
  color: var(--text-muted);
}

.resolve-btn { color: #059669 !important; }
.unresolve-btn {
  color: #b45309 !important;
  opacity: 1 !important;
  font-weight: 500;
}

.comment-top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.comment-meta-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.comment-line {
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
}

.comment-author {
  font-size: 10px;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 5px;
  line-height: 16px;
}

.category-tag {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 1px 6px;
  border-radius: 2px;
  background: var(--cat-color);
  color: #fff;
}

:global(html.dark .category-tag.cat-must-fix) {
  background: #fca5a5 !important;
  color: #7f1d1d !important;
}

:global(html.dark .filter-btn.filter-must-fix) {
  --cat-bg: #fca5a5;
  --cat-text: #7f1d1d;
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

.reply-section {
  margin-top: 6px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}

.reply-link {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 11px;
  padding: 0;
  cursor: pointer;
  font-family: var(--font-body);
}

.reply-link:hover {
  color: var(--accent);
}

.reply-thread {
  margin-top: 6px;
}

.reply-item {
  margin-left: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}

.reply-item:last-of-type {
  border-bottom: none;
}

.reply-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.reply-time {
  font-size: 10px;
  color: var(--text-muted);
}

.reply-body {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.4;
}

.reply-actions {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.reply-item:hover .reply-actions {
  opacity: 1;
}

.reply-input-row {
  display: flex;
  gap: 6px;
  margin-left: 12px;
  margin-top: 6px;
}

.reply-input {
  flex: 1;
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: var(--font-body);
  color: var(--text-primary);
}

.reply-input:focus {
  outline: none;
  border-color: var(--text-muted);
}

.reply-send-btn {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: var(--font-body);
  color: var(--text-primary);
  cursor: pointer;
}

.reply-send-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
