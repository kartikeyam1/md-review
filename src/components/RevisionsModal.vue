<script setup lang="ts">
import { ref, computed, watch, onUnmounted, toRef } from 'vue'
import type { RevisionEntry, RevisionContent } from '@/composables/useShare'
import { useRevisions, displayAuthor } from '@/composables/useRevisions'
import { buildLineDiff, changedSections, type DiffRow, type DiffStats } from '@/composables/useDiff'
import { useFocusTrap } from '@/composables/useFocusTrap'

const props = defineProps<{
  visible: boolean
  pasteId: string | null
  revisions: RevisionEntry[]
  currentHash: string | null
  /** Hash to diff from when the modal opens (e.g. "since I last looked"). */
  initialFrom: string | null
  /** Viewers (#2) can compare but not restore. */
  allowRestore?: boolean
  /**
   * The doc's live hash when `currentHash` is not it (a pinned revision on
   * screen compares against itself). Defaults to `currentHash`.
   */
  liveHash?: string | null
  /**
   * Edits this browser set aside (e.g. "use server version" in a conflict, QA M6):
   * listed above the revisions so they can be compared and restored like one.
   */
  localCopy?: { markdown: string; at: string } | null
}>()

const emit = defineEmits<{
  close: []
  /** Load an older revision into the editor as unsaved edits. */
  restore: [markdown: string, entry: RevisionEntry | null]
  /** The user has now looked at changes up to `hash`. */
  acknowledged: [hash: string]
}>()

const { fetchRevision } = useRevisions()

/**
 * Rows are keyed by position, not hash: a restore makes the newest revision's
 * content (and so its hash) equal an older one's, and only the newest is "now"
 * (QA M6). `LOCAL` is the set-aside local copy.
 */
const LOCAL = 'local'
type Row = RevisionEntry & { key: string }

const keyed = computed<Row[]>(() => props.revisions.map((r, i) => ({ ...r, key: String(i) })))
const localRow = computed<Row | null>(() => props.localCopy
  ? { key: LOCAL, hash: '', at: props.localCopy.at, at_end: null, by: 'Your set-aside edits', client: 'ui', size: null, parent: null }
  : null)
// Newest first for display; the local copy (never saved) on top.
const ordered = computed<Row[]>(() => [...(localRow.value ? [localRow.value] : []), ...[...keyed.value].reverse()])

/** Index of the newest revision holding `hash` (optionally before `before`), else -1. */
function lastIndexOf(hash: string | null, before = props.revisions.length): number {
  for (let i = Math.min(before, props.revisions.length) - 1; i >= 0; i--) if (props.revisions[i].hash === hash) return i
  return -1
}

const fromKey = ref<string | null>(null)
const toKey = ref<string | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const rows = ref<DiffRow[]>([])
const stats = ref<DiffStats>({ added: 0, removed: 0 })
const sections = ref<Array<string | null>>([])
const fromContent = ref<RevisionContent | null>(null)
const toContent = ref<RevisionContent | null>(null)
const expanded = ref<Set<number>>(new Set())
/** QA leader M4: a reader sees the change notes and touched sections first; the raw line diff on request. */
const readerMode = computed(() => props.allowRestore === false)
const showLines = ref(true)

const fromHash = computed(() => (fromKey.value === null || fromKey.value === LOCAL ? null : props.revisions[Number(fromKey.value)]?.hash ?? null))
const toHash = computed(() => (toKey.value === null ? props.currentHash : props.revisions[Number(toKey.value)]?.hash ?? props.currentHash))

function entryFor(key: string | null): RevisionEntry | null {
  return key === null || key === LOCAL ? null : props.revisions[Number(key)] ?? null
}

function defaultFrom(): string | null {
  const at = toKey.value === null ? -1 : Number(toKey.value)
  if (props.initialFrom && props.initialFrom !== props.currentHash) {
    const i = lastIndexOf(props.initialFrom, at === -1 ? undefined : at)
    if (i !== -1) return String(i)
    const anywhere = lastIndexOf(props.initialFrom)
    if (anywhere !== -1) return String(anywhere)
  }
  // The revision before the "now" side (the latest one before current).
  if (at > 0) return String(at - 1)
  if (at === 0) return null
  const n = props.revisions.length
  return n >= 2 ? String(n - 2) : null
}

// Only the latest load may write its result (opening the modal and the key
// watcher can both start one).
let loadSeq = 0

