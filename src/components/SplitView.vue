<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  clampSplit, parseSplitRatio, parseSyncPref, ratioToScrollTop, readPref, scrollRatio, splitBounds, stepSplit, writePref,
  SPLIT_DEFAULT, SPLIT_RATIO_KEY, SPLIT_SYNC_KEY,
} from '@/composables/useScrollSync'

// The doc's panes (spec #7). DocView renders the editor and the preview into
// the two slots in every view, so switching edit ↔ split ↔ read never remounts
// either pane (the editor keeps its state and undo history, #8). Outside split
// view the wrappers are `display: contents` and the layout is the old one.
// In split view (viewport ≥ 960px): editor | divider | preview, with synced
// scrolling; below 960px: Edit / Preview tabs, the hidden pane kept mounted.

interface EditorHandle {
  focus(): void
  scrollElement(): HTMLElement | null
  topLine(): number | null
  scrollTopForLine(line: number): number | null
}
interface PreviewHandle {
  scrollElement(): HTMLElement | null
  offsetForLine(line: number): number
  lineAtOffset(offset: number): number
  getRatio(): number
  setRatio(ratio: number): void
}
type Side = 'editor' | 'preview'

const props = defineProps<{
  split: boolean
  editor?: EditorHandle | null
  preview?: PreviewHandle | null
  /** The doc source; a change re-renders the preview, which is then re-synced (rule 7). */
  content?: string
  html?: boolean
}>()

// ── Layout: wide vs tabs (00 §12: the 960px exception) ──────────────────────
const NARROW_QUERY = '(max-width: 959.98px)'
const narrow = ref(typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches)
let mql: MediaQueryList | null = null
const onMedia = (e: MediaQueryListEvent) => { narrow.value = e.matches }
const tabs = computed(() => props.split && narrow.value)
const wide = computed(() => props.split && !narrow.value)
const tab = ref<Side>('editor')

const editorHidden = computed(() => tabs.value && tab.value !== 'editor')
const previewHidden = computed(() => tabs.value && tab.value !== 'preview')

/** A pane's place, read while it is still on screen: a source line, and its scroll ratio. */
interface PanePlace { line: number | null; ratio: number; top: number }
const lastTop: Record<Side, number> = { editor: 0, preview: 0 }

function placeOf(side: Side): PanePlace | null {
  if (side === 'editor') {
    const el = props.editor?.scrollElement() ?? null
    if (!visible(el)) return null
    return { line: atBottom(el) ? null : props.editor!.topLine(), ratio: scrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight), top: el.scrollTop }
  }
  if (props.html) return { line: null, ratio: props.preview?.getRatio() ?? 0, top: 0 }
  const el = props.preview?.scrollElement() ?? null
  if (!visible(el)) return null
  return { line: atBottom(el) ? null : props.preview!.lineAtOffset(el.scrollTop), ratio: scrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight), top: el.scrollTop }
}

/** Put `side` at `place` (a line when known, else the ratio: top ⇒ top, bottom ⇒ bottom). */
function applyPlace(side: Side, place: PanePlace) {
  if (side === 'preview' && props.html) { props.preview?.setRatio(place.ratio); return }
  const el = side === 'editor' ? props.editor?.scrollElement() ?? null : props.preview?.scrollElement() ?? null
  if (!visible(el)) return
  if (place.line === null || place.ratio <= 0) return setTop(side, el, ratioToScrollTop(place.ratio, el.scrollHeight, el.clientHeight))
  const top = side === 'editor' ? props.editor!.scrollTopForLine(place.line) : props.preview!.offsetForLine(place.line)
  if (top !== null) setTop(side, el, top)
}

/** A pointer click on the Edit tab puts the caret back in the editor (typing, Ctrl/Cmd+Z work at once); arrow keys keep focus on the tabs. */
function onTabClick(next: Side, e: MouseEvent) {
  selectTab(next)
  if (next === 'editor' && e.detail > 0) nextTick(() => props.editor?.focus())
}

function selectTab(next: Side) {
  if (tab.value === next) return
  const from = tab.value
  // Read the outgoing pane before it is hidden: a display:none scroller loses its offset.
  const place = placeOf(from)
  if (place) lastTop[from] = place.top
  tab.value = next
  nextTick(() => requestAnimationFrame(() => {
    if (syncOn.value && place) {
      // The newly shown pane opens where the reader was in the other one.
      applyPlace(next, place)
      return
    }
    // Sync off: the pane comes back where the reader left it.
    const el = next === 'editor' ? props.editor?.scrollElement() ?? null : props.preview?.scrollElement() ?? null
    if (visible(el)) setTop(next, el, lastTop[next])
  }))
}

function onTabKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const next: Side = tab.value === 'editor' ? 'preview' : 'editor'
  selectTab(next)
  nextTick(() => root.value?.querySelector<HTMLElement>(`[data-testid="split-tab-${next === 'editor' ? 'edit' : 'preview'}"]`)?.focus())
}

// ── Divider (rule 4) ─────────────────────────────────────────────────────────
const DIVIDER_PX = 8
const root = ref<HTMLElement | null>(null)
const ratio = ref(parseSplitRatio(readPref(SPLIT_RATIO_KEY)))
const paneWidth = ref(0)
const bounds = computed(() => splitBounds(paneWidth.value))
const effective = computed(() => clampSplit(ratio.value, bounds.value))
const dragging = ref(false)

function setRatio(next: number, persist: boolean) {
  ratio.value = clampSplit(next, bounds.value)
  if (persist) writePref(SPLIT_RATIO_KEY, String(Math.round(ratio.value * 100) / 100))
}

let drag: { id: number; x: number; start: number; width: number; moved: boolean } | null = null

function onDividerDown(e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture?.(e.pointerId)
  drag = { id: e.pointerId, x: e.clientX, start: effective.value, width: paneWidth.value, moved: false }
  dragging.value = true
}

function onDividerMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id || !(drag.width > 0)) return
  if (e.clientX !== drag.x) drag.moved = true
  setRatio(drag.start + ((e.clientX - drag.x) / drag.width) * 100, false)
}

function onDividerUp(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return
  const moved = drag.moved
  drag = null
  dragging.value = false
  // A plain click (or a double-click's first half) keeps the stored preference.
  if (moved) {
    setRatio(ratio.value, true)
    resyncAfterRender()
  }
}

function onDividerKey(e: KeyboardEvent) {
  const next = stepSplit(effective.value, e.key, bounds.value)
  if (next === null) return
  e.preventDefault()
  setRatio(next, true)
}

function resetRatio() {
  setRatio(SPLIT_DEFAULT, true)
}

let resizeObs: ResizeObserver | null = null
function measure() {
  const el = root.value
  paneWidth.value = el ? Math.max(0, el.clientWidth - DIVIDER_PX) : 0
}

// ── Synced scrolling (rules 7–11) ───────────────────────────────────────────
const syncOn = ref(parseSyncPref(readPref(SPLIT_SYNC_KEY)))

function toggleSync() {
  syncOn.value = !syncOn.value
  writePref(SPLIT_SYNC_KEY, syncOn.value ? '1' : '0')
  if (syncOn.value) scheduleSync('editor')
}

/** scrollTop values this component set, per pane: their scroll events are not echoed back (rule 10). */
const expected: Record<Side, number | null> = { editor: null, preview: null }
let queued: Side | null = null
let frame = 0

const active = () => props.split && syncOn.value

function scheduleSync(from: Side) {
  if (!active()) return
  queued = from
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; const f = queued; queued = null; if (f) syncFrom(f) })
}

function sideOf(t: EventTarget | null): Side | null {
  if (!(t instanceof HTMLElement)) return null
  if (t.classList.contains('cm-scroller')) return t.closest('[data-pane="editor"]') ? 'editor' : null
  if (t.classList.contains('preview-pane') || t.tagName === 'IFRAME') return t.closest('[data-pane="preview"]') ? 'preview' : null
  return null
}

function onScrollCapture(e: Event) {
  if (!active()) return
  const side = sideOf(e.target)
  if (!side) return
  const el = e.target as HTMLElement
  // The HTML bridge already drops the scrolls we asked for.
  if (el.tagName !== 'IFRAME') {
    const exp = expected[side]
    expected[side] = null
    if (exp !== null && Math.abs(el.scrollTop - exp) < 2) return
  }
  scheduleSync(side)
}

function visible(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.clientHeight > 0
}

function setTop(side: Side, el: HTMLElement, top: number) {
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  const next = Math.min(max, Math.max(0, top))
  if (Math.abs(el.scrollTop - next) < 1) return
  el.scrollTop = next
  expected[side] = el.scrollTop
}

const atBottom = (el: HTMLElement) => el.scrollHeight - el.clientHeight > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1

