import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import type { Shortcut } from '@/composables/useGlobalShortcuts'

/**
 * Keyboard-shortcuts overlay state (spec #9 rule 11, 00 §3.5).
 *
 * The overlay lives with the editor toolbar (edit/split views only); a mounted
 * toolbar registers itself as a host. The global `?` key opens it only while a
 * host toolbar is on screen — the editor may stay mounted but hidden (#6
 * keep-alive), so mounted is not enough — and only when focus is not in an
 * editable element, so it never steals a typed character.
 */

const open = ref(false)
const hosts = new Set<Ref<HTMLElement | null>>()
let returnFocus: HTMLElement | null = null

export function shortcutsOverlayOpen() {
  return open
}

/** Opens the overlay; focus goes back to `opener` (default: the focused element) on close. */
/** A host toolbar is rendered and visible (edit/split view on screen). */
export function shortcutsOverlayAvailable(): boolean {
  for (const el of hosts) if (el.value?.isConnected && el.value.getClientRects().length > 0) return true
  return false
}

export function openShortcutsOverlay(opener?: HTMLElement | null) {
  if (!hosts.size) return
  const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
  returnFocus = opener ?? active
  open.value = true
}

export function closeShortcutsOverlay() {
  if (!open.value) return
  open.value = false
  const el = returnFocus
  returnFocus = null
  if (el && el.isConnected && typeof el.focus === 'function') el.focus()
}

/** Called by the component that renders the overlay (EditorToolbar) with its root element. */
export function useShortcutsOverlayHost(el: Ref<HTMLElement | null>) {
  onMounted(() => { hosts.add(el) })
  onUnmounted(() => {
    hosts.delete(el)
    if (!hosts.size) { open.value = false; returnFocus = null }
  })
  return open
}

export function isEditableTarget(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el.closest('.cm-editor')) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type)
  }
  return false
}

/** The global `?` handler. */
export function onShortcutsHelpKey(e: KeyboardEvent) {
  if (e.key !== '?' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
  if (open.value || !shortcutsOverlayAvailable()) return
  if (isEditableTarget(e.target as Element | null) || isEditableTarget(document.activeElement)) return
  e.preventDefault()
  openShortcutsOverlay()
}

/** The `?` entry for useGlobalShortcuts (00 §3.5); it gates and prevents default itself. */
export const shortcutsHelpShortcut: Shortcut = { key: '?', preventDefault: false, run: onShortcutsHelpKey }
