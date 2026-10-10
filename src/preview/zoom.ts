import { createApp, type App } from 'vue'
import type { Enhancer } from './enhancers'
import type { Size } from '@/composables/useZoomPan'

// Spec #15 rules 1–3, 12, 16: marks rendered mermaid diagrams and eligible
// images as zoom triggers and opens the full-screen viewer (ZoomViewer.vue,
// loaded on first use) with a snapshot of the clicked one. Diagrams render
// after the enhancers run, so a MutationObserver marks them as their SVG lands.

const TRIGGER = '[data-testid="zoom-trigger"]'
const MIN_IMAGE = 48
/** Images whose load listener is attached (scan() runs on every mutation batch). */
const pendingImages = new WeakSet<HTMLImageElement>()

let current: { app: App; host: HTMLElement; trigger: HTMLElement; index: number; scrollY: number; overflow: string } | null = null

/** The trigger to give focus back to: the one that opened the viewer, or — re-rendered meanwhile — the same-index one. */
function returnTarget(c: NonNullable<typeof current>): HTMLElement | null {
  if (c.trigger.isConnected) return c.trigger
  return document.querySelectorAll<HTMLElement>(`.preview-pane ${TRIGGER}`)[c.index] ?? null
}

function markMermaid(node: HTMLElement) {
  const ok = !!node.querySelector(':scope > svg') && !node.querySelector('.mermaid-error')
  if (ok) {
    if (node.dataset.zoomable === 'mermaid') return
    node.dataset.zoomable = 'mermaid'
    node.dataset.testid = 'zoom-trigger'
    node.tabIndex = 0
    node.setAttribute('role', 'button')
    node.setAttribute('aria-label', 'Open diagram full screen')
  } else if (node.dataset.zoomable) unmark(node)
}

function unmark(el: HTMLElement) {
  delete el.dataset.zoomable
  delete el.dataset.testid
  el.removeAttribute('tabindex')
  el.removeAttribute('role')
  el.removeAttribute('aria-label')
}

function imageEligible(img: HTMLImageElement): boolean {
  if (img.closest('a[href]')) return false
  if (!img.complete || img.naturalWidth === 0) return false
  return img.naturalWidth >= MIN_IMAGE || img.naturalHeight >= MIN_IMAGE
}

function markImage(img: HTMLImageElement) {
  if (!imageEligible(img)) return
  img.dataset.zoomable = 'image'
  img.dataset.testid = 'zoom-trigger'
  img.tabIndex = 0
  img.setAttribute('role', 'button')
  img.setAttribute('aria-label', img.alt ? `Open image full screen: ${img.alt}` : 'Open image full screen')
}

/** Give a cloned SVG's ids a suffix (and rewrite its own references), so the copy never resolves to the page's. */
function isolateIds(svg: SVGSVGElement) {
  const ids = new Map<string, string>()
  for (const el of [svg, ...svg.querySelectorAll('[id]')]) {
    if (el.id) { ids.set(el.id, `${el.id}-zv`); el.id = `${el.id}-zv` }
  }
  if (!ids.size) return
  const fix = (s: string) => s.replace(/#([A-Za-z_][\w\-:.]*)/g, (m, id: string) => (ids.has(id) ? `#${ids.get(id)}` : m))
  for (const style of svg.querySelectorAll('style')) style.textContent = fix(style.textContent ?? '')
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) if (a.value.includes('#') && a.name !== 'id') el.setAttribute(a.name, fix(a.value))
  }
}

