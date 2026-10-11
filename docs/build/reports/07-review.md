# #7 Split view: code review

Scope: `git diff` (13 files) plus untracked `SplitView.vue`, `useScrollSync.ts`, `tests/items/07-split-view.test.ts`, `tests/e2e/items/07-*.test.mjs`, checked against spec 07 and 00-cross-cutting. Static review only. I did not run the gate; that is QA's job.

**Verdict: PASS with should-fixes. No blockers.**

All 17 ACs have tests. The pure maths in `useScrollSync.ts` is unit-tested. Capability gating works: `resolveView` and `resolveDocAxes` handle split, and `loseEditAccess` rewrites `split` too. Autosave and the title timer treat split as an editing view. The TOC and `doc-scroll` are correctly off in split, since `editorShown` covers it.

## BLOCKER
None.

## SHOULD-FIX
1. **`frameRatio` carries over to the next HTML doc, and this regresses read view too.** See `PreviewPane.vue:318-327`. `frameRatio` is per PreviewPane instance and is never reset. The bridge reports `scroll-ratio` in every view, and `onFrameLoad` restores it on every load. PreviewPane is not keyed by doc (DocView/App have no `:key`), so it can stay mounted across a doc-to-doc navigation. In that case the new HTML doc opens at the old doc's scroll ratio. Because the ratio is posted after `postAnchorToFrame(false)`, it also overrides a `#fragment` on the new doc (a #4 regression). **Fix:** reset `frameRatio = 0` when the doc identity changes (watch `docState.screenKey`/`pasteId`, or key PreviewPane by `docKey` the way LazyEditor is), and restore only on a reload of the *same* doc.
2. **Tab-switch sync never runs (the DECISIONS #7 line 2 claim is not implemented).** See `SplitView.vue:50` and `:163-187`. `selectTab` calls `syncFrom(from)` after the switch, but by then the source pane is `display:none`. So `visible(edEl)` or `visible(pvEl)` fails (clientHeight 0, scrollTop 0) and the call returns early. In the HTML path both panes have to be visible, which is impossible in tabs mode. On top of that, Chromium drops the scroll offset of a `display:none` scroller, so each tab switch lands at the top. **Fix:** before flipping `tab`, read the source position while it is still visible (`ed.topLine()` or `pv.lineAtOffset(scrollTop)`, or the ratio). Apply it to the destination after `nextTick` + rAF. Otherwise drop the DECISIONS claim.
3. **The comment in `DocView.vue:137` is inaccurate.** PreviewPane is still `v-if="previewShown"` (`:57`), so edit↔split and edit↔read remount it, which loses preview scroll and the mermaid cache. Either fix the comment ("the editor never remounts; the preview mounts with split/read"), or keep PreviewPane mounted and `v-show` it in edit view if that cost is acceptable.

## NIT
- `PreviewPane.vue:298`: in split, *navigating* to another HTML doc (or a remote update) is also debounced by 400ms, so the old doc stays visible for that long. Debounce only while `frameDoc` belongs to the same doc.
- `PreviewPane.vue:830`: the anchor cache key includes `clientWidth`, and the ResizeObserver (`SplitView.vue:231`) resyncs on every resize. So during a divider drag, and on every keystroke (`renderSeq`, `:217`), every `[data-line-start]` is queried and measured with `getBoundingClientRect`. That is fine at 300 lines but layout-heavy for large docs. Consider skipping resync while `dragging` and resyncing once on pointerup.
- `SplitView.vue:96`: `onDividerUp` persists the ratio on a plain click with no movement. `setRatio(..., true)` also persists a value clamped by a temporarily narrow container, which overwrites the reader's preference. Persist only when `drag` actually moved.
- Coupling with #13: the sync toggle lives in a new 36px "Preview" bar inside SplitView. Focus mode will need a prop or slot to hide that bar along with the other chrome. Worth a one-line note in BUILD-ORDER or the #13 spec so #13 doesn't fork SplitView's template.
- `tests/composables/useRouter.test.ts`: changing the "not shipped" expectation for `split` is legitimate now that split ships. It is not an edit to a frozen item test.
