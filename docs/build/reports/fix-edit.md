# Fix captain report: edit lane (persona QA)

Worktree `/home/ubuntu/locus-repos/md-review-fixedit` (branch `lane/fixedit`), base 8be2187.
Patch: `scratchpad/fix/edit.patch` (tracked diff + untracked files; no node_modules or POLISH.md).

## Scope (agreed with the orchestrator)

- **Engineer findings:** M5, M6 (conflict loser, double NOW, FROM deselect), m7, c7, c8. Also the RevisionsModal parts of M2 (focus) and c1 (palette and emoji).
- **Leader findings:** M3 (diff overflow on phone) and M4 (raw diff shown to readers).
- **Left to the read lane:** engineer m1 and m2, M2 and m8 outside History, and c1 outside History.

## Fixes

| Finding | Fix | Regression tests |
|---|---|---|
| **eng M5:** Ctrl+B after typing gives `****` | New rule 1f in `markdownCommands.ts` (empty selection only): inside an empty pair `**\|**` the pair is removed. Right before the closer of a span opened earlier on the line (`**bb\|**`, not preceded by whitespace) the cursor steps over it. Applies to bold, italic, strike and code. Italic never steps over half of `**`. | unit `tests/editor/qa-edit-toggle.test.ts` (13 cases); e2e `QA M5` (keyboard flow, plus an empty bullet that now ends the list) |
| **eng M6a:** overwritten work not in History | **Keep my version:** the client sends `overwrite: true` on the forced PUT, and the server (`routes/markdown.cjs`) calls savePaste with `noCoalesce`. The copy it replaces stays its own revision instead of being folded into the same "someone" editing session. **Use server version:** `doc.useServerVersion()` sets the local edits aside as the #23 local copy with `reason:'conflict'`. LocalCopyBanner then shows conflict wording plus a **Restore** button. History lists the copy as a "Your set-aside edits" row (editors only), where it can be compared and restored. | server `server/test-items/qa-edit-overwrite.test.mjs` (3); unit `useSync.test.ts` now asserts `overwrite: true`; component `tests/components/qa-edit-revisions.test.ts`; e2e Keep-mine / Use-server / banner-Restore |
| **eng M6b:** two NOW rows | History rows are keyed by position, not hash. A restore makes the newest revision repeat an older hash, and only the newest row is now "now". | component + e2e `one NOW row` |
| **eng M6c:** clicking FROM hides Restore | Re-clicking the selected FROM row is a no-op. Restore is also hidden when the FROM content equals the current one. | component + e2e |
| **eng m7:** image after a table becomes a row | `imagePaste.ts` `leadingBreak()` handles inserts in markdown docs only. On the empty line after a GFM table the insert gets `\n` in front, and at the end of the last row it gets `\n\n`. | unit (4 cases); e2e (editor text plus preview `table img` = 0) |
| **eng c7:** focus cluster crowds Sync scroll | The bar reserves `cluster width + 28px` (was +16), and the cluster has its own divider (`border-left`). Measured gap: 8px on base, now ≥ 20px. | e2e `QA c7` |
| **eng c8:** one pill per word | `mergeSegments()` in `useDiff.ts`: whitespace between two changed words joins them, and adjacent segments of the same kind merge. | unit `useDiff.test.ts` |
| **eng M2 (History):** focus not trapped | `useFocusTrap` on the dialog: initial focus goes to × and Tab cycles inside. On close, focus returns to the opener. If the opener is gone (a menu item, or the changes banner), it falls back to the header More button. Also adds `role="dialog"`, `aria-modal` and `aria-labelledby`. | component + e2e (12 Tab/Shift+Tab presses stay inside; Esc lands on `header-overflow-btn`) |
| **eng c1 (History):** off-palette colours and emoji | Row borders, stats, error text and diff tints now use the existing `--rag-{green,red}-{dot,fg}` tokens (color-mix for tints). The now/from labels are coloured with the fg tokens. The 👤/🤖/⚙ emoji are replaced by inline line-icon SVGs in `--text-meta`, with aria-labels. | e2e ×6 themes: stats and labels ≥ 4.5:1 on the dialog, no emoji, SVG icons labelled, theme class asserted |
| **leader M3:** diff spills out on phone | `.rev-diff` gets `min-height: 0`, and the status/summary/diff live in a new `.rev-diff-scroll` (`overflow: auto`). | e2e at 390×844 touch: the scroller ends above the footer and scrolls |
| **leader M4:** raw diff shown to readers | A summary block shows the change notes of the revisions in the compared range and chips for the sections the diff touches (`changedSections()`; fenced code is ignored and `:rag-x[label]` is reduced to its label). For viewers the line diff sits behind "Show line-by-line changes". Editors see the diff at once. The hint now says "Select" instead of "Click". | unit `changedSections`; component; e2e on a phone |

