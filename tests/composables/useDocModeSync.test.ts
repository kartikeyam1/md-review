import { describe, it, expect, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import type { DocMode } from '@/types'
import { useDocModeSync } from '@/composables/useDocModeSync'
import { useToast, _resetToasts } from '@/composables/useToast'

/** A putMeta whose calls resolve when the test says so. */
function fakeShare() {
  const calls: { mode: DocMode; resolve: (ok: boolean) => void }[] = []
  const share = {
    putMeta: (_id: string, u: { mode?: DocMode }) => new Promise<boolean>((resolve) => { calls.push({ mode: u.mode!, resolve }) }),
  }
  return { share: share as any, calls }
}

const flush = async () => { for (let i = 0; i < 5; i++) await nextTick() }

describe('useDocModeSync — serialised mode writes (#2 rule 11)', () => {
  beforeEach(() => _resetToasts())

  function setup() {
    const mode = ref<DocMode>('publish')
    const pasteId = ref<string | null>('doc1')
    const { share, calls } = fakeShare()
    const sync = useDocModeSync({ mode, pasteId, share, canChange: () => true })
    sync.setModeBaseline('publish')
    return { mode, pasteId, calls, sync }
  }

  it('one PUT in flight; the latest choice is written next', async () => {
    const { mode, calls, sync } = setup()
    sync.setDocMode('review')
    sync.setDocMode('publish')
    sync.setDocMode('review')
    expect(calls.map((c) => c.mode)).toEqual(['review'])
    calls[0].resolve(true)
    await flush()
    // Server holds review = the latest choice: nothing more to write.
    expect(calls.length).toBe(1)
    expect(mode.value).toBe('review')
  })

  it('a newer choice pending → the next PUT carries it', async () => {
    const { mode, calls, sync } = setup()
    sync.setDocMode('review')
    sync.setDocMode('publish')
    calls[0].resolve(true) // server: review; UI wants publish
    await flush()
    expect(calls.map((c) => c.mode)).toEqual(['review', 'publish'])
    calls[1].resolve(true)
    await flush()
    expect(mode.value).toBe('publish')
  })

  it('a failure with nothing newer rolls back and raises an error toast', async () => {
    const { mode, calls, sync } = setup()
    sync.setDocMode('review')
    calls[0].resolve(false)
    await flush()
    expect(mode.value).toBe('publish')
    expect(useToast().toasts.value.map((t) => t.kind)).toEqual(['error'])
  })

  it('no error toast when the final state is what the server holds', async () => {
    const { mode, calls, sync } = setup()
    sync.setDocMode('review')
    sync.setDocMode('publish') // back to what the server has
    calls[0].resolve(false)
    await flush()
    expect(calls.length).toBe(1)
    expect(mode.value).toBe('publish')
    expect(useToast().toasts.value).toEqual([])
  })

  it('a poll requested during a write does not undo the local choice', async () => {
    const { mode, calls, sync } = setup()
    const before = Date.now() - 1000
    sync.setDocMode('review')
    sync.applyServerMeta({ markdown: '', filename: 'x', comments: [], sharedAt: '', mode: 'publish' }, before)
    expect(mode.value).toBe('review')
    calls[0].resolve(true)
    await flush()
    sync.applyServerMeta({ markdown: '', filename: 'x', comments: [], sharedAt: '', mode: 'publish' }, before)
    expect(mode.value).toBe('review')
    sync.applyServerMeta({ markdown: '', filename: 'x', comments: [], sharedAt: '', mode: 'publish' }, Date.now() + 1)
    expect(mode.value).toBe('publish')
  })

  it('viewers cannot change the mode; a local doc changes without a write', async () => {
    const mode = ref<DocMode>('publish')
    const { share, calls } = fakeShare()
    useDocModeSync({ mode, pasteId: ref('d'), share, canChange: () => false }).setDocMode('review')
    expect(mode.value).toBe('publish')
    useDocModeSync({ mode, pasteId: ref(null), share, canChange: () => true }).setDocMode('review')
    expect(mode.value).toBe('review')
    expect(calls.length).toBe(0)
  })
})
