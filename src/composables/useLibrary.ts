import { ref, shallowRef, computed, watch, onUnmounted } from 'vue'
import { PASTE_API } from '@/composables/pasteApi'
import { useReader } from '@/composables/useReader'
import { useRouter } from '@/composables/useRouter'
import { editHeaders, tokenFor, checkWriteStatus, learnAlias } from '@/composables/useEditToken'
import { toast } from '@/composables/useToast'
import { useRecent } from '@/composables/useRecent'
import {
  parseLibraryQuery, serializeLibraryQuery, hasActiveFilters, effectiveSort, apiQuery, searchTerm,
  EMPTY_QUERY, type LibraryQuery,
} from '@/composables/libraryQuery'

// ── The library page's data (#26) ────────────────────────────────────────────
// One instance per mounted LibraryView. The list state is the URL (rule 2,
// libraryQuery.ts); this composable fetches GET /library/docs for it (00 §8),
// the reader's pins (00 §7 reader_key in X-MdReview-Reader), collections and
// tags, and performs every mutation. Nothing is cached across a mutation
// (rule 18): each one refetches what it changed.

export interface SnippetSegment { text: string; hit: boolean }

export interface LibraryItem {
  id: string
  slug: string | null
  title: string
  filename: string | null
  contentType: 'markdown' | 'html'
  mode: 'publish' | 'review'
  created_by: string | null
  created_at: string | null
  updated_at: string | null
  collection: { id: string; name: string } | null
  tags: string[]
  file_count: number
  reaction_count: number | null
  view_count: number | null
  must_fix_unresolved: number
  pinned: boolean
  protected?: boolean
  match: null | { field: 'title' | 'filename' | 'content' | 'file'; file: string | null; snippet: SnippetSegment[] }
}

export interface LibraryCollection { id: string; name: string; slug?: string; doc_count: number }
export interface TagCount { tag: string; count: number }
export interface BulkResult { id: string; ok: boolean; error?: string }
export type BulkAction = 'add-tag' | 'move' | 'delete'

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** "N documents" (rule 15). */
export const countLabel = (n: number) => `${n} ${n === 1 ? 'document' : 'documents'}`

/** Edit capability for a row (#23): legacy link-editable docs, or a token this browser holds. */
export function rowCanEdit(item: { id: string; protected?: boolean }, token: (id: string) => string | null = tokenFor): boolean {
  return !item.protected || !!token(item.id)
}

/** Per-doc bulk results → ids done (not_found counts as gone), skipped for no edit access, other failures. */
export function bulkOutcome(results: BulkResult[]): { done: string[]; skipped: number; failed: number } {
  const done: string[] = []
  let skipped = 0
  let failed = 0
  for (const r of results) {
    if (r.ok || r.error === 'not_found') done.push(r.id)
    else if (r.error === 'edit_token_required' || r.error === 'edit_token_invalid') skipped++
    else failed++
  }
  return { done, skipped, failed }
}

/**
 * The rows to render for a virtual list (rule 15): those within `overscan`
 * rows of the viewport, never more than `cap`. `scrollTop` is the viewport top
 * relative to the list top (negative while the list is below it). Rows are
 * `rowHeight` tall, unless `offsets` (row tops, `count + 1` entries, the last
 * = the list height) gives each row its own height.
 */
export function virtualRange(o: { scrollTop: number; viewport: number; rowHeight: number; count: number; overscan: number; cap: number; offsets?: number[] }): { start: number; end: number } {
  const { rowHeight: h, count, overscan, cap, offsets } = o
  if (count <= 0) return { start: 0, end: 0 }
  const top = Math.max(0, o.scrollTop)
  const bottom = Math.max(0, o.scrollTop + o.viewport)
  // the row index at y (row tops ≤ y), by binary search over the offsets
  const rowAt = (y: number) => {
    if (!offsets) return Math.floor(y / h)
    let lo = 0
    let hi = count
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= y) lo = mid; else hi = mid - 1 }
    return lo
  }
  const first = Math.min(count, rowAt(top))
  const last = Math.min(count, offsets ? rowAt(bottom) + 1 : Math.ceil(bottom / h))
  let start = Math.max(0, first - overscan)
  let end = Math.min(count, Math.max(last, first) + overscan)
  if (end - start > cap) {
    // keep the viewport's rows, trim the overscan evenly
    const extra = end - start - cap
    start += Math.min(Math.floor(extra / 2), Math.max(0, first - start))
    end = start + cap
  }
  if (start >= end) start = Math.max(0, end - 1)
  return { start, end }
}

/** A phone card (rule 17) drops its tags line when it would be empty: no tags, no collection, no "+ tag". */
export function cardHasTagsLine(item: Pick<LibraryItem, 'tags' | 'collection'>, canEdit: boolean): boolean {
  return item.tags.length > 0 || !!item.collection || canEdit
}

/**
 * A row's slot height in px (a phone card's includes its 8 px gap), known
 * without measuring: desktop rows are fixed; phone cards are 2 lines (title,
 * badges + updated), + the tags line when it has content, + the search snippet.
 */
