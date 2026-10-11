import type { Enhancer } from './enhancers'

// A wide table scrolls sideways in its .table-scroll box (#5 rule 5) with no
// visible sign that more columns exist. This marks each box with the sides that
// have hidden content (data-overflow="l" | "r" | "lr"); the stylesheet fades
// those edges. Kept current on scroll (captured from the container) and resize.

function update(box: HTMLElement) {
  const max = box.scrollWidth - box.clientWidth
  const v = max > 1 ? `${box.scrollLeft > 1 ? 'l' : ''}${box.scrollLeft < max - 1 ? 'r' : ''}` : ''
  if (v) box.dataset.overflow = v
  else delete box.dataset.overflow
}

export const tableScrollHint: Enhancer = (container) => {
  const all = () => container.querySelectorAll<HTMLElement>('.table-scroll')
  const refresh = () => { for (const b of all()) update(b) }
  refresh()
  const onScroll = (e: Event) => {
    const t = e.target
    if (t instanceof HTMLElement && t.classList.contains('table-scroll')) update(t)
  }
  container.addEventListener('scroll', onScroll, { capture: true, passive: true })
  let raf = 0
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh() }) })
    : null
  ro?.observe(container)
  // Fonts and lazy content can change a table's width after the first pass.
  const late = setTimeout(refresh, 500)
  return () => {
    container.removeEventListener('scroll', onScroll, { capture: true })
    ro?.disconnect()
    if (raf) cancelAnimationFrame(raf)
    clearTimeout(late)
  }
}
