<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { RevisionEntry, RevisionContent } from '@/composables/useShare'
import { useRevisions, displayAuthor } from '@/composables/useRevisions'
import { buildLineDiff, type DiffRow, type DiffStats } from '@/composables/useDiff'

const props = defineProps<{
  visible: boolean
  pasteId: string | null
  revisions: RevisionEntry[]
  currentHash: string | null
  /** Hash to diff from when the modal opens (e.g. "since I last looked"). */
  initialFrom: string | null
}>()

const emit = defineEmits<{
  close: []
  /** Load an older revision into the editor as unsaved edits. */
  restore: [markdown: string, entry: RevisionEntry | null]
  /** The user has now looked at changes up to `hash`. */
  acknowledged: [hash: string]
}>()

const { fetchRevision } = useRevisions()

// Newest first for display.
const ordered = computed(() => [...props.revisions].reverse())

const fromHash = ref<string | null>(null)
const toHash = ref<string | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const rows = ref<DiffRow[]>([])
const stats = ref<DiffStats>({ added: 0, removed: 0 })
const fromContent = ref<RevisionContent | null>(null)
const toContent = ref<RevisionContent | null>(null)
const expanded = ref<Set<number>>(new Set())

function entryFor(hash: string | null): RevisionEntry | null {
  return props.revisions.find(r => r.hash === hash) ?? null
}

function defaultFrom(): string | null {
  if (props.initialFrom && props.initialFrom !== props.currentHash) return props.initialFrom
  const revs = props.revisions
  return revs.length >= 2 ? revs[revs.length - 2].hash : null
}

async function load() {
  if (!props.pasteId || !toHash.value) return
  loading.value = true
  error.value = null
  rows.value = []
  expanded.value = new Set()
  try {
    const [from, to] = await Promise.all([
      fromHash.value ? fetchRevision(props.pasteId, fromHash.value) : Promise.resolve({ data: null, status: 200 }),
      fetchRevision(props.pasteId, toHash.value === props.currentHash ? 'current' : toHash.value),
    ])
    if (!to.data) { error.value = 'Could not load the selected revision.'; return }
    if (fromHash.value && !from.data) {
      error.value = from.status === 410
        ? 'The earlier version you saw is no longer stored. Pick another revision on the left.'
        : 'Could not load the earlier revision.'
      return
    }
    fromContent.value = from.data
    toContent.value = to.data
    const result = await buildLineDiff(from.data?.markdown ?? '', to.data.markdown)
    rows.value = result.rows
    stats.value = result.stats
    if (to.data.hash === props.currentHash) emit('acknowledged', to.data.hash)
  } catch {
    error.value = 'Could not compute the diff.'
  } finally {
    loading.value = false
  }
}

watch(() => props.visible, (v) => {
  if (!v) return
  toHash.value = props.currentHash
  fromHash.value = defaultFrom()
  load()
})

watch([fromHash, toHash], () => { if (props.visible) load() })

function pick(hash: string) {
  // Clicking a revision compares it with the current one, unless it is already
  // the "to" side, in which case clicking picks a new "from".
  if (hash === toHash.value) return
  if (hash === fromHash.value) { fromHash.value = null; return }
  fromHash.value = hash
}

