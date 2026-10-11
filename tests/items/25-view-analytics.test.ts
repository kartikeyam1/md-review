// #25 view counts — unit tests for the label and the client debounce (docs/build/specs/25-view-analytics.md
// rules 3, 5, 6). Browser behaviour: tests/e2e/items/25-view-analytics.test.mjs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, nextTick, effectScope } from 'vue'
import { viewStatsLabel, createViews, VIEW_DWELL_MS } from '@/composables/useViews'
import { _resetReaderId } from '@/composables/useReader'
import { useReviewer } from '@/composables/useReviewer'

describe('viewStatsLabel (rule 5)', () => {
  it('singular and plural forms; empty when nothing was viewed', () => {
    expect(viewStatsLabel({ total_views: 1, unique_readers: 1 })).toBe('1 view · 1 reader')
    expect(viewStatsLabel({ total_views: 5, unique_readers: 2 })).toBe('5 views · 2 readers')
    expect(viewStatsLabel({ total_views: 0, unique_readers: 0 })).toBe('')
    expect(viewStatsLabel(null)).toBe('')
  })
})

describe('createViews debounce (rule 3)', () => {
  let posts: unknown[] = []
  let gets = 0
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear(); _resetReaderId(); posts = []; gets = 0
    useReviewer().setReviewerName('')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }
      gets++
      return new Response(JSON.stringify({ total_views: posts.length, unique_readers: posts.length ? 1 : 0, last_viewed_at: null }), { status: 200 })
    }))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  function setup(init: { id?: string | null; rev?: string | null; eligible?: boolean } = {}) {
    const docId = ref<string | null>(init.id === undefined ? 'doc1' : init.id)
    const revision = ref<string | null>(init.rev === undefined ? 'a'.repeat(32) : init.rev)
    const eligible = ref(init.eligible ?? true)
    const scope = effectScope()
    const views = scope.run(() => createViews({ docId, revision, eligible }))!
    return { docId, revision, eligible, views, stop: () => scope.stop() }
  }

  it('posts once after 2 s of dwell, with the revision; then reloads the stats', async () => {
    const { views, stop } = setup()
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS - 100)
    expect(posts).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(posts).toEqual([{ reader_id: expect.stringMatching(/^anon-/), revision: 'a'.repeat(32) }])
    await vi.advanceTimersByTimeAsync(10)
    expect(gets).toBeGreaterThanOrEqual(2) // on load + after the record
    expect(views.stats.value?.total_views).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(posts.length).toBe(1)
    stop()
  })

  it('leaving before 2 s sends nothing; a new revision sends one more', async () => {
    const { docId, revision, stop } = setup()
    await vi.advanceTimersByTimeAsync(1000)
    docId.value = null
    await nextTick()
    await vi.advanceTimersByTimeAsync(5000)
    expect(posts.length).toBe(0)
    docId.value = 'doc1'
    await nextTick()
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS + 10)
    expect(posts.length).toBe(1)
    revision.value = 'b'.repeat(32)
    await nextTick()
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS + 10)
    expect(posts.length).toBe(2)
    stop()
  })

  it('never while ineligible (embed, local doc, other route)', async () => {
    const { eligible, stop } = setup({ eligible: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(posts.length).toBe(0)
    eligible.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS + 10)
    expect(posts.length).toBe(1)
    stop()
  })

  it('a hidden tab pauses the dwell; it restarts when visible again', async () => {
    const { stop } = setup()
    const vis = vi.spyOn(document, 'visibilityState', 'get')
    vis.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(posts.length).toBe(0)
    vis.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS - 500)
    expect(posts.length).toBe(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(posts.length).toBe(1)
    vis.mockRestore()
    stop()
  })

  it('fix: naming yourself after the view was counted posts once more with the name', async () => {
    const { stop } = setup()
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS + 10)
    expect(posts.length).toBe(1)
    useReviewer().setReviewerName('Ana')
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)
    expect(posts.length).toBe(2)
    expect(posts[1]).toMatchObject({ name: 'Ana' })
    useReviewer().setReviewerName('Ana B') // a rename is not a new view
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)
    expect(posts.length).toBe(2)
    stop()
  })

  it('revision unknown (null) posts without one (the server uses its current hash)', async () => {
    const { stop } = setup({ rev: null })
    await vi.advanceTimersByTimeAsync(VIEW_DWELL_MS + 10)
    expect(posts).toEqual([{ reader_id: expect.stringMatching(/^anon-/) }])
    stop()
  })
})
