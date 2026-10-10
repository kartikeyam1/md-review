import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { Comment, ThemeMode, ContentType, DocMode } from '@/types'
import { payloadMode } from '@/composables/docMeta'
import { applyTheme, isValidTheme } from '@/composables/useTheme'
import { detectContentType } from '@/composables/useContentType'
import { openDraftStore, createMemoryStore, type DraftStore } from '@/composables/draftStore'

const STORAGE_KEY = 'md-review-state'
/**
 * The never-shared local draft, kept apart from the main slot: opening a
 * shared doc rewrites the main slot, and must not cost the reader the local
 * doc they were writing (spec #4).
 */
const LOCAL_KEY = 'md-review-local-draft'
const LOCAL_RECORD = 'local'
const THEME_KEY = 'md-review-theme'
const DEBOUNCE_MS = 500

export interface PersistedState {
  markdown: string
  filename: string
  comments: Comment[]
  contentType?: ContentType
  /** Doc mode (#2). Drafts from before it have none and restore as review. */
  mode?: DocMode
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
  mode: DocMode
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
    /** Doc mode (#2), stored with the draft. */
    mode?: Ref<DocMode>
    /** Injected in tests; defaults to IndexedDB with a localStorage fallback. */
    store?: DraftStore
    /** Slot for the never-shared local draft (tests); defaults like `store`, or memory when `store` is injected. */
    localStore?: DraftStore
    /**
     * While true, nothing is written: read-only views (pinned revisions, file
     * routes, embeds) and content that is not the current route's must not
     * overwrite the reader's own draft.
     */
    paused?: () => boolean
  } = {},
) {
  let restoredState: PersistedState | null = null
  let store: DraftStore | null = options.store ?? null
  let localStore: DraftStore | null = options.localStore ?? (options.store ? createMemoryStore() : null)
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
    if (options.mode) options.mode.value = payloadMode(state.mode)
    setAppMode('review')
    // The URL is App's business (spec #4 rule 9): it reads restoredInfo() and
    // decides whether the landing route should become d/<pasteId>.
  }

  function isClean(s: PersistedState): boolean {
    return s.baselineEqualsLocal === true || (s.serverMarkdown != null && s.serverMarkdown === s.markdown)
  }

  /** What was restored, without consuming it: the shared session (if any) and whether it has unsaved edits. */
  function restoredInfo(): { pasteId: string | null; dirty: boolean } | null {
    const s = restoredState
    if (!s) return null
    return { pasteId: s.pasteId ?? null, dirty: !!s.pasteId && !isClean(s) }
  }

  /**
   * Resolves once the previous draft (if any) has been put back on screen.
   * App awaits this before loading anything from the URL.
   */
  const restored: Promise<boolean> = (async () => {
    try {
      store ??= await openDraftStore(STORAGE_KEY)
      storeKind.value = store.kind
      try { localStore ??= await openDraftStore(LOCAL_KEY, LOCAL_RECORD) } catch { localStore = createMemoryStore() }
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
    const clean = isClean(s)
    return {
      pasteId,
      markdown: s.markdown,
      filename: s.filename,
      baseMarkdown: clean ? s.markdown : (s.serverMarkdown ?? null),
      clean,
      mode: payloadMode(s.mode),
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
      ...(options.mode ? { mode: options.mode.value } : {}),
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
    if (options.paused?.()) return writing ?? Promise.resolve()
    const snap = snapshot()
    // Nothing on screen, nothing to keep (an explicit clear is clearPersisted).
    if (!snap.markdown && !snap.filename) return writing ?? Promise.resolve()
    const payload = JSON.stringify(snap)
    // A never-shared doc with content is also the local draft.
    const isLocal = !snap.pasteId && !!(snap.markdown || snap.filename)
    const run = async () => {
      await restored
      if (!store) return
      try {
        await store.set(payload)
        if (isLocal) await localStore?.set(payload)
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
  if (options.mode) watch(() => options.mode!.value, scheduleSave)

  // Flush the debounce when the page is going away so the last keystrokes are
  // not lost to the 500 ms window.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { persistNow() })
  }

  /** Drop the persisted draft. `keepLocal` leaves the never-shared local draft alone. */
  async function clearPersisted(opts: { keepLocal?: boolean } = {}) {
    restoredState = null
    if (timer) { clearTimeout(timer); timer = null }
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    await restored
    try { await store?.remove() } catch { /* ignore */ }
    if (!opts.keepLocal) await forgetLocalDraft()
  }

  /** The never-shared local draft, if one is stored. */
  async function loadLocalDraft(): Promise<(Pick<PersistedState, 'markdown' | 'filename' | 'comments' | 'contentType'> & { mode: DocMode }) | null> {
    await restored
    try {
      const raw = await localStore?.get()
      if (!raw) return null
      const s = JSON.parse(raw) as PersistedState
      if (!s.markdown || !s.filename || s.pasteId) return null
      return { markdown: s.markdown, filename: s.filename, comments: s.comments || [], contentType: s.contentType ?? detectContentType(s.filename, s.markdown), mode: payloadMode(s.mode) }
    } catch { return null }
  }

  /** The local doc became shared (or was discarded): it is no longer a local draft. */
  function forgetLocalDraft(): Promise<void> {
    const run = async () => {
      await restored
      try { await localStore?.remove() } catch { /* ignore */ }
    }
    // Queued behind pending writes, so an older local snapshot cannot land after it.
    writing = (writing ?? Promise.resolve()).then(run, run)
    return writing
  }

  return { clearPersisted, takeRestoredDraft, restoredInfo, loadLocalDraft, forgetLocalDraft, persistNow, restored, persistError, storeKind }
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
