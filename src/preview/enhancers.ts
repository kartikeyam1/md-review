import type { HeadingInfo } from '@/markdown/headingIds'
import type { DocState } from '@/composables/docState'
import type { Router } from '@/composables/useRouter'
import type { toast } from '@/composables/useToast'

// Preview enhancers (00 §4.5): DOM behaviour layered on the rendered markdown.
// Each is `(container, ctx) => cleanup`, run by PreviewPane after every render
// through the single runEnhancers() call; they use event delegation on the
// container. Later items add one line to ENHANCERS: codeCopy (#14), zoom (#15),
// folding (#17), sectionReactions (#24).

export interface EnhancerContext {
  /** The rendered headings (ids + token plain text), from the same parse as the HTML. */
  headings: HeadingInfo[]
  /** The doc on screen (null when the preview is rendered outside a doc layout). */
  docState: DocState | null
  router: Router
  toast: typeof toast
  /** Clipboard write with the textarea fallback; resolves false when both fail. */
  copyText: (text: string) => Promise<boolean>
  /** Copy the link to the section `id`, with its toast (#3 rule 17). */
  copySectionLink: (id: string) => void
}

export type Enhancer = (container: HTMLElement, ctx: EnhancerContext) => (() => void) | void

const ENHANCERS: Enhancer[] = []

// All of them (#3 heading anchors, #24 section reactions, #14 code copy, #17
// folding, #15 zoom) live in one lazy chunk (lazyEnhancers.ts) so the entry stays within #6's AC-06.8 budget.
// It is requested when this module loads, so it is normally in before the first
// doc renders; a render that beats it runs them as soon as it arrives.
let lazy: Enhancer[] | null = null
const lazyReady: Promise<Enhancer[]> = import('./lazyEnhancers')
  .then((m) => (lazy = m.LAZY_ENHANCERS))
  .catch(() => (lazy = []))

/** Run every enhancer on `container`; returns one cleanup for all of them. */
export function runEnhancers(container: HTMLElement, ctx: EnhancerContext): () => void {
  const cleanups: (() => void)[] = []
  let cancelled = false
  const run = (list: Enhancer[]) => {
    for (const enhance of list) {
      const c = enhance(container, ctx)
      if (typeof c === 'function') cleanups.push(c)
    }
  }
  run(ENHANCERS)
  if (lazy) run(lazy)
  else lazyReady.then((list) => { if (!cancelled && container.isConnected) run(list) })
  return () => { cancelled = true; for (const c of cleanups) c() }
}
