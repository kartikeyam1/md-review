import { watchEffect } from 'vue'
import { REACTIONS, SECTION_RE } from '@shared/reactions.mjs'
import { currentReactions, groupsOf, type ReactionGroup } from '@/composables/useReactions'
import type { Enhancer } from './enhancers'

// Section reactions (#24 rule 7): on every h2/h3 with an id, a
// `section-reaction-trigger` (opens the picker) and, when the heading has
// reactions, `section-reaction-chip`s — after the heading text, before #3's
// heading-anchor (00 §2.5). Chips toggle that reaction; hovering, focusing or
// long-pressing one shows who reacted. Everything injected is user-select:
// none, and heading ids / TOC text / doc title come from markdown tokens, so
// none of this leaks into them. Only for a shared doc's read view (the store's
// `active`); chips of sections that are not in the render are simply never drawn.

const HOST_CLASS = 'section-reactions'
const LABELS = new Map(REACTIONS.map((r) => [r.code, r.label]))
const LONG_PRESS_MS = 500

const TRIGGER_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">'
  + '<circle cx="9" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'
  + '<circle cx="6.8" cy="8.6" r="0.9" fill="currentColor"/><circle cx="11.2" cy="8.6" r="0.9" fill="currentColor"/>'
  + '<path d="M6.3 11.6c.7 1 1.6 1.5 2.7 1.5s2-.5 2.7-1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
  + '<path d="M16.5 2.5v5M14 5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

/** The heading's own text: without anything an enhancer injected (00 §2.5 controls). */
function headingText(h: HTMLElement): string {
  const clone = h.cloneNode(true) as HTMLElement
  clone.querySelectorAll(`.${HOST_CLASS}, .heading-anchor, .heading-fold-toggle, .heading-fold-ellipsis`).forEach((n) => n.remove())
  return (clone.textContent || '').replace(/\s+/g, ' ').trim()
}

function makeTrigger(section: string, label: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'section-reaction-trigger'
  b.dataset.testid = 'section-reaction-trigger'
  b.dataset.section = section
  b.setAttribute('aria-label', `React to section ${label}`)
  b.setAttribute('aria-haspopup', 'dialog')
  b.setAttribute('aria-expanded', 'false')
  b.title = 'React to this section'
  b.innerHTML = TRIGGER_ICON
  return b
}

function syncChips(host: HTMLElement, trigger: HTMLElement, groups: ReactionGroup[]) {
  const existing = new Map<string, HTMLButtonElement>()
  host.querySelectorAll<HTMLButtonElement>(':scope > .section-reaction-chip').forEach((c) => existing.set(c.dataset.code!, c))
  for (const g of groups) {
    let chip = existing.get(g.code)
    existing.delete(g.code)
    if (!chip) {
      chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'section-reaction-chip'
      chip.dataset.testid = 'section-reaction-chip'
      chip.dataset.code = g.code
      chip.innerHTML = '<span class="chip-emoji" aria-hidden="true"></span><span class="chip-count"></span>'
    }
    chip.querySelector('.chip-emoji')!.textContent = g.emoji
    chip.querySelector('.chip-count')!.textContent = String(g.count)
    chip.setAttribute('aria-pressed', g.mine ? 'true' : 'false')
    chip.setAttribute('aria-label', `${LABELS.get(g.code) ?? g.code} ${g.emoji}: ${g.count}`)
    host.insertBefore(chip, trigger) // keeps the fixed order (groups arrive ordered)
  }
  for (const stale of existing.values()) stale.remove()
}

