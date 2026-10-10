import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  EDIT_TOKENS_KEY, tokenFor, saveToken, dropToken, editHeaders, settleAccess, checkWriteStatus, onTokenRejected,
  sameDoc, learnAlias, __resetEditTokensForTests, installEditTokenHook,
} from '@/composables/useEditToken'
import { onEditToken } from '@/composables/useRouter'

const stored = () => JSON.parse(localStorage.getItem(EDIT_TOKENS_KEY) || '{}')

describe('useEditToken (#23 rule 9)', () => {
  beforeEach(() => { localStorage.clear(); __resetEditTokensForTests(); installEditTokenHook() })

  it('a ?edit= token is pending until the GET confirms it, then stored under the server id', () => {
    onEditToken('my-slug', 'mre_t1')
    expect(tokenFor('my-slug')).toBe('mre_t1')
    expect(stored()).toEqual({})
    settleAccess('my-slug', { id: 'abc123', slug: 'my-slug', access: { protected: true, can_edit: true } })
    expect(stored()).toEqual({ abc123: 'mre_t1' })
    expect(tokenFor('my-slug')).toBe('mre_t1')
    expect(editHeaders('abc123')).toEqual({ 'X-Edit-Token': 'mre_t1' })
  })

  it('a token the server does not accept is never stored', () => {
    onEditToken('a-slug', 'mre_other_doc')
    settleAccess('a-slug', { id: 'aaa', slug: 'a-slug', access: { protected: true, can_edit: false } })
    expect(stored()).toEqual({})
    expect(tokenFor('a-slug')).toBeNull()
  })

  it('a pending token on a legacy doc is not kept (nothing to protect)', () => {
    onEditToken('old', 'mre_x')
    settleAccess('old', { id: 'old1', access: { protected: false, can_edit: true } })
    expect(stored()).toEqual({})
  })

  it('a stored token the GET no longer accepts is dropped', () => {
    saveToken('doc1', 'mre_old', 'slug1')
    settleAccess('slug1', { id: 'doc1', slug: 'slug1', access: { protected: true, can_edit: false } })
    expect(stored()).toEqual({})
  })

  it('401/403 on a write drops the token and notifies listeners; other statuses do nothing', () => {
    saveToken('doc2', 'mre_2', 'two')
    const seen = vi.fn()
    const off = onTokenRejected(seen)
    checkWriteStatus('two', 412)
    expect(tokenFor('doc2')).toBe('mre_2')
    checkWriteStatus('two', 403)
    expect(tokenFor('doc2')).toBeNull()
    expect(seen).toHaveBeenCalledWith('two')
    off()
  })

  it('sameDoc follows learned slug aliases', () => {
    learnAlias('id9', 'nine')
    expect(sameDoc('nine', 'id9')).toBe(true)
    expect(sameDoc('nine', 'id8')).toBe(false)
    expect(sameDoc(null, 'id9')).toBe(false)
  })

  it('dropToken by slug removes the id entry', () => {
    saveToken('id7', 'mre_7', 'seven')
    dropToken('seven')
    expect(stored()).toEqual({})
  })
})
