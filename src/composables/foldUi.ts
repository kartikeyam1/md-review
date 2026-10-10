import { ref, shallowRef } from 'vue'

// #17: the preview on screen registers its fold controller here; `foldable`
// gates the TOC's Collapse all / Expand all buttons (rule 8). Kept separate from
// useFolding.ts so the entry chunk (TocPanel) does not pull in the fold logic.

export interface FoldController {
  collapseAll(): void
  expandAll(): void
}

/** The preview on screen registers its controller here; `foldable` gates the TOC buttons (rule 8). */
export const foldUi = {
  foldable: ref(false),
  controller: shallowRef<FoldController | null>(null),
}
