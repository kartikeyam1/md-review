// #24 reactions — unit tests for the pure logic and the store (docs/build/specs/24-reactions.md
// rules 2, 6–9; 00 §7 reader identity). Browser behaviour: tests/e2e/items/24-reactions.test.mjs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import {
  applyLocal, formatWho, groupsOf, emptySummary, createReactions, currentReactions,
  type ReactionGroup, type ReactionSummary,
} from '@/composables/useReactions'
import { getReaderId, readerKeyOf, _resetReaderId, READER_ID_KEY } from '@/composables/useReader'
import { useReviewer } from '@/composables/useReviewer'
import { sectionReactions } from '@/preview/sectionReactions'
import { _resetToasts, useToast } from '@/composables/useToast'

const g = (over: Partial<ReactionGroup>): ReactionGroup => ({ code: '+1', emoji: '👍', count: 1, names: [], anonymous: 0, mine: false, ...over })

describe('useReader (00 §7)', () => {
  beforeEach(() => { localStorage.clear(); _resetReaderId() })

  it('creates anon-<uuid> once per browser and keeps it', () => {
    const id = getReaderId()
    expect(id).toMatch(/^anon-[0-9a-f-]{36}$/)
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(localStorage.getItem(READER_ID_KEY)).toBe(id)
    _resetReaderId()
    expect(getReaderId()).toBe(id)
  })

  it('replaces an invalid stored id', () => {
    localStorage.setItem(READER_ID_KEY, 'bad id!')
    const id = getReaderId()
    expect(id).toMatch(/^anon-/)
  })

  it('falls back to an in-memory id when storage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      const a = getReaderId()
      expect(a).toMatch(/^anon-/)
      expect(getReaderId()).toBe(a) // same for the page lifetime
    } finally { get.mockRestore(); set.mockRestore() }
  })

  it('reader_key is name:<lower-cased name>, else the reader id', () => {
    expect(readerKeyOf('  Ana Lopez ', 'anon-x')).toBe('name:ana lopez')
    expect(readerKeyOf('', 'anon-x')).toBe('anon-x')
  })
})

describe('formatWho (rule 8)', () => {
  it('names then "and N others" for anonymous readers', () => {
    expect(formatWho(g({ count: 3, names: ['Ana'], anonymous: 2 }), '')).toBe('Ana and 2 others')
  })
  it('"You" first for the reader\'s own (anonymous) reaction', () => {
    expect(formatWho(g({ count: 3, names: ['Ana'], anonymous: 2, mine: true }), '')).toBe('You, Ana and 1 other')
  })
  it('a named reader is "You", not their name', () => {
    expect(formatWho(g({ count: 2, names: ['Ana', 'Ben'], mine: true }), 'Ana')).toBe('You and Ben')
    expect(formatWho(g({ count: 1, names: ['Ana'], mine: true }), 'Ana')).toBe('You')
  })
  it('lists names with commas and "and"', () => {
    expect(formatWho(g({ count: 3, names: ['A', 'B', 'C'] }), '')).toBe('A, B and C')
    expect(formatWho(g({ count: 1, names: ['A'] }), '')).toBe('A')
  })
  it('only anonymous readers', () => {
    expect(formatWho(g({ count: 1, anonymous: 1 }), '')).toBe('1 person')
    expect(formatWho(g({ count: 3, anonymous: 3 }), '')).toBe('3 people')
    expect(formatWho(g({ count: 2, anonymous: 2, mine: true }), '')).toBe('You and 1 other')
  })
  it('names past the 20 listed count as others', () => {
    const names = Array.from({ length: 20 }, (_, i) => `N${i}`)
    expect(formatWho(g({ count: 25, names }), '')).toMatch(/N19 and 5 others$/)
  })
})

