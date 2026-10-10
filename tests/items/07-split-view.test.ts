// #7 Split view — pure logic (docs/build/specs/07-split-view.md rules 4, 8, 9, 11).
// The mapping functions behind synced scrolling and the divider live in
// src/composables/useScrollSync.ts; the DOM side is covered by the e2e suite.
import { describe, it, expect } from 'vitest'
import {
  buildAnchors,
  lineToOffset,
  offsetToLine,
  scrollRatio,
  ratioToScrollTop,
  splitBounds,
  clampSplit,
  parseSplitRatio,
  stepSplit,
  parseSyncPref,
} from '@/composables/useScrollSync'

// A small rendered doc: h1 (line 0), a 3-line paragraph (2–5), a list (6–9)
// with two items, the second holding a nested paragraph pair.
const BLOCKS = [
  { start: 0, end: 1, top: 24, bottom: 64 },
  { start: 2, end: 5, top: 80, bottom: 170 },
  { start: 6, end: 9, top: 186, bottom: 300 },   // <ul>
  { start: 6, end: 7, top: 186, bottom: 216 },   //   <li>
  { start: 7, end: 9, top: 216, bottom: 300 },   //   <li>
  { start: 7, end: 8, top: 216, bottom: 246 },   //     <p>
]

describe('AC-07.6/07.7 line ↔ offset mapping (rule 8)', () => {
  const anchors = buildAnchors(BLOCKS)

  it('anchors are sorted by line and never go back up', () => {
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i].line).toBeGreaterThan(anchors[i - 1].line)
      expect(anchors[i].offset).toBeGreaterThanOrEqual(anchors[i - 1].offset)
    }
  })

  it('a block start maps to that block\'s top edge', () => {
    expect(lineToOffset(anchors, 0)).toBe(24)
    expect(lineToOffset(anchors, 2)).toBe(80)
    expect(lineToOffset(anchors, 6)).toBe(186)
  })

  it('interpolates linearly inside a block by line fraction', () => {
    // paragraph 2..5 spans 80..170: line 3.5 is halfway
    expect(lineToOffset(anchors, 3.5)).toBeCloseTo(125, 5)
    // nested <p> 7..8 spans 216..246
    expect(lineToOffset(anchors, 7.5)).toBeCloseTo(231, 5)
  })

  it('a blank line between blocks maps into the gap', () => {
    const y = lineToOffset(anchors, 1.5)
    expect(y).toBeGreaterThan(64)
    expect(y).toBeLessThan(80)
  })

  it('before the first block → top; past the last → the last block\'s bottom', () => {
    const fm = buildAnchors([{ start: 4, end: 5, top: 40, bottom: 80 }])
    expect(lineToOffset(fm, 0)).toBe(0)
    expect(lineToOffset(fm, 2)).toBeLessThanOrEqual(40)
    expect(lineToOffset(anchors, 500)).toBe(300)
  })

  it('offset → line is the inverse inside blocks and clamps at both ends', () => {
    for (const line of [0, 0.5, 2, 3.25, 6, 7.5, 8.5]) {
      expect(offsetToLine(anchors, lineToOffset(anchors, line))).toBeCloseTo(line, 5)
    }
    expect(offsetToLine(anchors, 0)).toBe(0)
    expect(offsetToLine(anchors, 10_000)).toBe(9)
  })

  it('an empty doc maps everything to 0', () => {
    const none = buildAnchors([])
    expect(lineToOffset(none, 12)).toBe(0)
    expect(offsetToLine(none, 300)).toBe(0)
  })

  it('zero-height blocks and out-of-order tops do not break monotonicity', () => {
    const odd = buildAnchors([
      { start: 0, end: 1, top: 0, bottom: 20 },
      { start: 1, end: 2, top: 20, bottom: 20 },
      { start: 2, end: 3, top: 10, bottom: 15 }, // a float/absolutely positioned oddity
      { start: 3, end: 4, top: 40, bottom: 60 },
    ])
    for (let i = 1; i < odd.length; i++) expect(odd[i].offset).toBeGreaterThanOrEqual(odd[i - 1].offset)
    expect(Number.isFinite(offsetToLine(odd, 20))).toBe(true)
  })
})

describe('AC-07.10 proportional scroll (rule 9)', () => {
  it('ratio = scrollTop / (scrollHeight − clientHeight), 0 when not scrollable', () => {
    expect(scrollRatio(500, 2000, 1000)).toBe(0.5)
    expect(scrollRatio(0, 800, 1000)).toBe(0)
    expect(scrollRatio(10, 1000, 1000)).toBe(0)
    expect(scrollRatio(1200, 2000, 1000)).toBe(1)
  })
  it('ratio → scrollTop round-trips and clamps', () => {
    expect(ratioToScrollTop(0.5, 2000, 1000)).toBe(500)
    expect(ratioToScrollTop(2, 2000, 1000)).toBe(1000)
    expect(ratioToScrollTop(-1, 2000, 1000)).toBe(0)
    expect(ratioToScrollTop(0.5, 900, 1000)).toBe(0)
  })
})

describe('AC-07.4/07.5 divider (rule 4)', () => {
  it('each pane keeps at least 240px', () => {
    const b = splitBounds(1000)
    expect(b.min).toBeCloseTo(24, 5)
    expect(b.max).toBeCloseTo(76, 5)
    expect(clampSplit(5, b)).toBeCloseTo(24, 5)
    expect(clampSplit(99, b)).toBeCloseTo(76, 5)
    expect(clampSplit(50, b)).toBe(50)
  })
  it('a container too narrow for two minimum panes pins the split at 50', () => {
    const b = splitBounds(400)
    expect(clampSplit(10, b)).toBe(50)
    expect(clampSplit(90, b)).toBe(50)
  })
  it('stored ratio: invalid or missing → 50', () => {
    expect(parseSplitRatio(null)).toBe(50)
    expect(parseSplitRatio('')).toBe(50)
    expect(parseSplitRatio('abc')).toBe(50)
    expect(parseSplitRatio('NaN')).toBe(50)
    expect(parseSplitRatio('-3')).toBe(50)
    expect(parseSplitRatio('140')).toBe(50)
    expect(parseSplitRatio('37.5')).toBe(37.5)
  })
  it('arrows move 5 points, Home/End jump to the bounds, other keys do nothing', () => {
    const b = splitBounds(1000)
    expect(stepSplit(50, 'ArrowRight', b)).toBe(55)
    expect(stepSplit(50, 'ArrowLeft', b)).toBe(45)
    expect(stepSplit(74, 'ArrowRight', b)).toBeCloseTo(76, 5)
    expect(stepSplit(50, 'Home', b)).toBeCloseTo(24, 5)
    expect(stepSplit(50, 'End', b)).toBeCloseTo(76, 5)
    expect(stepSplit(50, 'a', b)).toBeNull()
  })
})

describe('AC-07.9 sync preference (rule 11)', () => {
  it('"0" is off; anything else (incl. missing) is on', () => {
    expect(parseSyncPref('0')).toBe(false)
    expect(parseSyncPref('1')).toBe(true)
    expect(parseSyncPref(null)).toBe(true)
    expect(parseSyncPref('junk')).toBe(true)
  })
})
