import type { Enhancer } from './enhancers'

// Spec #14 rules 4–9: the Copy button on each `code-block` (markup from
// src/markdown/codeBlock.ts). One delegated click handler per render; the
// copied text is the <code>'s textContent minus the final newline, which is
// the fence's token content. Feedback is in-button ("Copied" / "Copy failed",
// data-state, 2 s) plus one polite live region per pane — never a toast
// (00 §3.1).

export const COPIED_MS = 2000

const LABELS = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' } as const
type CopyState = keyof typeof LABELS

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/** Rule 4: the exact source text of the block (no highlight markup, no trailing newline). */
export function codeTextOf(block: Element): string {
  const code = block.querySelector('pre code') ?? block.querySelector('pre')
  return (code?.textContent ?? '').replace(/\n$/, '')
}

export function setCopyState(btn: HTMLElement, state: CopyState) {
  const prev = timers.get(btn)
  if (prev) clearTimeout(prev)
  timers.delete(btn)
  btn.dataset.state = state
  const text = btn.querySelector('.code-copy-text')
  if (text) text.textContent = LABELS[state]
  if (state !== 'idle') timers.set(btn, setTimeout(() => setCopyState(btn, 'idle'), COPIED_MS))
}

/** The pane's live region (rule 6), re-created after each render since v-html replaces the pane's children. */
function liveRegion(container: HTMLElement): HTMLElement {
  let el = container.querySelector<HTMLElement>(':scope > [data-testid="code-copy-status"]')
  if (!el) {
    el = document.createElement('div')
    el.className = 'sr-only code-copy-status'
    el.dataset.testid = 'code-copy-status'
    // #19's export drops app-only nodes by this one selector (with the code toolbar).
    el.setAttribute('data-export-strip', '')
    el.setAttribute('aria-live', 'polite')
    el.setAttribute('role', 'status')
    container.appendChild(el)
  }
  return el
}

export const codeCopy: Enhancer = (container, ctx) => {
  const status = liveRegion(container)

  const inToolbar = (e: Event) => {
    const t = e.target as Element | null
    return !!t?.closest?.('[data-testid="code-toolbar"]') && container.contains(t)
  }
  // Rule 9: a click on the toolbar never starts/clears a selection or reaches the
  // pane's selection → comment handlers (mousedown/mouseup on the container).
  // A mouseup is swallowed only when its mousedown was on the toolbar too, so a
  // drag-selection that starts in the code and ends over the toolbar still
  // raises the comment bar. Side effect (DECISIONS #14): an open comment popover
  // stays open across a copy click.
  let downInToolbar = false
  const swallow = (e: MouseEvent) => {
    if (e.type === 'mousedown') {
      downInToolbar = inToolbar(e)
      if (!downInToolbar) return
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const wasDown = downInToolbar
    downInToolbar = false
    if (wasDown && inToolbar(e)) e.stopPropagation()
  }

  const onClick = async (e: MouseEvent) => {
    const btn = (e.target as Element | null)?.closest?.<HTMLElement>('[data-testid="code-copy-btn"]')
    if (!btn || !container.contains(btn)) return
    e.preventDefault()
    const block = btn.closest('[data-testid="code-block"]')
    if (!block) return
    const ok = await ctx.copyText(codeTextOf(block))
    if (!btn.isConnected) return
    setCopyState(btn, ok ? 'copied' : 'failed')
    // Clear first so a repeated copy is announced again.
    status.textContent = ''
    requestAnimationFrame(() => { status.textContent = ok ? 'Copied to clipboard' : 'Copy failed' })
  }

  container.addEventListener('mousedown', swallow, true)
  container.addEventListener('mouseup', swallow, true)
  container.addEventListener('click', onClick)
  return () => {
    container.removeEventListener('mousedown', swallow, true)
    container.removeEventListener('mouseup', swallow, true)
    container.removeEventListener('click', onClick)
  }
}
