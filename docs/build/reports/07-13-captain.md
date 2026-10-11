# Lane "layout" — captain report (#7, then AC-08.11 Split, then #13)

Base: wip/0305 4b56c26 (main + #5 + #3). The work is uncommitted in `/home/ubuntu/locus-repos/md-review-cap-layout`.

Hand-off patches are in the cap-layout scratchpad:
- `07.patch` applies on 4b56c26. It includes the AC-08.11 Split test.
- `13.patch` applies on top of 07.

The orchestrator patched five pre-existing e2e files in this worktree (app, mermaid, selection-preservation, table-highlight, tripleclick-selection) to fix the doc-title integration bug. Those edits are excluded from both patches.

No frozen tests existed for #7 or #13. I wrote the acceptance tests from the specs first and confirmed they were red for the right reason (missing `split-view` / `focus-mode-btn` testids, a missing overlay row). Then I implemented against them.

QA and review ran in separate snapshot worktrees, so #13 could be built in parallel:
- `md-review-cap-layout-qa07`: base + #7 (first draft).
- `md-review-cap-layout-qa13`: base + #7 + #13 (draft).

The QA and review reports live in those worktrees. Copies are in `docs/build/reports/` here.

## #7 Split view (`?view=split`)
- **Tests written:**
  - `tests/e2e/items/07-split-view.test.mjs`: 21 tests covering AC-07.1 to 07.17 (two viewports for 07.13; viewer and pinned variants for 07.16), plus rule 13 (a comment card scrolls both panes) and the narrow tab-switch sync.
  - `tests/items/07-split-view.test.ts`: 15 unit tests for the pure mapping and divider maths in `useScrollSync.ts`.
- **ACs:** all pass. Result: 21/21 e2e, 15/15 unit.
- **Design:**
  - `SplitView.vue` wraps the two panes in every view. Outside split, its wrappers are `display: contents`, so edit ↔ split ↔ read never remounts the editor and undo history survives.
  - Wide layout: editor | divider | preview, with a 36px preview bar holding `split-sync-toggle`.
  - Below 960px: `split-tabs`. The hidden pane is `display: none`, not unmounted.
  - Divider: pointer events, keyboard, double-click reset, and localStorage. Each pane is at least 240px.
  - Synced scroll uses one capturing scroll listener with rAF coalescing. Programmatic positions are remembered so their scroll events are not echoed back.
  - Markdown mapping: piecewise-linear line ↔ offset anchors.
  - HTML: a proportional `scroll-ratio` bridge, both ways. The bridge drops echoes of positions the parent set.
  - HTML reloads in split are debounced (400ms trailing), and the same doc's reload restores its scroll ratio.
  - Editor and preview each expose a small scroll API.
- **QA (blind, `reports/07-qa.md`): PASS.** All 17 ACs pass and the edge cases are clean: ping-pong, front matter, tall code/mermaid, HTML without `<body>`, growing HTML, touch drag, resizing across 960px, viewers, pinned revisions, embeds, and all 6 themes. Fixes:
  - **minor:** after Preview → Edit on narrow tabs, focus stayed on the tab button. Fix: a pointer click on the Edit tab now focuses the editor; arrow-key tab navigation keeps focus on the tabs. AC-07.14's test now presses Ctrl+Z without clicking the editor first.
  - **minor (a11y):** forward Tab can't reach the divider, because the editor keeps Tab (#9). This is by design: keyboard users leave the editor with Esc then Tab, or Shift+Tab from the preview bar. Logged in DECISIONS; no code change.
  - Rule 13 (scroll-to moves both panes) was not covered by QA, so I added an e2e test. Rule 14 (the placeholder) is LazyEditor's existing `editor-loading` slot inside `split-pane-editor`, unchanged.
- **Review (`reports/07-review.md`): PASS, no blockers.** Every item is fixed:
  - SF1: `frameRatio` carried over to the next HTML doc and overrode its `#fragment`. It now resets when the doc identity changes, and the restore applies only to the same doc.
  - SF2: tab-switch sync never ran. The outgoing pane's position is now read before it is hidden and applied to the shown pane. With sync off, each pane's own scrollTop is restored. New e2e: "narrow split … Preview tab opens where the editor was".
  - SF3: the DocView comment was corrected (the preview still mounts with read/split).
  - Nits fixed:
    - HTML debounce no longer delays loading another doc.
    - No resync while dragging (one resync on release).
    - A divider click without movement no longer persists the ratio.
  - The coupling note for #13 (preview bar) is moot: #13 keeps the bar, since it is part of the split layout and not app chrome.
- **Decisions:** the `#7:` lines in DECISIONS.md cover:
  - the anchor map;
  - the preview-bar sync toggle and tab sync;
  - the centred preview column with the scrollbar at the pane edge;
  - the iframe-scroll event;
  - `?filePath=&view=` being honoured (the dev loader ignored `view` before);
  - Edit-tab focus;
  - divider Tab order;
  - restoring the HTML ratio on same-doc reloads (read view too).
- **Frozen-test changes:** none.
- **Pre-existing test change (1):** `tests/composables/useRouter.test.ts`. "allowed but not shipped" no longer lists `split`, and a new case asserts `resolveView('split', editor)` → split. This is required because split ships (SHIPPED_VIEWS).

## AC-08.11 (Split half)
- Implemented as real tests in a new file, `tests/e2e/items/07-undo-split.test.mjs`, gated with #7. The frozen `08-undo-redo.test.mjs` is untouched and keeps its `todo`.
- Result: 3/3 pass:
  - Edit → Split, then undo;
  - Split → Read → Split, then undo;
  - Split → Edit, then undo.
- The editor is never remounted across these switches, because SplitView keeps it in the same parent.

## #13 Focus mode
- **Tests written:** `tests/e2e/items/13-focus-mode.test.mjs`, 21 tests covering AC-13.1 to 13.15. Extras:
  - review-doc banners;
  - a non-empty selection, and the comment action bar, under Esc layering;
  - the shortcut under an open dialog;
  - browser Back to another doc.
- **ACs:** all pass. Result: 21/21.
- **Design:**
  - `useFocusMode.ts` holds one gated flag. DocView sets whether focus mode is allowed (edit/split, editor, not embed) and clears it on a doc change or unmount.
  - Shortcuts: Mod+Shift+Enter is registered through `useGlobalShortcuts`. Esc layering uses a window capture listener (comment bar/popover) and a bubble listener (exit).
  - `focus-mode-btn` sits at the toolbar's right end.
  - `FocusControls.vue` provides `focus-controls`, `focus-save-state` and `focus-exit-btn`. Save labels are shared with the header through `saveStateLabels.ts`.
  - What hides: the header (`v-if`); banners (`v-show`); the comments column (zero width, so the fixed popover still works).
  - Layout: an 860px centred column in Edit. The top bar reserves room for the controls.
  - The overlay gets a "Focus mode" row.
- **QA (blind, `reports/13-qa.md`): PASS**, 15/15 ACs, with 3 minor and 3 cosmetic findings. The multi-cursor case was blocked because the editor has no multi-cursor (logged). Fixes:
  - **minor:** one Esc closed History *and* exited focus mode (Vue removes the dialog between listeners). Fix: whether a layer was open is now recorded in the capture phase.
  - **minor:** the shortcut toggled focus mode under an open dialog. Fix: the shortcut is disabled while a dialog is open. New test.
  - **minor:** History is unreachable in focus mode, because the header is hidden. Logged in DECISIONS as a spec gap. It needs an owner call if History must be reachable.
  - **cosmetic:** CodeMirror's dotted focus outline showed at the column edges. Fix: removed in focus mode.
  - **cosmetic:** two look-alike icons, with the pressed one red. Fix: the exit button is now an ×, and the pressed toggle uses neutral ink on `--bg-page`.
  - **cosmetic:** on a phone in split view, the exit button takes the right end of the tabs. This reservation is intended and the tabs keep at least 150px each. Logged.
- **Review (`reports/13-review.md`): PASS, no blockers.** Every item is fixed:
  - SF1: Esc no longer throws away a typed comment draft (swallowed in focus mode).
  - SF2: an open comments drawer closes on entering focus mode (no hidden focus trap). The TOC drawer can't be open in edit views (`toc.visible` is read-only).
  - SF3: in the error state, `focus-save-state` is a Retry button.
  - SF4: a review-doc banner test was added.
  - Nits fixed:
    - DocBanners, EditorToolbar and DocView now read one gated `focusActive`.
    - Held keys act once (`e.repeat`).
    - The shortcut is blocked under dialogs.
    - Esc closing the action bar or popover now applies in every view.
    - The contract for later layers (#12/#15/#24) is in DECISIONS.
    - The column-style location is noted in DECISIONS.
    - `toggleFocusMode` is bound directly.
    - The dead assert was removed.
    - A Back-navigation test was added.
  - Kept as-is and logged: the header uses `v-if`, so a filename edit in progress is dropped when the shortcut fires.
- **Decisions:** the `#13:` lines in DECISIONS.md.
- **Frozen-test changes:** none.
- **Pre-existing test changes:** none. #9's overlay test requires ≥ 14 rows; the new row only adds one.

## Gate (lane end, main worktree with #7 + #13)
`VERIFY_ITEMS=7,13 scripts/verify.sh --only typecheck,unit,build,e2e` (run 20261010-220402-2796300) passed:
- **typecheck:** 0 errors
- **unit:** 393/393
- **build:** 170 chunks, including `check:lazy-editor`
- **e2e:** 453/456 across all 30 files. The 3 not run are #8's frozen `todo`s.
- **Item files:** 07-split-view 21/21, 07-undo-split 3/3, 13-focus-mode 21/21.

The server step was skipped because `server/` is untouched.

## Follow-up round (orchestrator: fix the logged items, plus a product call)
- **#7 Tab order.** The divider now sits before the editor pane in the DOM, and CSS `order` draws it between the panes. Forward Tab reaches it before the editor captures Tab. New test: `AC-07.5 (Tab order)` in 07-split-view, now 22 tests.
- **#13 phone tabs.** Below 960px the focus controls moved off the split tabs into the toolbar row under them (the editor toolbar or the preview bar). The tabs keep their full width, and on phone/touch those rows grow to 44px for the 40×40 exit button.
- **#13 header.** The header now stays mounted (a `display: contents` slot with `v-show`). A filename edit in progress is committed, not lost.
- **#13 History (product call).** `focus-history-btn` appears in the editor toolbar during focus mode for docs with a history, and opens the same RevisionsModal. Esc closes the dialog first; a second Esc exits focus mode.
- **Tests:** new file `tests/e2e/items/13-fixes.test.mjs` with 5 tests:
  - History opens, the first Esc closes it, the second Esc exits focus mode;
  - no History button on a local doc;
  - narrow focus split at 390 and 820px;
  - the header stays mounted.
- **DECISIONS:** the affected #7 and #13 lines were rewritten (no deferrals remain).
- **Gates:**
  - `VERIFY_ITEMS=7,13 E2E_FILES=07-split-view,07-undo-split,13-focus-mode,13-fixes,08-undo-redo,app --only typecheck,unit,build,e2e`: OVERALL PASS. Typecheck 0, unit 393/393, build OK, e2e 119/122 (3 are #8's frozen todos).
  - The header-adjacent suites (02, 05-mobile-layout, 05-print-title, 01, 03, durable-sync): 157/157.

## Patch check
`07.patch` and `13.patch` were applied in order onto a clean `git worktree add --detach 4b56c26` (see the captain's reply for the result).
