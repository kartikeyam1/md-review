import { ref, watch, onScopeDispose, type Ref } from 'vue'
import { getReaderId } from '@/composables/useReader'
import { useReviewer } from '@/composables/useReviewer'
import { editHeaders } from '@/composables/useEditToken'
import { PASTE_API } from '@/composables/pasteApi'

// ── View counts and named readers (#25) ──────────────────────────────────────
// Records this browser's view of a shared doc (or pinned revision) once it has
// been rendered and the tab visible for 2 s in a row — at most one POST per doc
// per page load, plus one each time the rendered revision changes — and loads
// the stats: counts for everyone, the reader list for editors (the server
// decides from the edit token sent with editHeaders). Never for embeds, the dev
// ?filePath= loader or unsaved local docs (docState makes those ineligible).
// No polling: stats load with the doc and after the reader's own view is recorded.

/** Visible-dwell before a view counts (rule 3). */
export const VIEW_DWELL_MS = 2000

export interface ReaderEntry {
  name: string
  last_viewed_at: string
  revision: string | null
  is_current: boolean
  views: number
}

export interface ViewStatsBody {
  total_views: number
  unique_readers: number
  last_viewed_at: string | null
  /** Editors only. */
  readers?: ReaderEntry[]
  anonymous_readers?: number
}

/** Pure: "{n} views · {m} readers" with singular forms for 1; '' when nothing was viewed (hidden). */
export function viewStatsLabel(s: Pick<ViewStatsBody, 'total_views' | 'unique_readers'> | null): string {
  if (!s || !s.total_views) return ''
  const one = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  return `${one(s.total_views, 'view')} · ${one(s.unique_readers, 'reader')}`
}

export type Views = ReturnType<typeof createViews>

export function createViews(opts: {
  /** The doc on screen (id or slug of a shared doc / pinned revision's doc), else null. */
  docId: Ref<string | null>
  /** Content hash of what is rendered (null = unknown: the server uses its current hash). */
  revision: Ref<string | null>
  /** Rendered, on its own route, not an embed. */
  eligible: Ref<boolean>
  /** Changes when this browser's edit access to the doc changes (the stats body depends on it). */
  accessKey?: Ref<string>
}) {
  const { reviewerName } = useReviewer()
  const stats = ref<ViewStatsBody | null>(null)
  /** Per doc: the revision whose view this page load already recorded. */
  const recorded = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let loadSeq = 0

  const api = (id: string) => `${PASTE_API}/paste/${encodeURIComponent(id)}/views`
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null } }

  async function load() {
    const id = opts.docId.value
    const seq = ++loadSeq
    if (!id) { stats.value = null; return }
    try {
      const res = await fetch(api(id), { headers: editHeaders(id) })
      // Always read the body: an unread response keeps its request open (and the page never network-idle).
      const body = res.ok ? await res.json() as ViewStatsBody : (await res.text(), null)
      if (seq !== loadSeq || opts.docId.value !== id) return
      stats.value = body
    } catch { /* offline: keep what we show */ }
  }

  async function record(id: string, rev: string | null) {
    const key = rev ?? ''
    recorded.set(id, key)
    const name = reviewerName.value.trim()
    try {
      const res = await fetch(api(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...editHeaders(id) },
        body: JSON.stringify({ reader_id: getReaderId(), ...(name ? { name } : {}), ...(rev ? { revision: rev } : {}) }),
      })
      await res.text().catch(() => '') // always read the body (see load)
      if (!res.ok && res.status >= 500) recorded.delete(id) // try again on the next chance
    } catch { recorded.delete(id) }
    if (opts.docId.value === id) void load()
  }

  /** (Re)start the visible-dwell timer for what is on screen now. */
  function schedule() {
    cancel()
    const id = opts.docId.value
    const rev = opts.revision.value
    if (!id || !opts.eligible.value) return
    if (recorded.get(id) === (rev ?? '')) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    timer = setTimeout(() => {
      timer = null
      // Still the same doc and revision, still visible.
      if (opts.docId.value !== id || opts.revision.value !== rev || !opts.eligible.value) return
      void record(id, rev)
    }, VIEW_DWELL_MS)
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') cancel()
    else schedule()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

  watch([opts.docId, opts.revision, opts.eligible], schedule, { immediate: true })
  watch(opts.docId, () => { stats.value = null; void load() }, { immediate: true })
  if (opts.accessKey) watch(opts.accessKey, () => { void load() })
  // A reader who names themselves after their view was counted: the same row of the day gains the name.
  watch(() => reviewerName.value.trim(), (name, prev) => {
    const id = opts.docId.value
    if (!name || prev || !id || !opts.eligible.value || !recorded.has(id)) return
    void record(id, opts.revision.value)
  })

  onScopeDispose(() => {
    cancel()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  })

  return { stats, load }
}
