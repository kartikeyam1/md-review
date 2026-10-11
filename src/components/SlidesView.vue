<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useDocState } from '@/composables/useDocState'
import { splitSlides, slideForHeading, clampSlide } from '@/composables/useSlides'
import { decodeFragment, encodeFragment } from '@/composables/useRouter'
import { isGithub } from '@/composables/useTheme'
import { mermaidConfigFor, mermaidJob } from '@/preview/mermaidTheme'
import { codeCopy } from '@/preview/codeCopy'
import { zoom } from '@/preview/zoom'
import type { EnhancerContext } from '@/preview/enhancers'
import { copyText } from '@/composables/useCopyLink'
import { toast } from '@/composables/useToast'
import '@/styles/preview.css'

// Slides view (spec #29): the doc as a deck — every top-level H1/H2/`---`
// starts a slide (useSlides.ts), shown on a fixed 1280×720 canvas scaled to the
// viewport. Lazy: DocView loads this chunk only for ?view=slides. The canvas
// renders every slide (only the current one visible and in the accessibility
// tree) so diagrams lay out, fit is measured once, and print emits all of them.

const CANVAS_W = 1280
const CANVAS_H = 720
/** Rule 7: overflow shrinks the type down to 70%, then the slide scrolls. */
const FIT_MIN = 0.7
const FIT_STEP = 0.05
const NOTES_KEY = 'md-review-slides-notes'
const CHROME_IDLE_MS = 3000

const doc = useDocState()
const { router, markdown, theme } = doc

const slides = computed(() => splitSlides(markdown.value))
const total = computed(() => slides.value.length)

// ── Current slide (rule 12) ──────────────────────────────────────────────────
function initialIndex(): number {
  const raw = router.query('slide')
  if (raw === null) {
    const frag = router.current.value.fragment
    const at = frag ? slideForHeading(slides.value, frag) : -1
    if (at >= 0) return at
  }
  return clampSlide(raw, total.value) - 1
}
const index = ref(initialIndex())
// Rule 19: a live update keeps the index, clamped (and the deep link follows).
watch(total, (t) => {
  if (index.value > t - 1) {
    index.value = Math.max(0, t - 1)
    writeSlideParam(index.value + 1)
  }
})

/** Every navigation writes `slide` with replaceState; the first one also drops the fragment. */
function writeSlideParam(n: number) {
  const l = window.location
  const params = new URLSearchParams(l.search)
  params.set('slide', String(n))
  router.replace(`${l.pathname}?${params.toString()}`)
}

// An invalid or out-of-range `?slide=` is rewritten to the slide shown (replaceState).
{
  const raw = router.query('slide')
  if (raw !== null && raw !== String(index.value + 1)) writeSlideParam(index.value + 1)
}

function go(i: number) {
  const next = Math.min(Math.max(0, i), total.value - 1)
  if (next === index.value) return
  index.value = next
  writeSlideParam(next + 1)
  hintDismissed.value = hintDismissed.value || next > 0
}
const next = () => go(index.value + 1)
const prev = () => go(index.value - 1)

const announce = computed(() => {
  const s = slides.value[index.value]
  return `Slide ${index.value + 1} of ${total.value}${s?.headingText ? `: ${s.headingText}` : ''}`
})

// ── Exit (rule 14) ───────────────────────────────────────────────────────────
/** Back to the read view: `view` and `slide` removed, the fragment set to the slide's heading (the read view scrolls to it). */
function exit() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  const headingId = slides.value[index.value]?.headingId ?? null
  const l = window.location
  const params = new URLSearchParams(l.search)
  params.delete('view')
  params.delete('slide')
  const qs = params.toString()
  doc.readerView.value = 'read'
  router.replace(`${l.pathname}${qs ? `?${qs}` : ''}${encodeFragment(headingId ?? '')}`)
  // Keyboard focus lands on Present (or the overflow menu that holds it) once the header is back.
  let tries = 0
  const refocus = () => {
    // Present is in the bar from 1100px (00 §2.2), in the overflow menu below.
    const sel = window.innerWidth >= 1100 ? '[data-testid="slides-enter-btn"]' : '[data-testid="header-overflow-btn"]'
    const btn = document.querySelector<HTMLElement>(sel)
    if (btn) btn.focus({ preventScroll: true })
    else if (++tries < 120) requestAnimationFrame(refocus)
  }
  requestAnimationFrame(refocus)
}

