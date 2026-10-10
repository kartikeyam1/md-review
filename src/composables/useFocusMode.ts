import { computed, ref } from 'vue'

/**
 * Focus mode (spec #13): in-memory, per page — off on every load, never in the
 * URL or localStorage (rule 10). One flag for the page; the editor toolbar's
 * button (inside the lazy editor chunk), the banners and DocView (shortcut,
 * Esc, chrome) share it. DocView says when it is allowed (edit/split views,
 * editors, not embedded) and turns it off on leaving the editing views or the
 * document; everything reads the gated `focusActive`.
 */
const on = ref(false)
const allowed = ref(false)
const active = computed(() => on.value && allowed.value)

/** Focus mode is on (and allowed where it is shown). */
export function focusActive() {
  return active
}

/** DocView: may focus mode be on right now? Turning it off clears the flag. */
export function setFocusAllowed(value: boolean) {
  allowed.value = value
  if (!value) on.value = false
}

export function setFocusMode(value: boolean) {
  on.value = value && allowed.value
}

export function toggleFocusMode() {
  setFocusMode(!active.value)
}
