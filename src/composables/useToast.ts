import { ref, readonly } from 'vue'

// ── App toasts (00 §3.1) ─────────────────────────────────────────────────────
// One app-wide stack, rendered by AppToast. Every transient user-facing
// message goes through here (no alert()).

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastAction {
  label: string
  href?: string
  onClick?: () => void
}

export interface ToastOptions {
  /** `data-toast` hook, for messages an AC targets (registry in 00 §3.1). */
  key?: string
  action?: ToastAction
}

export interface ToastItem extends ToastOptions {
  id: number
  kind: ToastKind
  text: string
}

/** Auto-dismiss delays: 4 s info/success, 8 s error. */
export const TOAST_DURATION_MS: Record<ToastKind, number> = { info: 4000, success: 4000, error: 8000 }
/** At most this many on screen; the oldest goes first. */
export const TOAST_MAX = 3

const items = ref<ToastItem[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 1

function dismiss(id: number) {
  const t = timers.get(id)
  if (t) { clearTimeout(t); timers.delete(id) }
  items.value = items.value.filter((x) => x.id !== id)
}

function push(kind: ToastKind, text: string, opts: ToastOptions = {}): number {
  const id = nextId++
  items.value = [...items.value, { id, kind, text, ...opts }]
  while (items.value.length > TOAST_MAX) dismiss(items.value[0].id)
  timers.set(id, setTimeout(() => dismiss(id), TOAST_DURATION_MS[kind]))
  return id
}

export const toast = {
  info: (text: string, opts?: ToastOptions) => push('info', text, opts),
  success: (text: string, opts?: ToastOptions) => push('success', text, opts),
  error: (text: string, opts?: ToastOptions) => push('error', text, opts),
}

export function useToast() {
  return { toasts: readonly(items), dismiss, ...toast }
}

/** Tests: drop every toast and timer. */
export function _resetToasts() {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  items.value = []
}