/** Align the other pane to `from` (rule 8 markdown / rule 9 HTML). */
function syncFrom(from: Side) {
  if (!active()) return
  const ed = props.editor
  const pv = props.preview
  const edEl = ed?.scrollElement() ?? null
  if (!ed || !pv || !visible(edEl)) return
  if (props.html) {
    if (previewHidden.value) return
    if (from === 'editor') pv.setRatio(scrollRatio(edEl.scrollTop, edEl.scrollHeight, edEl.clientHeight))
    else setTop('editor', edEl, ratioToScrollTop(pv.getRatio(), edEl.scrollHeight, edEl.clientHeight))
    return
  }
  const pvEl = pv.scrollElement()
  if (!visible(pvEl)) return
  const src = from === 'editor' ? edEl : pvEl
  const dst = from === 'editor' ? pvEl : edEl
  const to: Side = from === 'editor' ? 'preview' : 'editor'
  // Both ends clamp: top ⇒ top, bottom ⇒ bottom.
  if (src.scrollTop <= 0) return setTop(to, dst, 0)
  if (atBottom(src)) return setTop(to, dst, dst.scrollHeight)
  if (from === 'editor') {
    const line = ed.topLine()
    if (line !== null) setTop('preview', pvEl, pv.offsetForLine(line))
  } else {
    const top = ed.scrollTopForLine(pv.lineAtOffset(pvEl.scrollTop))
    if (top !== null) setTop('editor', edEl, top)
  }
}

/** Rule 7: after a re-render (or a reload of the HTML frame) the preview follows the editor again. */
function resyncAfterRender() {
  if (!active()) return
  nextTick(() => requestAnimationFrame(() => syncFrom('editor')))
}

function onLoadCapture(e: Event) {
  if ((e.target as HTMLElement | null)?.tagName === 'IFRAME') resyncAfterRender()
}

watch(() => props.content, resyncAfterRender)
// Entering split view, or either pane (re)mounting, aligns the preview to the editor.
watch(() => [props.split, props.editor, props.preview] as const, ([split]) => {
  if (!split) { tab.value = 'editor'; return }
  nextTick(measure)
  resyncAfterRender()
})

onMounted(() => {
  mql = window.matchMedia(NARROW_QUERY)
  narrow.value = mql.matches
  mql.addEventListener('change', onMedia)
  measure()
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    resizeObs = new ResizeObserver(() => {
      measure()
      // During a divider drag the preview reflows every frame; it re-syncs once on release.
      if (!dragging.value) resyncAfterRender()
    })
    resizeObs.observe(root.value)
  }
  root.value?.addEventListener('scroll', onScrollCapture, true)
  root.value?.addEventListener('load', onLoadCapture, true)
  if (props.split) resyncAfterRender()
})

onUnmounted(() => {
  mql?.removeEventListener('change', onMedia)
  resizeObs?.disconnect()
  root.value?.removeEventListener('scroll', onScrollCapture, true)
  root.value?.removeEventListener('load', onLoadCapture, true)
  if (frame) cancelAnimationFrame(frame)
})

const rootStyle = computed(() => (wide.value ? { '--split': String(effective.value) } : undefined))
</script>