export const sectionReactions: Enhancer = (container) => {
  // Only ids the server accepts as a section key (today's slugger has no length cap).
  const headings = () => Array.from(container.querySelectorAll<HTMLElement>('h2[id], h3[id]')).filter((h) => SECTION_RE.test(h.id))
  const hostOf = (h: HTMLElement) => h.querySelector<HTMLElement>(`:scope > .${HOST_CLASS}`)

  const stop = watchEffect(() => {
    const store = currentReactions.value
    const active = !!store?.active.value
    const summary = store?.summary.value ?? null
    const openFor = store?.picker.value?.section ?? null
    for (const h of headings()) {
      let host = hostOf(h)
      if (!active) { host?.remove(); continue }
      if (!host) {
        host = document.createElement('span')
        host.className = HOST_CLASS
        host.dataset.section = h.id
        host.appendChild(makeTrigger(h.id, headingText(h) || h.id))
        h.insertBefore(host, h.querySelector(':scope > .heading-anchor'))
      }
      const trigger = host.querySelector<HTMLElement>(':scope > .section-reaction-trigger')!
      trigger.setAttribute('aria-expanded', openFor === h.id ? 'true' : 'false')
      syncChips(host, trigger, groupsOf(summary, h.id))
    }
  })

  const sectionOf = (el: Element) => el.closest<HTMLElement>(`.${HOST_CLASS}`)?.dataset.section ?? null
  const groupOf = (chip: HTMLElement) => groupsOf(currentReactions.value?.summary.value ?? null, sectionOf(chip))
    .find((g) => g.code === chip.dataset.code)
  const chipAt = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('.section-reaction-chip') : null)

  let suppressClick = false
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null } }

  function onClick(e: MouseEvent) {
    const store = currentReactions.value
    if (!store) return
    const target = e.target instanceof Element ? e.target : null
    const trigger = target?.closest<HTMLElement>('.section-reaction-trigger')
    if (trigger && container.contains(trigger)) {
      e.preventDefault()
      const section = trigger.dataset.section!
      if (store.picker.value?.section === section) store.closePicker({ restoreFocus: false })
      else store.openPicker({ section, label: headingText(trigger.closest('h2, h3') as HTMLElement), trigger })
      return
    }
    const chip = chipAt(target)
    if (chip && container.contains(chip)) {
      e.preventDefault()
      if (suppressClick) { suppressClick = false; return }
      store.toggle(chip.dataset.code!, sectionOf(chip))
      // Keep the tooltip current for a pointer still on the chip.
      requestAnimationFrame(() => { if (chip.isConnected && chip.matches(':hover, :focus')) store.showWho(groupOf(chip), chip) })
    }
  }
  // Mouse events a touch synthesises must not re-open the tooltip a long-press closed.
  let lastTouchAt = 0
  function onOver(e: Event) {
    if (e.type === 'mouseover' && Date.now() - lastTouchAt < 1000) return
    const chip = chipAt(e.target)
    if (chip) currentReactions.value?.showWho(groupOf(chip), chip)
  }
  function onOut(e: Event) {
    const chip = chipAt(e.target)
    const to = (e as MouseEvent | FocusEvent).relatedTarget
    if (chip && !(to instanceof Node && chip.contains(to))) currentReactions.value?.hideWho()
  }
  function onTouchStart(e: TouchEvent) {
    suppressClick = false // a long-press whose click never came must not swallow this tap
    lastTouchAt = Date.now()
    const chip = chipAt(e.target)
    if (!chip) return
    clearPress()
    pressTimer = setTimeout(() => {
      pressTimer = null
      suppressClick = true
      currentReactions.value?.showWho(groupOf(chip), chip)
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(() => currentReactions.value?.hideWho(), 2000)
    }, LONG_PRESS_MS)
  }

  function onTouchEnd() { lastTouchAt = Date.now(); clearPress() }

  // A long-press on a chip shows who reacted, not the browser's context menu.
  function onContextMenu(e: Event) { if (chipAt(e.target)) e.preventDefault() }

  container.addEventListener('click', onClick)
  container.addEventListener('mouseover', onOver)
  container.addEventListener('mouseout', onOut)
  container.addEventListener('focusin', onOver)
  container.addEventListener('focusout', onOut)
  container.addEventListener('touchstart', onTouchStart, { passive: true })
  container.addEventListener('touchend', onTouchEnd)
  container.addEventListener('touchmove', clearPress, { passive: true })
  container.addEventListener('contextmenu', onContextMenu)

  return () => {
    stop()
    clearPress()
    if (hideTimer) clearTimeout(hideTimer)
    container.removeEventListener('click', onClick)
    container.removeEventListener('mouseover', onOver)
    container.removeEventListener('mouseout', onOut)
    container.removeEventListener('focusin', onOver)
    container.removeEventListener('focusout', onOut)
    container.removeEventListener('touchstart', onTouchStart)
    container.removeEventListener('touchend', onTouchEnd)
    container.removeEventListener('touchmove', clearPress)
    container.removeEventListener('contextmenu', onContextMenu)
    container.querySelectorAll(`.${HOST_CLASS}`).forEach((n) => n.remove())
  }
}
