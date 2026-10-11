import type { ThemeMode, ThemeStyle } from '@/types'
import githubLightUrl from 'github-markdown-css/github-markdown-light.css?url'
import githubDarkUrl from 'github-markdown-css/github-markdown-dark.css?url'

// A theme is a style (Default / GitHub / Locus) × a dark flag (#1 rule 1).
// The header toggle flips the flag; the Style menu picks the style.

export const ALL_THEMES: ThemeMode[] = ['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark']

export const THEME_STYLES: ThemeStyle[] = ['default', 'github', 'locus']

export const THEME_STYLE_LABELS: Record<ThemeStyle, string> = {
  default: 'Default',
  github: 'GitHub',
  locus: 'Locus',
}

const VALID_THEMES = new Set<string>(ALL_THEMES)

export function isValidTheme(v: unknown): v is ThemeMode {
  return typeof v === 'string' && VALID_THEMES.has(v)
}

export function isDark(theme: ThemeMode): boolean {
  return theme === 'dark' || theme === 'github-dark' || theme === 'locus-dark'
}

export function isGithub(theme: ThemeMode): boolean {
  return theme === 'github-light' || theme === 'github-dark'
}

export function isLocus(theme: ThemeMode): boolean {
  return theme === 'locus-light' || theme === 'locus-dark'
}

export function themeStyle(theme: ThemeMode): ThemeStyle {
  if (isGithub(theme)) return 'github'
  if (isLocus(theme)) return 'locus'
  return 'default'
}

export function themeFor(style: ThemeStyle, dark: boolean): ThemeMode {
  if (style === 'default') return dark ? 'dark' : 'light'
  return `${style}-${dark ? 'dark' : 'light'}`
}

/** Same style, flipped dark flag. */
export function toggleDark(theme: ThemeMode): ThemeMode {
  return themeFor(themeStyle(theme), !isDark(theme))
}

function ensureLink(url: string, id: string): HTMLLinkElement {
  let link = document.getElementById(id) as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    link.href = url
    link.disabled = true
    document.head.appendChild(link)
  }
  return link
}

/** Keep in sync with the inline boot script in index.html (tests/composables/themeBoot.test.ts). */
export function applyTheme(t: ThemeMode): void {
  const html = document.documentElement
  html.classList.toggle('dark', isDark(t))
  html.classList.toggle('github-theme', isGithub(t))
  html.classList.toggle('locus-theme', isLocus(t))
  html.setAttribute('data-theme-style', themeStyle(t))

  const light = ensureLink(githubLightUrl, 'github-css-light')
  const dark = ensureLink(githubDarkUrl, 'github-css-dark')
  light.disabled = t !== 'github-light'
  dark.disabled = t !== 'github-dark'
}
