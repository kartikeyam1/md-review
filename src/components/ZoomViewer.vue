<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import {
  fitScale, scaleLimits, initialView, zoomAround, clampView, doubleTapScale, clampScale,
  ZOOM_STEP, PAN_STEP, PAN_STEP_LARGE, type Size, type View,
} from '@/composables/useZoomPan'

// Full-screen zoom/pan viewer (spec #15 rules 4–17). Mounted on demand by
// src/preview/zoom.ts with a snapshot of the diagram (a cloned SVG) or the
// image; live re-renders of the doc never reach it (rule 16). The innermost
// Esc layer (00 §3.4): every key and pointer event it handles stops here.

const props = defineProps<{
  kind: 'mermaid' | 'image'
  /** The snapshot to show: a cloned <svg> or an <img>, sized here. */
  content: Element
  natural: Size
  /** Mermaid fence source for "Copy source". */
  source?: string
  copyText: (text: string) => Promise<boolean>
  onClose: () => void
}>()

const rootRef = ref<HTMLElement | null>(null)
const stageRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLElement | null>(null)
const open = ref(false)

const stage = ref<Size>({ w: 1, h: 1 })
const view = ref<View>({ scale: 1, x: 0, y: 0 })
const fit = computed(() => fitScale(props.natural, stage.value))
const limits = computed(() => scaleLimits(fit.value))
const initial = computed(() => initialView(props.natural, stage.value))
const pct = computed(() => Math.round(view.value.scale * 100))
const EPS = 1e-6
const atMax = computed(() => view.value.scale >= limits.value.max - EPS)
const atMin = computed(() => view.value.scale <= limits.value.min + EPS)
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
let copyTimer: ReturnType<typeof setTimeout> | null = null

const contentStyle = computed(() => ({
  width: `${props.natural.w * view.value.scale}px`,
  height: `${props.natural.h * view.value.scale}px`,
  transform: `translate(${view.value.x}px, ${view.value.y}px)`,
}))

function measure() {
  const s = stageRef.value
  if (s) stage.value = { w: s.clientWidth, h: s.clientHeight }
}

function setView(v: View, centreSmall = true) {
  view.value = clampView(v, props.natural, stage.value, undefined, centreSmall)
}

function zoomTo(scale: number, px = stage.value.w / 2, py = stage.value.h / 2) {
  const s = clampScale(scale, limits.value)
  setView(zoomAround(view.value, s, px, py), false)
}

const zoomIn = () => zoomTo(view.value.scale * ZOOM_STEP)
const zoomOut = () => zoomTo(view.value.scale / ZOOM_STEP)
const reset = () => { view.value = initial.value }
const panBy = (dx: number, dy: number) => setView({ ...view.value, x: view.value.x + dx, y: view.value.y + dy })

/** Rule 9: initial ↔ double-tap scale, centred on the tap point. */
function toggleZoom(px: number, py: number) {
  const target = doubleTapScale(initial.value.scale, limits.value.max)
  if (Math.abs(view.value.scale - initial.value.scale) > EPS) { reset(); return }
  const z = zoomAround(view.value, target, px, py)
  // centre the tapped content point
  setView({ scale: target, x: z.x + (stage.value.w / 2 - px), y: z.y + (stage.value.h / 2 - py) })
}

const announce = ref('')

async function copySource() {
  const ok = await props.copyText(props.source ?? '')
  copyState.value = ok ? 'copied' : 'failed'
  // #14 rule 6: a polite announcement, inside the dialog (aria-modal hides the page's region).
  announce.value = ''
  requestAnimationFrame(() => { announce.value = ok ? 'Copied to clipboard' : 'Copy failed' })
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copyState.value = 'idle' }, 2000)
}

function close() { props.onClose() }

// ── Pointer: pan (1 pointer), pinch (2), double-tap, background click ──
const pointers = new Map<number, { x: number; y: number }>()
let gesture: null | { kind: 'pan'; sx: number; sy: number; v: View } | { kind: 'pinch'; d0: number; mx: number; my: number; v: View } = null
let moved = false
let lastTap: { t: number; x: number; y: number } | null = null
let lastPointerType = 'mouse'
let downOnBackground = false