// ── Notes panel (rule 15) ────────────────────────────────────────────────────
function readNotesPref(): boolean {
  try { return localStorage.getItem(NOTES_KEY) === '1' } catch { return false }
}
const notesOpen = ref(readNotesPref())
function toggleNotes() {
  notesOpen.value = !notesOpen.value
  try {
    if (notesOpen.value) localStorage.setItem(NOTES_KEY, '1')
    else localStorage.removeItem(NOTES_KEY)
  } catch { /* storage unavailable: the choice lasts for this page */ }
}

// ── Fullscreen (rule 13) and the auto-hiding chrome (rule 11) ────────────────
const rootRef = ref<HTMLElement | null>(null)
const fullscreenOk = typeof document !== 'undefined' && !!document.fullscreenEnabled
const isFullscreen = ref(false)
function toggleFullscreen() {
  if (!fullscreenOk) return
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void rootRef.value?.requestFullscreen().catch(() => {})
}
const chromeHidden = ref(false)
/** A short viewport (a landscape phone): the controls float over the slide so the canvas fills the height (rule 17). */
const compact = ref(typeof window !== 'undefined' && window.innerHeight < 500)
let idleTimer: ReturnType<typeof setTimeout> | null = null
function wake() {
  chromeHidden.value = false
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = isFullscreen.value || compact.value ? setTimeout(() => { chromeHidden.value = true }, CHROME_IDLE_MS) : null
}
function onFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === rootRef.value && !!rootRef.value
  wake()
}

// ── Rotate hint (rule 17) ────────────────────────────────────────────────────
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const portrait = ref(typeof window !== 'undefined' && window.innerHeight > window.innerWidth)
const hintDismissed = ref(false)
const hintShown = computed(() => coarse && portrait.value && index.value === 0 && !hintDismissed.value)

// ── Canvas scale (rule 6) ────────────────────────────────────────────────────
const stageRef = ref<HTMLElement | null>(null)
const scale = ref(1)
let resizeObs: ResizeObserver | null = null
function measureStage() {
  const el = stageRef.value
  if (!el) return
  const w = el.clientWidth
  const h = el.clientHeight
  if (w > 0 && h > 0) scale.value = Math.min(w / CANVAS_W, h / CANVAS_H)
  portrait.value = window.innerHeight > window.innerWidth
  const short = window.innerHeight < 500
  if (short !== compact.value) { compact.value = short; wake() }
}
const boxStyle = computed(() => ({ width: `${CANVAS_W * scale.value}px`, height: `${CANVAS_H * scale.value}px` }))
const canvasStyle = computed(() => ({ transform: `scale(${scale.value})` }))

// ── Keyboard (rule 9, 00 §3.5) ───────────────────────────────────────────────
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return
  if (document.querySelector('[data-testid="zoom-viewer"]')) return // #15 owns the keys while open
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const target = e.target as HTMLElement | null
  if (target?.closest?.(EDITABLE)) return
  const onControl = !!target?.closest?.('a[href], button, summary, [role="button"]')
  const k = e.key
  let handled = true
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') next()
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') prev()
  else if (k === ' ' || k === 'Enter') {
    if (onControl) return // Space/Enter activate the focused link or button
    if (k === ' ' && e.shiftKey) prev()
    else next()
  } else if (k === 'Home') go(0)
  else if (k === 'End') go(total.value - 1)
  else if (k === 'f' || k === 'F') { if (fullscreenOk) toggleFullscreen(); else handled = false }
  else if (k === 'n' || k === 'N') toggleNotes()
  else if (k === 'Escape') {
    // In fullscreen the browser's Esc only leaves fullscreen (00 §3.4 layer 9).
    if (document.fullscreenElement) return
    exit()
  } else handled = false
  if (handled) e.preventDefault()
}

