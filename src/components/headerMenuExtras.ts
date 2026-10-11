import type { AppMenuEntry } from '@/components/AppMenu.vue'

// Overflow-menu entries for header controls that live in lazy chunks (#6 entry
// budget): HeaderOverflowMenu loads this module on mount and slots the entries
// into their 00 §2.3 places. #18: "Reading settings" (phone).

export interface OverflowExtrasContext {
  demoted: { reader?: boolean }
  docOpen: boolean
}

/** #18: on a phone the reading settings open as a sheet from the overflow menu. */
export function readerEntry(ctx: OverflowExtrasContext): AppMenuEntry | null {
  if (!ctx.demoted.reader || !ctx.docOpen) return null
  return {
    type: 'item', id: 'reader', testid: 'reader-settings-btn', label: 'Reading settings',
    attrs: { 'aria-haspopup': 'dialog' },
    onSelect: () => { window.dispatchEvent(new Event('md-review:reader-settings')) },
  }
}