function local(e: { clientX: number; clientY: number }) {
  const r = stageRef.value!.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function startGesture() {
  const pts = [...pointers.values()]
  if (pts.length === 1) gesture = { kind: 'pan', sx: pts[0]!.x, sy: pts[0]!.y, v: { ...view.value } }
  else if (pts.length >= 2) {
    const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }]
    gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, v: { ...view.value } }
  } else gesture = null
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 && e.pointerType === 'mouse') return
  if ((e.target as Element).closest('button')) return
  e.stopPropagation()
  // A press on the stage must not drop focus to <body> (keys keep working, the trap keeps Tab).
  e.preventDefault()
  focusInside()
  lastPointerType = e.pointerType
  // Pointer capture retargets the click to the stage: remember where the press landed.
  if (!pointers.size) downOnBackground = e.target === stageRef.value
  stageRef.value?.setPointerCapture?.(e.pointerId)
  pointers.set(e.pointerId, local(e))
  if (pointers.size === 1) moved = false
  startGesture()
}

function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  e.stopPropagation()
  pointers.set(e.pointerId, local(e))
  const g = gesture
  if (!g) return
  const pts = [...pointers.values()]
  if (g.kind === 'pan' && pts.length === 1) {
    const dx = pts[0]!.x - g.sx
    const dy = pts[0]!.y - g.sy
    if (Math.hypot(dx, dy) >= 5) moved = true
    if (moved) setView({ scale: g.v.scale, x: g.v.x + dx, y: g.v.y + dy })
  } else if (g.kind === 'pinch' && pts.length >= 2) {
    moved = true
    const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }]
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const s = clampScale(g.v.scale * (d / g.d0), limits.value)
    const z = zoomAround(g.v, s, g.mx, g.my)
    setView({ scale: s, x: z.x + (mx - g.mx), y: z.y + (my - g.my) }, false)
  }
}

function onPointerUp(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  e.stopPropagation()
  const p = pointers.get(e.pointerId)!
  pointers.delete(e.pointerId)
  startGesture()
  if (e.type !== 'pointerup' || moved || pointers.size) return
  if (e.pointerType !== 'mouse') {
    const now = Date.now()
    if (lastTap && now - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      lastTap = null
      toggleZoom(p.x, p.y)
      suppressClick = true
      return
    }
    lastTap = { t: now, x: p.x, y: p.y }
  }
}

let suppressClick = false
let tapTimer: ReturnType<typeof setTimeout> | null = null
function onStageClick(e: MouseEvent) {
  e.stopPropagation()
  const wasDrag = moved
  moved = false
  if (suppressClick) { suppressClick = false; return }
  // Rule 12: a click on the background (not the content), not ending a pan, closes.
  if (wasDrag || !downOnBackground || e.target !== stageRef.value) return
  if (lastPointerType !== 'mouse') {
    // A tap may be the first of a double-tap: wait it out.
    const t = lastTap
    if (tapTimer) clearTimeout(tapTimer)
    tapTimer = setTimeout(() => { tapTimer = null; if (lastTap === t && t) close() }, 320)
    return
  }
  close()
}

function onDblClick(e: MouseEvent) {
  e.stopPropagation()
  if (lastPointerType !== 'mouse') return
  const p = local(e)
  toggleZoom(p.x, p.y)
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  e.stopPropagation()
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.value.h : 1
  const dy = e.deltaY * unit
  const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002))
  const p = local(e)
  zoomTo(view.value.scale * factor, p.x, p.y)
}

function focusInside() {
  const root = rootRef.value
  if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true })
}

// A focused zoom button that becomes disabled at min/max would drop focus to <body>.
watch([atMin, atMax], () => {
  const root = rootRef.value
  if (!root || !root.contains(document.activeElement)) return
  nextTick(() => { if (!root.contains(document.activeElement)) root.focus({ preventScroll: true }) })
})

// ── Keyboard (rule 11) ──
// A document capture listener while open: keys reach the viewer wherever focus is,
// and nothing behind it (global shortcuts, slides, drawers) sees them.
function onKeydown(e: KeyboardEvent) {
  // The viewer swallows every key; only the ones it handles are prevented.
  e.stopPropagation()
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const big = e.shiftKey ? PAN_STEP_LARGE : PAN_STEP
  switch (e.key) {
    case 'Escape': e.preventDefault(); close(); return
    case '+': case '=': e.preventDefault(); zoomIn(); return
    case '-': case '_': e.preventDefault(); zoomOut(); return
    case '0': e.preventDefault(); reset(); return
    case 'ArrowLeft': e.preventDefault(); panBy(big, 0); return
    case 'ArrowRight': e.preventDefault(); panBy(-big, 0); return
    case 'ArrowUp': e.preventDefault(); panBy(0, big); return
    case 'ArrowDown': e.preventDefault(); panBy(0, -big); return
  }
}

