import { describe, it, expect, beforeEach } from 'vitest'
import { LOCAL_COPIES_KEY, loadLocalCopy, saveLocalCopy, clearLocalCopy } from '@/composables/localCopy'

describe('localCopy (#23 fix 2)', () => {
  beforeEach(() => localStorage.clear())

  it('saves, loads and clears a doc\'s unsaved copy by id', () => {
    const copy = { markdown: '# mine', filename: 'a.md', at: '2026-10-10T00:00:00.000Z' }
    saveLocalCopy('doc1', copy)
    expect(loadLocalCopy('doc1')).toEqual(copy)
    expect(loadLocalCopy('doc2')).toBeNull()
    clearLocalCopy('doc1')
    expect(loadLocalCopy('doc1')).toBeNull()
    expect(localStorage.getItem(LOCAL_COPIES_KEY)).toBeNull()
  })

  it('survives a corrupt store', () => {
    localStorage.setItem(LOCAL_COPIES_KEY, '{not json')
    expect(loadLocalCopy('x')).toBeNull()
    saveLocalCopy('x', { markdown: 'm', filename: '', at: '' })
    expect(loadLocalCopy('x')?.markdown).toBe('m')
  })
})
