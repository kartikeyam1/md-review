import { ref, computed, watch, provide, inject, type InjectionKey, type Ref, type ComputedRef } from 'vue'
import { extractHeadings, buildToc, type TocEntry } from '@/markdown/headingIds'
import type { Breakpoint } from '@/composables/useBreakpoint'

// TOC state shared by DocView (rail / drawer) and DocHeader (toc-toggle) —
// spec #3 rules 8–14. DocView provides it; the header injects it.

export const TOC_COLLAPSED_KEY = 'md-review-toc-collapsed'

function readCollapsed(): boolean {
  try { return localStorage.getItem(TOC_COLLAPSED_KEY) === '1' } catch { return false }
}

function writeCollapsed(v: boolean) {
  try {
    if (v) localStorage.setItem(TOC_COLLAPSED_KEY, '1')
    else localStorage.removeItem(TOC_COLLAPSED_KEY)
  } catch { /* storage unavailable: the preference lasts for this page only */ }
}

export interface TocState {
  entries: ComputedRef<TocEntry[]>
  /** A TOC exists for what is on screen (read view, markdown, ≥ 2 entries). */
  visible: ComputedRef<boolean>
  /** Desktop rail shown (visible, ≥ 1100px, not collapsed). */
  railShown: ComputedRef<boolean>
  /** toc-toggle shown: below 1100px, or on desktop while the rail is collapsed. */
  toggleShown: ComputedRef<boolean>
  drawerMode: ComputedRef<boolean>
  collapsed: Ref<boolean>
  drawerOpen: Ref<boolean>
  activeId: Ref<string | null>
  setCollapsed: (v: boolean) => void
  /** toc-toggle: reopen the rail (desktop) or open/close the drawer. */
  toggle: () => void
  closeDrawer: () => void
}

const TOC_STATE: InjectionKey<TocState> = Symbol('toc-state')

export function provideToc(o: { markdown: Ref<string>; enabled: Ref<boolean>; breakpoint: Ref<Breakpoint>; agentView?: Ref<boolean> }): TocState {
  // Parsed only while a TOC can show (computed is lazy and `enabled` gates it).
  // #28: the human view leaves out headings inside agent-only sections; the agent view lists them.
  const entries = computed<TocEntry[]>(() => (o.enabled.value ? buildToc(extractHeadings(o.markdown.value, o.agentView?.value ? 'agent' : 'human')) : []))
  const visible = computed(() => o.enabled.value && entries.value.length >= 2)
  const drawerMode = computed(() => o.breakpoint.value !== 'desktop')
  const collapsed = ref(readCollapsed())
  const drawerOpen = ref(false)
  const activeId = ref<string | null>(null)
  const railShown = computed(() => visible.value && !drawerMode.value && !collapsed.value)
  const toggleShown = computed(() => visible.value && (drawerMode.value || collapsed.value))

  function setCollapsed(v: boolean) {
    collapsed.value = v
    writeCollapsed(v)
  }

  function toggle() {
    if (!drawerMode.value) { setCollapsed(false); return }
    drawerOpen.value = !drawerOpen.value
  }

  function closeDrawer() { drawerOpen.value = false }

  // The drawer only exists below 1100px and while a TOC does.
  watch([drawerMode, visible], ([d, v]) => { if (!d || !v) drawerOpen.value = false })
  // Rule 14: a rebuild keeps the active entry when its id survives.
  watch(entries, (list) => {
    if (activeId.value && !list.some((e) => e.id === activeId.value)) activeId.value = null
  })

  const state: TocState = { entries, visible, railShown, toggleShown, drawerMode, collapsed, drawerOpen, activeId, setCollapsed, toggle, closeDrawer }
  provide(TOC_STATE, state)
  return state
}

/** The TOC state DocView provides, or null outside a doc layout. */
export function useToc(): TocState | null {
  return inject(TOC_STATE, null)
}
