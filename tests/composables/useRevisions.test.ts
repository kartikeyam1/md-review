import { describe, it, expect } from 'vitest'
import { summarizeSince, displayAuthor } from '@/composables/useRevisions'
import type { RevisionEntry } from '@/composables/useShare'

const rev = (hash: string, by: string | null, client: RevisionEntry['client'], at: string, extra: Partial<RevisionEntry> = {}): RevisionEntry =>
  ({ hash, by, client, at, size: 1, parent: null, ...extra })

const list: RevisionEntry[] = [
  rev('h1', 'Kartikeya', 'ui', '2026-09-14T10:00:00Z'),
  rev('h2', 'agent', 'mcp', '2026-09-14T11:00:00Z'),
  rev('h3', null, 'ui', '2026-09-14T12:00:00Z', { at_end: '2026-09-14T12:20:00Z' }),
]

describe('summarizeSince', () => {
  it('returns null when nothing changed', () => {
    expect(summarizeSince(list, 'h3', 'h3')).toBeNull()
  })

  it('describes the revisions after the acknowledged one', () => {
    const s = summarizeSince(list, 'h1', 'h3')!
    expect(s.sinceKnown).toBe(true)
    expect(s.count).toBe(2)
    expect(s.authors).toEqual(['agent', 'someone'])
    expect(s.from).toBe('2026-09-14T11:00:00Z')
    expect(s.to).toBe('2026-09-14T12:20:00Z') // end of the folded editing session
  })

  it('falls back to the whole history when the acknowledged hash is no longer listed', () => {
    const s = summarizeSince(list, 'gone', 'h3')!
    expect(s.sinceKnown).toBe(false)
    expect(s.count).toBe(3)
    expect(s.authors).toEqual(['Kartikeya', 'agent', 'someone'])
  })

  it('displayAuthor names agents and anonymous UI writers sensibly', () => {
    expect(displayAuthor({ by: 'Zed', client: 'api' })).toBe('Zed')
    expect(displayAuthor({ by: null, client: 'mcp' })).toBe('an agent')
    expect(displayAuthor({ by: null, client: 'ui' })).toBe('someone')
    expect(displayAuthor({ by: null, client: 'api' })).toBe('the API')
  })
})