// ── Pointer (rule 10) ────────────────────────────────────────────────────────
const canvasRef = ref<HTMLElement | null>(null)
const NO_NAV = 'a[href], button, input, textarea, select, summary, label, [data-zoomable], [data-testid="zoom-trigger"], pre, [data-testid="code-block"], [role="button"]'
let swipedAt = 0
function onCanvasClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || Date.now() - swipedAt < 500) return
  // An in-doc link (`#heading`) goes to the slide holding that heading.
  const a = (e.target as Element | null)?.closest?.('a[href^="#"]')
  if (a && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
    const at = slideForHeading(slides.value, decodeFragment(a.getAttribute('href') ?? ''))
    e.preventDefault()
    if (at >= 0) go(at)
    return
  }
  if ((e.target as Element | null)?.closest?.(NO_NAV)) return
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.toString().trim()) return // the click ended a text selection
  const r = canvasRef.value?.getBoundingClientRect()
  if (!r || r.width === 0) return
  if (e.clientX - r.left >= r.width / 2) next()
  else prev()
}
let touch: { x: number; y: number; lx: number; ly: number } | null = null
/** A touch that starts in content that scrolls sideways (a wide table or code line) is that content's, not a swipe. */
function inSideScroller(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== canvasRef.value; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') return true
  }
  return false
}
function onTouchStart(e: TouchEvent) {
  wake()
  const t = e.touches[0]
  touch = e.touches.length === 1 && t && !inSideScroller(e.target) ? { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY } : null
}
function onTouchMove(e: TouchEvent) {
  const t = e.touches[0]
  if (touch && t) { touch.lx = t.clientX; touch.ly = t.clientY }
}
function onTouchEnd(e: TouchEvent) {
  if (!touch) return
  const t = e.changedTouches[0]
  const dx = (t ? t.clientX : touch.lx) - touch.x
  const dy = (t ? t.clientY : touch.ly) - touch.y
  touch = null
  if (Math.abs(dx) >= 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
    swipedAt = Date.now()
    if (dx < 0) next()
    else prev()
  }
}

// ── Rendered content: enhancers, diagrams, fit (rules 7, 8) ─────────────────
const slideEls = ref<HTMLElement[]>([])
const githubClass = computed(() => isGithub(theme.value ?? 'light'))
const enhancerCtx: EnhancerContext = {
  headings: [], docState: doc, router, toast, copyText,
  copySectionLink: () => {},
}
let cleanups: (() => void)[] = []

/** Rule 8: collapsible sections render expanded, with no fold controls (the summary cannot close them). */
function expandDetails(root: HTMLElement) {
  for (const d of root.querySelectorAll('details')) {
    d.open = true
    d.addEventListener('toggle', () => { if (!d.open) d.open = true })
    for (const s of d.querySelectorAll(':scope > summary')) s.setAttribute('tabindex', '-1')
  }
}

/**
 * Diagrams fit the slide: never wider than the body, never taller than the
 * room left under what precedes them, never upscaled past mermaid's own size.
 * Logical (unscaled) canvas pixels, so it holds for every screen and in print.
 */
function sizeDiagrams(el: HTMLElement) {
  const k = scale.value || 1
  const slideTop = el.getBoundingClientRect().top
  const cs = getComputedStyle(el)
  const bottomPad = parseFloat(cs.paddingBottom) || 0
  const bodyW = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
  for (const svg of el.querySelectorAll<SVGSVGElement>('.mermaid > svg')) {
    const vb = svg.viewBox?.baseVal
    if (!vb || !vb.width || !vb.height) continue
    const natural = svg.dataset.naturalWidth ? Number(svg.dataset.naturalWidth) : (parseFloat(svg.style.maxWidth) || vb.width)
    svg.dataset.naturalWidth = String(natural)
    const top = (svg.getBoundingClientRect().top - slideTop) / k + el.scrollTop
    const room = CANVAS_H - top - bottomPad
    const height = room >= 160 ? room : CANVAS_H * 0.6
    const width = Math.max(40, Math.min(natural, bodyW, height * (vb.width / vb.height)))
    svg.style.maxWidth = 'none'
    svg.style.width = `${Math.floor(width)}px`
    svg.style.height = 'auto'
  }
}

