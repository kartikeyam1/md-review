// #1 Locus brand theme + switcher — frozen unit acceptance tests
// (docs/build/specs/01-locus-theme.md rules 1–4, AC-01.16).
//
// Imports the module as a namespace so a missing export fails its own
// assertion instead of breaking the whole file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as theme from '@/composables/useTheme'
import * as persistence from '@/composables/usePersistence'

const ALL = ['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark'] as const
type T = (typeof ALL)[number]
const STYLE: Record<T, 'default' | 'github' | 'locus'> = {
  'light': 'default',
  'dark': 'default',
  'github-light': 'github',
  'github-dark': 'github',
  'locus-light': 'locus',
  'locus-dark': 'locus',
}
const DARK: Record<T, boolean> = {
  'light': false,
  'dark': true,
  'github-light': false,
  'github-dark': true,
  'locus-light': false,
  'locus-dark': true,
}
const PAIR: Record<T, T> = {
  'light': 'dark',
  'dark': 'light',
  'github-light': 'github-dark',
  'github-dark': 'github-light',
  'locus-light': 'locus-dark',
  'locus-dark': 'locus-light',
}

// The module is untyped here on purpose (the exports are what is under test).
const m = theme as unknown as Record<string, any>
const fn = (name: string) => {
  expect(typeof m[name], `useTheme.ts must export ${name}()`).toBe('function')
  return m[name] as (...a: unknown[]) => unknown
}

