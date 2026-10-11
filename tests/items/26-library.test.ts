// #26 library — unit tests for the pure logic: URL state (rule 2), sort options (rule 7),
// the recently-viewed list (rule 10), the virtual window (rule 15), bulk outcomes (rule 13)
// and labels. Browser behaviour: tests/e2e/items/26-library.test.mjs.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseLibraryQuery, serializeLibraryQuery, hasActiveFilters, effectiveSort, sortOptions,
  apiQuery, searchTerm, sortParam, EMPTY_QUERY, type LibraryQuery,
} from '@/composables/libraryQuery'
import { addRecent, removeRecent, parseRecent, useRecent, RECENT_KEY, RECENT_MAX, type RecentEntry } from '@/composables/useRecent'
import { virtualRange, bulkOutcome, countLabel, rowCanEdit, libraryRowHeight, cardHasTagsLine } from '@/composables/useLibrary'

const q = (over: Partial<LibraryQuery> = {}): LibraryQuery => ({ ...EMPTY_QUERY, ...over })

describe('URL state (rule 2)', () => {
  it('parses every control from the query string', () => {
    expect(parseLibraryQuery('?q=kumquat&collection=abc&tag=Ops&mode=review&type=md&updated=30d&sort=title')).toEqual({
      q: 'kumquat', collection: 'abc', tag: 'ops', mode: 'review', type: 'md', updated: '30d', sort: 'title',
    })
    expect(parseLibraryQuery('')).toEqual(EMPTY_QUERY)
    expect(parseLibraryQuery('?collection=none').collection).toBe('none')
  })

  it('drops invalid values instead of passing them on', () => {
    expect(parseLibraryQuery('?mode=draft&type=pdf&updated=1y&sort=random')).toEqual(EMPTY_QUERY)
  })

  it('serialises in a fixed order, omits empty values, and round-trips', () => {
    const s = q({ q: 'a b', tag: 'ops', mode: 'review', sort: 'created' })
    expect(serializeLibraryQuery(s)).toBe('?q=a+b&tag=ops&mode=review&sort=created')
    expect(parseLibraryQuery(serializeLibraryQuery(s))).toEqual(s)
    expect(serializeLibraryQuery(EMPTY_QUERY)).toBe('')
  })

  it('active filters: any filter or a search of ≥ 2 characters', () => {
    expect(hasActiveFilters(EMPTY_QUERY)).toBe(false)
    expect(hasActiveFilters(q({ q: 'k' }))).toBe(false)
    expect(hasActiveFilters(q({ q: 'ku' }))).toBe(true)
    expect(hasActiveFilters(q({ sort: 'title' }))).toBe(false)
    for (const f of [{ collection: 'x' }, { tag: 'a' }, { mode: 'publish' as const }, { type: 'html' as const }, { updated: '7d' as const }]) {
      expect(hasActiveFilters(q(f))).toBe(true)
    }
  })

  it('searchTerm trims and ignores one-character queries', () => {
    expect(searchTerm('  kum ')).toBe('kum')
    expect(searchTerm(' k ')).toBe('')
    expect(searchTerm('')).toBe('')
  })
})

describe('sort (rule 7)', () => {
  it('default is updated without q, relevance with q', () => {
    expect(effectiveSort(EMPTY_QUERY, true)).toBe('updated')
    expect(effectiveSort(q({ q: 'kumquat' }), true)).toBe('relevance')
    expect(effectiveSort(q({ q: 'kumquat', sort: 'title' }), true)).toBe('title')
  })
  it('relevance needs q; views needs view counts', () => {
    expect(effectiveSort(q({ sort: 'relevance' }), true)).toBe('updated')
    expect(effectiveSort(q({ sort: 'views' }), false)).toBe('updated')
    expect(sortOptions(EMPTY_QUERY, true)).toEqual(['updated', 'created', 'title', 'views'])
    expect(sortOptions(EMPTY_QUERY, false)).toEqual(['updated', 'created', 'title'])
    expect(sortOptions(q({ q: 'ab' }), true)).toEqual(['relevance', 'updated', 'created', 'title', 'views'])
  })
})