/** Rule 7: step the type down until the slide fits (≥ 70%); beyond that it scrolls. */
function fit(el: HTMLElement) {
  let f = 1
  el.style.setProperty('--fit', '1')
  sizeDiagrams(el)
  while (el.scrollHeight > el.clientHeight + 1 && f - FIT_STEP >= FIT_MIN - 1e-9) {
    f = Math.round((f - FIT_STEP) * 100) / 100
    el.style.setProperty('--fit', String(f))
    sizeDiagrams(el)
  }
}
/** What each slide was last fitted for: a slide is re-measured only when its content or the theme changed. */
const fittedFor = new WeakMap<HTMLElement, string>()
function fitChanged(force = false) {
  slides.value.forEach((s, i) => {
    const el = slideEls.value.find((e) => Number(e.dataset.slideIndex) === i)
    if (!el?.isConnected) return
    const key = `${theme.value}|${s.html}|${el.querySelectorAll('.mermaid > svg').length}`
    if (!force && fittedFor.get(el) === key) return
    fit(el)
    fittedFor.set(el, key)
  })
}
const fitAll = () => fitChanged(true)

type MermaidApi = typeof import('mermaid')['default']
let mermaid: Promise<MermaidApi> | null = null
async function renderDiagrams() {
  const nodes = slideEls.value.flatMap((el) => [...el.querySelectorAll<HTMLElement>('.mermaid')])
  if (!nodes.length) return
  const api = await (mermaid ??= import('mermaid').then((m) => m.default))
  const config = mermaidConfigFor(theme.value ?? 'light')
  const key = JSON.stringify(config)
  await mermaidJob(async () => {
    api.initialize({ startOnLoad: false, ...config })
    // The current slide first, so the diagram on screen is never the last to draw.
    const cur = slideEls.value[index.value]
    const ordered = [...nodes].sort((a, b) => Number(!cur?.contains(a)) - Number(!cur?.contains(b)))
    for (const node of ordered) {
      if (!node.isConnected || node.dataset.renderedKey === key) continue
      node.dataset.source ??= node.textContent ?? ''
      try {
        const { svg, bindFunctions } = await api.render(`slides-mermaid-${Math.random().toString(36).slice(2)}`, node.dataset.source)
        if (!node.isConnected) continue
        node.innerHTML = svg
        bindFunctions?.(node)
        node.dataset.renderedKey = key
        const host = node.closest<HTMLElement>('.slide')
        if (host) fittedFor.delete(host)
      } catch (err) {
        const msg = document.createElement('pre')
        msg.className = 'mermaid-error'
        msg.textContent = `Diagram error: ${err instanceof Error ? err.message : String(err)}`
        node.replaceChildren(msg)
        delete node.dataset.renderedKey
      }
    }
  })
  fitChanged()
}

async function enhance() {
  await nextTick()
  for (const c of cleanups) c()
  cleanups = []
  for (const el of slideEls.value) {
    expandDetails(el)
    for (const run of [codeCopy, zoom]) {
      const c = run(el, enhancerCtx)
      if (typeof c === 'function') cleanups.push(c)
    }
    for (const img of el.querySelectorAll('img')) if (!img.complete) img.addEventListener('load', () => fit(el), { once: true })
  }
  fitChanged()
  void renderDiagrams()
}
watch(slides, () => { void enhance() })
watch(theme, () => { void nextTick(() => { void renderDiagrams(); fitAll() }) })

