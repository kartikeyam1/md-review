import { ref, nextTick, onUnmounted, type Ref } from 'vue'

// ── Menu keyboard model (00 §3.2) ────────────────────────────────────────────
// Trigger: Enter/Space/click open on the checked (or first) item, ArrowDown
// too, ArrowUp opens on the last. In the menu: arrows move with wrap,
// Home/End jump, Enter/Space select (native button activation), Esc closes
// and returns focus to the trigger, Tab closes, an outside click closes.

export type MenuKeyMove = 'next' | 'prev' | 'first' | 'last'

const KEY_MOVES: Record<string, MenuKeyMove> = {
  ArrowDown: 'next', ArrowUp: 'prev', Home: 'first', End: 'last',
}

/** Pure: the item index a key moves focus to (wrapping), or null when the key is not a move. */
export function menuKeyTarget(key: string, current: number, count: number): number | null {
  const move = KEY_MOVES[key]
  if (!move || count <= 0) return null
  switch (move) {
    case 'first': return 0
    case 'last': return count - 1
    case 'next': return current < 0 ? 0 : (current + 1) % count
    case 'prev': return current < 0 ? count - 1 : (current - 1 + count) % count
  }
}

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

export function useMenu(trigger: Ref<HTMLElement | null | undefined>, list: Ref<HTMLElement | null | undefined>) {
  const open = ref(false)

  function items(): HTMLElement[] {
    const el = list.value
    if (!el) return []
    // Disabled items stay focusable (WAI-ARIA menu pattern); activating them is a no-op.
    return [...el.querySelectorAll<HTMLElement>(ITEM_SELECTOR)]
  }

  function focusItem(index: number) {
    const all = items()
    all.forEach((el, i) => { el.tabIndex = i === index ? 0 : -1 })
    all[index]?.focus()
  }

  async function show(at: 'checked' | 'last' = 'checked') {
    open.value = true
    document.addEventListener('pointerdown', onOutside, true)
    await nextTick()
    const all = items()
    if (!all.length) return
    if (at === 'last') { focusItem(all.length - 1); return }
    const checked = all.findIndex((el) => el.getAttribute('aria-checked') === 'true')
    focusItem(checked >= 0 ? checked : 0)
  }

  function close(opts: { focusTrigger?: boolean } = {}) {
    if (!open.value) return
    open.value = false
    document.removeEventListener('pointerdown', onOutside, true)
    if (opts.focusTrigger) trigger.value?.focus()
  }

  function toggle() {
    if (open.value) close()
    else show()
  }

  function onOutside(e: Event) {
    const t = e.target as Node | null
    if (t && (list.value?.contains(t) || trigger.value?.contains(t))) return
    close()
  }

  function onTriggerKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      show(e.key === 'ArrowUp' ? 'last' : 'checked')
    }
  }

  function onListKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close({ focusTrigger: true })
      return
    }
    if (e.key === 'Tab') { close(); return }
    const all = items()
    const current = all.indexOf(document.activeElement as HTMLElement)
    const target = menuKeyTarget(e.key, current, all.length)
    if (target === null) return
    e.preventDefault()
    focusItem(target)
  }

  onUnmounted(() => document.removeEventListener('pointerdown', onOutside, true))

  return { open, show, close, toggle, onTriggerKeydown, onListKeydown }
}