function formatAt(entry: RevisionEntry): string {
  const start = new Date(entry.at)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  const s = start.toLocaleString([], opts)
  if (entry.at_end) {
    const end = new Date(entry.at_end)
    return `${s} – ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return s
}

function toggleSkip(i: number) {
  const s = new Set(expanded.value)
  if (s.has(i)) s.delete(i)
  else s.add(i)
  expanded.value = s
}

const visibleRows = computed(() => {
  const out: Array<DiffRow & { skipIndex?: number }> = []
  rows.value.forEach((row, i) => {
    if (row.type === 'skip') {
      if (expanded.value.has(i)) out.push(...(row.hidden ?? []))
      else out.push({ ...row, skipIndex: i })
    } else {
      out.push(row)
    }
  })
  return out
})

const canRestore = computed(() => !!fromContent.value && fromHash.value !== props.currentHash)

function restore() {
  if (!fromContent.value) return
  emit('restore', fromContent.value.markdown, entryFor(fromHash.value))
}
</script>

<template>
  <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
    <div class="modal revisions-modal" data-testid="revisions-modal">
      <div class="modal-header">
        <h2 class="modal-title">
          History
          <span class="modal-title-count">({{ revisions.length }} revision{{ revisions.length === 1 ? '' : 's' }})</span>
        </h2>
        <button class="modal-close" @click="emit('close')">&times;</button>
      </div>

      <div class="revisions-body">
        <aside class="rev-list">
          <div class="rev-list-hint">Click a revision to compare it with the current version.</div>
          <button
            v-for="entry in ordered"
            :key="entry.hash"
            class="rev-item"
            :class="{ from: entry.hash === fromHash, to: entry.hash === toHash, current: entry.hash === currentHash }"
            :data-hash="entry.hash"
            @click="pick(entry.hash)"
          >
            <span class="rev-role">{{ entry.hash === toHash ? 'now' : entry.hash === fromHash ? 'from' : '' }}</span>
            <span class="rev-main">
              <span class="rev-by">{{ displayAuthor(entry) }}</span>
              <span class="rev-at">{{ formatAt(entry) }}</span>
              <span v-if="entry.writes && entry.writes > 1" class="rev-meta">{{ entry.writes }} saves</span>
              <span v-if="entry.seeded" class="rev-meta">before history</span>
            </span>
            <span class="rev-client" :title="entry.client === 'mcp' ? 'written by an agent via MCP' : entry.client === 'ui' ? 'written in the browser' : 'written via the API'">{{ entry.client === 'mcp' ? '🤖' : entry.client === 'ui' ? '👤' : '⚙' }}</span>
          </button>
        </aside>

        <section class="rev-diff">
          <div class="rev-diff-header">
            <span v-if="fromHash && fromContent" class="rev-range">
              Changes from <strong>{{ displayAuthor(fromContent) }}, {{ formatAt(fromContent) }}</strong>
              to <strong>{{ toHash === currentHash ? 'current version' : (toContent ? formatAt(toContent) : '') }}</strong>
            </span>
            <span v-else class="rev-range">Select a revision on the left to compare.</span>
            <span v-if="!loading && !error && fromHash" class="rev-stats" data-testid="diff-stats">
              <span class="stat-add">+{{ stats.added }}</span>
              <span class="stat-del">−{{ stats.removed }}</span>
            </span>
          </div>
          <div v-if="loading" class="rev-status">Loading…</div>
          <div v-else-if="error" class="rev-status rev-error">{{ error }}</div>
          <div v-else-if="fromHash && rows.length === 0" class="rev-status">No differences.</div>
          <div v-else-if="fromHash" class="diff-table" data-testid="diff-table">
            <template v-for="(row, i) in visibleRows" :key="i">
              <button v-if="row.type === 'skip'" class="diff-skip" @click="toggleSkip(row.skipIndex!)">
                ⋯ {{ row.hidden?.length }} unchanged line{{ row.hidden?.length === 1 ? '' : 's' }} — show
              </button>
              <div v-else class="diff-row" :class="row.type">
                <span class="diff-no">{{ row.oldNo ?? '' }}</span>
                <span class="diff-no">{{ row.newNo ?? '' }}</span>
                <span class="diff-sign">{{ row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ' }}</span>
                <span class="diff-text">
                  <template v-if="row.segments">
                    <span v-for="(seg, k) in row.segments" :key="k" :class="{ 'seg-changed': seg.changed }">{{ seg.text }}</span>
                  </template>
                  <template v-else>{{ row.text }}</template>
                </span>
              </div>
            </template>
          </div>
        </section>
      </div>

      <div class="modal-footer">
        <span class="rev-footer-hint" v-if="canRestore">Restoring loads that version into the editor as unsaved edits; nothing is written until it autosaves.</span>
        <div class="modal-footer-actions">
          <button class="btn btn-ghost" @click="emit('close')">Close</button>
          <button v-if="canRestore" class="btn btn-primary" data-testid="restore-revision" @click="restore">Restore this version</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: min(1200px, 94vw);
  height: min(84vh, 900px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header,
.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.modal-footer {
  border-bottom: none;
  border-top: 1px solid var(--border);
  gap: 12px;
}

.modal-title {
  font-family: var(--font-heading);
  font-size: 16px;
  font-weight: 600;
}

.modal-title-count {
  color: var(--text-muted);
  font-weight: 400;
  font-size: 13px;
}

.modal-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 22px;
  cursor: pointer;
  line-height: 1;
}

.modal-footer-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.rev-footer-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.revisions-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.rev-list {
  width: 300px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rev-list-hint {
  font-size: 11px;
  color: var(--text-muted);
  padding: 4px 8px 8px;
}

.rev-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  font-family: var(--font-body);
}

.rev-item:hover { background: var(--bg-page); }
.rev-item.from { border-color: #dc2626; background: rgba(220, 38, 38, 0.06); }
.rev-item.to { border-color: #16a34a; background: rgba(22, 163, 74, 0.06); }

.rev-role {
  width: 34px;
  flex-shrink: 0;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.rev-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.rev-by { font-size: 13px; font-weight: 500; }
.rev-at, .rev-meta { font-size: 11px; color: var(--text-muted); }
.rev-client { font-size: 13px; opacity: 0.8; }

.rev-diff {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.rev-diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
}

.rev-stats { font-family: var(--font-mono); font-size: 12px; display: flex; gap: 8px; }
.stat-add { color: #16a34a; }
.stat-del { color: #dc2626; }

.rev-status {
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
}

.rev-error { color: #dc2626; }

.diff-table {
  flex: 1;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.5;
}

.diff-row {
  display: grid;
  grid-template-columns: 44px 44px 16px 1fr;
  white-space: pre-wrap;
  word-break: break-word;
}

.diff-row.add { background: rgba(22, 163, 74, 0.12); }
.diff-row.del { background: rgba(220, 38, 38, 0.10); }
.diff-row.add .seg-changed { background: rgba(22, 163, 74, 0.35); border-radius: 2px; }
.diff-row.del .seg-changed { background: rgba(220, 38, 38, 0.30); border-radius: 2px; }

.diff-no {
  color: var(--text-muted);
  text-align: right;
  padding-right: 8px;
  user-select: none;
  opacity: 0.7;
}

.diff-sign { color: var(--text-muted); user-select: none; }

.diff-skip {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  border-top: 1px dashed var(--border);
  border-bottom: 1px dashed var(--border);
  background: var(--bg-page);
  color: var(--text-muted);
  font-family: var(--font-body);
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}
</style>
