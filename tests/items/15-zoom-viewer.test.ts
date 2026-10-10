// #15 Zoom viewer — unit acceptance tests for the pure zoom/pan maths
// (docs/build/specs/15-zoom-viewer.md rules 6, 8, 9, 10, 14).
//
// Module contract — src/composables/useZoomPan.ts:
//   type Size = { w: number; h: number }; type View = { scale: number; x: number; y: number }
//     (x, y = the content's top-left corner in stage coordinates, CSS px)
//   fitScale(natural: Size, stage: Size, pad = 16): number
//     largest scale at which `natural` fits inside the stage minus `pad` on each side
//   scaleLimits(fit: number): { min: number; max: number }   min = min(fit, 1) / 2; max = max(4, fit × 2)
//   initialView(natural, stage): View                         scale = min(fit, 2), content centred
//   zoomAround(v: View, scale: number, px: number, py: number): View
//     the content point under stage point (px, py) stays there
//   clampView(v: View, natural: Size, stage: Size, margin = 48): View
//     ≥ `margin` px of content stays inside the stage on each axis; an axis where the content is
//     smaller than the stage is centred
//   doubleTapScale(initial: number, max: number): number      min(max, max(1, initial × 2.5))
import { describe, it, expect } from 'vitest'
import { fitScale, scaleLimits, initialView, zoomAround, clampView, doubleTapScale } from '@/composables/useZoomPan'

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('#15 useZoomPan', () => {
  it('rule 6: fit, limits and the initial view', () => {
    const stage = { w: 390, h: 700 }
    const nat = { w: 3000, h: 400 }
    const fit = fitScale(nat, stage)
    near(fit, (390 - 32) / 3000)
    const lim = scaleLimits(fit)
    near(lim.min, fit / 2)
    expect(lim.max).toBe(4)
    const v = initialView(nat, stage)
    near(v.scale, fit)
    near(v.x, (390 - 3000 * fit) / 2)
    near(v.y, (700 - 400 * fit) / 2)
  })

  it('rule 6: a tiny diagram starts at 200% (not its fit), limits follow fit', () => {
    const nat = { w: 100, h: 50 }
    const stage = { w: 1400, h: 840 }
    const fit = fitScale(nat, stage)
    expect(fit).toBeGreaterThan(2)
    expect(initialView(nat, stage).scale).toBe(2)
    expect(scaleLimits(fit)).toEqual({ min: 0.5, max: fit * 2 })
  })

  it('rule 8: zooming keeps the point under the cursor fixed', () => {
    const v = { scale: 0.5, x: 10, y: 20 }
    const px = 300; const py = 200
    const before = { cx: (px - v.x) / v.scale, cy: (py - v.y) / v.scale }
    const z = zoomAround(v, 1.25, px, py)
    expect(z.scale).toBe(1.25)
    near((px - z.x) / z.scale, before.cx)
    near((py - z.y) / z.scale, before.cy)
  })

  it('rule 10: pan clamps to keep 48px visible; smaller axes are centred', () => {
    const stage = { w: 400, h: 600 }
    const nat = { w: 1000, h: 100 }
    // scale 1: content 1000 wide (bigger than the stage), 100 tall (smaller)
    const far = clampView({ scale: 1, x: 5000, y: -999 }, nat, stage)
    expect(far.x).toBe(400 - 48)
    expect(far.y).toBe((600 - 100) / 2)
    const farLeft = clampView({ scale: 1, x: -5000, y: 0 }, nat, stage)
    expect(farLeft.x).toBe(48 - 1000)
    const inside = clampView({ scale: 1, x: -200, y: 0 }, nat, stage)
    expect(inside.x).toBe(-200)
  })

  it('rule 9: double-tap target scale', () => {
    expect(doubleTapScale(0.1, 4)).toBe(1)
    expect(doubleTapScale(0.8, 4)).toBe(2)
    expect(doubleTapScale(2, 4)).toBe(4)
  })

  it('rule 14: at a phone stage the reader can reach 100% and every corner of a 3000px diagram', () => {
    const stage = { w: 390, h: 760 }
    const nat = { w: 3000, h: 1200 }
    const lim = scaleLimits(fitScale(nat, stage))
    expect(lim.max).toBeGreaterThanOrEqual(1)
    const tl = clampView({ scale: 1, x: 0, y: 0 }, nat, stage)
    expect(tl).toEqual({ scale: 1, x: 0, y: 0 })
    const br = clampView({ scale: 1, x: stage.w - nat.w, y: stage.h - nat.h }, nat, stage)
    expect(br).toEqual({ scale: 1, x: stage.w - nat.w, y: stage.h - nat.h })
  })
})
