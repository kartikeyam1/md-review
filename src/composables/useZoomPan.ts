// Zoom/pan maths for the #15 viewer (spec rules 6, 8–10, 14). Pure functions:
// a View is the content's scale and the stage position of its top-left corner.

export interface Size { w: number; h: number }
export interface View { scale: number; x: number; y: number }

export const ZOOM_STEP = 1.25
export const PAN_STEP = 48
export const PAN_STEP_LARGE = 240
export const MIN_VISIBLE = 48

/** Rule 6: the largest scale at which `natural` fits the stage minus `pad` on each side. */
export function fitScale(natural: Size, stage: Size, pad = 16): number {
  const w = Math.max(1, stage.w - 2 * pad)
  const h = Math.max(1, stage.h - 2 * pad)
  return Math.min(w / Math.max(1, natural.w), h / Math.max(1, natural.h))
}

/** Rule 6: min = min(fit, 1) / 2, max = max(4, fit × 2). */
export function scaleLimits(fit: number): { min: number; max: number } {
  return { min: Math.min(fit, 1) / 2, max: Math.max(4, fit * 2) }
}

export function centred(natural: Size, stage: Size, scale: number): View {
  return { scale, x: (stage.w - natural.w * scale) / 2, y: (stage.h - natural.h * scale) / 2 }
}

/** Rule 6: min(fit, 2), centred. */
export function initialView(natural: Size, stage: Size): View {
  return centred(natural, stage, Math.min(fitScale(natural, stage), 2))
}

/** Rule 8: scale to `scale` keeping the content point under stage point (px, py) fixed. */
export function zoomAround(v: View, scale: number, px: number, py: number): View {
  const k = scale / v.scale
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
}

function clampAxis(pos: number, size: number, stage: number, margin: number, centreSmall: boolean): number {
  if (size <= stage && centreSmall) return (stage - size) / 2
  const m = Math.min(margin, size)
  return Math.min(stage - m, Math.max(m - size, pos))
}

/**
 * Rule 10: ≥ `margin` px of content stays in the stage; an axis smaller than
 * the stage is centred. Zooming passes `centreSmall: false` so the point under
 * the cursor stays put (rule 8) even while the content is still small.
 */
export function clampView(v: View, natural: Size, stage: Size, margin = MIN_VISIBLE, centreSmall = true): View {
  return {
    scale: v.scale,
    x: clampAxis(v.x, natural.w * v.scale, stage.w, margin, centreSmall),
    y: clampAxis(v.y, natural.h * v.scale, stage.h, margin, centreSmall),
  }
}

/** Rule 9: the double-tap / double-click target. */
export function doubleTapScale(initial: number, max: number): number {
  return Math.min(max, Math.max(1, initial * 2.5))
}

export function clampScale(s: number, lim: { min: number; max: number }): number {
  return Math.min(lim.max, Math.max(lim.min, s))
}
