import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ALL_THEMES, applyTheme } from '@/composables/useTheme'

// #1: index.html carries a tiny inline script that applies the stored theme
// before first paint. It must agree with applyTheme() for every stored value.
const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf-8')
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
const KEY = 'md-review-theme'

function state() {
  const h = document.documentElement
  return {
    dark: h.classList.contains('dark'),
    github: h.classList.contains('github-theme'),
    locus: h.classList.contains('locus-theme'),
    style: h.getAttribute('data-theme-style'),
  }
}
function reset() {
  document.documentElement.className = ''
  document.documentElement.removeAttribute('data-theme-style')
}
const runBoot = () => new Function(script)()
const prefers = (dark: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: dark && q.includes('dark') }))

describe('index.html theme boot script', () => {
  beforeEach(() => { reset(); localStorage.clear(); prefers(false) })
  afterEach(() => { reset(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('exists', () => {
    expect(script).toContain(KEY)
  })

  it.each(ALL_THEMES)('stored %s gives the same <html> state as applyTheme()', (t) => {
    applyTheme(t)
    const want = state()
    reset()
    localStorage.setItem(KEY, t)
    runBoot()
    expect(state()).toEqual(want)
  })

  it('an unknown value falls back to the OS preference in the Default style', () => {
    localStorage.setItem(KEY, 'locus')
    runBoot()
    expect(state()).toEqual({ dark: false, github: false, locus: false, style: 'default' })
    reset()
    prefers(true)
    runBoot()
    expect(state()).toEqual({ dark: true, github: false, locus: false, style: 'default' })
  })

  it('throwing storage does not break it', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    expect(runBoot).not.toThrow()
    expect(state().style).toBe('default')
  })
})
