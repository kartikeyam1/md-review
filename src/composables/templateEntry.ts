// #27: the template dialogs, loaded on demand — the entry chunk holds only these one-liners (#6 AC-06.8 budget).
// The library reaches the dialogs through here too, so its chunk does not carry them either.
import type { SaveTemplateSource } from '@/components/templateHost'
import { toast } from '@/composables/useToast'

type Host = typeof import('@/components/templateHost')
export const LOAD_FAILED_MESSAGE = 'Could not open templates. Reload the page.'

/** Load the dialogs' chunk and run `use`; a failed load (a stale chunk after a deploy) says so instead of doing nothing. */
export function withTemplateHost(use: (m: Host) => void, load: () => Promise<Host> = () => import('@/components/templateHost')): Promise<void> {
  return load().then(use, () => { toast.error(LOAD_FAILED_MESSAGE) })
}

/** Rule 9: open the "New from template" picker (takes no argument, so it can be a click handler). */
export const newFromTemplate = () => withTemplateHost((m) => m.openTemplatePicker())
/** Rule 18: the picker with one template preselected (the library's template-use). */
export const newFromTemplateId = (templateId: string) => withTemplateHost((m) => m.openTemplatePicker(templateId))
/** Rule 14: open "Save as template" for the doc on screen (read when it opens: unsaved edits included). */
export const saveAsTemplate = (doc: SaveTemplateSource) => withTemplateHost((m) => m.openSaveTemplate(doc))
