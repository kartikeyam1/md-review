import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { Comment, ThemeMode } from '@/types'

const STORAGE_KEY = 'md-review-state'
const THEME_KEY = 'md-review-theme'
const DEBOUNCE_MS = 500

interface PersistedState {
  markdown: string
  filename: string
  comments: Comment[]
}

export function usePersistence(
  markdown: Ref<string>,
  filename: Ref<string>,
  comments: Ref<Comment[]>,
  loadComments: (c: Comment[]) => void,
  setAppMode: (mode: 'upload' | 'review') => void,
) {
  // Restore state on init
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const state: PersistedState = JSON.parse(raw)
      if (state.markdown && state.filename) {
        markdown.value = state.markdown
        filename.value = state.filename
        loadComments(state.comments || [])
        setAppMode('review')
      }
    }
  } catch {
    // Corrupted state — ignore
  }

  // Save state on changes (debounced)
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleSave() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const state: PersistedState = {
        markdown: markdown.value,
        filename: filename.value,
        comments: comments.value,
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch {
        // Storage full — silently ignore
      }
    }, DEBOUNCE_MS)
  }

  watch(() => markdown.value, scheduleSave)
  watch(() => filename.value, scheduleSave)
  watch(() => comments.value, scheduleSave, { deep: true })

  function clearPersisted() {
    localStorage.removeItem(STORAGE_KEY)
  }

  return { clearPersisted }
}

export function useThemePersistence() {
  const stored = localStorage.getItem(THEME_KEY) as ThemeMode | null
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme = ref<ThemeMode>(stored || (prefersDark ? 'dark' : 'light'))

  function applyTheme(t: ThemeMode) {
    document.documentElement.classList.toggle('dark', t === 'dark')
  }

  applyTheme(theme.value)

  function setTheme(t: ThemeMode) {
    theme.value = t
    localStorage.setItem(THEME_KEY, t)
    applyTheme(t)
  }

  return { theme, setTheme }
}
