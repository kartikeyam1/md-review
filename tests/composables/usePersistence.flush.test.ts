// #8 scope add: the conflict travels with the draft, and the draft is flushed
// synchronously to localStorage when the page goes away.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, effectScope } from 'vue'
import { usePersistence } from '@/composables/usePersistence'
import { createMemoryStore, type DraftStore } from '@/composables/draftStore'
import type { Comment, ContentType } from '@/types'

/**
 * A memory store that reports itself as IndexedDB (the async backend). While
 * `hang.on`, writes never settle — the page unloaded before they landed.
 */
function fakeIdb(hang = { on: false }): DraftStore {
  const m = createMemoryStore()
  return {
    kind: 'indexeddb',
    get: m.get,
    set: (v) => (hang.on ? new Promise<void>(() => {}) : m.set(v)),
    remove: m.remove,
  }
}

const scopes: ReturnType<typeof effectScope>[] = []

function setup(store: DraftStore, localStore: DraftStore = fakeIdb()) {
  const scope = effectScope()
  scopes.push(scope)
  return { scope, ...scope.run(() => build(store, localStore))! }
}

function build(store: DraftStore, localStore: DraftStore) {
  const markdown = ref('')
  const filename = ref('')
  const comments = ref<Comment[]>([])
  const contentType = ref<ContentType>('markdown')
  const pasteId = ref<string | null>(null)
  const serverMarkdown = ref<string | null>(null)
  const baseHash = ref<string | null>(null)
  const conflict = ref(false)
  const p = usePersistence(markdown, filename, comments, contentType, vi.fn(), vi.fn(), {
    pasteId, serverMarkdown, baseHash, conflict, store, localStore,
  })
  return { markdown, filename, pasteId, serverMarkdown, baseHash, conflict, ...p }
}

describe('usePersistence — conflict and page-away flush (#8)', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
  afterEach(() => { vi.useRealTimers(); scopes.splice(0).forEach((sc) => sc.stop()) })

  it('persists the base hash and the conflict flag with a shared draft', async () => {
    const store = fakeIdb()
    const a = setup(store)
    await a.restored
    a.pasteId.value = 'p1'
    a.filename.value = 'doc.md'
    a.serverMarkdown.value = 'base'
    a.baseHash.value = 'h1'
    a.conflict.value = true
    a.markdown.value = 'base + mine'
    await vi.advanceTimersByTimeAsync(600)

    const b = setup(store)
    await b.restored
    const draft = b.takeRestoredDraft('p1')
    expect(draft).toMatchObject({ markdown: 'base + mine', baseMarkdown: 'base', baseHash: 'h1', conflict: true, clean: false })
  })

  it('pagehide writes the snapshot to localStorage synchronously; the next load prefers it when newer', async () => {
    const hang = { on: false }
    const store = fakeIdb(hang)
    await store.set(JSON.stringify({ markdown: 'older', filename: 'doc.md', comments: [], savedAt: '2000-01-01T00:00:00.000Z' }))
    const a = setup(store, fakeIdb(hang))
    await a.restored
    a.filename.value = 'doc.md'
    a.markdown.value = 'typed just now'
    // The page goes away before any async write can land.
    hang.on = true
    a.flushDraft() // what the leave-page path (useAutosave) runs on pagehide
    await vi.advanceTimersByTimeAsync(600)
    expect(JSON.parse(localStorage.getItem('md-review-state')!).markdown).toBe('typed just now')
    expect(JSON.parse(localStorage.getItem('md-review-local-draft')!).markdown).toBe('typed just now')
    a.scope.stop()

    hang.on = false
    const b = setup(store)
    expect(await b.restored).toBe(true)
    expect(b.markdown.value).toBe('typed just now')
    expect(localStorage.getItem('md-review-state')).toBeNull()
    expect(JSON.parse((await store.get())!).markdown).toBe('typed just now')
  })

  it('the flush copy is dropped once the async write of that snapshot lands', async () => {
    const store = fakeIdb()
    const a = setup(store)
    await a.restored
    a.filename.value = 'doc.md'
    a.markdown.value = 'landed'
    a.flushDraft() // what the leave-page path (useAutosave) runs on pagehide
    expect(localStorage.getItem('md-review-state')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(50)
    expect(JSON.parse((await store.get())!).markdown).toBe('landed')
    expect(localStorage.getItem('md-review-state')).toBeNull()
    expect(localStorage.getItem('md-review-local-draft')).toBeNull()
    a.scope.stop()
  })

  it('a newer flush survives an older async write landing after it', async () => {
    const m = createMemoryStore()
    const gates: Array<() => void> = []
    const store: DraftStore = {
      kind: 'indexeddb', get: m.get, remove: m.remove,
      set: (v) => new Promise<void>((resolve) => { gates.push(() => { m.set(v).then(resolve) }) }),
    }
    const a = setup(store)
    await a.restored
    a.filename.value = 'doc.md'
    a.markdown.value = 'first'
    a.persistNow() // async write of "first" in flight
    a.markdown.value = 'second'
    a.flushDraft() // what the leave-page path (useAutosave) runs on pagehide // flush copy = "second"
    await vi.advanceTimersByTimeAsync(0)
    gates.shift()!() // "first" lands
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(localStorage.getItem('md-review-state')!).markdown).toBe('second')
    gates.shift()!() // "second" lands
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse((await m.get())!).markdown).toBe('second')
    expect(localStorage.getItem('md-review-state')).toBeNull()
    a.scope.stop()
  })

  it('registers no leave-page listener of its own (the one path is useAutosave, which calls flushDraft)', async () => {
    const a = setup(fakeIdb())
    await a.restored
    a.filename.value = 'doc.md'
    a.markdown.value = 'x'
    window.dispatchEvent(new Event('pagehide'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(localStorage.getItem('md-review-state')).toBeNull()
    a.flushDraft()
    expect(JSON.parse(localStorage.getItem('md-review-state')!).markdown).toBe('x')
    a.scope.stop()
  })

  it('an older localStorage copy loses to a newer store copy', async () => {
    const store = fakeIdb()
    await store.set(JSON.stringify({ markdown: 'newer', filename: 'doc.md', comments: [], savedAt: '2030-01-01T00:00:00.000Z' }))
    localStorage.setItem('md-review-state', JSON.stringify({ markdown: 'stale', filename: 'doc.md', comments: [], savedAt: '2020-01-01T00:00:00.000Z' }))
    const b = setup(store)
    await b.restored
    expect(b.markdown.value).toBe('newer')
    expect(localStorage.getItem('md-review-state')).toBeNull()
  })
})
