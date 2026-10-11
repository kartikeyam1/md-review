import type { Enhancer } from './enhancers'

// #3 rules 15–17: every markdown heading ends with an icon-only "copy link to
// this section" button (00 §2.5: the last control in the heading). The label
// comes from the heading's token plain text; the button is user-select: none
// and outside every token-derived text (TOC, docTitle, ids).

const ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'

export const SECTION_LINK_LABEL = 'Copy link to section: '

export const headingAnchors: Enhancer = (container, ctx) => {
  const textById = new Map(ctx.headings.map((h) => [h.id, h.text]))
  for (const h of container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    // Only markdown headings (ids assigned by headingIds); raw-HTML ones are left alone.
    const text = h.id ? textById.get(h.id) : undefined
    if (text === undefined || h.lastElementChild?.matches('[data-testid="heading-anchor"]')) continue
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'heading-anchor'
    btn.dataset.testid = 'heading-anchor'
    btn.setAttribute('aria-label', `${SECTION_LINK_LABEL}${text}`)
    btn.title = 'Copy link to this section'
    btn.innerHTML = ICON
    h.appendChild(btn)
  }

  const onClick = (e: MouseEvent) => {
    const btn = (e.target as Element | null)?.closest?.('[data-testid="heading-anchor"]')
    if (!btn || !container.contains(btn)) return
    e.preventDefault()
    const id = btn.parentElement?.id
    if (id) ctx.copySectionLink(id)
  }
  container.addEventListener('click', onClick)
  return () => container.removeEventListener('click', onClick)
}
