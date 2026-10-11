<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { FONT_SCALES, DEFAULT_READER_PREFS, useReaderPrefs, type ReaderWidth } from '@/composables/useReaderPrefs'

// Reading settings (#18 rules 7–11): "Aa" in the header (after the Style
// trigger, never `.btn-icon` — 00 §2.1) opens a non-modal panel with text size
// and width. On a phone the control is an item of the overflow menu (00 §2.2)
// and the panel opens as a full-width sheet; then `sheet` is set and only the
// panel renders here; the menu item opens it with a window event
// (`md-review:reader-settings`). Lazy-loaded by DocHeader (off the #6 entry budget).
const props = defineProps<{
  /** Phone: no bar button; the overflow menu opens the panel as a sheet. */
  sheet?: boolean
  /** HTML document: the controls are shown disabled with a note (rule 11). */
  html?: boolean
}>()

const prefs = useReaderPrefs()
const { fontScale, width } = prefs
const open = ref(false)
const btnRef = ref<HTMLButtonElement>()
const panelRef = ref<HTMLElement>()

const MIN = FONT_SCALES[0]
const MAX = FONT_SCALES[FONT_SCALES.length - 1]
const atMin = computed(() => props.html || fontScale.value <= MIN)
const atMax = computed(() => props.html || fontScale.value >= MAX)
const atDefault = computed(() => props.html || fontScale.value === DEFAULT_READER_PREFS.fontScale)

/** Where focus goes back on close: the bar button, or the overflow trigger on a phone. */
function returnFocus() {
  const target = btnRef.value ?? document.querySelector<HTMLElement>('[data-testid="header-overflow-btn"]')
  target?.focus()
}

function close(focusBack = false) {
  if (!open.value) return
  open.value = false
  if (focusBack) returnFocus()
}

function toggle() {
  open.value = !open.value
}

/** Rule 9: the first enabled control, or the panel itself when all are disabled (HTML docs). */
function focusFirst() {
  const panel = panelRef.value
  if (!panel) return
  const first = panel.querySelector<HTMLButtonElement>('button:not(:disabled)')
  ;(first ?? panel).focus()
}

const KEEP_OPEN = '[data-testid="header-overflow-menu"], [data-testid="theme-toggle"]'

function onOutside(e: Event) {
  const t = e.target as Node | null
  if (t && (panelRef.value?.contains(t) || btnRef.value?.contains(t))) return
  // The overflow item that opens the sheet is a click on the menu; the light/dark
  // toggle restyles the open panel in place (spec edge case). Neither closes it.
  if (t instanceof Element && t.closest(KEEP_OPEN)) return
  close()
}

const openFromMenu = () => { open.value = true }
onMounted(() => window.addEventListener('md-review:reader-settings', openFromMenu))

watch(open, async (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onOutside, true)
    await nextTick()
    focusFirst()
  } else {
    document.removeEventListener('pointerdown', onOutside, true)
  }
}, { immediate: true })
onUnmounted(() => {
  document.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('md-review:reader-settings', openFromMenu)
})

function onKeydown(e: KeyboardEvent) {
  if (!open.value || e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
  // 00 §3.4 layer 3: one Esc closes this panel and goes no further.
  e.preventDefault()
  e.stopPropagation()
  close(true)
}

/** Tabbing out of the panel closes it (a control that just got disabled drops focus to null: stay open). */
function onFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  // Back to the bar button: its own click toggles (closing here would reopen on that click).
  if (!next || panelRef.value?.contains(next) || btnRef.value?.contains(next)) return
  if (next instanceof Element && next.closest(KEEP_OPEN)) return
  close()
}

/**
 * Rule 6 / AC-18.13: a change keeps the reading position by proportion — the
 * window in the read view's document scroll, the preview pane in split view.
 * The prefs land on <html> synchronously, so the new layout is measurable at once.
 */
function keepPosition(change: () => void) {
  const scrollers = [document.scrollingElement, ...document.querySelectorAll('.preview-pane')]
    .filter((el): el is Element => !!el && el.scrollTop > 0 && el.scrollHeight > el.clientHeight)
  const kept = scrollers.map((el) => [el, el.scrollTop / (el.scrollHeight - el.clientHeight)] as const)
  change()
  for (const [el, ratio] of kept) el.scrollTop = Math.round(ratio * (el.scrollHeight - el.clientHeight))
}

