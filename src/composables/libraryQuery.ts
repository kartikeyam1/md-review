// ── Library list state in the URL (#26 rule 2) ───────────────────────────────
// Every control of the library page lives in the query string: q, collection
// (id | 'none'), tag, mode, type, updated (7d|30d|90d), sort. Pure helpers,
// shared by useLibrary and the unit tests.

export type LibSort = 'updated' | 'created' | 'title' | 'views' | 'relevance'
export type UpdatedWindow = '' | '7d' | '30d' | '90d'

export interface LibraryQuery {
  q: string
  collection: string
  tag: string
  mode: '' | 'publish' | 'review'
  type: '' | 'md' | 'html'
  updated: UpdatedWindow
  /** '' = the default for the current q (updated, or relevance with a search). */
  sort: '' | LibSort
}

export const EMPTY_QUERY: Readonly<LibraryQuery> = Object.freeze({ q: '', collection: '', tag: '', mode: '', type: '', updated: '', sort: '' })

export const UPDATED_DAYS: Record<Exclude<UpdatedWindow, ''>, number> = { '7d': 7, '30d': 30, '90d': 90 }
export const PAGE_SIZE = 50
/** Queries shorter than this are ignored (rule 5): no request, list mode. */
export const MIN_QUERY_LENGTH = 2

const SORTS: LibSort[] = ['updated', 'created', 'title', 'views', 'relevance']
const ORDER: (keyof LibraryQuery)[] = ['q', 'collection', 'tag', 'mode', 'type', 'updated', 'sort']

export function parseLibraryQuery(search: string): LibraryQuery {
  const p = new URLSearchParams(search)
  const get = (k: string) => (p.get(k) ?? '').trim()
  const mode = get('mode')
  const type = get('type')
  const updated = get('updated')
  const sort = get('sort')
  return {
    q: p.get('q') ?? '',
    collection: get('collection'),
    tag: get('tag').toLowerCase(),
    mode: mode === 'publish' || mode === 'review' ? mode : '',
    type: type === 'md' || type === 'html' ? type : '',
    updated: updated in UPDATED_DAYS ? (updated as UpdatedWindow) : '',
    sort: (SORTS as string[]).includes(sort) ? (sort as LibSort) : '',
  }
}

/** `?a=b&…` in a fixed order (empty values omitted), or '' for the bare page. */
export function serializeLibraryQuery(s: LibraryQuery): string {
  const p = new URLSearchParams()
  for (const k of ORDER) if (s[k]) p.set(k, s[k])
  const qs = p.toString()
  return qs ? `?${qs}` : ''
}

/** The search actually sent: trimmed, '' when shorter than MIN_QUERY_LENGTH. */
export function searchTerm(q: string): string {
  const t = q.trim()
  return t.length >= MIN_QUERY_LENGTH ? t : ''
}

/** A search or any filter is on (rules 9/10 hide the pinned and recent sections then). */
export function hasActiveFilters(s: LibraryQuery): boolean {
  return !!(searchTerm(s.q) || s.collection || s.tag || s.mode || s.type || s.updated)
}

/** Sort options offered (rule 7): relevance only with a search, views only with view counts. */
export function sortOptions(s: LibraryQuery, viewsAvailable: boolean): LibSort[] {
  const out: LibSort[] = searchTerm(s.q) ? ['relevance'] : []
  out.push('updated', 'created', 'title')
  if (viewsAvailable) out.push('views')
  return out
}

/** The sort in effect: the chosen one when offered, else the default for the current q. */
export function effectiveSort(s: LibraryQuery, viewsAvailable: boolean): LibSort {
  const offered = sortOptions(s, viewsAvailable)
  if (s.sort && offered.includes(s.sort)) return s.sort
  return searchTerm(s.q) ? 'relevance' : 'updated'
}

/**
 * The `sort` URL value for choosing `v`: '' when `v` is the default for the
 * current q, so picking "Recently updated" again restores the bare URL and a
 * later search falls back to relevance (rule 5).
 */
export function sortParam(s: LibraryQuery, v: LibSort): '' | LibSort {
  return v === (searchTerm(s.q) ? 'relevance' : 'updated') ? '' : v
}

export const SORT_LABELS: Record<LibSort, string> = {
  relevance: 'Relevance', updated: 'Recently updated', created: 'Recently created', title: 'Title A–Z', views: 'Most viewed',
}

/** Query string (no `?`) for GET /library/docs (00 §8). */
export function apiQuery(s: LibraryQuery, nowMs: number, viewsAvailable: boolean, cursor?: string | null): string {
  const p = new URLSearchParams()
  const term = searchTerm(s.q)
  if (term) p.set('q', term)
  if (s.collection) p.set('collection', s.collection)
  if (s.tag) p.set('tag', s.tag)
  if (s.mode) p.set('mode', s.mode)
  if (s.type) p.set('type', s.type)
  if (s.updated) p.set('updated_after', new Date(nowMs - UPDATED_DAYS[s.updated] * 86_400_000).toISOString())
  p.set('sort', effectiveSort(s, viewsAvailable))
  p.set('limit', String(PAGE_SIZE))
  if (cursor) p.set('cursor', cursor)
  return p.toString()
}
