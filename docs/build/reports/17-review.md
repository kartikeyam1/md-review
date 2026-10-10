# #17 Collapsible sections — code review

Scope: `git diff f35945e7` (src/components/TocPanel.vue, PreviewPane.vue scrollToLine dispatch, src/preview/enhancers.ts,
src/styles/preview.css, src/styles/print.css) plus the untracked src/composables/useFolding.ts, src/preview/folding.ts and the
17-* tests. #14/#16 and the orchestrator-patched base e2e files were not reviewed.

Evidence run: `npx vitest run tests/items/17-collapsible.test.ts` → 10/10 passed; `npx vue-tsc --noEmit -p tsconfig.app.json`
→ clean. I did not run e2e. That is the QA lane's job.

**Verdict: no blockers.** The design follows 00 §4.5: one enhancer, delegated handlers, the pure logic sits in a unit-tested
composable, and the TOC is coupled only through `foldUi`. HTML docs are safe because `containerRef` sits on the `v-else` branch,
so no enhancer runs and the cleanup resets `foldable`. The `preview-reveal` dispatch in scrollToLine does nothing when
no listener is attached. There are no server or MCP changes.

## SHOULD-FIX

1. **The toggle is clipped at tablet width.** At src/styles/preview.css:888 the toggle sits at `left: -28px` with width 24px.
   Between 641 and 1099px `--read-pad` is 24px (preview.css:22), and `.preview-pane` uses `overflow-y: auto`, which also clips
   x. So the left 4px of the button and its focus ring are cut off. Rule 6 asks for a 24×24 hit area and a visible
   focus ring. Fix: set `left: calc(-1 * min(28px, var(--read-pad)))` and use `outline-offset: -2px` at that width.
   Alternatively, extend the static-inline media query at :959 up to 1099.98px.
2. **The one-shot deep-link reveal is used up before the target exists.** At src/preview/folding.ts:150,
   `revealedFor.set(container, docKey)` runs whether or not the fragment's target was found. Suppose the first render under the
   final key is empty or partial, for example because pasteId is set before the markdown arrives, or a re-key happens on empty
   content. Then the stored folds win and the deep-linked heading stays hidden. Nothing retries, because the fragment
   never changes. Fix: mark the doc as revealed only when the fragment is empty or `findAnchorIn(container, frag)` returns an
   element.
3. **Some folded blocks still paint.** `hidden="until-found"` applies `content-visibility: hidden`. That skips an element's
   contents, but not its own explicit height or background. In GitHub themes, `hr` has `height: .25em` plus a
   `background-color`, so it shows as a bar inside a folded section. Raw-HTML top-level blocks with an explicit height do
   the same. Fix: add `height: 0 !important; min-height: 0 !important; overflow: hidden !important;` to the
   `@media screen` `[data-fold-hidden]` rule (preview.css:951).

## NIT

4. In print.css:235, `display: block !important` on `[hidden='until-found']` is only needed for Safari's
   `hidden` fallback. In Chromium it turns a top-level raw `<table>` or flex block into a block box. Consider limiting it to
   `[data-fold-hidden]:not(table)`.
5. At folding.ts:90 the ellipsis is real text (`textContent = '⋯'`) inside the heading. 00 §2.5 says controls contribute nothing
   to copied text. `user-select: none` covers copying, but any code that reads the heading's `textContent` will see the
   glyph, for example comment quotes or offsets. Render it with `::before { content: '⋯' }` and keep the aria-label.
6. The capture-phase `stopPropagation` on mousedown/mouseup (folding.ts:195) also hides those events from document-level
   outside-click handlers, so a popover or menu stays open when the reader clicks a fold toggle. Prefer having
   PreviewPane's `onMouseDown`/`onMouseUp` ignore targets inside `.heading-fold-toggle, .heading-fold-ellipsis`.
7. Re-keying from `local:<file>` to the backend id, which happens on Share, resets visible folds to the new key's empty set
   (folding.ts:157). Optionally carry the set over when the old key was `local:`.
8. TocPanel.vue duplicates the two button blocks for the rail and the drawer. The indentation inside the drawer's
   `toc-head-actions` and the rail's close button is also off. A small `v-for` over `[collapse, expand]` would remove the
   copy.
9. Edge cases the spec lists that I did not see tests for: duplicate ids (`notes` / `notes-1`), a mermaid diagram inside a
   folded section, and collapse-all on a doc with only H5 headings. The missing-id deep link is covered at e2e:276.
