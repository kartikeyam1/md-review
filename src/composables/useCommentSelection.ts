import { ref, type Ref } from 'vue'

// ── Selection → comment flow (part of the doc state, 00 §4.1) ────────────────
// A selection in the editor or preview raises the action bar, which opens the
// comment popover. Review UI only (#2 rule 6); a viewer on a pinned revision
// does not anchor new comments. The pane that paints the persisted selection
// highlight registers how to clear it (pane refs stay in DocView).

export interface CommentSelection {
  startLine: number
  endLine: number
  selectedText: string
  coords: { x: number; y: number }
}

export function useCommentSelection(opts: { reviewUI: Ref<boolean>; readOnly: Ref<boolean> }) {
  const selection = ref<CommentSelection | null>(null)
  const showActionBar = ref(false)
  const showPopover = ref(false)
  let clearHighlight: () => void = () => {}

  /** DocView: how to clear the preview's persisted selection highlight. */
  function setHighlightClearer(fn: () => void) { clearHighlight = fn }

  function dismissAll() {
    showActionBar.value = false
    showPopover.value = false
    selection.value = null
    clearHighlight()
  }

  function handleSelection(info: CommentSelection) {
    if (showPopover.value || opts.readOnly.value || !opts.reviewUI.value) return
    selection.value = info
    showActionBar.value = true
  }

  function openComment() {
    showActionBar.value = false
    showPopover.value = true
  }

  function dismissActionBar() {
    showActionBar.value = false
    // Keep selection alive briefly in case popover is opening
    setTimeout(() => {
      if (!showPopover.value && !showActionBar.value) {
        selection.value = null
        clearHighlight()
      }
    }, 100)
  }

  function handleSelectionClear() {
    setTimeout(() => {
      if (!showPopover.value && !showActionBar.value) {
        selection.value = null
      }
    }, 200)
  }

  return {
    selection, showActionBar, showPopover, setHighlightClearer,
    dismissAll, handleSelection, handleSelectionClear, openComment, dismissActionBar,
  }
}
