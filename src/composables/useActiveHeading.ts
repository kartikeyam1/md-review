import { watch, nextTick, onMounted, onUnmounted, type Ref } from 'vue'
import type { TocEntry } from '@/markdown/headingIds'
import { findAnchorIn } from '@/composables/useRouter'

// #3 rule 13: which TOC entry the reader is in. The active entry is the last
// one whose heading top is at or above the reading-area top + 80px; before the
// first heading it is the first entry; scrolled to the very bottom it is the
// last entry whose heading is visible. Scroll handling is rAF-throttled with
// one read pass per frame and no writes.

const ACTIVE_LINE_PX = 80

/** Pure: the active index given each entry's heading top (viewport px, document order; null = not rendered). */
export function activeIndex(tops: (number | null)[], o: { line: number; atBottom: boolean; viewportHeight: number }): number {
  let idx = 0
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i]
    if (t === null || t === undefined) continue
    if (t <= o.line) idx = i
    else break
  }
  if (o.atBottom) {
    for (let i = tops.length - 1; i > idx; i--) {
      const t = tops[i]
      if (t !== null && t !== undefined && t < o.viewportHeight) return i
    }
  }
  return idx
}

function headerBottom(): number {
  const h = document.querySelector<HTMLElement>('[data-testid="doc-header"]')
  const r = h?.getBoundingClientRect()
  return r && r.height > 0 && r.bottom > 0 ? r.bottom : 0
}

export function useActiveHeading(o: { entries: Ref<TocEntry[]>; activeId: Ref<string | null>; enabled: Ref<boolean> }) {
  let frame = 0
  /**
   * Kept active regardless of the scroll position until the reader's next
   * wheel/touch/key/mouse input or Back/Forward: a TOC click (rule 12) and a
   * content rebuild that still has the entry (rule 14).
   */
  let pinned: string | null = null

  // Heading elements, looked up once per entry list / render (re-queried when a render replaced them).
  let els: (HTMLElement | null)[] = []
  let elsFor: TocEntry[] | null = null
  function headingEls(list: TocEntry[]): (HTMLElement | null)[] {
    if (elsFor !== list || els.some((e) => e !== null && !e.isConnected)) {
      const root = document.querySelector<HTMLElement>('.preview-pane')
      els = list.map((e) => (root ? findAnchorIn(root, e.id) : null))
      elsFor = list
    }
    return els
  }

  /** Viewport top of a heading, or null when it is not rendered (missing, or hidden — e.g. a folded section, #17). */
  function topOf(el: HTMLElement | null): number | null {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width === 0 && r.height === 0 ? null : r.top
  }

  function compute() {
    frame = 0
    if (!o.enabled.value || pinned) return
    const list = o.entries.value
    if (!list.length) return
    const scroller = document.scrollingElement ?? document.documentElement
    // One read pass (no writes in between, so one layout at most).
    const tops = headingEls(list).map(topOf)
    const idx = activeIndex(tops, {
      line: headerBottom() + ACTIVE_LINE_PX,
      atBottom: scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 2,
      viewportHeight: window.innerHeight,
    })
    const id = list[idx]!.id
    if (o.activeId.value !== id) o.activeId.value = id
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(compute)
  }

  /** A TOC link was clicked: that entry is active now and while the jump scrolls. */
  function pin(id: string) {
    pinned = id
    o.activeId.value = id
  }

  function unpin() {
    if (!pinned) return
    pinned = null
    schedule()
  }

  const INPUT_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown', 'popstate'] as const

  onMounted(() => {
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    for (const ev of INPUT_EVENTS) window.addEventListener(ev, unpin, { passive: true, capture: true })
  })
  onUnmounted(() => {
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    for (const ev of INPUT_EVENTS) window.removeEventListener(ev, unpin, { capture: true })
    if (frame) cancelAnimationFrame(frame)
  })

  // A TOC appears (or comes back): find the active entry once the DOM is there.
  watch(o.enabled, (on) => { if (on) nextTick(schedule) }, { immediate: true })

  // Rule 14: a rebuild (poll, restore) keeps the active entry when its id is still
  // there, and keeps that heading where the reader had it on screen — content
  // inserted above it does not push the reading position away. This watcher runs
  // before the preview re-renders, so the old position is still measurable.
  watch(o.entries, (list) => {
    const id = o.activeId.value
    if (!id || !list.some((e) => e.id === id)) {
      if (pinned && !list.some((e) => e.id === pinned)) pinned = null
      nextTick(schedule)
      return
    }
    const root = document.querySelector<HTMLElement>('.preview-pane')
    const before = topOf(root ? findAnchorIn(root, id) : null)
    pinned = id
    if (before === null) return
    nextTick(() => {
      const now = document.querySelector<HTMLElement>('.preview-pane')
      const after = topOf(now ? findAnchorIn(now, id) : null)
      if (after !== null && Math.abs(after - before) >= 1) window.scrollBy({ top: after - before, behavior: 'instant' as ScrollBehavior })
    })
  })

  return { pin, recompute: schedule }
}
