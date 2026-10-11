import { ref, nextTick } from 'vue'
import type { DocState } from '@/composables/docState'
import type { DocViewName } from '@/composables/useDocState'
import { toast } from '@/composables/useToast'

// #19: what each Download item does, shared by the bar's DownloadMenu and the
// overflow menu's "Download" group (both lazy). The work itself lives in
// useDownload.ts, loaded on first use. Everything is client-side: .md, HTML
// source and PDF never touch the backend (rule 9).

export type DownloadKind = 'md' | 'html' | 'pdf' | 'html-source'

/** Rule 11: the .html export is working (busy state on download-html; a second click is ignored). */
export const downloadBusy = ref(false)
let running = false

/** The markdown preview on screen, if it is visible (read view, or split view's preview). */
function livePreview(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>('.doc-content .preview-pane')
  return el && el.getClientRects().length ? el : null
}

async function waitFor<T>(get: () => T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  for (let v = get(); ; v = get()) {
    if (v || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 50))
  }
}

export async function runDownload(kind: DownloadKind, doc: DocState, setView: (v: DocViewName) => void): Promise<void> {
  if (running) return
  running = true
  if (kind === 'html') downloadBusy.value = true
  try {
    const d = await import('@/composables/useDownload')
    const source = doc.markdown.value
    // A pinned revision's `filename` is its id; the doc's own name rides on its meta.
    const name = (doc.pinnedInfo.value && doc.docMeta.value.filename) || doc.filename.value
    if (kind === 'md') {
      d.saveBlob(source, 'text/markdown;charset=utf-8', d.mdFilename(name))
    } else if (kind === 'html-source') {
      d.saveBlob(source, 'text/html;charset=utf-8', d.htmlSourceFilename(name))
    } else if (kind === 'html') {
      const html = await d.buildHtmlExport({ live: livePreview(), markdown: source, theme: doc.theme.value, title: doc.docTitle.value })
      d.saveBlob(html, 'text/html;charset=utf-8', d.htmlExportFilename(name))
    } else {
      // Rule 8: print what the read view shows. From the edit view (nothing to
      // print on screen) switch to the read view for the print, then go back.
      let live = livePreview()
      const back = live ? null : doc.view.value
      if (!live) {
        setView('read')
        await nextTick()
        live = await waitFor(livePreview, 5000)
      }
      try {
        if (live) await d.diagramsSettled(live, undefined, d.diagramKey(doc.theme.value))
        window.print()
      } finally {
        if (back && back !== 'read') setView(back)
      }
    }
  } catch {
    toast.error('Download failed')
  } finally {
    running = false
    downloadBusy.value = false
  }
}