async function load() {
  if (!props.pasteId || !toHash.value) return
  const seq = ++loadSeq
  loading.value = true
  error.value = null
  rows.value = []
  sections.value = []
  expanded.value = new Set()
  try {
    const live = props.liveHash === undefined ? props.currentHash : props.liveHash
    const local = fromKey.value === LOCAL ? props.localCopy ?? null : null
    const [from, to] = await Promise.all([
      local
        ? Promise.resolve({ data: { ...localRow.value!, markdown: local.markdown, is_current: false } as RevisionContent, status: 200 })
        : fromHash.value ? fetchRevision(props.pasteId, fromHash.value) : Promise.resolve({ data: null, status: 200 }),
      fetchRevision(props.pasteId, toHash.value === live ? 'current' : toHash.value),
    ])
    if (seq !== loadSeq) return
    if (!to.data) { error.value = 'Could not load the selected revision.'; return }
    if (fromKey.value !== null && !from.data) {
      error.value = from.status === 410
        ? 'The earlier version you saw is no longer stored. Pick another revision.'
        : 'Could not load the earlier revision.'
      return
    }
    // A revision's own metadata (author, time, note) comes from its row, not the content fetch.
    const fromEntry = entryFor(fromKey.value)
    fromContent.value = from.data && fromEntry ? { ...from.data, ...fromEntry } : from.data
    toContent.value = to.data
    const oldText = from.data?.markdown ?? ''
    const result = await buildLineDiff(oldText, to.data.markdown)
    if (seq !== loadSeq) return
    rows.value = result.rows
    stats.value = result.stats
    sections.value = changedSections(result.rows, oldText, to.data.markdown)
    if (to.data.hash === props.currentHash) emit('acknowledged', to.data.hash)
  } catch {
    if (seq === loadSeq) error.value = 'Could not compute the diff.'
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

// Escape closes the dialog (the shared modal behaviour, 00 §3).
function onEscape(e: KeyboardEvent) { if (e.key === 'Escape' && !e.defaultPrevented) emit('close') }
watch(() => props.visible, (v) => {
  if (v) document.addEventListener('keydown', onEscape)
  else document.removeEventListener('keydown', onEscape)
}, { immediate: true })
onUnmounted(() => document.removeEventListener('keydown', onEscape))

// Focus (00 §3.4, QA M2): trapped inside while open, back to the opener on close. When the
// opener is gone (a menu item, the changes banner), back to the header's More button.
const dialogRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
let opener: HTMLElement | null = null
watch(() => props.visible, (v) => {
  if (v) opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
}, { immediate: true, flush: 'sync' })
useFocusTrap(dialogRef, toRef(props, 'visible'), {
  initialFocus: () => closeRef.value,
  returnFocus: () => (opener?.isConnected && !opener.closest('[role="menu"]') ? opener : document.querySelector<HTMLElement>('[data-testid="header-overflow-btn"]')),
})

// `immediate`: the modal is a lazy chunk (DocView's defineAsyncComponent); when
// the reader opens it before the chunk has loaded, it mounts already visible.
watch(() => props.visible, (v) => {
  if (!v) return
  const at = lastIndexOf(props.currentHash)
  toKey.value = at === -1 ? null : String(at)
  fromKey.value = defaultFrom()
  showLines.value = !readerMode.value
  load()
}, { immediate: true })

watch([fromKey, toKey], () => { if (props.visible) load() })

function pick(key: string) {
  // Clicking a revision compares it with the current one. The "now" row and the
  // row already picked stay as they are (re-clicking never hides Restore, QA M6).
  if (key === toKey.value || key === fromKey.value) return
  fromKey.value = key
}

function formatAt(entry: Pick<RevisionEntry, 'at' | 'at_end'>): string {
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

/** Change notes (#21) of the revisions in the compared range, newest first. */
const rangeNotes = computed(() => {
  if (fromKey.value === LOCAL) return []
  const lo = fromKey.value === null ? -1 : Number(fromKey.value)
  const hi = toKey.value === null ? props.revisions.length - 1 : Number(toKey.value)
  const out: Array<{ key: number; by: string; at: string; note: string }> = []
  for (let i = hi; i > lo; i--) {
    const r = props.revisions[i]
    if (r?.note) out.push({ key: i, by: displayAuthor(r), at: formatAt(r), note: r.note })
  }
  return out
})

const clientLabel = (c: RevisionEntry['client']) => (c === 'mcp' ? 'written by an agent via MCP' : c === 'ui' ? 'written in the browser' : 'written via the API')

const canRestore = computed(() => props.allowRestore !== false && !!fromContent.value && fromKey.value !== null && fromKey.value !== toKey.value
  && (fromKey.value === LOCAL || fromHash.value !== props.currentHash))

function restore() {
  if (!fromContent.value) return
  emit('restore', fromContent.value.markdown, entryFor(fromKey.value))
}
</script>

<template>
  <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
    <div ref="dialogRef" class="modal revisions-modal" role="dialog" aria-modal="true" aria-labelledby="revisions-title" data-testid="revisions-modal">
      <div class="modal-header">
        <h2 id="revisions-title" class="modal-title">
          History
          <span class="modal-title-count">({{ revisions.length }} revision{{ revisions.length === 1 ? '' : 's' }})</span>
        </h2>
        <button ref="closeRef" class="modal-close" aria-label="Close history" @click="emit('close')">&times;</button>
      </div>

      <div class="revisions-body">
        <aside class="rev-list" aria-label="Revisions">
          <div class="rev-list-hint">Pick a revision to compare it with the current version.</div>
          <button
            v-for="entry in ordered"
            :key="entry.key"
            class="rev-item"
            :class="{ from: entry.key === fromKey, to: entry.key === toKey, local: entry.key === LOCAL }"
            :data-hash="entry.hash || undefined"
            :data-key="entry.key"
            :data-testid="entry.key === LOCAL ? 'revision-local-copy' : undefined"
            :aria-pressed="entry.key === fromKey || entry.key === toKey ? 'true' : 'false'"
            @click="pick(entry.key)"
          >
            <span class="rev-role">{{ entry.key === toKey ? 'now' : entry.key === fromKey ? 'from' : '' }}</span>
            <span class="rev-main">
              <span class="rev-by">{{ displayAuthor(entry) }}</span>
              <span class="rev-at">{{ formatAt(entry) }}</span>
              <span v-if="entry.key === LOCAL" class="rev-meta">not saved, kept in this browser</span>
              <span v-if="entry.writes && entry.writes > 1" class="rev-meta">{{ entry.writes }} saves</span>
              <span v-if="entry.seeded" class="rev-meta">before history</span>
              <span v-if="entry.note" class="rev-note" data-testid="revision-note" :title="entry.note">{{ entry.note }}</span>
            </span>
            <span v-if="entry.key !== LOCAL" class="rev-client" :data-client="entry.client ?? 'api'" :title="clientLabel(entry.client)" role="img" :aria-label="clientLabel(entry.client)">
              <!-- QA c1: line icons like the rest of the UI (agent / person / API), not emoji. -->
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <template v-if="entry.client === 'mcp'"><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M9 13v1M15 13v1M2 14h2M20 14h2" /></template>
                <template v-else-if="entry.client === 'ui'"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></template>
                <template v-else><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></template>
              </svg>
            </span>
          </button>
        </aside>

        <section class="rev-diff">
          <div class="rev-diff-header">
            <span v-if="fromKey !== null && fromContent" class="rev-range">
              Changes from <strong>{{ displayAuthor(fromContent) }}, {{ formatAt(fromContent) }}</strong>
              to <strong>{{ toHash === currentHash ? 'current version' : (toContent ? formatAt(toContent) : '') }}</strong>
            </span>
            <span v-else class="rev-range">Select a revision to compare.</span>
            <span v-if="!loading && !error && fromKey !== null" class="rev-stats" data-testid="diff-stats">
              <span class="stat-add">+{{ stats.added }}</span>
              <span class="stat-del">−{{ stats.removed }}</span>
            </span>
          </div>
          <div class="rev-diff-scroll" data-testid="rev-diff-scroll">
            <div v-if="loading" class="rev-status">Loading…</div>
            <div v-else-if="error" class="rev-status rev-error">{{ error }}</div>
            <div v-else-if="fromKey !== null && rows.length === 0" class="rev-status">No differences.</div>
            <template v-else-if="fromKey !== null">
              <div v-if="rangeNotes.length || sections.length || readerMode" class="rev-summary" data-testid="rev-summary">
                <ul v-if="rangeNotes.length" class="rev-summary-notes">
                  <li v-for="n in rangeNotes" :key="n.key" data-testid="rev-summary-note">
                    <span class="rev-summary-note-text">{{ n.note }}</span>
                    <span class="rev-summary-note-by">{{ n.by }} · {{ n.at }}</span>
                  </li>
                </ul>
                <p v-if="sections.length" class="rev-summary-sections" data-testid="rev-summary-sections">
                  <span class="rev-summary-label">Changed {{ sections.length === 1 ? 'section' : 'sections' }}:</span>
                  <span v-for="(name, i) in sections" :key="i" class="rev-section-chip">{{ name ?? 'Opening (before the first heading)' }}</span>
                </p>
                <button
                  v-if="readerMode"
                  type="button"
                  class="btn btn-ghost btn-sm rev-toggle-lines"
                  data-testid="rev-toggle-lines"
                  :aria-expanded="showLines ? 'true' : 'false'"
                  @click="showLines = !showLines"
                >{{ showLines ? 'Hide line-by-line changes' : 'Show line-by-line changes' }}</button>
              </div>
              <div v-if="showLines" class="diff-table" data-testid="diff-table">
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
  background: var(--overlay-bg, rgba(0, 0, 0, 0.45));
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
  width: min(1200px, calc(100vw - 32px));
  height: min(84vh, 900px);
  max-height: calc(100dvh - 32px);
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
  color: var(--text-meta);
  font-weight: 400;
  font-size: 13px;
}

.modal-close {
  border: none;
  background: transparent;
  color: var(--text-meta);
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
  color: var(--text-meta);
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

/* Phone (#5 rule 10): the revision list stacks above the diff. */
@media (max-width: 640.98px) {
  .revisions-body {
    flex-direction: column;
  }
  .rev-list {
    width: auto;
    max-height: 35%;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .modal-footer {
    flex-wrap: wrap;
  }
}

.rev-list-hint {
  font-size: 11px;
  color: var(--text-meta);
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
/* QA c1: theme status tokens (style.css RAG set), not fixed Tailwind hues. */
.rev-item.from { border-color: var(--rag-red-dot); background: color-mix(in srgb, var(--rag-red-dot) 7%, transparent); }
.rev-item.to { border-color: var(--rag-green-dot); background: color-mix(in srgb, var(--rag-green-dot) 7%, transparent); }
.rev-item.local .rev-by { font-style: italic; }
/* The role label carries the state in text (>= 4.5:1), the border is the accent. */
.rev-item.from .rev-role { color: var(--rag-red-fg); font-weight: 600; }
.rev-item.to .rev-role { color: var(--rag-green-fg); font-weight: 600; }

.rev-role {
  width: 34px;
  flex-shrink: 0;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-meta);
}

.rev-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.rev-by { font-size: 13px; font-weight: 500; }
.rev-at, .rev-meta { font-size: 11px; color: var(--text-meta); }
/* #21: an upsert run's change note — plain text, wrapped, never HTML; at most 3 lines (full text in title). */
.rev-note {
  font-size: 12px;
  color: var(--text-secondary, var(--text-primary));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-top: 2px;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}
.rev-client { display: inline-flex; flex-shrink: 0; color: var(--text-meta, var(--text-muted)); }

.rev-diff {
  flex: 1;
  min-width: 0;
  /* QA leader M3: the diff scrolls inside the modal, never past its edge (phone column layout). */
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.rev-diff-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.rev-summary {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  font-size: 13px;
}
.rev-summary-notes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rev-summary-notes li { display: flex; flex-direction: column; gap: 1px; }
.rev-summary-note-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.rev-summary-note-by { font-size: 11px; color: var(--text-meta); }
.rev-summary-sections { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: baseline; }
.rev-summary-label { color: var(--text-meta); font-size: 12px; }
.rev-section-chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.rev-diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-meta);
  border-bottom: 1px solid var(--border);
}

.rev-stats { font-family: var(--font-mono); font-size: 12px; display: flex; gap: 8px; }
.stat-add { color: var(--rag-green-fg); }
.stat-del { color: var(--rag-red-fg); }

.rev-status {
  padding: 24px;
  color: var(--text-meta);
  font-size: 13px;
}

.rev-error { color: var(--rag-red-fg); }

.diff-table {
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

/* Solid RAG tints read as add/remove on every theme background (Locus dark's purple turned a thin green mix navy). */
.diff-row.add { background: var(--rag-green-bg); }
.diff-row.del { background: var(--rag-red-bg); }
.diff-row.add .seg-changed { background: color-mix(in srgb, var(--rag-green-dot) 35%, var(--rag-green-bg)); border-radius: 2px; }
.diff-row.del .seg-changed { background: color-mix(in srgb, var(--rag-red-dot) 30%, var(--rag-red-bg)); border-radius: 2px; }

.diff-no {
  color: var(--text-meta);
  text-align: right;
  padding-right: 8px;
  user-select: none;
  opacity: 0.7;
}

.diff-sign { color: var(--text-meta); user-select: none; }

.diff-skip {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  border-top: 1px dashed var(--border);
  border-bottom: 1px dashed var(--border);
  background: var(--bg-page);
  color: var(--text-meta);
  font-family: var(--font-body);
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}
</style>
