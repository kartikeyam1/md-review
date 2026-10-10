import { onMounted, onUnmounted } from 'vue'

// ── Global keyboard shortcuts (00 §3.5) ──────────────────────────────────────
// One window keydown listener for app-wide chords. Editor-local keys (undo,
// markdown shortcuts…) belong to the editor extensions, not here.

export interface Shortcut {
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string
  /** Ctrl on Linux/Windows, Cmd on macOS (either is accepted). */
  mod?: boolean
  shift?: boolean
  alt?: boolean
  /** Only fires while this returns true. */
  when?: () => boolean
  run: (e: KeyboardEvent) => void
  /** preventDefault() before running (default true). */
  preventDefault?: boolean
}

/** Pure: does `e` match `s` (modifiers exact, key case-insensitive)? */
export function matchesShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, s: Shortcut): boolean {
  const mod = e.metaKey || e.ctrlKey
  if (!!s.mod !== mod) return false
  if (s.shift !== undefined && s.shift !== e.shiftKey) return false
  if (s.alt !== undefined && s.alt !== e.altKey) return false
  return e.key.toLowerCase() === s.key.toLowerCase()
}

/** Register shortcuts for the lifetime of the calling component. */
export function useGlobalShortcuts(shortcuts: Shortcut[]) {
  function onKeydown(e: KeyboardEvent) {
    for (const s of shortcuts) {
      if (!matchesShortcut(e, s)) continue
      if (s.when && !s.when()) continue
      if (s.preventDefault !== false) e.preventDefault()
      s.run(e)
      return
    }
  }
  onMounted(() => window.addEventListener('keydown', onKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onKeydown))
}