export function libraryRowHeight(phone: boolean, snippet: boolean, tagsLine: boolean): number {
  if (!phone) return snippet ? 90 : 68
  return 84 + (tagsLine ? 28 : 0) + (snippet ? 24 : 0)
}

// ── The composable ───────────────────────────────────────────────────────────

type Status = 'loading' | 'ready' | 'error'

async function readJson(res: Response): Promise<any> {
  const text = await res.text()
  try { return text ? JSON.parse(text) : null } catch { return null }
}

export function useLibrary() {
  const router = useRouter()
  const { readerHeader, readerKey } = useReader()
  const recent = useRecent()

  const onLibrary = computed(() => router.current.value.route.kind === 'library')
  /** The URL's list state (frozen while another route is on screen). */
  const lastSearch = ref(onLibrary.value ? router.current.value.search : '')
  watch(() => router.current.value, (loc) => { if (loc.route.kind === 'library') lastSearch.value = loc.search })
  const query = computed<LibraryQuery>(() => parseLibraryQuery(lastSearch.value))

  const items = shallowRef<LibraryItem[]>([])
  const pinnedItems = shallowRef<LibraryItem[]>([])
  const total = ref(0)
  const nextCursor = ref<string | null>(null)
  const status = ref<Status>('loading')
  const loadingMore = ref(false)
  const collections = shallowRef<LibraryCollection[]>([])
  const tags = shallowRef<TagCount[]>([])
  /** View counts are reported (#25 shipped): the `views` sort is offered. */
  const viewsAvailable = ref(true)
  const filtersActive = computed(() => hasActiveFilters(query.value))
  const sort = computed(() => effectiveSort(query.value, viewsAvailable.value))

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${PASTE_API}${path}`, { ...init, headers: { ...readerHeader.value, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> || {}) } })

  let gen = 0
  /** Identity of the current result set: a URL change that does not change it sends no request. */
  const resultKey = computed(() => JSON.stringify([searchTerm(query.value.q), query.value.collection, query.value.tag,
    query.value.mode, query.value.type, query.value.updated, sort.value, readerKey.value]))

  function noteItems(list: LibraryItem[]) {
    for (const it of list) learnAlias(it.id, it.slug)
    const withCounts = list.find((x) => x.view_count !== undefined)
    if (withCounts) viewsAvailable.value = withCounts.view_count !== null
  }

  async function fetchPage(cursor: string | null) {
    const res = await api(`/library/docs?${apiQuery(query.value, Date.now(), viewsAvailable.value, cursor)}`)
    if (!res.ok) throw new Error(`library ${res.status}`)
    return readJson(res) as Promise<{ total: number; next_cursor: string | null; items: LibraryItem[] }>
  }

  async function fetchPinned(): Promise<LibraryItem[]> {
    const res = await api('/library/docs?pinned=1&limit=50')
    if (!res.ok) return []
    const data = await readJson(res)
    const list: LibraryItem[] = Array.isArray(data?.items) ? data.items : []
    return list.filter((x) => x.pinned)
  }

  /** (Re)load the first page (and the pinned section when no filter is on). */
  async function load({ quiet = false } = {}) {
    const my = ++gen
    if (!quiet) status.value = 'loading'
    try {
      const [page, pinned] = await Promise.all([fetchPage(null), filtersActive.value ? Promise.resolve([]) : fetchPinned()])
      if (my !== gen) return
      noteItems(page.items)
      noteItems(pinned)
      items.value = page.items
      total.value = page.total
      nextCursor.value = page.next_cursor
      pinnedItems.value = pinned
      status.value = 'ready'
    } catch {
      if (my !== gen) return
      status.value = 'error'
    }
  }

  async function loadMore() {
    if (!nextCursor.value || loadingMore.value || status.value !== 'ready') return
    const my = gen
    loadingMore.value = true
    try {
      const page = await fetchPage(nextCursor.value)
      if (my !== gen) return
      noteItems(page.items)
      const seen = new Set(items.value.map((x) => x.id))
      items.value = [...items.value, ...page.items.filter((x) => !seen.has(x.id))]
      total.value = page.total
      nextCursor.value = page.next_cursor
    } catch {
      if (my === gen) toast.error('Could not load more documents')
    } finally {
      loadingMore.value = false
    }
  }

  async function loadSide() {
    try {
      const [c, t] = await Promise.all([api('/library/collections'), api('/library/tags')])
      if (c.ok) collections.value = (await readJson(c)) ?? []
      if (t.ok) tags.value = (await readJson(t)) ?? []
    } catch { /* the list's own error state covers an unreachable API */ }
  }

  function reload() { void load(); void loadSide() }

  watch(resultKey, () => { if (onLibrary.value) void load() })
  // Back on the library after a doc: whatever changed elsewhere shows (rule 18).
  watch(onLibrary, (on) => { if (on) reload() })

  // ── URL updates (rule 2) ──
  function setQuery(patch: Partial<LibraryQuery>, opts: { replace?: boolean } = {}) {
    const next = { ...query.value, ...patch }
    const url = `${router.base}library${serializeLibraryQuery(next)}`
    if (opts.replace) router.replace(url)
    else router.push(url)
  }
  /** Rule 6: q and every filter go; the chosen sort stays (sort is not a filter). */
  function clearFilters() {
    setQuery({ ...EMPTY_QUERY, sort: query.value.sort && query.value.sort !== 'relevance' ? query.value.sort : '' })
  }

  // ── Pins (rules 8/9) ──
  function patchItem(id: string, patch: Partial<LibraryItem>) {
    const apply = (list: LibraryItem[]) => list.map((x) => (x.id === id ? { ...x, ...patch } : x))
    items.value = apply(items.value)
    pinnedItems.value = apply(pinnedItems.value)
  }

  async function togglePin(item: LibraryItem) {
    const pin = !item.pinned
    patchItem(item.id, { pinned: pin })
    try {
      const res = await api(`/library/pins/${encodeURIComponent(item.id)}`, { method: pin ? 'PUT' : 'DELETE' })
      if (res.status === 409) {
        patchItem(item.id, { pinned: !pin })
        toast.error('Pin limit reached (50) — unpin a document first')
        return
      }
      if (!res.ok) throw new Error(String(res.status))
    } catch {
      patchItem(item.id, { pinned: !pin })
      toast.error(pin ? 'Could not pin the document' : 'Could not unpin the document')
      return
    }
    void load({ quiet: true })
  }

  // ── Tags (rule 12) ──
  /** Replace a doc's tags. Returns null on success, else an error sentence. */
  async function saveTags(item: LibraryItem, next: string[]): Promise<string | null> {
    try {
      const res = await api(`/paste/${encodeURIComponent(item.id)}/tags`, { method: 'PUT', body: JSON.stringify({ tags: next }), headers: editHeaders(item.id) })
      checkWriteStatus(item.id, res.status)
      const data = await readJson(res)
      if (!res.ok) return data?.error || (res.status === 401 || res.status === 403 ? 'No edit access to this document' : 'Could not save the tag')
      patchItem(item.id, { tags: Array.isArray(data?.tags) ? data.tags : next })
      void loadSide()
      return null
    } catch { return 'Could not reach the server' }
  }

  // ── Collections (rule 11) ──
  async function createCollection(name: string): Promise<string | null> {
    try {
      const res = await api('/library/collections', { method: 'POST', body: JSON.stringify({ name }) })
      const data = await readJson(res)
      if (!res.ok) return data?.error || 'Could not create the collection'
      void loadSide()
      return null
    } catch { return 'Could not reach the server' }
  }

  async function renameCollection(id: string, name: string): Promise<string | null> {
    try {
      const res = await api(`/library/collections/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) })
      const data = await readJson(res)
      if (!res.ok) return data?.error || 'Could not rename the collection'
      reload()
      return null
    } catch { return 'Could not reach the server' }
  }

  async function deleteCollection(id: string): Promise<boolean> {
    try {
      const res = await api(`/library/collections/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(String(res.status))
    } catch {
      toast.error('Could not delete the collection')
      return false
    }
    if (query.value.collection === id) setQuery({ collection: '' })
    reload()
    return true
  }

  // ── Bulk (rules 13/14) ──
  async function bulk(action: BulkAction, ids: string[], extra: { tag?: string; collectionId?: string | null } = {}): Promise<boolean> {
    const editTokens: Record<string, string> = {}
    for (const id of ids) { const t = tokenFor(id); if (t) editTokens[id] = t }
    let results: BulkResult[]
    try {
      const res = await api('/library/bulk', { method: 'POST', body: JSON.stringify({ action, ids, ...extra, editTokens }) })
      const data = await readJson(res)
      if (!res.ok) { toast.error(data?.error || 'The bulk action failed'); return false }
      results = Array.isArray(data?.results) ? data.results : []
    } catch {
      toast.error('Could not reach the server')
      return false
    }
    const { done, skipped, failed } = bulkOutcome(results)
    if (action === 'delete') recent.remove(done)
    const verb = action === 'delete' ? 'Deleted' : action === 'move' ? 'Moved' : 'Tagged'
    if (done.length) toast.success(`${verb} ${countLabel(done.length)}`)
    if (skipped) toast.info(`${skipped} skipped — no edit access`)
    if (failed) toast.error(`${failed} could not be changed`)
    reload()
    return true
  }

  // A stale list must not linger when the component goes (a later mount refetches).
  onUnmounted(() => { gen++ })

  return {
    query, items, pinnedItems, total, nextCursor, status, loadingMore, collections, tags,
    viewsAvailable, filtersActive, sort, recent: recent.entries,
    load, loadMore, loadSide, reload, setQuery, clearFilters,
    togglePin, saveTags, createCollection, renameCollection, deleteCollection, bulk,
  }
}