**Decisions:** four lines added to `docs/build/DECISIONS.md` under Implementation decisions (#9 rule 1f, the #8/#21 `overwrite` flag and local-copy row, the #2/#21 reader summary, #10 image after a table).

**Server change (minimal, flagged to the orchestrator):** `server/routes/markdown.cjs` accepts an optional body field `overwrite: true`, which maps to `ctx.noCoalesce`. Any other value is ignored. The api lane was told to avoid that line.

## Evidence

**Red runs on base 8be2187** (tests copied onto a clean detached worktree):
- `tests/components/qa-edit-revisions.test.ts`: 5 of 7 failed.
- `VERIFY_ITEMS=29 E2E_FILES=qa-edit-fixes scripts/verify.sh --only e2e`: `FAIL 0/9`, with these failure messages:
  - M5: `a **bb** cc****`
  - Keep mine: `[1,2]` (the overwritten copy was folded)
  - One NOW: `["now","","now"]`
  - Focus: focus never got inside the dialog
  - m7: `| 1 | 2 |\n![shot]`
  - c7: gap 8px
  - Use-server and M3/M4: timed out (the elements don't exist)

**Green on the fix:** `e2e/qa-edit-fixes PASS 15/15` (9 functional + 6 theme).

**Targeted gate:** `VERIFY_ITEMS=29 E2E_FILES=qa-edit-fixes,durable-sync,21-upsert-by-key,23-fixes,02-reading-mode,13-fixes,13-focus-mode,08-undo-redo,08-sync-bugs,09-md-shortcuts,10-paste-image,05-mobile-layout,23-view-edit-links,07-split-view scripts/verify.sh --only typecheck,unit,build,e2e,server`

| Step | Result |
|---|---|
| typecheck | PASS |
| build | PASS (218 chunks) |
| server | PASS 440/441 (1 skip), including `qa-edit-overwrite` 3/3 |
| e2e | 214/220; the only failures were 3 in durable-sync |
| unit | FAIL: 5 failures, all `vite build failed` inside the 04/06 build-in-test items after 240 s |

Load was about 9 during that run: the blind re-check agent was running browsers at the same time.

**Re-run on a quieter box:** `VERIFY_ITEMS=29 E2E_FILES=durable-sync scripts/verify.sh --only unit,e2e` gave `unit PASS 667 passed (667)` and `e2e/durable-sync PASS 11/11`.

So both gate failures were load flakes, not regressions. The earlier stand-alone runs also had `unit PASS 667`.

**Pre-existing test touched:** `tests/composables/useSync.test.ts`, where one assertion now also expects `overwrite: true`. No frozen NN-* tests were edited.

## Independent blind re-check

A fresh subagent ran with `common.md` + `verifier.md` and did not read the diff. Its result: **all 11 findings FIXED** (report: `docs/build/reports/fix-edit-recheck.md`). It raised three cosmetic leftovers:

- **Addressed, Locus dark:** added diff rows were tinted navy (a thin green mix over the purple background). Rows now use the solid `--rag-{green,red}-bg` tokens, and the changed words mix the dot colour into them. The theme e2e now also asserts that add rows are green-dominant, del rows are red-dominant, and row text is >= 4.5:1, in all 6 themes.
- **Addressed, hint wording:** the History hint now reads "Pick a revision…", which is neutral for touch.
- **Not changed, faint "Saved":** the focus cluster's faint "Saved" label is spec #13's idle dimming (opacity 0.35, full on hover/focus). I left it as specified.

After these changes, `VERIFY_ITEMS=29 E2E_FILES=qa-edit-fixes,durable-sync scripts/verify.sh --only typecheck,unit,e2e` gave:
- typecheck PASS
- e2e 26/26 PASS
- unit: 6 timeouts in the 04/06 build-in-test items and one 28 render test, at load average about 20 from other lanes. A re-run of exactly those files passed: `npx vitest run tests/items/06-lazy-editor.test.ts tests/items/04-routes.test.ts` gave 17/17, and the full unit suite gave 667/667 on the quieter run above.

## Notes for landing

- `durable-sync`'s "Use server version" test still passes. The adopted text is in `.cm-content`, and the set-aside copy is in the local-copy banner outside the editor.
- `useServerVersion` only sets a copy aside when the local text differs from the server text. The loseEditAccess path (#23 view-only) is unchanged (`reason` defaults to view-only).
