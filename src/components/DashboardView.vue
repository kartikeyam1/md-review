<script setup lang="ts">
import { ref, onMounted } from 'vue'

const PASTE_API = import.meta.env.VITE_PASTE_API_URL || ''

interface SessionItem {
  id: string
  slug: string | null
  sessionName: string | null
  filename: string | null
  approval_status: string
  comment_count: number
  must_fix_unresolved: number
  created_at: string | null
  expires_at: string | null
}

defineEmits<{ 'new-doc': [] }>()

const sessions = ref<SessionItem[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

async function loadSessions() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch(`${PASTE_API}/paste/list?status=pending`)
    if (!res.ok) throw new Error(`${res.status}`)
    sessions.value = await res.json()
  } catch (e) {
    error.value = 'Could not load sessions'
  } finally {
    loading.value = false
  }
}

function openSession(s: SessionItem) {
  const shareId = s.slug || s.id
  window.location.hash = `#shared=${shareId}`
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return ''
  const ms = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

onMounted(loadSessions)
</script>

<template>
  <div class="dashboard">
    <div class="dashboard-header">
      <div class="dashboard-title-row">
        <h2>Pending Reviews</h2>
        <a href="#" class="nav-link" @click.prevent="$emit('new-doc')">New Review</a>
      </div>
      <button class="refresh-btn" @click="loadSessions" :disabled="loading">Refresh</button>
    </div>

    <div v-if="loading" class="dashboard-status">Loading...</div>
    <div v-else-if="error" class="dashboard-status error">{{ error }}</div>
    <div v-else-if="sessions.length === 0" class="dashboard-status empty">No pending reviews.</div>

    <div v-else class="session-list">
      <div
        v-for="s in sessions"
        :key="s.id"
        class="session-card"
        @click="openSession(s)"
      >
        <div class="session-name">{{ s.sessionName || s.filename || s.id }}</div>
        <div class="session-meta">
          <span v-if="s.filename" class="meta-tag file">{{ s.filename }}</span>
          <span class="meta-tag comments">{{ s.comment_count }} comments</span>
          <span v-if="s.must_fix_unresolved > 0" class="meta-tag must-fix">{{ s.must_fix_unresolved }} must-fix</span>
          <span v-if="s.created_at" class="meta-tag age">{{ timeAgo(s.created_at) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px;
}
.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.dashboard-title-row {
  display: flex;
  align-items: baseline;
  gap: 16px;
}
.nav-link {
  font-size: 13px;
  color: var(--text-muted);
  text-decoration: none;
}
.nav-link:hover {
  color: var(--text-primary);
  text-decoration: underline;
}
.dashboard-header h2 {
  margin: 0;
  font-size: 20px;
  color: var(--text-primary);
}
.refresh-btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
}
.refresh-btn:disabled { opacity: 0.5; }
.dashboard-status {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
  font-size: 14px;
}
.dashboard-status.error { color: #dc2626; }
.session-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.session-card {
  padding: 12px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: box-shadow 0.15s;
}
.session-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}
.session-name {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 6px;
  color: var(--text-primary);
}
.session-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.meta-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-page);
  color: var(--text-muted);
}
.meta-tag.must-fix {
  background: #fee2e2;
  color: #dc2626;
}
</style>
