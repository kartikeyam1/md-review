// #9 fix 3: `?` opens the shortcuts overlay only while an editor toolbar is on
// screen — a mounted-but-hidden editor (#6 keep-alive) does not count.
import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import {
  onShortcutsHelpKey, shortcutsOverlayAvailable, shortcutsOverlayOpen, closeShortcutsOverlay, useShortcutsOverlayHost,
} from '@/composables/useShortcutsOverlay'

let wrapper: VueWrapper | null = null
afterEach(() => { closeShortcutsOverlay(); wrapper?.unmount(); wrapper = null })

function mountHost(visible: boolean) {
  const Comp = defineComponent({
    setup() {
      const el = ref<HTMLElement | null>(null)
      useShortcutsOverlayHost(el)
      return () => h('div', { ref: el })
    },
  })
  wrapper = mount(Comp, { attachTo: document.body })
  const el = wrapper.element as HTMLElement
  el.getClientRects = () => (visible ? [{ width: 10, height: 10 }] : []) as unknown as DOMRectList
  return el
}

const press = (target: EventTarget = document.body) => {
  const e = new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true })
  Object.defineProperty(e, 'target', { value: target })
  onShortcutsHelpKey(e)
  return e
}

describe('shortcuts overlay `?` gate', () => {
  it('no host: nothing opens', () => {
    expect(shortcutsOverlayAvailable()).toBe(false)
    press()
    expect(shortcutsOverlayOpen().value).toBe(false)
  })

  it('a mounted but hidden toolbar does not count', () => {
    mountHost(false)
    expect(shortcutsOverlayAvailable()).toBe(false)
    const e = press()
    expect(shortcutsOverlayOpen().value).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })

  it('a visible toolbar: `?` opens and is consumed; not from inside the editor', () => {
    mountHost(true)
    const cm = document.createElement('div')
    cm.className = 'cm-editor'
    document.body.appendChild(cm)
    press(cm)
    expect(shortcutsOverlayOpen().value).toBe(false)
    const e = press()
    expect(shortcutsOverlayOpen().value).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    cm.remove()
  })
})
