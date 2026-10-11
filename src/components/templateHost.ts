// ── Templates (#27): mount the picker / save dialog on demand ──────────────────
// Entry-chunk callers (the landing page, the header overflow menu) reach this
// module only through a dynamic import(), so neither dialog nor the template
// API adds to the entry (#6 AC-06.8 budget). Each dialog is its own small Vue
// app under <body>; app-wide state (router, toasts, edit tokens, reader name)
// lives in module singletons, so it is shared with the main app.
import { createApp, type Component, type Ref } from 'vue'
import TemplatePicker from '@/components/TemplatePicker.vue'
import SaveTemplateDialog from '@/components/SaveTemplateDialog.vue'

let current: (() => void) | null = null

function mount(component: Component, props: Record<string, unknown>) {
  current?.() // one template dialog at a time
  const el = document.createElement('div')
  document.body.appendChild(el)
  const close = () => {
    if (current !== close) return
    current = null
    app.unmount()
    el.remove()
  }
  const app = createApp(component, { ...props, onClose: close })
  current = close
  app.mount(el)
}

/** "New from template" (rule 9); `templateId` preselects one (the library's template-use). */
export function openTemplatePicker(templateId?: string | null) {
  mount(TemplatePicker, { initialTemplateId: templateId ?? null })
}

/** The doc-state fields "Save as template" reads (the overflow menu passes the doc state itself). */
export interface SaveTemplateSource {
  docTitle: Ref<string>
  markdown: Ref<string>
  contentType: Ref<'markdown' | 'html'>
  mode: Ref<'publish' | 'review'>
  pasteId: Ref<string | null>
}

/** "Save as template" (rule 14), with the primary doc as it is on screen now. */
export function openSaveTemplate(doc: SaveTemplateSource) {
  mount(SaveTemplateDialog, {
    title: doc.docTitle.value, content: doc.markdown.value, contentType: doc.contentType.value,
    mode: doc.mode.value, docId: doc.pasteId.value,
  })
}
