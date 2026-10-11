import type { ThemeMode } from '@/types'
import { isDark, isLocus } from '@/composables/useTheme'

// Mermaid theme config per app theme — shared by the preview (PreviewPane) and
// the #19 HTML export, which renders diagrams itself when no preview is on screen.

// Locus diagrams (#1 rule 12): mermaid's `base` theme fed brand colours, the
// six series colours for pie slices / cScale / xy plots.
const LOCUS_SERIES = ['#B066FF', '#3264FF', '#14B4EF', '#00D273', '#FF9F00', '#FF6429']

export function locusThemeVariables(dark: boolean): Record<string, unknown> {
  const series: Record<string, string> = {}
  LOCUS_SERIES.forEach((c, i) => {
    series[`pie${i + 1}`] = c
    series[`cScale${i}`] = c
  })
  const tone = dark
    ? {
        background: '#280A38', primaryColor: '#533B60', mainBkg: '#533B60',
        primaryTextColor: '#FFFFFF', titleColor: '#FFFFFF', textColor: '#FFFFFF', nodeTextColor: '#FFFFFF',
        lineColor: '#E6E1DA', clusterBkg: '#280A38', clusterBorder: '#533B60', edgeLabelBackground: '#280A38',
      }
    : {
        background: '#FFFFFF', primaryColor: '#F3F0EB', mainBkg: '#F3F0EB',
        primaryTextColor: '#280A38', titleColor: '#280A38', textColor: '#533B60', nodeTextColor: '#280A38',
        lineColor: '#533B60', clusterBkg: '#FFFFFF', clusterBorder: '#E6E1DA', edgeLabelBackground: '#FFFFFF',
      }
  return {
    darkMode: dark,
    fontFamily: 'Montserrat, Arial, sans-serif',
    primaryBorderColor: '#B066FF',
    nodeBorder: '#B066FF',
    ...tone,
    ...series,
    // Full-strength slices separated by the page colour (no black outlines).
    pieOpacity: '1',
    pieStrokeColor: tone.background,
    pieOuterStrokeColor: tone.background,
    pieTitleTextColor: tone.primaryTextColor,
    pieLegendTextColor: tone.textColor,
    // Slice labels in deep purple read on every series colour (bold in CSS).
    pieSectionTextColor: '#280A38',
    // Sequence-diagram notes as cream / purple-grey cards with a brand edge.
    noteBkgColor: dark ? '#533B60' : '#F3F0EB',
    noteBorderColor: '#B066FF',
    noteTextColor: tone.primaryTextColor,
    // xy charts default to a white canvas with black axes: follow the page.
    xyChart: {
      plotColorPalette: LOCUS_SERIES.join(', '),
      backgroundColor: tone.background,
      titleColor: tone.primaryTextColor,
      xAxisLabelColor: tone.textColor, xAxisTitleColor: tone.textColor,
      xAxisTickColor: tone.lineColor, xAxisLineColor: tone.lineColor,
      yAxisLabelColor: tone.textColor, yAxisTitleColor: tone.textColor,
      yAxisTickColor: tone.lineColor, yAxisLineColor: tone.lineColor,
    },
  }
}

export type MermaidThemeConfig = { theme: 'dark' | 'neutral' | 'base'; themeVariables?: Record<string, unknown> }

/** The mermaid config for `theme`; `print` = the light rendering used on paper (#5 rule 13). */
export function mermaidConfigFor(theme: ThemeMode, print = false): MermaidThemeConfig {
  if (isLocus(theme)) return { theme: 'base', themeVariables: locusThemeVariables(print ? false : isDark(theme)) }
  if (print) return { theme: 'neutral' }
  return { theme: isDark(theme) ? 'dark' : 'neutral' }
}

// mermaid.initialize() sets one global config: every render job in the app
// (each preview, the #19 export's off-screen render) runs through this queue,
// one at a time, so a job never renders with another job's theme.
let queue: Promise<unknown> = Promise.resolve()

/** Run `job` after every mermaid job queued before it; resolves with its result. */
export function mermaidJob<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.catch(() => {}).then(job)
  queue = run
  return run
}

// ── Author fills (`style X fill:#f8d7da`) ───────────────────────────────────
// Mermaid keeps the theme's label colour on a node the author filled, so a light
// fill in a dark theme (or a dark fill in a light one) gets an unreadable label.
// After each render, a label that falls below 3:1 on its node's fill switches to
// whichever of dark or white text reads better. Labels the author coloured
// (`color:` in the style) are left alone.

let paint: CanvasRenderingContext2D | null | undefined
function rgbOf(value: string | null | undefined): [number, number, number] | null {
  const v = value?.trim()
  if (!v || v === 'none' || typeof CSS === 'undefined' || !CSS.supports('color', v)) return null
  paint ??= document.createElement('canvas').getContext('2d')
  if (!paint) return null
  paint.fillStyle = v
  const s = String(paint.fillStyle)
  if (s.startsWith('#')) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number]
  const m = /rgba?\(([^)]+)\)/.exec(s)
  if (!m) return null
  const [r, g, b, a] = m[1]!.split(',').map(Number)
  return a === 0 ? null : [r!, g!, b!]
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

const DARK: [number, number, number] = [40, 10, 56]
const WHITE: [number, number, number] = [255, 255, 255]

export function fixAuthorFillContrast(root: Element): void {
  for (const shape of root.querySelectorAll<SVGElement>('g.node [style*="fill"]')) {
    const style = shape.getAttribute('style') ?? ''
    if (/(^|;)\s*color\s*:/i.test(style)) continue
    const fill = rgbOf(/(?:^|;)\s*fill\s*:\s*([^;!]+)/i.exec(style)?.[1])
    const node = shape.closest('g.node')
    if (!fill || !node) continue
    for (const label of node.querySelectorAll<HTMLElement | SVGElement>('.nodeLabel, text')) {
      const svgText = label instanceof SVGElement
      const fg = rgbOf(svgText ? getComputedStyle(label).fill : getComputedStyle(label).color)
      if (!fg || ratio(fg, fill) >= 3) continue
      const pick = ratio(DARK, fill) >= ratio(WHITE, fill) ? DARK : WHITE
      label.style.setProperty(svgText ? 'fill' : 'color', `rgb(${pick.join(',')})`, 'important')
    }
  }
}
