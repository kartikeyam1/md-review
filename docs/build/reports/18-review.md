# #18 Reader font size + content width: code review

Reviewer, lane/controls @ f5d2850 + working tree (item-18 files only; item-19 files ignored).

**Verdict: PASS, no blockers.** There are 2 SHOULD-FIX items and 3 NITs. One unit failure was already there at the base and is not caused by #18 (see Gate).

## Gate (evidence)
- `VERIFY_ITEMS=18 scripts/verify.sh --only typecheck,unit`: typecheck PASS (0 errors). Unit FAIL: 1 failed, 518 passed. The failure is `AC-06.8 entry chunk size` (575,465 bytes against a 574,644 cap).
- **The AC-06.8 failure was already there at the base.** I exported HEAD with `git archive` and ran the same test on it: 575,187 bytes, which also fails. #18 adds +278 bytes to the build the test measures. In a plain `vite build` it adds +2,413 bytes (520,234 to 522,647). The test's build is ~53 KB larger than a plain one, probably because it runs under vitest's NODE_ENV. Item 6's budget needs a separate look; it does not block #18.
- The implementer's last e2e run is in `.verify/last-summary.txt`: `e2e/18-font-width-control` 16/16 pass. Not run yet, and needed before landing: 01-locus-theme, 05-mobile-layout, 07, 13, 15, 16, 17, app.test. They are needed because the px→rpx change and the `--read-width` override touch their CSS.

## The deliberate choices, judged on merit
- **`calc(N * var(--rpx))` instead of em: agree.** Rule 3 asks for exact 100% sizes, including nested text: code in a table or heading, and the frontmatter table. Under em, every nested rule would need a compensating fraction. With `--rpx`, the source still reads as the 100% size, and only one inline custom property changes, so nothing is re-rendered. It does contradict 00 §4.6 (line 242, "#18 converts it to em") and BUILD-ORDER's "em pass". 00 is supposed to win over item specs, so the deviation must be written down (SHOULD-FIX 2).
- **GitHub base 15px → 16px: agree.** The spec requires it (rule 3, "GitHub: p 16, h1 32"). Today's 15px comes from `:root .preview-pane` (0,2,0) beating `.markdown-body`. The new `:root .preview-pane.github-mode` rule comes later in the file at the same specificity, so it also beats the phone media rule. No existing e2e asserts GitHub at 15px. The Locus 15px assertions in 01-locus-theme run at 100%, so they are unaffected.

## SHOULD-FIX
1. **`src/components/ReaderSettings.vue` `onKeydown` (bound to the button too) swallows Esc when the panel is closed.** It calls `preventDefault()` and `stopPropagation()` before `close()`, and `close()` then returns early. With "Aa" focused and the panel closed, Esc never reaches a lower layer from 00 §3.4, such as the toc or comments drawer (layer 4) or a comment popover (layer 5). Fix: add `if (!open.value) return` before `preventDefault`.
2. **The `--rpx` convention is not recorded.** Add to `docs/build/DECISIONS.md` under "## Implementation decisions":
   `- #18: preview type sizes are calc(N * var(--rpx)), not em — keeps nested 100% sizes exact; new preview CSS (#12, #28, #29) sizes text with --rpx or em, never bare px`.
   Also tell #19, whose captain is writing it now: the inlined `preview.css` defines `--rpx` only on `.preview-pane`. An export root without that class gets an invalid `font-size` on every rule, which falls back to the inherited size. The export root must keep `.preview-pane` or define `--rpx: 1px`.

## NIT
- `DocHeader.vue`: `defineAsyncComponent(ReaderSettings)` loads straight away whenever a doc is on screen, so "Aa" appears a beat after the header, a small layout shift. `useReaderPrefs` is already in the entry through PreviewPane and HeaderOverflowMenu, so the async split saves only the component itself, about 2 KB. It is acceptable given the AC-06.8 squeeze. A fixed-width placeholder would avoid the shift.
- `HeaderOverflowMenu.vue`: the phone "Reading settings" item has `aria-haspopup="dialog"` but no `aria-expanded`. Rule 7 says `aria-expanded` mirrors the state, but the menu closes on select, so this is low value.
- `ReaderSettings.vue` `onOutside`: the `closest('[data-testid="header-overflow-menu"]')` guard is never reached in practice, because the panel only opens after the menu item's `onSelect` has run. It is harmless but could be dropped or commented as defensive.

## Checked, no issue
- Pure exports in `useReaderPrefs.ts` match rule 1 and AC-18.15. They cover off-list snapping, sanitising each field on its own, and array or number JSON. All storage access is in try/catch.
- `print.css` sets `--reader-scale: 1 !important`, which correctly beats the non-important inline style.
- Wide mode sets `--read-width: 100%`. That works with both the read view's `max-width: calc(100% + 2*pad)` and SplitView's `max(read-pad, (100% - read-width)/2)` padding; SplitView.vue:468 needs no edit.
- Scroll position is kept by proportion with a pre/post watcher pair: the document scroller in read view, the pane in split view. The markdown is not re-rendered, because only the attributes and style change.
- Esc order follows 00 §3.4 layer 3. Focus returns to the button, or to `header-overflow-btn` on a phone. The panel stays open when A+ disables itself (`step()` puts focus back inside the panel). In HTML docs, focus lands on the panel itself (tabindex -1).
- The header position matches 00 §2.2: after ThemeSwitcher, before overflow. The button has no `.btn-icon`. `.header:has([role=dialog])` lets the panel escape the header box.
- No frozen tests were edited, and no other item's files were touched.
