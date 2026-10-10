import { describe, it, expect } from 'vitest'
import { resolveDocAxes } from '@/composables/useDocState'

describe('resolveDocAxes (00 §1)', () => {
  const base = { routeKind: 'doc' as const, embed: false, paneMode: 'preview' as const, pasteId: 'abc' }

  it('a shared doc is editor-capable and reads by default', () => {
    expect(resolveDocAxes(base)).toEqual({ routeKind: 'doc', capability: 'editor', view: 'read', isShared: true })
  })

  it('the landing route (a local doc) counts as a doc, not shared', () => {
    expect(resolveDocAxes({ ...base, routeKind: 'landing', pasteId: null })).toMatchObject({ routeKind: 'doc', capability: 'editor', isShared: false })
  })

  it('pinned revisions, file routes and embeds are viewers', () => {
    expect(resolveDocAxes({ ...base, routeKind: 'pinned' })).toMatchObject({ routeKind: 'pinned', capability: 'viewer' })
    expect(resolveDocAxes({ ...base, routeKind: 'file' })).toMatchObject({ routeKind: 'file', capability: 'viewer' })
    expect(resolveDocAxes({ ...base, embed: true })).toMatchObject({ routeKind: 'embed', capability: 'viewer' })
  })

  it('edit view only for editors', () => {
    expect(resolveDocAxes({ ...base, paneMode: 'edit' }).view).toBe('edit')
    expect(resolveDocAxes({ ...base, routeKind: 'pinned', paneMode: 'edit' }).view).toBe('read')
  })
})
