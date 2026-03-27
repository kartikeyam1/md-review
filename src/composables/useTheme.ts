import type { ThemeMode } from '@/types'
import githubLightUrl from 'github-markdown-css/github-markdown-light.css?url'
import githubDarkUrl from 'github-markdown-css/github-markdown-dark.css?url'

export const THEME_CYCLE: ThemeMode[] = ['light', 'dark', 'github-light', 'github-dark']

const VALID_THEMES = new Set<string>(THEME_CYCLE)

export function isDark(theme: ThemeMode): boolean {
  return theme === 'dark' || theme === 'github-dark'
}

export function isGithub(theme: ThemeMode): boolean {
  return theme === 'github-light' || theme === 'github-dark'
}

export function nextTheme(current: ThemeMode): ThemeMode {
  const idx = THEME_CYCLE.indexOf(current)
  return THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]
}

export function isValidTheme(v: unknown): v is ThemeMode {
  return typeof v === 'string' && VALID_THEMES.has(v)
}

export const THEME_META: Record<ThemeMode, { label: string; title: string }> = {
  'light': { label: 'Light', title: 'Switch to Dark mode' },
  'dark': { label: 'Dark', title: 'Switch to GitHub Light mode' },
  'github-light': { label: 'GitHub Light', title: 'Switch to GitHub Dark mode' },
  'github-dark': { label: 'GitHub Dark', title: 'Switch to Light mode' },
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

export function applyTheme(t: ThemeMode): void {
  const html = document.documentElement
  html.classList.toggle('dark', isDark(t))
  html.classList.toggle('github-theme', isGithub(t))

  const light = ensureLink(githubLightUrl, 'github-css-light')
  const dark = ensureLink(githubDarkUrl, 'github-css-dark')
  light.disabled = t !== 'github-light'
  dark.disabled = t !== 'github-dark'
}
