import { ref } from 'vue'

// ── Recently viewed docs (#26 rule 10) ───────────────────────────────────────
// Local to this browser (localStorage md-review-recent): opening /d/:slug
// records {id, slug, title, viewedAt}, most recent first, de-duplicated by id,
// at most RECENT_MAX. The library shows the latest RECENT_SHOWN.

export const RECENT_KEY = 'md-review-recent'
export const RECENT_MAX = 20
export const RECENT_SHOWN = 8

export interface RecentEntry {
  id: string
  slug: string | null
  title: string
  /** ISO time of the last open. */
  viewedAt: string
}

const isEntry = (x: unknown): x is RecentEntry => {
  if (!x || typeof x !== 'object') return false
  const e = x as Record<string, unknown>
  return typeof e.id === 'string' && !!e.id && typeof e.title === 'string' && typeof e.viewedAt === 'string'
    && (e.slug === null || e.slug === undefined || typeof e.slug === 'string')
}

/** Stored JSON → entries; junk reads as an empty list (never throws). */
export function parseRecent(raw: string | null): RecentEntry[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(isEntry).map((e) => ({ id: e.id, slug: e.slug ?? null, title: e.title, viewedAt: e.viewedAt }))
  } catch { return [] }
}

/** `entry` moved to the front (any older entry for its id dropped), capped at `max`. */
export function addRecent(list: RecentEntry[], entry: RecentEntry, max = RECENT_MAX): RecentEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, max)
}

export function removeRecent(list: RecentEntry[], ids: string[]): RecentEntry[] {
  const gone = new Set(ids)
  return list.filter((e) => !gone.has(e.id))
}

function read(): RecentEntry[] {
  try { return parseRecent(localStorage.getItem(RECENT_KEY)) } catch { return [] }
}

function write(list: RecentEntry[]) {
  try {
    if (list.length) localStorage.setItem(RECENT_KEY, JSON.stringify(list))
    else localStorage.removeItem(RECENT_KEY)
  } catch { /* storage unavailable: this page only */ }
}

const entries = ref<RecentEntry[]>(read())

export function useRecent() {
  /** Re-read storage (another tab may have written). */
  function refresh() { entries.value = read() }
  function record(e: { id: string; slug: string | null; title: string }) {
    const list = addRecent(read(), { id: e.id, slug: e.slug || null, title: e.title, viewedAt: new Date().toISOString() })
    entries.value = list
    write(list)
  }
  function remove(ids: string[]) {
    const list = removeRecent(read(), ids)
    entries.value = list
    write(list)
  }
  return { entries, refresh, record, remove }
}

// ── Recording from the app shell (lazy: kept out of the entry chunk, #6 AC-06.8) ──
type Seen = { id: string; slug: string | null; title: string }
let lastId: string | null = null
let titleNext: Seen | null = null
let titleTimer: ReturnType<typeof setTimeout> | undefined
function flushTitle() { clearTimeout(titleTimer); if (titleNext) useRecent().record(titleNext); titleNext = null }

/**
 * The shared doc on screen at /d/:slug (null = none). A newly opened doc is
 * recorded at once; a title (or slug) change of the open one is debounced, so
 * an editor typing its first heading does not write storage per keystroke.
 */
export function noteRecent(e: Seen | null) {
  if (e && e.id === lastId) {
    clearTimeout(titleTimer)
    titleNext = e
    titleTimer = setTimeout(flushTitle, 800)
    return
  }
  flushTitle()
  lastId = e ? e.id : null
  if (e) useRecent().record(e)
}