describe('#1 useTheme — pure helpers (AC-01.16)', () => {
  it('AC-01.16 ALL_THEMES equals the 6 values in order', () => {
    expect(m.ALL_THEMES).toEqual([...ALL])
  })

  it('AC-01.16 isDark / isGithub / isLocus / themeStyle are correct for all 6', () => {
    const isDark = fn('isDark'), isGithub = fn('isGithub'), isLocus = fn('isLocus'), themeStyle = fn('themeStyle')
    for (const t of ALL) {
      expect(isDark(t), `isDark(${t})`).toBe(DARK[t])
      expect(isGithub(t), `isGithub(${t})`).toBe(STYLE[t] === 'github')
      expect(isLocus(t), `isLocus(${t})`).toBe(STYLE[t] === 'locus')
      expect(themeStyle(t), `themeStyle(${t})`).toBe(STYLE[t])
    }
  })

  it('AC-01.16 toggleDark maps each theme to its pair (same style, flipped dark flag)', () => {
    const toggleDark = fn('toggleDark')
    for (const t of ALL) expect(toggleDark(t), `toggleDark(${t})`).toBe(PAIR[t])
  })

  it('AC-01.16 themeFor(style, dark) composes every theme; themeFor("locus", true) === "locus-dark"', () => {
    const themeFor = fn('themeFor')
    expect(themeFor('locus', true)).toBe('locus-dark')
    for (const t of ALL) expect(themeFor(STYLE[t], DARK[t]), `themeFor(${STYLE[t]}, ${DARK[t]})`).toBe(t)
  })

  it('AC-01.16 isValidTheme accepts the 6 values and rejects "locus", "system", "", null, 42', () => {
    const isValidTheme = fn('isValidTheme')
    for (const t of ALL) expect(isValidTheme(t), t).toBe(true)
    for (const bad of ['locus', 'system', '', null, 42, undefined, 'github', 'LOCUS-LIGHT', 'locus-dark ']) {
      expect(isValidTheme(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('rule 2: THEME_CYCLE and nextTheme are removed', () => {
    expect('THEME_CYCLE' in m).toBe(false)
    expect('nextTheme' in m).toBe(false)
  })
})

describe('#1 applyTheme — <html> classes and data-theme-style (rule 3)', () => {
  afterEach(() => {
    const html = document.documentElement
    html.className = ''
    html.removeAttribute('data-theme-style')
  })

  it('rule 3: every theme sets exactly its classes and data-theme-style; never github-theme and locus-theme together', () => {
    const applyTheme = fn('applyTheme')
    const html = document.documentElement
    // Apply in an order that crosses every style boundary in both directions.
    const order: T[] = ['locus-dark', 'github-light', 'locus-light', 'dark', 'github-dark', 'light', 'locus-dark', 'locus-light', 'github-dark']
    for (const t of order) {
      applyTheme(t)
      expect(html.classList.contains('dark'), `${t}: dark`).toBe(DARK[t])
      expect(html.classList.contains('github-theme'), `${t}: github-theme`).toBe(STYLE[t] === 'github')
      expect(html.classList.contains('locus-theme'), `${t}: locus-theme`).toBe(STYLE[t] === 'locus')
      expect(html.getAttribute('data-theme-style'), `${t}: data-theme-style`).toBe(STYLE[t])
    }
  })

  it('rule 3: github-markdown-css links are enabled only for the matching github theme', () => {
    const applyTheme = fn('applyTheme')
    // The two github-markdown-css <link>s keep today's ids (vitest resolves
    // `?url` imports to '', so the href cannot identify them here).
    const link = (id: string) => document.getElementById(id) as HTMLLinkElement | null
    for (const t of ALL) {
      applyTheme(t)
      const light = link('github-css-light'), dark = link('github-css-dark')
      expect(light && dark, 'github-css-light / github-css-dark links exist').toBeTruthy()
      expect(light!.disabled, `${t}: github-css-light disabled`).toBe(t !== 'github-light')
      expect(dark!.disabled, `${t}: github-css-dark disabled`).toBe(t !== 'github-dark')
    }
  })
})

describe('#1 useThemePersistence — storage (rule 4)', () => {
  const KEY = 'md-review-theme'
  const usePersist = () => {
    const f = (persistence as unknown as Record<string, any>).useThemePersistence
    expect(typeof f).toBe('function')
    return f() as { theme: { value: string }; setTheme: (t: string) => void }
  }
  const matchMedia = (dark: boolean) =>
    vi.fn((q: string) => ({
      matches: dark && /prefers-color-scheme:\s*dark/.test(q),
      media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false },
    }))

  beforeEach(() => {
    try { localStorage.clear() } catch { /* ignore */ }
    vi.stubGlobal('matchMedia', matchMedia(false))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-theme-style')
    try { localStorage.clear() } catch { /* ignore */ }
  })

  it('rule 4: each of the 6 stored values is restored as-is', () => {
    for (const t of ALL) {
      localStorage.setItem(KEY, t)
      expect(usePersist().theme.value, t).toBe(t)
      expect(document.documentElement.getAttribute('data-theme-style'), t).toBe(STYLE[t])
    }
  })

  it('rule 4: a corrupt value falls back to the OS preference in the Default style', () => {
    localStorage.setItem(KEY, 'bogus')
    expect(usePersist().theme.value).toBe('light')
    vi.stubGlobal('matchMedia', matchMedia(true))
    localStorage.setItem(KEY, 'locus')
    expect(usePersist().theme.value).toBe('dark')
  })

  it('rule 4: setTheme persists under md-review-theme', () => {
    const p = usePersist()
    p.setTheme('locus-dark')
    expect(localStorage.getItem(KEY)).toBe('locus-dark')
    expect(document.documentElement.classList.contains('locus-theme')).toBe(true)
  })

  it('rule 4: when localStorage throws, the theme still resolves, applies and switches for the session', () => {
    const boom = () => { throw new DOMException('denied', 'SecurityError') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom)
    let p!: ReturnType<typeof usePersist>
    expect(() => { p = usePersist() }).not.toThrow()
    expect(p.theme.value).toBe('light')
    expect(() => p.setTheme('locus-dark')).not.toThrow()
    expect(p.theme.value).toBe('locus-dark')
    const html = document.documentElement
    expect(html.classList.contains('dark') && html.classList.contains('locus-theme')).toBe(true)
  })
})