/** A+/A− that reaches its end disables itself: keep keyboard focus inside the panel. */
async function step(fn: () => void) {
  keepPosition(fn)
  await nextTick()
  const panel = panelRef.value
  if (panel && open.value && !panel.contains(document.activeElement)) focusFirst()
}

function setWidth(w: ReaderWidth) {
  keepPosition(() => prefs.setWidth(w))
}
</script>

<template>
  <div class="reader-settings" :class="{ 'is-sheet': sheet }">
    <button
      v-if="!sheet"
      ref="btnRef"
      type="button"
      class="reader-settings-btn"
      title="Reading settings"
      aria-label="Reading settings"
      aria-haspopup="dialog"
      :aria-expanded="open ? 'true' : 'false'"
      data-testid="reader-settings-btn"
      @click="toggle"
      @keydown="onKeydown"
    >Aa</button>
    <div
      v-if="open"
      ref="panelRef"
      class="reader-panel"
      :class="{ 'reader-sheet': sheet }"
      role="dialog"
      aria-label="Reading settings"
      tabindex="-1"
      data-testid="reader-settings-panel"
      @keydown="onKeydown"
      @focusout="onFocusOut"
    >
      <div id="reader-size-label" class="reader-label">Text size</div>
      <div class="reader-row" role="group" aria-labelledby="reader-size-label">
        <button type="button" class="reader-ctl" aria-label="Decrease text size" data-testid="font-decrease" :disabled="atMin" @click="step(prefs.decrease)">A−</button>
        <span class="reader-value" aria-live="polite" data-testid="font-size-value">{{ fontScale }}%</span>
        <button type="button" class="reader-ctl" aria-label="Increase text size" data-testid="font-increase" :disabled="atMax" @click="step(prefs.increase)">A+</button>
        <button type="button" class="reader-ctl reader-reset" aria-label="Reset text size" data-testid="font-reset" :disabled="atDefault" @click="step(prefs.reset)">Reset</button>
      </div>
      <div id="reader-width-label" class="reader-label">Width</div>
      <div class="reader-row" role="group" aria-labelledby="reader-width-label">
        <button type="button" class="reader-ctl reader-toggle" data-testid="width-narrow" :aria-pressed="width === 'narrow' ? 'true' : 'false'" :disabled="html" @click="setWidth('narrow')">Narrow</button>
        <button type="button" class="reader-ctl reader-toggle" data-testid="width-wide" :aria-pressed="width === 'wide' ? 'true' : 'false'" :disabled="html" @click="setWidth('wide')">Wide</button>
      </div>
      <p v-if="html" class="reader-note" data-testid="reader-settings-note">Text size and width apply to Markdown documents.</p>
    </div>
  </div>
</template>

<style scoped>
.reader-settings {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

.reader-settings.is-sheet {
  display: contents;
}

.reader-settings-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  min-width: 32px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: opacity 0.15s;
}

.reader-settings-btn:hover {
  opacity: 0.7;
}

.reader-settings-btn:focus-visible,
.reader-ctl:focus-visible,
.reader-panel:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.reader-panel {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 200;
  width: 268px;
  max-width: calc(100vw - 16px);
  padding: 10px 12px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 13px;
  text-align: left;
}

/* Phone (#5 rule 7): a full-width sheet under the doc header. */
.reader-panel.reader-sheet {
  position: fixed;
  top: var(--header-h);
  left: 0;
  right: 0;
  width: auto;
  max-width: none;
  border-left: 0;
  border-right: 0;
  border-radius: 0 0 8px 8px;
  padding: 12px 16px 16px;
}

.reader-label {
  margin: 2px 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.reader-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}

.reader-ctl {
  min-width: 36px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.reader-ctl:hover:not(:disabled) {
  background: var(--bg-page);
}

.reader-ctl:disabled {
  opacity: 0.45;
  cursor: default;
}

.reader-value {
  min-width: 48px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.reader-reset {
  margin-left: auto;
  font-weight: 500;
}

.reader-toggle {
  flex: 1 1 0;
}

.reader-toggle[aria-pressed='true'] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface));
}

.reader-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-secondary);
}

.reader-sheet .reader-ctl {
  min-height: 44px;
}

.reader-sheet .reader-row {
  margin-bottom: 12px;
}
</style>
