import type { AppMenuEntry } from '@/components/AppMenu.vue'
import type { DocState } from '@/composables/docState'
import type { DocViewName } from '@/composables/useDocState'
import { downloadBusy, runDownload } from '@/composables/downloadActions'

// Overflow-menu entries for header controls that live in lazy chunks (#6 entry
// budget): HeaderOverflowMenu loads this module on mount and slots the entries
// into their 00 §2.3 places. #18: "Reading settings" (phone); #19: the
// "Download" group (tablet and phone; the bar's DownloadMenu uses the same items).

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

export interface DownloadContext {
  doc: DocState
  setView: (v: DocViewName) => void
}

/** #19 rule 2: markdown docs get .md / .html / PDF, HTML docs their source. */
export function downloadEntries({ doc, setView }: DownloadContext): AppMenuEntry[] {
  const run = (kind: Parameters<typeof runDownload>[0]) => () => { void runDownload(kind, doc, setView) }
  if (doc.contentType.value === 'html') {
    return [{ type: 'item', id: 'dl-source', testid: 'download-html-source', label: 'HTML source (.html)', onSelect: run('html-source') }]
  }
  const busy = downloadBusy.value
  return [
    { type: 'item', id: 'dl-md', testid: 'download-md', label: 'Markdown (.md)', onSelect: run('md') },
    {
      type: 'item', id: 'dl-html', testid: 'download-html', label: busy ? 'HTML (.html) — preparing…' : 'HTML (.html)',
      disabled: busy, attrs: busy ? { 'aria-busy': 'true' } : undefined, onSelect: run('html'),
    },
    { type: 'item', id: 'dl-pdf', testid: 'download-pdf', label: 'PDF (print)', onSelect: run('pdf') },
  ]
}

/** #19 rule 1: below 1100px the Download items are a group of the overflow menu. */
export function downloadGroup(ctx: DownloadContext & { demoted: { download?: boolean }; docOpen: boolean }): AppMenuEntry | null {
  if (!ctx.demoted.download || !ctx.docOpen) return null
  return { type: 'group', id: 'download', label: 'Download', entries: downloadEntries(ctx) }
}