<template>
  <div
    ref="root"
    class="panes"
    :class="{ split, wide, tabs, dragging }"
    :style="rootStyle"
    :data-testid="split ? 'split-view' : undefined"
  >
    <div v-if="tabs" class="split-tabs" role="tablist" aria-label="Split view" data-testid="split-tabs">
      <button
        id="split-tab-edit"
        type="button"
        role="tab"
        class="split-tab"
        :aria-selected="tab === 'editor' ? 'true' : 'false'"
        :tabindex="tab === 'editor' ? 0 : -1"
        aria-controls="split-pane-editor"
        data-testid="split-tab-edit"
        @click="onTabClick('editor', $event)"
        @keydown="onTabKey"
      >Edit</button>
      <button
        id="split-tab-preview"
        type="button"
        role="tab"
        class="split-tab"
        :aria-selected="tab === 'preview' ? 'true' : 'false'"
        :tabindex="tab === 'preview' ? 0 : -1"
        aria-controls="split-pane-preview"
        data-testid="split-tab-preview"
        @click="onTabClick('preview', $event)"
        @keydown="onTabKey"
      >Preview</button>
    </div>
    <!-- The divider comes before the editor in the DOM (CSS `order` draws it between the
         panes): the editor keeps Tab for indenting (#9), so forward Tab reaches it first. -->
    <div
      v-if="wide"
      class="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize editor and preview"
      aria-controls="split-pane-editor"
      tabindex="0"
      :aria-valuenow="Math.round(effective)"
      :aria-valuemin="Math.round(bounds.min)"
      :aria-valuemax="Math.round(bounds.max)"
      title="Drag to resize · double-click to reset"
      data-testid="split-divider"
      @pointerdown="onDividerDown"
      @pointermove="onDividerMove"
      @pointerup="onDividerUp"
      @pointercancel="onDividerUp"
      @lostpointercapture="onDividerUp"
      @dblclick="resetRatio"
      @keydown="onDividerKey"
    />
    <div
      id="split-pane-editor"
      class="pane pane-editor"
      :class="{ hidden: editorHidden }"
      :role="tabs ? 'tabpanel' : undefined"
      :aria-labelledby="tabs ? 'split-tab-edit' : undefined"
      data-pane="editor"
      :data-testid="split ? 'split-pane-editor' : undefined"
    >
      <slot name="editor" />
    </div>
    <div
      id="split-pane-preview"
      class="pane pane-preview"
      :class="{ hidden: previewHidden }"
      :role="tabs ? 'tabpanel' : undefined"
      :aria-labelledby="tabs ? 'split-tab-preview' : undefined"
      data-pane="preview"
      :data-testid="split ? 'split-pane-preview' : undefined"
    >
      <div v-if="split" class="split-preview-bar">
        <span class="split-preview-label">Preview</span>
        <button
          type="button"
          class="split-sync"
          :class="{ on: syncOn }"
          :aria-pressed="syncOn ? 'true' : 'false'"
          title="Keep the editor and the preview scrolled to the same place"
          data-testid="split-sync-toggle"
          @click="toggleSync"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" /></svg>
          <span>Sync scroll</span>
        </button>
      </div>
      <div class="pane-body">
        <slot name="preview" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Outside split view the wrappers take no part in layout (the old structure). */
.panes:not(.split),
.panes:not(.split) > .pane,
.panes:not(.split) .pane-body {
  display: contents;
}

.panes.split {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--bg-surface);
}

.panes.tabs {
  flex-direction: column;
}

.panes.split > .pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.panes.wide > .pane {
  min-width: 240px;
}

.panes.wide > .pane-editor {
  flex: 0 0 calc((100% - 8px) * var(--split) / 100);
}

.panes.wide > .pane-editor { order: 1; }
.panes.wide > .split-divider { order: 2; }
.panes.wide > .pane-preview { order: 3; }

.panes.split > .pane-preview {
  flex: 1 1 0;
}

.panes.tabs > .pane {
  flex: 1 1 auto;
}

.panes.split > .pane.hidden {
  display: none;
}

.panes.split > .pane-editor > :deep(*) {
  flex: 1 1 auto;
  min-height: 0;
}

.pane-body {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
}

/* The preview scrolls at the pane's edge; its reading column stays centred. */
.panes.split .pane-body > :deep(.preview-pane) {
  max-width: none;
  padding-left: max(var(--read-pad), calc((100% - var(--read-width)) / 2));
  padding-right: max(var(--read-pad), calc((100% - var(--read-width)) / 2));
}

.split-divider {
  flex: 0 0 8px;
  position: relative;
  cursor: col-resize;
  touch-action: none;
  background: var(--bg-page);
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
}

.split-divider::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 2px;
  height: 32px;
  transform: translate(-50%, -50%);
  border-radius: 1px;
  background: var(--text-muted);
  opacity: 0.5;
}

.split-divider:hover,
.panes.dragging .split-divider {
  background: var(--border);
}

.split-divider:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

/* While dragging, the panes (and the HTML iframe) must not eat the pointer. */
.panes.dragging {
  cursor: col-resize;
  user-select: none;
}

.panes.dragging > .pane {
  pointer-events: none;
}

.split-preview-bar {
  flex: 0 0 36px;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--text-muted);
}

.split-preview-label {
  flex: 1;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}

.split-sync {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  cursor: pointer;
}

.split-sync.on {
  color: var(--text-primary);
  background: var(--bg-page);
  border-color: var(--accent);
}

.split-sync:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.split-tabs {
  flex: 0 0 auto;
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
}

.split-tab {
  flex: 1;
  min-height: 40px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-size: 14px;
  cursor: pointer;
}

.split-tab[aria-selected='true'] {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.split-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
</style>
