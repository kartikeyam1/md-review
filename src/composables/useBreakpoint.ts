import { ref, onMounted, onUnmounted, type Ref } from 'vue'

// Breakpoints (00 §12): phone < 641px · tablet 641–1099px · desktop ≥ 1100px.
export type Breakpoint = 'phone' | 'tablet' | 'desktop'

/** Pure: the breakpoint for a viewport width. */
export function breakpointFor(width: number): Breakpoint {
  if (width < 641) return 'phone'
  if (width < 1100) return 'tablet'
  return 'desktop'
}

/** The current breakpoint, following window resizes. */
export function useBreakpoint(): Ref<Breakpoint> {
  const bp = ref<Breakpoint>(typeof window === 'undefined' ? 'desktop' : breakpointFor(window.innerWidth))
  const update = () => { bp.value = breakpointFor(window.innerWidth) }
  onMounted(() => { update(); window.addEventListener('resize', update) })
  onUnmounted(() => window.removeEventListener('resize', update))
  return bp
}
