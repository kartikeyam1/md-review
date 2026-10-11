<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { ViewStatsBody } from '@/composables/useViews'
import { relativeTime } from '@/composables/docMeta'
import { useBreakpoint } from '@/composables/useBreakpoint'

// #25 rule 5: the editor-only reader list — one row per named reader (name,
// when, latest vs older version), "+ N anonymous", or an empty state. A
// non-modal panel (Esc layer 3, 00 §3.4) under the view-stats button; a
// full-width sheet on a phone.
const props = defineProps<{ stats: ViewStatsBody; anchor: HTMLElement | null }>()
const emit = defineEmits<{ close: [restoreFocus: boolean] }>()

const bp = useBreakpoint()
const panel = ref<HTMLElement | null>(null)
const now = ref(Date.now())
const pos = ref<{ top: number; left: number } | null>(null)
const PANEL_W = 320

const readers = computed(() => props.stats.readers ?? [])
const anonymous = computed(() => props.stats.anonymous_readers ?? 0)

function place() {
  const r = props.anchor?.getBoundingClientRect()
  if (!r) return
  // Right-aligned with the button when there is room, never past either edge of the viewport.
  const vw = document.documentElement.clientWidth
  const w = Math.min(PANEL_W, vw - 16)
  pos.value = { top: r.bottom + 6, left: Math.max(8, Math.min(r.right - w, vw - w - 8)) }
}

const when = (iso: string) => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : relativeTime(t, now.value)
}

// Bubble phase, and only an Esc nothing inside handled: one Esc closes the innermost layer (00 §3.4).
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  e.preventDefault()
  e.stopPropagation()
  emit('close', true)
}

function onPointerDown(e: PointerEvent) {
  const t = e.target as Node | null
  if (!t || panel.value?.contains(t) || props.anchor?.contains(t)) return
  emit('close', false)
}

onMounted(() => {
  place()
  window.addEventListener('resize', place)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeydown)
  panel.value?.focus()
})
onUnmounted(() => {
  window.removeEventListener('resize', place)
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    ref="panel"
    class="readers-panel"
    :class="{ sheet: bp === 'phone' }"
    data-testid="readers-panel"
    role="dialog"
    aria-label="Readers"
    tabindex="-1"
    :style="bp !== 'phone' && pos ? { top: `${pos.top}px`, left: `${pos.left}px` } : undefined"
  >
    <div class="readers-head">
      <span class="readers-title">Readers</span>
      <button type="button" class="readers-close" aria-label="Close" @click="emit('close', true)">&times;</button>
    </div>
    <p v-if="readers.length === 0" class="readers-empty" data-testid="readers-empty">No named readers yet</p>
    <ul v-else class="readers-list">
      <li v-for="r in readers" :key="r.name.toLowerCase()" class="reader-row" data-testid="reader-row">
        <span class="reader-name">{{ r.name }}</span>
        <time class="reader-when" :datetime="r.last_viewed_at" :title="r.last_viewed_at">{{ when(r.last_viewed_at) }}</time>
        <span v-if="r.is_current" class="reader-badge latest" data-testid="reader-latest-badge">latest</span>
        <span v-else class="reader-badge stale" data-testid="reader-stale-badge" :title="r.revision ? r.revision.slice(0, 7) : 'unknown version'">older version</span>
      </li>
    </ul>
    <p v-if="anonymous > 0" class="readers-anonymous" data-testid="readers-anonymous">+ {{ anonymous }} anonymous</p>
  </div>
</template>

<style scoped>
.readers-panel {
  position: fixed;
  z-index: 200; /* panels (00 §3.7) */
  width: 320px;
  max-width: calc(100vw - 16px);
  max-height: min(60vh, 480px);
  overflow-y: auto;
  padding: 8px 12px 12px;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  font-size: 13px;
  text-align: left;
}

.readers-panel:focus { outline: none; }

.readers-panel.sheet {
  left: 0;
  right: 0;
  bottom: 0;
  top: auto;
  width: auto;
  max-width: none;
  max-height: 70vh;
  border-radius: 14px 14px 0 0;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
}

.readers-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.readers-title { font-weight: 600; }

.readers-close {
  border: none;
  background: transparent;
  color: var(--text-meta);
  font-size: 20px;
  line-height: 1;
  width: 32px;
  height: 32px;
  cursor: pointer;
  border-radius: 6px;
}

.readers-close:focus-visible { outline: 2px solid var(--accent); }

.readers-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.reader-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--border);
}

.reader-row:first-child { border-top: none; }

.reader-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.reader-when { color: var(--text-meta); font-size: 12px; white-space: nowrap; }

.reader-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  white-space: nowrap;
  border: 1px solid var(--border);
}

.reader-badge.latest { color: var(--text-primary); border-color: var(--text-secondary); }
.reader-badge.stale { color: var(--text-meta); border-style: dashed; }

.readers-empty, .readers-anonymous {
  margin: 6px 0 0;
  color: var(--text-meta);
  font-size: 12px;
}
</style>
