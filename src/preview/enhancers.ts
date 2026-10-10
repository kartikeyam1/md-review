import type { HeadingInfo } from '@/markdown/headingIds'
import type { DocState } from '@/composables/docState'
import type { Router } from '@/composables/useRouter'
import type { toast } from '@/composables/useToast'
import { headingAnchors } from './headingAnchors'
import { sectionReactions } from './sectionReactions'

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

const ENHANCERS: Enhancer[] = [
  headingAnchors, // #3
  sectionReactions, // #24 (after headingAnchors: its chips go before the heading-anchor)
]

/** Run every enhancer on `container`; returns one cleanup for all of them. */
export function runEnhancers(container: HTMLElement, ctx: EnhancerContext): () => void {
  const cleanups = ENHANCERS.map((enhance) => enhance(container, ctx)).filter((c): c is () => void => typeof c === 'function')
  return () => { for (const c of cleanups) c() }
}