describe('applyLocal (optimistic update)', () => {
  it('adds a doc reaction (named) and removes it again; group disappears at 0', () => {
    let s = applyLocal(null, 'tada', null, true, 'Ana')
    expect(s.total).toBe(1)
    expect(s.doc).toEqual([{ code: 'tada', emoji: '🎉', count: 1, names: ['Ana'], anonymous: 0, mine: true }])
    s = applyLocal(s, 'tada', null, false, 'Ana')
    expect(s).toEqual(emptySummary())
  })

  it('anonymous counts and section groups, fixed order, never negative', () => {
    const base: ReactionSummary = { total: 1, doc: [], sections: { intro: [g({ code: 'rocket', emoji: '🚀', count: 1, anonymous: 1 })] } }
    let s = applyLocal(base, 'eyes', 'intro', true, '')
    expect(groupsOf(s, 'intro').map((x) => x.code)).toEqual(['eyes', 'rocket'])
    expect(groupsOf(s, 'intro')[0]).toMatchObject({ count: 1, anonymous: 1, mine: true })
    expect(s.total).toBe(2)
    // Setting an already-set state is a no-op (no double count).
    expect(applyLocal(s, 'eyes', 'intro', true, '')).toBe(s)
    // Removing a reaction that is not mine does nothing.
    expect(applyLocal(s, 'rocket', 'intro', false, '')).toBe(s)
    s = applyLocal(s, 'eyes', 'intro', false, '')
    expect(groupsOf(s, 'intro').map((x) => x.code)).toEqual(['rocket'])
    expect(s.total).toBe(1)
  })

  it('does not mutate its input', () => {
    const base: ReactionSummary = { total: 1, doc: [g({ count: 1, names: ['Ben'] })], sections: {} }
    const copy = JSON.parse(JSON.stringify(base))
    applyLocal(base, '+1', null, true, 'Ana')
    expect(base).toEqual(copy)
  })
})

// ── the store ────────────────────────────────────────────────────────────────
type Call = { url: string; init?: RequestInit; resolve: (r: Response) => void; reject: (e: unknown) => void }
let calls: Call[] = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const flush = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }

