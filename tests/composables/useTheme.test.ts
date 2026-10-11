import { describe, it, expect } from 'vitest'
import { isDark, isGithub, isLocus, isValidTheme, themeStyle, themeFor, toggleDark, ALL_THEMES } from '@/composables/useTheme'

describe('useTheme', () => {
  it('ALL_THEMES lists the six themes in order', () => {
    expect(ALL_THEMES).toEqual(['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark'])
  })

  it('isDark returns true only for dark variants', () => {
    expect(isDark('light')).toBe(false)
    expect(isDark('dark')).toBe(true)
    expect(isDark('github-light')).toBe(false)
    expect(isDark('github-dark')).toBe(true)
    expect(isDark('locus-light')).toBe(false)
    expect(isDark('locus-dark')).toBe(true)
  })

  it('isGithub / isLocus / themeStyle classify every theme', () => {
    expect(ALL_THEMES.filter(isGithub)).toEqual(['github-light', 'github-dark'])
    expect(ALL_THEMES.filter(isLocus)).toEqual(['locus-light', 'locus-dark'])
    expect(ALL_THEMES.map(themeStyle)).toEqual(['default', 'default', 'github', 'github', 'locus', 'locus'])
  })

  it('toggleDark flips the dark flag within the style', () => {
    expect(toggleDark('light')).toBe('dark')
    expect(toggleDark('dark')).toBe('light')
    expect(toggleDark('github-light')).toBe('github-dark')
    expect(toggleDark('github-dark')).toBe('github-light')
    expect(toggleDark('locus-light')).toBe('locus-dark')
    expect(toggleDark('locus-dark')).toBe('locus-light')
  })

  it('themeFor composes style × dark flag', () => {
    expect(themeFor('default', false)).toBe('light')
    expect(themeFor('default', true)).toBe('dark')
    expect(themeFor('github', false)).toBe('github-light')
    expect(themeFor('locus', true)).toBe('locus-dark')
  })

  it('isValidTheme accepts valid themes', () => {
    for (const t of ALL_THEMES) expect(isValidTheme(t)).toBe(true)
  })

  it('isValidTheme rejects invalid values', () => {
    expect(isValidTheme('github')).toBe(false)
    expect(isValidTheme('locus')).toBe(false)
    expect(isValidTheme('system')).toBe(false)
    expect(isValidTheme('')).toBe(false)
    expect(isValidTheme(null)).toBe(false)
    expect(isValidTheme(42)).toBe(false)
  })
})
