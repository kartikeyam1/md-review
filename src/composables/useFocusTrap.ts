import { watch, nextTick, onUnmounted, type Ref } from 'vue'

// Focus trap for modals and drawers (00 §3.4). First used by #5's comments
// drawer; #3's TOC drawer and #9's shortcuts overlay reuse it. While `active`:
// focus moves into the container (the `initialFocus` element, else the first
// focusable), Tab / Shift+Tab cycle inside it, and on deactivation focus goes
// back to `returnFocus` (else whatever had it before). Esc is the caller's.

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'summary',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Tabbable elements inside `root`, in DOM order (rendered ones only). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) =>
    el.tabIndex >= 0 && !el.hasAttribute('inert') && el.getClientRects().length > 0)
}

export interface FocusTrapOptions {
  /** Where focus goes on activation (default: the first focusable, else the container). */
  initialFocus?: () => HTMLElement | null | undefined
  /** Where focus goes on deactivation (default: the element focused before activation). */
  returnFocus?: () => HTMLElement | null | undefined
}

export function useFocusTrap(container: Ref<HTMLElement | null | undefined>, active: Ref<boolean>, opts: FocusTrapOptions = {}) {
  let previous: HTMLElement | null = null

  function onKeydown(e: KeyboardEvent) {
    const root = container.value
    if (e.key !== 'Tab' || !root) return
    const els = focusableIn(root)
    if (!els.length) { e.preventDefault(); root.focus(); return }
    const first = els[0]!
    const last = els[els.length - 1]!
    const current = document.activeElement
    if (e.shiftKey && (current === first || !root.contains(current))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (current === last || !root.contains(current))) {
      e.preventDefault()
      first.focus()
    }
  }

  function activate() {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.addEventListener('keydown', onKeydown, true)
    nextTick(() => {
      const root = container.value
      if (!root) return
      const target = opts.initialFocus?.() ?? focusableIn(root)[0] ?? root
      if (target === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1')
      target.focus({ preventScroll: true })
    })
  }

  function deactivate() {
    document.removeEventListener('keydown', onKeydown, true)
    const back = opts.returnFocus?.() ?? previous
    previous = null
    if (back?.isConnected) back.focus({ preventScroll: true })
  }

  watch(active, (on, was) => {
    if (on && !was) activate()
    else if (!on && was) deactivate()
  }, { immediate: true })

  onUnmounted(() => document.removeEventListener('keydown', onKeydown, true))
}
