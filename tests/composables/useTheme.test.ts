import { describe, it, expect } from 'vitest'
import { isDark, isGithub, nextTheme, isValidTheme, THEME_CYCLE } from '@/composables/useTheme'

describe('useTheme', () => {
  it('isDark returns true only for dark variants', () => {
    expect(isDark('light')).toBe(false)
    expect(isDark('dark')).toBe(true)
    expect(isDark('github-light')).toBe(false)
    expect(isDark('github-dark')).toBe(true)
  })

  it('isGithub returns true only for github variants', () => {
    expect(isGithub('light')).toBe(false)
    expect(isGithub('dark')).toBe(false)
    expect(isGithub('github-light')).toBe(true)
    expect(isGithub('github-dark')).toBe(true)
  })

  it('nextTheme cycles through all four themes', () => {
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('github-light')
    expect(nextTheme('github-light')).toBe('github-dark')
    expect(nextTheme('github-dark')).toBe('light')
  })

  it('THEME_CYCLE has exactly four entries', () => {
    expect(THEME_CYCLE).toEqual(['light', 'dark', 'github-light', 'github-dark'])
  })

  it('isValidTheme accepts valid themes', () => {
    expect(isValidTheme('light')).toBe(true)
    expect(isValidTheme('dark')).toBe(true)
    expect(isValidTheme('github-light')).toBe(true)
    expect(isValidTheme('github-dark')).toBe(true)
  })

  it('isValidTheme rejects invalid values', () => {
    expect(isValidTheme('github')).toBe(false)
    expect(isValidTheme('system')).toBe(false)
    expect(isValidTheme('')).toBe(false)
    expect(isValidTheme(null)).toBe(false)
    expect(isValidTheme(42)).toBe(false)
  })
})
