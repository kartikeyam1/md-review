# #13 Focus mode — code review

Scope: only the `13-draft.patch` changes (on top of #7), read in context in `md-review-cap-layout-qa13`. Static review; I ran no gate (that is QA's job).

**Verdict: PASS, no blockers.** The design is sound. There is one module-level flag, DocView gates and resets it (on load, leaving the editing views, a doc change or unmount), and both the shortcut and the Esc exit run through window listeners. Modals that close on Esc in a bubble listener (Share, History) still have `.modal-overlay` in the DOM when the exit check runs, so their Esc never also leaves focus mode. CodeMirror's search close and `simplifySelection` call preventDefault, and `simplifySelection` returns false on an empty selection, so layers 7–8 work. Mod-Shift-Enter does not clash with `insertBlankLine` (Mod-Enter), because CodeMirror matches modifiers exactly for keys that do not type a character. Pulling the save labels out into `saveStateLabels.ts` is a clean change. The conflict and persist-error bars stay visible in focus mode.

## SHOULD-FIX

1. **In focus mode, Esc throws away a comment the user is typing.** `DocView.vue:97-102` calls `doc.dismissAll()` while the popover is open, including when the Esc comes from inside the `CommentPopover` textarea. The draft lives only in that component (`CommentPopover.vue:22`, `const body = ref('')`) and is lost without warning. Outside focus mode Esc does nothing in the popover, so this risk exists only in focus mode, which works against the spec's own "never lose work silently" rule. Fix: when `showPopover` is open and the draft is non-empty, do not dismiss. Return early so the popover keeps focus, or move focus back to the editor. Closing the action bar is fine either way.
2. **A drawer left open when focus mode starts breaks Esc and Tab.** The shortcut works with any focus, so it can fire while `comments-drawer` (below 1100px) or `toc-drawer` is open.
   - The comments drawer gets `display:none` from the `.doc-aside :deep(.comments-drawer)` rule but stays mounted with `aria-modal="true"`. `OPEN_LAYERS` (`DocView.vue:95`) keeps matching it, so Esc can never exit focus mode, and its `useFocusTrap` keeps catching Tab for a hidden element.
   - The TOC drawer (`DocView.vue:241`) is not hidden at all, which breaks rule 3.
   - Fix: when `focusShown` turns true, call `toc.closeDrawer()` and close the comments drawer, for example with a `watch(focusMode())` in CommentsLayer that calls `closeDrawer()`. Alternatively, let `when:` refuse the toggle while `document.querySelector(OPEN_LAYERS)` finds something.
3. **The save-state tooltip promises an action that isn't there.** In the error state, `focus-save-state` shows `SAVE_TITLE.error`, "…click to retry" (`FocusControls.vue:41`), but the span has no click handler, and the header's Retry is hidden in focus mode. Fix: render it as a button that calls `flushAutosave()` in the `error` state, as `SaveState.vue` does. Or give the error state a different title, such as "…press Ctrl/Cmd+S to retry".
4. **The banner part of AC-13.1 is barely tested.** The test only checks `.notice-bar` (`13-focus-mode.test.mjs:108`) on a local doc, and a local doc never shows ApprovalBanner, SummaryPanel or ChangesBanner, because those need `pasteId`. The `v-show` lines added to `DocBanners.vue` are not exercised. Fix: add a shared review-mode doc to AC-13.1 (or a sibling test) and assert `.summary-panel` and `.approval-banner` are hidden in focus mode and come back on exit. A TOC-rail-hidden check (rule 3) would also be cheap.

## NIT

- `DocBanners.vue:21` hides banners on the raw flag, while the header and controls use DocView's gated `focusShown`. It works today only because every path that toggles the flag is gated. Export one gated computed (for example `focusActive`) or provide it from DocView, so the two cannot drift.
- Holding Esc or Mod+Shift+Enter repeats the key. One held Esc closes search and then exits focus mode, and a held shortcut makes the chrome flicker. Ignore `e.repeat` in `onFocusEscape` and in the shortcut's `run`.
- `DocView.vue:83`: the shortcut also toggles focus mode underneath an open Share or History modal. Harmless, but `when` could add `!document.querySelector(OPEN_LAYERS)`.
- Esc closing the popover / action bar (layer 5) is only implemented in focus mode. 00 §3.4 is meant to apply everywhere, so in normal mode Esc on the action bar does nothing. Either note this in DECISIONS as deliberately limited to focus mode, or move the capture handler into CommentsLayer without the focus gate.
- `OPEN_LAYERS` names the future `slash-menu` (#12) and `zoom-viewer` (#15) test ids. That is fine, but #24's `reaction-picker` and the other layer-3 panels must call preventDefault on Esc or they will also exit focus mode. A one-line note for #12/#15/#24 in BUILD-ORDER or DECISIONS would make the contract explicit.
- BUILD-ORDER says #13 puts its column style in `EditorPane.vue`. It lives in DocView `:deep(.cm-editor)` instead. Acceptable, but update the file map or move the rule.
- `EditorToolbar.vue`: `onFocusMode()` only wraps `toggleFocusMode()`. Bind it directly.
- Tests:
  - `13-focus-mode.test.mjs:305` `assert.ok(before !== null)` is dead.
  - No test covers "browser Back to another doc turns focus mode off", an edge case the spec lists and that the `docKey` watch is meant to handle.
- The header is removed with `v-if`, so exiting remounts it. An in-progress filename edit is lost if the shortcut is pressed while editing it. This is an edge case and the DECISIONS line explains why `v-if` is used.
