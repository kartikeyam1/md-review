import type { Enhancer } from './enhancers'
import { headingAnchors } from './headingAnchors'
import { sectionReactions } from './sectionReactions'
import { codeCopy } from './codeCopy'
import { folding } from './folding'
import { zoom } from './zoom'
import { readerState } from './readerState'

// The enhancers that load in their own chunk (fetched as soon as the app
// starts, see enhancers.ts), keeping #6's entry-size budget. Order matters:
// heading anchors first, then the controls that go before them in a heading.
export const LAZY_ENHANCERS: Enhancer[] = [
  headingAnchors, // #3
  sectionReactions, // #24 (after headingAnchors: its chips go before the heading-anchor)
  codeCopy, // #14
  folding, // #17
  zoom, // #15
  readerState, // #18
]
