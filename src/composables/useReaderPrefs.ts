import { ref, type Ref } from 'vue'

// Reader font size + content width (#18). Per browser tab: read once from
// localStorage at first use, written on every change, never synced (a second
// tab keeps its own until it reloads). All storage access is guarded — with
// storage unavailable the controls still work for the session.
//
// The prefs act through <html>: `--reader-scale` (preview.css sizes type with
// it) and `data-reader-width`. index.html's boot script sets both before first
// paint; this module keeps them current. Only lazy chunks import it (the panel,
// the preview enhancer that mirrors the state onto the pane) — #6 entry budget.

export type ReaderWidth = 'narrow' | 'wide'
export interface ReaderPrefs { fontScale: number; width: ReaderWidth }

/** Text size steps, in percent of the style's base size (15px Default/Locus, 16px GitHub). */
export const FONT_SCALES = [80, 90, 100, 110, 120, 135, 150] as const
export const DEFAULT_READER_PREFS: Readonly<ReaderPrefs> = Object.freeze({ fontScale: 100, width: 'narrow' })
export const READER_PREFS_KEY = 'md-review-reader-prefs'

const isScale = (v: unknown): v is number => typeof v === 'number' && (FONT_SCALES as readonly number[]).includes(v)
const isWidth = (v: unknown): v is ReaderWidth => v === 'narrow' || v === 'wide'

/** The neighbouring step in `dir`, clamped at the ends; an off-list value counts as 100. */
export function stepFontScale(current: number, dir: 1 | -1): number {
  const list = FONT_SCALES as readonly number[]
  let i = list.indexOf(current)
  if (i < 0) i = list.indexOf(DEFAULT_READER_PREFS.fontScale)
  return list[Math.min(list.length - 1, Math.max(0, i + dir))]
}

/** Sanitised prefs from the stored string; each invalid or missing field falls back on its own. */
export function parseReaderPrefs(raw: string | null): ReaderPrefs {
  let data: unknown = null
  try { data = raw == null ? null : JSON.parse(raw) } catch { data = null }
  const o = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  return {
    fontScale: isScale(o.fontScale) ? o.fontScale : DEFAULT_READER_PREFS.fontScale,
    width: isWidth(o.width) ? o.width : DEFAULT_READER_PREFS.width,
  }
}

let state: { fontScale: Ref<number>; width: Ref<ReaderWidth> } | null = null

function load(): ReaderPrefs {
  try { return parseReaderPrefs(localStorage.getItem(READER_PREFS_KEY)) } catch { return parseReaderPrefs(null) }
}

/** Put the prefs on <html> (mirrored by the index.html boot script). */
export function applyReaderPrefs(p: ReaderPrefs): void {
  const h = document.documentElement
  h.style.setProperty('--reader-scale', String(p.fontScale / 100))
  h.setAttribute('data-reader-width', p.width)
}

function save() {
  if (!state) return
  applyReaderPrefs({ fontScale: state.fontScale.value, width: state.width.value })
  try { localStorage.setItem(READER_PREFS_KEY, JSON.stringify({ fontScale: state.fontScale.value, width: state.width.value })) } catch { /* session only */ }
}

export function useReaderPrefs() {
  if (!state) {
    const p = load()
    state = { fontScale: ref(p.fontScale), width: ref(p.width) }
    applyReaderPrefs(p)
  }
  const { fontScale, width } = state
  const setScale = (n: number) => { if (n !== fontScale.value) { fontScale.value = n; save() } }
  return {
    fontScale,
    width,
    increase: () => setScale(stepFontScale(fontScale.value, 1)),
    decrease: () => setScale(stepFontScale(fontScale.value, -1)),
    reset: () => setScale(DEFAULT_READER_PREFS.fontScale),
    setWidth: (w: ReaderWidth) => { if (isWidth(w) && w !== width.value) { width.value = w; save() } },
  }
}
