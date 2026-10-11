// #27: the landing page (FileUpload, with its template entry point) is its own chunk, so doc readers
// never load it (#6 AC-06.8 budget). On the landing route the chunk is requested at boot, in parallel
// with the app's own start-up, instead of only once the page renders; a failed load (a stale chunk
// after a deploy, a dropped connection) shows a reload prompt instead of a blank page.
import { defineAsyncComponent, defineComponent, h } from 'vue'
import { useRouter } from '@/composables/useRouter'

let pending: Promise<typeof import('@/components/FileUpload.vue')> | null = null
/** The FileUpload chunk, requested once (a failed request is retried on the next call). */
export function loadFileUpload() {
  pending ??= import('@/components/FileUpload.vue').catch((e) => { pending = null; throw e })
  return pending
}

/** Shown when the landing chunk cannot be loaded. */
export const LandingLoadError = defineComponent({
  name: 'LandingLoadError',
  setup() {
    return () => h('div', { class: 'landing-load-error', role: 'alert', 'data-testid': 'landing-load-error', style: 'text-align:center;padding:48px 16px;color:var(--text-secondary)' }, [
      h('p', { style: 'margin:0 0 12px' }, 'This page could not be loaded.'),
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => window.location.reload() }, 'Reload'),
    ])
  },
})

/** The async FileUpload for DocView; starts the chunk now when the app opened on the landing route. */
export function lazyFileUpload() {
  if (useRouter().current.value.route.kind === 'landing') void loadFileUpload().catch(() => {})
  return defineAsyncComponent({ loader: loadFileUpload, errorComponent: LandingLoadError })
}
