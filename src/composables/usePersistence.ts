import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { Comment, ThemeMode, ContentType } from '@/types'
import { applyTheme, isValidTheme } from '@/composables/useTheme'
import { detectContentType } from '@/composables/useContentType'
import { openDraftStore, type DraftStore } from '@/composables/draftStore'

const STORAGE_KEY = 'md-review-state'
const THEME_KEY = 'md-review-theme'
const DEBOUNCE_MS = 500

interface PersistedState {
  markdown: string
  filename: string
  comments: Comment[]
  contentType?: ContentType
  /** Shared session this document belongs to, if any. */
  pasteId?: string | null
  /**
   * Server copy the local markdown was last known to match. Lets a reload
   * tell "unsaved draft" from "already saved". Omitted (with
   * baselineEqualsLocal=true) when clean, so a large document is not stored twice.
   */
  serverMarkdown?: string | null
  baselineEqualsLocal?: boolean
  savedAt?: string
}

export interface RestoredDraft {
  pasteId: string
  markdown: string
  filename: string
  /** Server content the draft was based on; null when unknown. */
  baseMarkdown: string | null
  /** True when the persisted copy was already in sync with the server. */
  clean: boolean
}

export function usePersistence(
  markdown: Ref<string>,
  filename: Ref<string>,
  comments: Ref<Comment[]>,
  contentType: Ref<ContentType>,
  loadComments: (c: Comment[]) => void,
  setAppMode: (mode: 'upload' | 'review') => void,
  options: {
    pasteId?: Ref<string | null>
    serverMarkdown?: Ref<string | null>
    /** Injected in tests; defaults to IndexedDB with a localStorage fallback. */
    store?: DraftStore
  } = {},
) {
  let restoredState: PersistedState | null = null
  let store: DraftStore | null = options.store ?? null
  /** Set when the local draft could not be written (storage full/blocked). */
  const persistError = ref<string | null>(null)
  /** Which backing store ended up in use — surfaced for diagnostics. */
  const storeKind = ref<DraftStore['kind'] | null>(null)

  function applyRestored(state: PersistedState) {
    restoredState = state
    markdown.value = state.markdown
    filename.value = state.filename
    // Back-compat: older persisted state has no contentType — re-derive it.
    contentType.value = state.contentType ?? detectContentType(state.filename, state.markdown)
    loadComments(state.comments || [])
    setAppMode('review')
    // Re-attach to the shared session this document came from, unless the
    // URL already says where to go (another share, a GitHub file, the
    // dashboard, or a dev ?filePath=). App.loadSharedDoc() then reconciles
    // the persisted draft against the server copy.
    if (state.pasteId && !window.location.hash && !window.location.search) {
      window.history.replaceState({}, '', `${window.location.pathname}#shared=${state.pasteId}`)
    }
  }

  /**
   * Resolves once the previous draft (if any) has been put back on screen.
   * App awaits this before loading anything from the URL.
   */
  const restored: Promise<boolean> = (async () => {
    try {
      store ??= await openDraftStore(STORAGE_KEY)
      storeKind.value = store.kind
      let raw = await store.get()
      // One-time migration from the old localStorage-only layout.
      if (raw === null && store.kind !== 'localstorage') {
        try {
          const legacy = localStorage.getItem(STORAGE_KEY)
          if (legacy) {
            raw = legacy
            await store.set(legacy)
            localStorage.removeItem(STORAGE_KEY)
          }
        } catch { /* no localStorage — nothing to migrate */ }
      }
      if (!raw) return false
      const state: PersistedState = JSON.parse(raw)
      if (!state.markdown || !state.filename) return false
      applyRestored(state)
      return true
    } catch {
      // Corrupted state or unusable storage — start fresh
      return false
    }
  })()

  /**
   * The persisted copy of a shared session, if that is what was restored.
   * Consumed once: after the first call the draft is gone.
   */
  function takeRestoredDraft(pasteId: string): RestoredDraft | null {
    const s = restoredState
    restoredState = null
    if (!s || s.pasteId !== pasteId) return null
    const clean = s.baselineEqualsLocal === true || (s.serverMarkdown != null && s.serverMarkdown === s.markdown)
    return {
      pasteId,
      markdown: s.markdown,
      filename: s.filename,
      baseMarkdown: clean ? s.markdown : (s.serverMarkdown ?? null),
      clean,
    }
  }

  // Save state on changes (debounced)
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> | null = null

  function snapshot(): PersistedState {
    const state: PersistedState = {
      markdown: markdown.value,
      filename: filename.value,
      comments: comments.value,
      contentType: contentType.value,
      pasteId: options.pasteId?.value ?? null,
      savedAt: new Date().toISOString(),
    }
    const base = options.serverMarkdown?.value ?? null
    if (base === null) state.serverMarkdown = null
    else if (base === markdown.value) state.baselineEqualsLocal = true
    else state.serverMarkdown = base
    return state
  }

  function persistNow(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null }
    const payload = JSON.stringify(snapshot())
    const run = async () => {
      await restored
      if (!store) return
      try {
        await store.set(payload)
        persistError.value = null
      } catch (e) {
        const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
        persistError.value = quota
          ? 'Local draft not saved: browser storage is full. Your edits still autosave to the server while shared.'
          : 'Local draft not saved: browser storage is unavailable.'
      }
    }
    // Serialise writes so an older snapshot can never land after a newer one.
    writing = (writing ?? Promise.resolve()).then(run, run)
    return writing
  }

  function scheduleSave() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { persistNow() }, DEBOUNCE_MS)
  }

  watch(() => markdown.value, scheduleSave)
  watch(() => filename.value, scheduleSave)
  watch(() => contentType.value, scheduleSave)
  watch(() => comments.value, scheduleSave, { deep: true })
  if (options.pasteId) watch(() => options.pasteId!.value, scheduleSave)
  if (options.serverMarkdown) watch(() => options.serverMarkdown!.value, scheduleSave)

  // Flush the debounce when the page is going away so the last keystrokes are
  // not lost to the 500 ms window.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { persistNow() })
  }

  async function clearPersisted() {
    restoredState = null
    if (timer) { clearTimeout(timer); timer = null }
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    await restored
    try { await store?.remove() } catch { /* ignore */ }
  }

  return { clearPersisted, takeRestoredDraft, persistNow, restored, persistError, storeKind }
}

export function useThemePersistence() {
  const stored = localStorage.getItem(THEME_KEY)
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const defaultTheme: ThemeMode = prefersDark ? 'dark' : 'light'
  const theme = ref<ThemeMode>(isValidTheme(stored) ? stored : defaultTheme)

  applyTheme(theme.value)

  function setTheme(t: ThemeMode) {
    theme.value = t
    localStorage.setItem(THEME_KEY, t)
    applyTheme(t)
  }

  return { theme, setTheme }
}