describe('apiQuery', () => {
  it('maps the URL state to GET /library/docs params (updated → updated_after)', () => {
    const now = Date.parse('2026-10-10T12:00:00.000Z')
    const p = new URLSearchParams(apiQuery(q({ q: ' kum ', collection: 'none', tag: 'ops', mode: 'review', type: 'md', updated: '7d' }), now, true))
    expect(p.get('q')).toBe('kum')
    expect(p.get('collection')).toBe('none')
    expect(p.get('tag')).toBe('ops')
    expect(p.get('mode')).toBe('review')
    expect(p.get('type')).toBe('md')
    expect(p.get('updated_after')).toBe('2026-10-03T12:00:00.000Z')
    expect(p.get('sort')).toBe('relevance')
    expect(p.get('limit')).toBe('50')
    expect(p.has('cursor')).toBe(false)
  })
  it('passes the cursor and drops a one-character q', () => {
    const p = new URLSearchParams(apiQuery(q({ q: 'k' }), 0, true, 'abc'))
    expect(p.has('q')).toBe(false)
    expect(p.get('cursor')).toBe('abc')
    expect(p.get('sort')).toBe('updated')
  })
})

describe('recently viewed (rule 10)', () => {
  const e = (id: string, t = 0): RecentEntry => ({ id, slug: null, title: `T ${id}`, viewedAt: new Date(t).toISOString() })

  it('most recent first, de-duplicated by id, capped at 20', () => {
    let list: RecentEntry[] = []
    list = addRecent(list, e('a', 1))
    list = addRecent(list, e('b', 2))
    list = addRecent(list, e('a', 3))
    expect(list.map((x) => x.id)).toEqual(['a', 'b'])
    expect(list[0].viewedAt).toBe(new Date(3).toISOString())
    for (let i = 0; i < 30; i++) list = addRecent(list, e(`n${i}`, 10 + i))
    expect(list).toHaveLength(RECENT_MAX)
    expect(list[0].id).toBe('n29')
  })

  it('removes deleted docs and survives junk in storage', () => {
    expect(removeRecent([e('a'), e('b'), e('c')], ['a', 'c']).map((x) => x.id)).toEqual(['b'])
    expect(parseRecent(null)).toEqual([])
    expect(parseRecent('not json')).toEqual([])
    expect(parseRecent('{"a":1}')).toEqual([])
    expect(parseRecent(JSON.stringify([e('a'), { id: 5 }, null, { id: 'b', title: 'x', viewedAt: 'y' }])).map((x) => x.id)).toEqual(['a', 'b'])
  })

  describe('useRecent', () => {
    beforeEach(() => localStorage.clear())
    it('persists to md-review-recent and keeps {id, slug, title, viewedAt}', () => {
      const r = useRecent()
      r.record({ id: 'abc', slug: 'my-doc', title: 'My doc' })
      const stored = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
      expect(Object.keys(stored[0]).sort()).toEqual(['id', 'slug', 'title', 'viewedAt'])
      expect(r.entries.value[0].slug).toBe('my-doc')
      r.remove(['abc'])
      expect(JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')).toEqual([])
    })
  })
})

describe('virtual window (rule 15)', () => {
  it('renders the rows around the viewport, never more than the cap', () => {
    expect(virtualRange({ scrollTop: 0, viewport: 900, rowHeight: 72, count: 600, overscan: 20, cap: 120 })).toEqual({ start: 0, end: 33 })
    const mid = virtualRange({ scrollTop: 72 * 300, viewport: 900, rowHeight: 72, count: 600, overscan: 20, cap: 120 })
    expect(mid.start).toBe(280)
    expect(mid.end - mid.start).toBeLessThanOrEqual(120)
    const huge = virtualRange({ scrollTop: 0, viewport: 100_000, rowHeight: 10, count: 600, overscan: 20, cap: 120 })
    expect(huge.end - huge.start).toBe(120)
    expect(virtualRange({ scrollTop: -500, viewport: 900, rowHeight: 72, count: 5, overscan: 20, cap: 120 })).toEqual({ start: 0, end: 5 })
    expect(virtualRange({ scrollTop: 1e9, viewport: 900, rowHeight: 72, count: 600, overscan: 20, cap: 120 }).end).toBe(600)
  })
})

describe('bulk outcome (rule 13) and labels', () => {
  it('counts done, skipped (no edit access) and failed', () => {
    expect(bulkOutcome([
      { id: 'a', ok: true }, { id: 'b', ok: false, error: 'edit_token_required' },
      { id: 'c', ok: false, error: 'edit_token_invalid' }, { id: 'd', ok: false, error: 'not_found' },
      { id: 'e', ok: false, error: 'tag_limit' },
    ])).toEqual({ done: ['a', 'd'], skipped: 2, failed: 1 })
  })
  it('count label', () => {
    expect(countLabel(0)).toBe('0 documents')
    expect(countLabel(1)).toBe('1 document')
    expect(countLabel(600)).toBe('600 documents')
  })
  it('a row is editable when unprotected or a token is held', () => {
    expect(rowCanEdit({ id: 'x', protected: false }, () => null)).toBe(true)
    expect(rowCanEdit({ id: 'x', protected: true }, () => null)).toBe(false)
    expect(rowCanEdit({ id: 'x', protected: true }, () => 't')).toBe(true)
  })
})

describe('#26 fix round', () => {
  it('sortParam: choosing the default sort for the current q leaves the URL without `sort` (QA m2)', () => {
    expect(sortParam(EMPTY_QUERY, 'updated')).toBe('')
    expect(sortParam(EMPTY_QUERY, 'title')).toBe('title')
    expect(sortParam(q({ q: 'kumquat' }), 'relevance')).toBe('')
    expect(sortParam(q({ q: 'kumquat' }), 'updated')).toBe('updated')
    expect(sortParam(q({ q: 'k' }), 'updated')).toBe('') // a 1-char q is no search: updated is the default
    expect(serializeLibraryQuery(q({ sort: sortParam(EMPTY_QUERY, 'updated') }))).toBe('')
  })

  it('phone cards: two lines, + the tags line only when it has content, + the snippet; desktop rows fixed (QA c1)', () => {
    expect(libraryRowHeight(false, false, false)).toBe(68)
    expect(libraryRowHeight(false, true, true)).toBe(90)
    expect(libraryRowHeight(true, false, false)).toBe(84)
    expect(libraryRowHeight(true, false, true)).toBe(112)
    expect(libraryRowHeight(true, true, true)).toBe(136)
    expect(cardHasTagsLine({ tags: [], collection: null }, false)).toBe(false)
    expect(cardHasTagsLine({ tags: [], collection: null }, true)).toBe(true) // "+ tag"
    expect(cardHasTagsLine({ tags: ['ops'], collection: null }, false)).toBe(true)
    expect(cardHasTagsLine({ tags: [], collection: { id: 'c', name: 'C' } }, false)).toBe(true)
  })

  it('virtualRange with per-row offsets (mixed heights) finds the viewport rows and keeps the cap', () => {
    const heights = Array.from({ length: 600 }, (_, i) => (i % 3 === 0 ? 84 : 112))
    const offsets = [0]
    for (const h of heights) offsets.push(offsets[offsets.length - 1] + h)
    const at = (y: number, viewport = 844) => virtualRange({ scrollTop: y, viewport, rowHeight: 112, count: 600, overscan: 0, cap: 120, offsets })
    expect(at(0)).toEqual({ start: 0, end: 9 }) // rows 0..8 cover 0..844 (84+112+112 = 308 per 3 rows)
    const y = offsets[300] + 10
    const r = at(y)
    expect(r.start).toBe(300)
    expect(offsets[r.end]).toBeGreaterThanOrEqual(y + 844)
    expect(offsets[r.end - 1]).toBeLessThan(y + 844)
    expect(at(1e9).end).toBe(600)
    expect(at(-500)).toEqual({ start: 0, end: 4 })
    const huge = virtualRange({ scrollTop: 0, viewport: 1e6, rowHeight: 112, count: 600, overscan: 12, cap: 120, offsets })
    expect(huge.end - huge.start).toBe(120)
    // uniform offsets agree with the fixed-height path
    const uni = Array.from({ length: 601 }, (_, i) => i * 72)
    for (const top of [0, 999, 72 * 300, 1e9]) {
      expect(virtualRange({ scrollTop: top, viewport: 900, rowHeight: 72, count: 600, overscan: 20, cap: 120, offsets: uni }).start)
        .toBe(virtualRange({ scrollTop: top, viewport: 900, rowHeight: 72, count: 600, overscan: 20, cap: 120 }).start)
    }
  })
})