// ── Print (rule 18): one 13.333in × 7.5in page per slide, only from this view ─
let pageStyle: HTMLStyleElement | null = null

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  window.addEventListener('resize', measureStage)
  if (stageRef.value && typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => measureStage())
    resizeObs.observe(stageRef.value)
  }
  measureStage()
  pageStyle = document.createElement('style')
  pageStyle.dataset.mdReview = 'slides-page'
  pageStyle.textContent = '@media print { @page { size: 13.333in 7.5in; margin: 0; } }'
  document.head.appendChild(pageStyle)
  void enhance()
  void document.fonts?.ready.then(() => fitAll())
  // Keyboard focus starts on the deck (not on a button that would eat Space/Enter).
  rootRef.value?.focus({ preventScroll: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.removeEventListener('resize', measureStage)
  resizeObs?.disconnect()
  pageStyle?.remove()
  if (idleTimer) clearTimeout(idleTimer)
  for (const c of cleanups) c()
  if (document.fullscreenElement === rootRef.value) void document.exitFullscreen().catch(() => {})
})

const progressStyle = computed(() => ({ width: `${((index.value + 1) / total.value) * 100}%` }))
const currentNotes = computed(() => slides.value[index.value]?.notesHtml ?? '')
</script>

<template>
  <div
    ref="rootRef"
    class="slides-root"
    :class="{ 'chrome-hidden': chromeHidden, fullscreen: isFullscreen, compact }"
    data-testid="slides-root"
    tabindex="-1"
    aria-label="Slides"
    role="region"
    @mousemove="wake"
    @pointerdown="wake"
  >
    <div
      class="slides-progress"
      data-testid="slides-progress"
      role="progressbar"
      aria-label="Slide progress"
      aria-valuemin="1"
      :aria-valuenow="index + 1"
      :aria-valuemax="total"
    ><div class="slides-progress-bar" :style="progressStyle"></div></div>

    <div
      ref="stageRef"
      class="slides-stage"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend="onTouchEnd"
    >
      <div class="slides-box" :style="boxStyle">
        <div ref="canvasRef" class="slides-canvas" data-testid="slides-canvas" :style="canvasStyle" @click="onCanvasClick">
          <section
            v-for="(s, i) in slides"
            :key="s.headingId ? `h:${s.headingId}` : `i:${i}`"
            ref="slideEls"
            class="slide preview-pane"
            :class="{ current: i === index, 'markdown-body': githubClass, 'github-mode': githubClass }"
            data-testid="slides-slide"
            :data-slide-index="i"
            :data-slide-kind="s.kind"
            :role="i === index ? 'group' : undefined"
            :aria-roledescription="i === index ? 'slide' : undefined"
            :aria-label="i === index ? `Slide ${i + 1} of ${total}` : undefined"
            :aria-hidden="i === index ? undefined : 'true'"
            :inert="i === index ? undefined : true"
            v-html="s.html"
          />
        </div>
      </div>
      <div v-if="hintShown" class="slides-rotate-hint" data-testid="slides-rotate-hint" role="status">
        <span>Rotate for a larger slide</span>
        <button type="button" class="slides-hint-close" aria-label="Dismiss" @click="hintDismissed = true">×</button>
      </div>
    </div>

    <div v-if="notesOpen" class="slides-notes" data-testid="slides-notes" aria-label="Speaker notes" role="note">
      <div v-if="currentNotes" class="slides-notes-body preview-pane" v-html="currentNotes" />
      <p v-else class="slides-notes-empty">No notes for this slide.</p>
    </div>

    <div class="slides-controls">
      <button type="button" class="slides-btn" data-testid="slides-exit" aria-label="Exit slides" title="Exit (Esc)" @click="exit">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
      <span class="slides-spacer"></span>
      <button type="button" class="slides-btn" data-testid="slides-prev" aria-label="Previous slide" :disabled="index === 0" @click="prev">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <span class="slides-counter" data-testid="slides-counter">{{ index + 1 }} / {{ total }}</span>
      <button type="button" class="slides-btn" data-testid="slides-next" aria-label="Next slide" :disabled="index >= total - 1" @click="next">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
      </button>
      <span class="slides-spacer"></span>
      <button type="button" class="slides-btn" data-testid="slides-notes-btn" :aria-pressed="notesOpen ? 'true' : 'false'" aria-label="Speaker notes" title="Speaker notes (N)" @click="toggleNotes">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v12H8l-4 4z" /><path d="M8 9h8M8 12h5" /></svg>
      </button>
      <button v-if="fullscreenOk" type="button" class="slides-btn" data-testid="slides-fullscreen-btn" :aria-pressed="isFullscreen ? 'true' : 'false'" aria-label="Full screen" title="Full screen (F)" @click="toggleFullscreen">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
      </button>
    </div>

    <div class="slides-live" aria-live="polite">{{ announce }}</div>
  </div>