useFocusTrap(rootRef, open, { initialFocus: () => closeRef.value, returnFocus: () => false })

let resizeObs: ResizeObserver | null = null
onMounted(async () => {
  const host = contentRef.value!
  host.appendChild(props.content)
  measure()
  view.value = initial.value
  open.value = true
  await nextTick()
  closeRef.value?.focus({ preventScroll: true })
  document.addEventListener('keydown', onKeydown, true)
  resizeObs = new ResizeObserver(() => {
    const before = stage.value
    measure()
    if (before.w !== stage.value.w || before.h !== stage.value.h) setView(view.value)
  })
  if (stageRef.value) resizeObs.observe(stageRef.value)
})

onUnmounted(() => {
  open.value = false
  document.removeEventListener('keydown', onKeydown, true)
  resizeObs?.disconnect()
  if (copyTimer) clearTimeout(copyTimer)
  if (tapTimer) clearTimeout(tapTimer)
})

defineExpose({ close })
</script>

<template>
  <div
    ref="rootRef"
    class="zoom-viewer"
    data-testid="zoom-viewer"
    role="dialog"
    aria-modal="true"
    :aria-label="kind === 'mermaid' ? 'Diagram viewer' : 'Image viewer'"
    tabindex="-1"
  >
    <div class="zoom-toolbar" data-testid="zoom-toolbar" role="toolbar" aria-label="Zoom">
      <span class="zoom-level" data-testid="zoom-level" aria-live="off">{{ pct }}%</span>
      <span class="zoom-sr" aria-live="polite" role="status">{{ announce }}</span>
      <button type="button" class="zoom-btn" data-testid="zoom-out-btn" :disabled="atMin" aria-label="Zoom out" title="Zoom out (−)" @click="zoomOut">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" class="zoom-btn" data-testid="zoom-in-btn" :disabled="atMax" aria-label="Zoom in" title="Zoom in (+)" @click="zoomIn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button type="button" class="zoom-btn zoom-btn-text" data-testid="zoom-reset-btn" title="Reset (0)" @click="reset">Reset</button>
      <button
        v-if="kind === 'mermaid'"
        type="button"
        class="zoom-btn zoom-btn-text"
        data-testid="zoom-copy-source"
        :data-state="copyState"
        @click="copySource"
      >{{ copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy source' }}</button>
      <span class="zoom-spacer"></span>
      <button ref="closeRef" type="button" class="zoom-btn" data-testid="zoom-close-btn" aria-label="Close viewer" title="Close (Esc)" @click="close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div
      ref="stageRef"
      class="zoom-stage"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click="onStageClick"
      @dblclick="onDblClick"
      @wheel="onWheel"
    >
      <div ref="contentRef" class="zoom-content" data-testid="zoom-content" :data-scale="view.scale" :style="contentStyle"></div>
    </div>
  </div>
</template>

<style>
/* Not scoped: the cloned SVG/img inside the content box is not part of this template. */
.zoom-viewer {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: var(--font-body);
}

.zoom-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 6px 8px;
  padding-top: max(6px, env(safe-area-inset-top));
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
}

.zoom-level {
  min-width: 4.5em;
  padding: 0 8px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.zoom-viewer:focus {
  outline: none;
}

.zoom-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* Locus pie labels are bold in the page (#1): the same in the viewer's copy. */
html.locus-theme .zoom-content .slice {
  font-weight: 600;
}

.zoom-spacer {
  flex: 1 1 auto;
}

.zoom-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  height: 36px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font: 500 13px var(--font-body);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

@media (hover: hover) {
  .zoom-btn:hover:not(:disabled) {
    background: var(--bg-page);
  }
}

.zoom-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.zoom-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

html.locus-theme .zoom-btn {
  border-radius: 8px;
  font-family: var(--font-body);
}

@media (hover: hover) {
  html.locus-theme .zoom-btn:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--bg-surface);
  }
}

@media (hover: none) {
  .zoom-btn {
    min-width: 44px;
    height: 44px;
  }
}

.zoom-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
}

.zoom-stage:active {
  cursor: grabbing;
}

.zoom-content {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

.zoom-content > svg,
.zoom-content > img {
  display: block;
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  max-height: none !important;
}

@media print {
  .zoom-viewer {
    display: none !important;
  }
}
</style>
