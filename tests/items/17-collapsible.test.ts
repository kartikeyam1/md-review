// #17 Collapsible sections — unit acceptance tests for the pure fold logic
// (docs/build/specs/17-collapsible.md rules 3, 4, 9, 11, 12; 00-cross-cutting.md §10.3).
//
// Module contract (spec names src/composables/useFolding.ts as the unit-testable part):
//   foldSections(levels: Array<number | null>): Array<{ index: number; level: number; end: number }>
//     `levels[i]` is the heading level (1–6) of the i-th top-level block, or null for a non-heading.
//     One entry per H1–H4 that has ≥ 1 following block before the next heading of level ≤ its own;
//     `end` is the exclusive index where its section stops (next heading of level ≤ n, or levels.length).
//   collapseAllLevel(levels: number[]): number | null
//     Rule 9 over the levels of the FOLDABLE headings: smallest level occurring ≥ 2 times, else the
//     smallest level present; null when the list is empty.
//   foldDocKey(o: { pasteId: string | null; route: { kind: string; id?: string; file?: string }; filename: string }): string
//     Rule 11: shared doc → backend id; file route → `<id>/<file>`; pinned revision → the doc id;
//     local → `local:<filename>`.
//   FOLD_KEY_PREFIX === 'md-review-fold:'
//   readFolds(docKey): string[]   writeFolds(docKey, ids: string[]): void   — never throw.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { foldSections, collapseAllLevel, foldDocKey, readFolds, writeFolds, FOLD_KEY_PREFIX } from '@/composables/useFolding'

describe('#17 foldSections (rules 3–4)', () => {
  it('AC-17.1 doc: # T, intro, ## A (p, p, ### A1, p), ## B (p)', () => {
    //            T  intro A   p     p     A1  p     B  p
    const levels = [1, null, 2, null, null, 3, null, 2, null]
    expect(foldSections(levels)).toEqual([
      { index: 0, level: 1, end: 9 },
      { index: 2, level: 2, end: 7 },
      { index: 5, level: 3, end: 7 },
      { index: 7, level: 2, end: 9 },
    ])
  })

  it('a heading with no body before the next same/higher heading gets no section; last heading too', () => {
    expect(foldSections([2, 2, null, 2])).toEqual([{ index: 1, level: 2, end: 3 }])
    // H4 directly followed by H2: no body → none; the H2 has a body
    expect(foldSections([4, 2, null])).toEqual([{ index: 1, level: 2, end: 3 }])
  })

  it('a deeper heading counts as body: ## A immediately followed by ### A1 + para', () => {
    expect(foldSections([2, 3, null])).toEqual([
      { index: 0, level: 2, end: 3 },
      { index: 1, level: 3, end: 3 },
    ])
  })

  it('H5/H6 never fold but are part of the section body', () => {
    expect(foldSections([5, null, 6, null])).toEqual([])
    expect(foldSections([4, 5, null])).toEqual([{ index: 0, level: 4, end: 3 }])
  })

  it('500 headings compute fast', () => {
    const levels = Array.from({ length: 1000 }, (_, i) => (i % 2 ? null : 2 + (i % 3)))
    const t = performance.now()
    foldSections(levels)
    expect(performance.now() - t).toBeLessThan(50)
  })
})

describe('#17 collapseAllLevel (rule 9)', () => {
  it('first repeated level', () => {
    expect(collapseAllLevel([1, 2, 3, 2])).toBe(2)
    expect(collapseAllLevel([1, 3, 3, 2])).toBe(3)
    expect(collapseAllLevel([2, 2, 1, 1])).toBe(1)
  })
  it('no repeated level → smallest present; empty → null', () => {
    expect(collapseAllLevel([3, 2, 4])).toBe(2)
    expect(collapseAllLevel([])).toBeNull()
  })
})

describe('#17 fold persistence (rules 11–12)', () => {
  beforeEach(() => { try { localStorage.clear() } catch { /* */ } })

  it('doc keys', () => {
    expect(FOLD_KEY_PREFIX).toBe('md-review-fold:')
    expect(foldDocKey({ pasteId: 'abc123', route: { kind: 'doc', id: 'my-slug' }, filename: 'x.md' })).toBe('abc123')
    expect(foldDocKey({ pasteId: 'abc123', route: { kind: 'pinned', id: 'my-slug' }, filename: 'x.md' })).toBe('abc123')
    expect(foldDocKey({ pasteId: 'abc123', route: { kind: 'file', id: 'my-slug', file: 'notes/b.md' }, filename: 'b.md' })).toBe('abc123/notes/b.md')
    expect(foldDocKey({ pasteId: null, route: { kind: 'landing' }, filename: 'plan.md' })).toBe('local:plan.md')
  })

  it('round-trips a JSON array under md-review-fold:<docKey>', () => {
    writeFolds('abc', ['a', 'b-1'])
    expect(JSON.parse(localStorage.getItem('md-review-fold:abc')!)).toEqual(['a', 'b-1'])
    expect(readFolds('abc')).toEqual(['a', 'b-1'])
    writeFolds('abc', [])
    expect(localStorage.getItem('md-review-fold:abc')).toBe('[]')
    expect(readFolds('missing')).toEqual([])
  })

  it('garbage or throwing storage never throws', () => {
    localStorage.setItem('md-review-fold:bad', '{not json')
    expect(readFolds('bad')).toEqual([])
    localStorage.setItem('md-review-fold:obj', '{"a":1}')
    expect(readFolds('obj')).toEqual([])
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => writeFolds('x', ['a'])).not.toThrow()
    expect(readFolds('x')).toEqual([])
    get.mockRestore()
    set.mockRestore()
  })
})