</template>

<style scoped>
.slides-root {
  position: fixed;
  inset: 0;
  z-index: 350; /* 00 §3.7 */
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
  color: var(--text-primary);
  outline: none;
}

.slides-progress {
  flex: none;
  height: 4px;
  background: color-mix(in srgb, var(--border) 60%, transparent);
}

.slides-progress-bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}

.slides-stage {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.slides-box {
  position: relative;
  flex: none;
}

.slides-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 1280px;
  height: 720px;
  transform-origin: 0 0;
}

.slides-rotate-hint {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
  box-shadow: 0 2px 8px var(--shadow-color);
}

.slides-hint-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.slides-notes {
  flex: none;
  max-height: 28vh;
  overflow-y: auto;
  padding: 10px 20px;
  border-top: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-primary);
}

.slides-notes-empty {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
}

.slides-controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-surface);
  transition: opacity 0.3s ease;
}

/* A short viewport (landscape phone): the controls float over the slide; they hide after 3 s idle. */
.slides-root.compact .slides-controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
}

.slides-root.compact .slides-progress {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1;
}

.slides-root.chrome-hidden {
  cursor: none;
}

.slides-root.chrome-hidden .slides-controls,
.slides-root.chrome-hidden .slides-progress {
  opacity: 0;
  pointer-events: none;
}

.slides-spacer {
  flex: 1;
}

/* Rule 20: the polite announcement is for screen readers only. */
.slides-live {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.slides-counter {
  min-width: 64px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  color: var(--text-secondary);
}

.slides-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
}

.slides-btn:hover:not(:disabled) {
  border-color: var(--accent);
}

.slides-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.slides-btn[aria-pressed='true'] {
  border-color: var(--accent);
  color: var(--accent-text);
}

.slides-btn:focus-visible,
.slides-hint-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .slides-progress-bar,
  .slides-controls {
    transition: none;
  }
}
</style>

<style>
/* Slides content (rules 4, 6–8, 16). Each slide is a .preview-pane so the read
   view's typography, code, tables and callouts apply; --rpx (the preview's
   type unit) is scaled up for the 1280×720 canvas and down by --fit. */
.slides-root .slide.preview-pane {
  --rpx: calc(1.6px * var(--fit, 1));
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  max-width: none;
  height: 720px;
  margin: 0;
  padding: 56px 80px;
  overflow: auto;
  visibility: hidden;
  background: var(--bg-surface);
  color: var(--text-primary);
}

.slides-root .slide.preview-pane.current {
  visibility: visible;
}

/* A slide's box never depends on its content: keep each one's layout and paint to itself. */
.slides-root .slide.preview-pane {
  contain: strict;
}

/* Rule 8: <details> are shown open, with no disclosure control. */
.slides-root .slide.preview-pane summary {
  pointer-events: none;
  list-style: none;
  cursor: default;
}

.slides-root .slide.preview-pane summary::-webkit-details-marker {
  display: none;
}

