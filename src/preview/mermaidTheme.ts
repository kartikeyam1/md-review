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