describe('createReactions store', () => {
  beforeEach(() => {
    localStorage.clear(); _resetReaderId(); _resetToasts(); calls = []
    useReviewer().setReviewerName('')
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => { calls.push({ url, init, resolve, reject }) })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('loads with the doc, sends the reader id, and is inactive without a doc', async () => {
    const docId = ref<string | null>(null)
    const active = ref(false)
    createReactions({ docId, active })
    expect(calls.length).toBe(0)
    docId.value = 'abc'; active.value = true
    await flush()
    expect(calls.length).toBe(1)
    expect(calls[0].url).toContain('/paste/abc/reactions?reader_id=anon-')
  })

  it('a click is optimistic, sends on:true; two quick clicks end with the server state, one request in flight at a time', async () => {
    const store = createReactions({ docId: ref('abc'), active: ref(true) })
    await flush()
    calls.shift()!.resolve(json({ total: 0, doc: [], sections: {} }))
    await flush()
    store.toggle('+1')
    expect(store.isMine('+1', null)).toBe(true)
    expect(groupsOf(store.summary.value, null)[0].count).toBe(1)
    store.toggle('+1') // second click while the first is in flight
    expect(store.isMine('+1', null)).toBe(false)
    expect(calls.length).toBe(1)
    expect(JSON.parse(String(calls[0].init!.body))).toMatchObject({ code: '+1', on: true, section: null })
    calls.shift()!.resolve(json({ active: true, summary: { total: 1, doc: [g({ mine: true, anonymous: 1 })], sections: {} } }))
    await flush()
    expect(calls.length).toBe(1)
    expect(JSON.parse(String(calls[0].init!.body))).toMatchObject({ on: false })
    calls.shift()!.resolve(json({ active: false, summary: { total: 0, doc: [], sections: {} } }))
    await flush()
    expect(store.summary.value).toEqual({ total: 0, doc: [], sections: {} })
  })

  it('fix: a poll GET that started before a click never undoes it', async () => {
    const store = createReactions({ docId: ref('abc'), active: ref(true) })
    await flush()
    calls.shift()!.resolve(json({ total: 0, doc: [], sections: {} }))
    await flush()
    void store.refresh() // a poll starts…
    await flush()
    const staleGet = calls.shift()!
    store.toggle('eyes') // …the reader clicks…
    calls.shift()!.resolve(json({ active: true, summary: { total: 1, doc: [g({ code: 'eyes', emoji: '👀', mine: true, anonymous: 1 })], sections: {} } }))
    await flush()
    staleGet.resolve(json({ total: 0, doc: [], sections: {} })) // …and the old GET lands last
    await flush()
    expect(store.isMine('eyes', null)).toBe(true)
    expect(groupsOf(store.summary.value, null)[0].count).toBe(1)
  })

  it('a failed request reverts and raises the reaction-failed toast', async () => {
    const store = createReactions({ docId: ref('abc'), active: ref(true) })
    await flush()
    calls.shift()!.resolve(json({ total: 1, doc: [g({ count: 1, names: ['Ben'] })], sections: {} }))
    await flush()
    store.toggle('+1', null)
    expect(groupsOf(store.summary.value, null)[0].count).toBe(2)
    calls.shift()!.reject(new TypeError('Failed to fetch'))
    await flush()
    expect(groupsOf(store.summary.value, null)[0]).toMatchObject({ count: 1, mine: false })
    const t = useToast().toasts.value
    expect(t.some((x) => x.key === 'reaction-failed' && x.kind === 'error')).toBe(true)
  })
})

describe('sectionReactions enhancer (rule 7)', () => {
  beforeEach(() => { localStorage.clear(); _resetReaderId(); calls = []; vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))) })
  afterEach(() => { vi.unstubAllGlobals(); currentReactions.value = null })

  function mount(html: string) {
    const c = document.createElement('div')
    c.className = 'preview-pane'
    c.innerHTML = html
    document.body.appendChild(c)
    return c
  }

  it('adds a trigger to every h2/h3 with an id, chips for headings with reactions, nothing when inactive', async () => {
    const active = ref(true)
    const store = createReactions({ docId: ref('abc'), active })
    store.summary.value = { total: 2, doc: [], sections: { 'rollout-plan': [g({ code: 'eyes', emoji: '👀', count: 2, mine: true })], gone: [g({})] } }
    const c = mount('<h1 id="t">T</h1><h2 id="rollout-plan">Rollout plan</h2><h3 id="details">Details</h3><h4 id="x">x</h4><h2>no id</h2>')
    const cleanup = sectionReactions(c, { content: '' })!
    const triggers = c.querySelectorAll('[data-testid="section-reaction-trigger"]')
    expect(triggers.length).toBe(2)
    expect(triggers[0].getAttribute('aria-label')).toBe('React to section Rollout plan')
    const chips = c.querySelectorAll('#rollout-plan [data-testid="section-reaction-chip"]')
    expect(chips.length).toBe(1)
    expect(chips[0].getAttribute('data-code')).toBe('eyes')
    expect(chips[0].textContent).toContain('2')
    expect(chips[0].getAttribute('aria-pressed')).toBe('true')
    // chips come before the trigger
    const host = c.querySelector('#rollout-plan .section-reactions')!
    expect(host.lastElementChild!.getAttribute('data-testid')).toBe('section-reaction-trigger')
    // live update keeps the trigger node
    const trig = triggers[0]
    store.summary.value = { total: 0, doc: [], sections: {} }
    await nextTick()
    expect(c.querySelectorAll('[data-testid="section-reaction-chip"]').length).toBe(0)
    expect(c.querySelector('#rollout-plan [data-testid="section-reaction-trigger"]')).toBe(trig)
    active.value = false
    await flush()
    expect(c.querySelectorAll('.section-reactions').length).toBe(0)
    cleanup()
    c.remove()
  })

  it('fix: a heading id the server would reject (> 200 chars) gets no trigger', () => {
    createReactions({ docId: ref('abc'), active: ref(true) })
    const c = mount(`<h2 id="${'x'.repeat(201)}">Long</h2><h2 id="ok">Ok</h2>`)
    const cleanup = sectionReactions(c, { content: '' })!
    expect(c.querySelectorAll('[data-testid="section-reaction-trigger"]').length).toBe(1)
    cleanup()
    c.remove()
  })

  it('the heading label ignores injected controls; cleanup removes everything', () => {
    createReactions({ docId: ref('abc'), active: ref(true) })
    const c = mount('<h2 id="a">Alpha <a class="heading-anchor" href="#a">#</a></h2>')
    const cleanup = sectionReactions(c, { content: '' })!
    const h = c.querySelector('h2')!
    expect(h.lastElementChild!.classList.contains('heading-anchor')).toBe(true) // reactions sit before #3's anchor
    expect(c.querySelector('[data-testid="section-reaction-trigger"]')!.getAttribute('aria-label')).toBe('React to section Alpha')
    cleanup()
    expect(c.querySelectorAll('.section-reactions').length).toBe(0)
    c.remove()
  })
})