function snapshot(trigger: HTMLElement): { kind: 'mermaid' | 'image'; content: Element; natural: Size; source?: string } | null {
  if (trigger.dataset.zoomable === 'mermaid') {
    const svg = trigger.querySelector<SVGSVGElement>(':scope > svg')
    if (!svg) return null
    const vb = svg.viewBox?.baseVal
    const r = svg.getBoundingClientRect()
    const natural = vb && vb.width > 0 ? { w: vb.width, h: vb.height } : { w: r.width || 300, h: r.height || 150 }
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.removeAttribute('style')
    clone.setAttribute('width', '100%')
    clone.setAttribute('height', '100%')
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${natural.w} ${natural.h}`)
    isolateIds(clone)
    // The fence content without its final newline (as #14 copies code).
    return { kind: 'mermaid', content: clone, natural, source: (trigger.dataset.source ?? '').replace(/\n$/, '') }
  }
  const img = trigger as HTMLImageElement
  const copy = document.createElement('img')
  copy.src = img.currentSrc || img.src
  copy.alt = img.alt
  copy.draggable = false
  return { kind: 'image', content: copy, natural: { w: img.naturalWidth, h: img.naturalHeight } }
}

function closeViewer() {
  const c = current
  if (!c) return
  current = null
  c.app.unmount()
  c.host.remove()
  document.documentElement.style.overflow = c.overflow
  returnTarget(c)?.focus({ preventScroll: true })
  window.scrollTo({ top: c.scrollY, behavior: 'instant' as ScrollBehavior })
}

async function openViewer(trigger: HTMLElement, copyText: (t: string) => Promise<boolean>) {
  if (current) return
  const snap = snapshot(trigger)
  if (!snap) return
  const { default: ZoomViewer } = await import('@/components/ZoomViewer.vue')
  if (current) return
  const host = document.createElement('div')
  host.className = 'zoom-viewer-host'
  document.body.appendChild(host)
  const scrollY = window.scrollY
  const overflow = document.documentElement.style.overflow
  document.documentElement.style.overflow = 'hidden'
  const app = createApp(ZoomViewer, { ...snap, copyText, onClose: closeViewer })
  const index = [...document.querySelectorAll(`.preview-pane ${TRIGGER}`)].indexOf(trigger)
  current = { app, host, trigger, index, scrollY, overflow }
  app.mount(host)
}

export const zoom: Enhancer = (container, ctx) => {
  const scan = () => {
    for (const m of container.querySelectorAll<HTMLElement>('.mermaid')) markMermaid(m)
    for (const img of container.querySelectorAll<HTMLImageElement>('img:not([data-zoomable])')) {
      if (img.complete) markImage(img)
      else if (!pendingImages.has(img)) {
        pendingImages.add(img)
        img.addEventListener('load', () => markImage(img), { once: true })
      }
    }
  }
  scan()
  const obs = new MutationObserver(() => scan())
  obs.observe(container, { childList: true, subtree: true })

  let down: { x: number; y: number; t: HTMLElement } | null = null
  const onPointerDown = (e: PointerEvent) => {
    const t = (e.target as Element | null)?.closest?.<HTMLElement>(TRIGGER)
    down = t && container.contains(t) && e.button === 0 ? { x: e.clientX, y: e.clientY, t } : null
  }
  const onClick = (e: MouseEvent) => {
    const t = (e.target as Element | null)?.closest?.<HTMLElement>(TRIGGER)
    if (!t || !container.contains(t) || e.button !== 0) return
    if ((e.target as Element).closest('a[href]')) return
    // Rule 3: a click, not the end of a drag-select.
    const d = down
    down = null
    if (d && (d.t !== t || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 5)) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    e.preventDefault()
    openViewer(t, ctx.copyText)
  }
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    // A held key, or a chord (Mod+Shift+Enter is focus mode), is not a trigger activation.
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    const t = e.target as HTMLElement
    if (!t?.matches?.(TRIGGER) || !container.contains(t)) return
    e.preventDefault()
    openViewer(t, ctx.copyText)
  }
  container.addEventListener('pointerdown', onPointerDown, true)
  container.addEventListener('click', onClick)
  container.addEventListener('keydown', onKeydown)
  return () => {
    obs.disconnect()
    container.removeEventListener('pointerdown', onPointerDown, true)
    container.removeEventListener('click', onClick)
    container.removeEventListener('keydown', onKeydown)
  }
}
