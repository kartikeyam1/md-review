import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { usePersistence } from '@/composables/usePersistence'
import { createMemoryStore, createLocalStorageStore, type DraftStore } from '@/composables/draftStore'
import type { Comment, ContentType } from '@/types'

function setup(store: DraftStore, opts: { pasteId?: string | null; serverMarkdown?: string | null } = {}) {
  const markdown = ref('')
  const filename = ref('')
  const comments = ref<Comment[]>([])
  const contentType = ref<ContentType>('markdown')
  const pasteId = ref<string | null>(opts.pasteId ?? null)
  const serverMarkdown = ref<string | null>(opts.serverMarkdown ?? null)
  const loadComments = vi.fn((c: Comment[]) => { comments.value = c })
  const setAppMode = vi.fn()
  const p = usePersistence(markdown, filename, comments, contentType, loadComments, setAppMode, { pasteId, serverMarkdown, store })
  return { markdown, filename, comments, contentType, pasteId, serverMarkdown, loadComments, setAppMode, ...p }
}

describe('usePersistence', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
  afterEach(() => { vi.useRealTimers() })

  it('writes a debounced snapshot to the store and restores it', async () => {
    const store = createMemoryStore()
    const a = setup(store, { pasteId: 'p1', serverMarkdown: 'server' })
    await a.restored
    a.markdown.value = 'server + edits'
    a.filename.value = 'doc.md'
    await vi.advanceTimersByTimeAsync(600)
    const raw = await store.get()
    expect(raw).not.toBeNull()
    const saved = JSON.parse(raw!)
    expect(saved).toMatchObject({ markdown: 'server + edits', filename: 'doc.md', pasteId: 'p1', serverMarkdown: 'server' })

    const b = setup(store)
    expect(await b.restored).toBe(true)
    expect(b.markdown.value).toBe('server + edits')
    expect(b.setAppMode).toHaveBeenCalledWith('review')
    const draft = b.takeRestoredDraft('p1')
    expect(draft).toMatchObject({ markdown: 'server + edits', baseMarkdown: 'server', clean: false })
    expect(b.takeRestoredDraft('p1')).toBeNull() // consumed
  })

  it('does not store the baseline twice when local equals the server copy', async () => {
    const store = createMemoryStore()
    const a = setup(store, { pasteId: 'p1', serverMarkdown: 'same' })
    await a.restored
    a.markdown.value = 'same'
    a.filename.value = 'doc.md'
    await vi.advanceTimersByTimeAsync(600)
    const saved = JSON.parse((await store.get())!)
    expect(saved.baselineEqualsLocal).toBe(true)
    expect(saved.serverMarkdown).toBeUndefined()
    const b = setup(store)
    await b.restored
    expect(b.takeRestoredDraft('p1')?.clean).toBe(true)
  })

  it('surfaces a storage failure instead of swallowing it, and clears it on the next success', async () => {
    let fail = true
    const inner = createMemoryStore()
    const flaky: DraftStore = {
      kind: 'memory',
      get: () => inner.get(),
      remove: () => inner.remove(),
      set: async (v) => {
        if (fail) throw new DOMException('quota', 'QuotaExceededError')
        return inner.set(v)
      },
    }
    const a = setup(flaky)
    await a.restored
    a.markdown.value = 'x'.repeat(10)
    a.filename.value = 'big.html'
    await vi.advanceTimersByTimeAsync(600)
    expect(a.persistError.value).toMatch(/storage is full/)

    fail = false
    a.markdown.value = 'more'
    await vi.advanceTimersByTimeAsync(600)
    expect(a.persistError.value).toBeNull()
  })

  it('migrates a legacy localStorage draft into the new store once', async () => {
    localStorage.setItem('md-review-state', JSON.stringify({ markdown: 'legacy doc', filename: 'old.md', comments: [] }))
    const store = createMemoryStore()
    const a = setup(store)
    expect(await a.restored).toBe(true)
    expect(a.markdown.value).toBe('legacy doc')
    expect(localStorage.getItem('md-review-state')).toBeNull()
    expect(JSON.parse((await store.get())!).markdown).toBe('legacy doc')
  })

  it('localStorage store keeps working as the fallback backend', async () => {
    const store = createLocalStorageStore('md-review-state')
    const a = setup(store)
    await a.restored
    a.markdown.value = 'ls'
    a.filename.value = 'a.md'
    await vi.advanceTimersByTimeAsync(600)
    expect(JSON.parse(localStorage.getItem('md-review-state')!).markdown).toBe('ls')
    await a.clearPersisted()
    expect(localStorage.getItem('md-review-state')).toBeNull()
  })

  it('ignores corrupt persisted state', async () => {
    const store = createMemoryStore()
    await store.set('{not json')
    const a = setup(store)
    expect(await a.restored).toBe(false)
    expect(a.setAppMode).not.toHaveBeenCalled()
    await nextTick()
  })
})
