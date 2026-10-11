// #8 + #2: one leave-page path. useAutosave's pagehide / visibilitychange→hidden
// handler flushes the local draft synchronously (usePersistence.flushDraft) and
// then pushes dirty shared edits; its listeners go away with the component.
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useAutosave } from '@/composables/useAutosave'
import type { PaneMode } from '@/types'

function host(shared: boolean, dirty: boolean) {
  const flushDraft = vi.fn()
  const saveMarkdown = vi.fn(() => Promise.resolve(true))
  const sync = {
    isShared: ref(shared), isDirty: ref(dirty), conflict: ref(false), saveState: ref('idle'), saveMarkdown,
  } as unknown as Parameters<typeof useAutosave>[0]['sync']
  const Comp = defineComponent({
    setup() {
      useAutosave({ sync, markdown: ref('x'), filename: ref('a.md'), paneMode: ref<PaneMode>('edit'), flushDraft })
      return () => h('div')
    },
  })
  return { wrapper: mount(Comp), flushDraft, saveMarkdown }
}

describe('useAutosave — the one leave-page path', () => {
  it('pagehide flushes the draft first, then a dirty shared doc with keepalive', () => {
    const { wrapper, flushDraft, saveMarkdown } = host(true, true)
    window.dispatchEvent(new Event('pagehide'))
    expect(flushDraft).toHaveBeenCalledTimes(1)
    expect(saveMarkdown).toHaveBeenCalledWith({ keepalive: true })
    expect(flushDraft.mock.invocationCallOrder[0]!).toBeLessThan(saveMarkdown.mock.invocationCallOrder[0]!)
    wrapper.unmount()
  })

  it('a local (never-shared) doc still gets its draft flushed; no server save', () => {
    const { wrapper, flushDraft, saveMarkdown } = host(false, false)
    window.dispatchEvent(new Event('pagehide'))
    expect(flushDraft).toHaveBeenCalledTimes(1)
    expect(saveMarkdown).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('a hidden tab flushes; listeners are removed on unmount', () => {
    const { wrapper, flushDraft } = host(false, false)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(flushDraft).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    window.dispatchEvent(new Event('pagehide'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(flushDraft).toHaveBeenCalledTimes(1)
    hidden.mockRestore()
  })
})
