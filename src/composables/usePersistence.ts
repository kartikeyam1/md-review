import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { Comment, ThemeMode, ContentType } from '@/types'
import { applyTheme, isValidTheme } from '@/composables/useTheme'
import { detectContentType } from '@/composables/useContentType'

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
  } = {},
) {
  let restored: PersistedState | null = null

  // Restore state on init
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const state: PersistedState = JSON.parse(raw)
      if (state.markdown && state.filename) {
        restored = state
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
    }
  } catch {
    // Corrupted state — ignore
  }

  /**
   * The persisted copy of a shared session, if that is what was restored.
   * Consumed once: after the first call the draft is gone.
   */
  function takeRestoredDraft(pasteId: string): RestoredDraft | null {
    const s = restored
    restored = null
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

  function persistNow() {
    if (timer) { clearTimeout(timer); timer = null }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()))
    } catch {
      // Storage full — silently ignore
    }
  }

  function scheduleSave() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persistNow, DEBOUNCE_MS)
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
    window.addEventListener('pagehide', persistNow)
  }

  function clearPersisted() {
    restored = null
    if (timer) { clearTimeout(timer); timer = null }
    localStorage.removeItem(STORAGE_KEY)
  }

  return { clearPersisted, takeRestoredDraft, persistNow }
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
