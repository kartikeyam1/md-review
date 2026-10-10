import { ref, readonly, computed } from 'vue'

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
/** Per toast: its auto-dismiss timer (null while paused), when that timer started, and the time left. */
const timers = new Map<number, { timer: ReturnType<typeof setTimeout> | null; startedAt: number; remaining: number }>()
let nextId = 1

function dismiss(id: number) {
  const t = timers.get(id)
  if (t?.timer) clearTimeout(t.timer)
  timers.delete(id)
  items.value = items.value.filter((x) => x.id !== id)
}

function arm(id: number, ms: number) {
  timers.set(id, { timer: setTimeout(() => dismiss(id), ms), startedAt: Date.now(), remaining: ms })
}

/** Hover or focus on a toast holds it on screen (WCAG 2.2.1); `resume` restarts the time it had left. */
function pause(id: number) {
  const t = timers.get(id)
  if (!t || !t.timer) return
  clearTimeout(t.timer)
  t.timer = null
  t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt))
}

function resume(id: number) {
  const t = timers.get(id)
  if (!t || t.timer) return
  arm(id, Math.max(t.remaining, 1000))
}

function push(kind: ToastKind, text: string, opts: ToastOptions = {}): number {
  const id = nextId++
  items.value = [...items.value, { id, kind, text, ...opts }]
  while (items.value.length > TOAST_MAX) dismiss(items.value[0].id)
  arm(id, TOAST_DURATION_MS[kind])
  return id
}

/** The newest polite (info/success) and assertive (error) texts on screen, for the persistent live regions. */
const latestPolite = computed(() => [...items.value].reverse().find((x) => x.kind !== 'error')?.text ?? '')
const latestAssertive = computed(() => [...items.value].reverse().find((x) => x.kind === 'error')?.text ?? '')

export const toast = {
  info: (text: string, opts?: ToastOptions) => push('info', text, opts),
  success: (text: string, opts?: ToastOptions) => push('success', text, opts),
  error: (text: string, opts?: ToastOptions) => push('error', text, opts),
}

export function useToast() {
  return { toasts: readonly(items), dismiss, pause, resume, latestPolite, latestAssertive, ...toast }
}

/** Tests: drop every toast and timer. */
export function _resetToasts() {
  for (const t of timers.values()) if (t.timer) clearTimeout(t.timer)
  timers.clear()
  items.value = []
}
