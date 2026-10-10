import { watch, onMounted, onUnmounted, type Ref } from 'vue'
import type { PaneMode } from '@/types'
import type { useSync } from '@/composables/useSync'

// ── Autosave (part of the doc state, 00 §4.1) ────────────────────────────────
// In a shared session the document autosaves: ~2 s after the last keystroke,
// immediately when leaving the editor for the preview, before a comment is
// anchored (so its line numbers refer to what the server holds), when the tab
// is hidden or closed, and on Ctrl/Cmd+S. Saves carry If-Match, so a copy
// changed elsewhere is never overwritten silently — it surfaces as a conflict.

export const AUTOSAVE_IDLE_MS = 2000

export function useAutosave(opts: {
  sync: ReturnType<typeof useSync>
  markdown: Ref<string>
  filename: Ref<string>
  paneMode: Ref<PaneMode>
  /** #23: false for a viewer — no autosave, no keepalive write, no leave prompt. */
  canWrite?: () => boolean
  /** Synchronous local-draft flush (usePersistence.flushDraft, #8): runs first on every leave. */
  flushDraft?: () => void
}) {
  const { sync, markdown, filename, paneMode } = opts
  const canWrite = () => opts.canWrite?.() ?? true
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null
      if (sync.isShared.value && sync.isDirty.value && canWrite()) sync.saveMarkdown()
    }, AUTOSAVE_IDLE_MS)
  }

  function flushAutosave(o: { keepalive?: boolean } = {}): Promise<boolean> {
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
    if (!sync.isShared.value || !canWrite()) return Promise.resolve(false)
    return sync.saveMarkdown(o)
  }

  watch(markdown, () => { if (sync.isShared.value && sync.isDirty.value) scheduleAutosave() })
  watch(filename, () => { if (sync.isShared.value && sync.isDirty.value) scheduleAutosave() })

  watch(paneMode, (mode, prev) => {
    if (prev === 'edit' && mode === 'preview' && sync.isShared.value && sync.isDirty.value) {
      flushAutosave()
    }
  })

  /** Ask before an action that would throw away unsaved edits to a shared document. */
  function confirmDiscardIfDirty(): boolean {
    if (!sync.isShared.value || !canWrite() || !(sync.isDirty.value || sync.conflict.value)) return true
    return window.confirm('You have unsaved changes to this shared document. Discard them?')
  }

  // Leaving the page: warn about unsaved edits, and push them out (keepalive).
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!sync.isShared.value || !canWrite()) return
    if (sync.isDirty.value || sync.conflict.value || sync.saveState.value === 'saving') {
      e.preventDefault()
      e.returnValue = ''
    }
  }

  function onPageHide() {
    // The one leave-page path: the local draft is written synchronously first
    // (an unload does not wait for IndexedDB), then dirty shared edits go out —
    // never for a viewer (#23).
    opts.flushDraft?.()
    if (sync.isShared.value && sync.isDirty.value && !sync.conflict.value && canWrite()) flushAutosave({ keepalive: true })
  }

  function onVisibilityChange() {
    if (document.hidden) onPageHide()
  }

  onMounted(() => {
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onUnmounted(() => {
    window.removeEventListener('beforeunload', onBeforeUnload)
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  return { flushAutosave, confirmDiscardIfDirty }
}