.slides-root .slide.preview-pane summary::marker,
.slides-root .slide.preview-pane summary::before,
.slides-root .slide.preview-pane summary::after {
  content: none;
}

.slides-root .slide.preview-pane > :first-child {
  margin-top: 0;
}

/* Rule 4: a title slide centres its content; the H1 is large. */
.slides-root .slide.preview-pane[data-slide-kind='title'] {
  display: flex;
  flex-direction: column;
  justify-content: safe center;
  align-items: center;
  text-align: center;
  background: var(--slide-title-bg);
  color: var(--slide-title-fg);
}

.slides-root .slide.preview-pane[data-slide-kind='title'] > * {
  max-width: 100%;
}

.slides-root .slide.preview-pane[data-slide-kind='title'] h1 {
  font-family: var(--font-heading);
  font-size: calc(44 * var(--rpx));
  line-height: 1.15;
  border: none;
  margin: 0 0 0.4em;
  padding: 0;
  color: var(--slide-title-fg);
}

.slides-root .slide.preview-pane[data-slide-kind='title'] :is(p, li) {
  color: var(--slide-title-fg);
}

/* Content slides: the slide's heading at the top left, larger than the read view's. */
.slides-root .slide.preview-pane[data-slide-kind='content'] > h2:first-child {
  margin: 0 0 0.6em;
  font-size: calc(30 * var(--rpx));
  line-height: 1.2;
}

.slides-root .slide.preview-pane[data-slide-kind='content'] h3 {
  font-size: calc(21 * var(--rpx));
}

/* Rule 8: the folding enhancer never runs here; anchors are not added either. */
.slides-root .slide.preview-pane .mermaid {
  display: flex;
  justify-content: center;
}

.slides-notes-body.preview-pane {
  max-width: none;
  height: auto;
  margin: 0;
  padding: 0;
  overflow: visible;
  background: transparent;
}

/* Rule 18: print every slide, one per 13.333in × 7.5in page (the page size is
   set by SlidesView while it is mounted), no chrome, backgrounds kept. #5's
   read-view print rules do not reach this layout. */
@media print {
  .app[data-view='slides'] .slides-root {
    position: static;
    display: block;
    background: none;
  }

  .app[data-view='slides'] :is(.slides-progress, .slides-controls, .slides-counter, .slides-btn, .slides-notes, .slides-rotate-hint, .slides-live) {
    display: none !important;
  }

  .app[data-view='slides'] .slides-stage {
    display: block;
    overflow: visible;
  }

  .app[data-view='slides'] .slides-box {
    width: auto !important;
    height: auto !important;
  }

  .app[data-view='slides'] .slides-canvas {
    position: static;
    width: auto;
    height: auto;
    transform: none !important;
  }

  .app[data-view='slides'] .slides-root .slide.preview-pane {
    position: relative;
    inset: auto;
    width: 1280px;
    height: 720px !important;
    overflow: hidden !important;
    visibility: visible;
    padding: 56px 80px;
    break-after: page;
    break-inside: avoid;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  /* #5 prints each external link's URL after it; on a fixed-size slide that only clips content. */
  .app[data-view='slides'] .slides-root .slide.preview-pane a::after {
    content: none !important;
  }

  /* Mermaid's tooltip lives under <body>; in the deck's print it would add a blank page. */
  body:has(.app[data-view='slides']) .mermaidTooltip {
    display: none !important;
  }

  /* A forced break after the final slide prints a blank last page (Chromium): one page per slide. */
  .app[data-view='slides'] .slides-root .slide.preview-pane:last-child {
    break-after: auto;
  }

  .app[data-view='slides'] .slides-root .slide.preview-pane[data-slide-kind='title'] {
    display: flex;
    /* #5's print sheet paints every .preview-pane white; the title slide keeps its colours. */
    background: var(--slide-title-bg) !important;
  }

  .app[data-view='slides'] .slides-root .slide.preview-pane[data-slide-kind='title'] :is(h1, p, li) {
    color: var(--slide-title-fg) !important;
  }
}
</style>
