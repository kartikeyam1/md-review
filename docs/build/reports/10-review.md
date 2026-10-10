# #10 paste/drop image: code review

Scope: `git diff` at fb3c2af plus untracked files: imagePaste.ts, attachments.ts, ShareRequiredDialog.vue, DocView.vue, extensions.ts, server/routes/files.cjs and the three 10-* tests.
Verdict: **no blockers**. Two SHOULD-FIX undo bugs, both reproduced against the worktree's real @codemirror packages (scripts in the reviewer's scratchpad `rev10/t.cjs`, `t2.cjs`).

## Checked and OK
- **Lazy-chunk rule (#6):** attachments.ts imports only `useEditToken` (→ `useRouter`) and types. imagePaste.ts is reached only from editor/extensions.ts. Nothing that DocView/main.ts can reach imports `@codemirror/*`.
- **The remove-then-reinsert design (the "re-record"):** the text is identical before and after. The selection is passed in the reinsert spec, which CM reads in post-change coordinates, so it is exact. Neither transaction carries scrollIntoView, and both are dispatched before CM measures, so the scroll does not move. The reinsert is `input.paste`, so the #8 `transactionExtender` isolates it (`isolateHistory 'full'`): it never merges with typing. The intermediate model emit is overwritten in the same tick, and the EditorPane watcher ends up a no-op. A remote write rewrites the text under the tracked ranges, but `intact()` guards that. Redo after undo returns the final markup, as the test at :295 asserts.
- **Share-first:** a share failure toasts inside handleShare and resolves null. After the share, `waitForLiveEditor` finds the editor that was remounted because `:key=docKey` changed. The text is the same, so the captured range is still valid. The `watch(docKey)` cancel cannot fire on its own share, because shareAsk is nulled first. `docIdOf` gets the canonical id through `settleAccess` on every doc GET.
- **Server:** 415/413 apply only under `assets/`, and other names are unchanged. nosniff, plus the CSP on svg, is keyed off the decoded fileName.

## SHOULD-FIX
1. **Pasting over a selection takes two undos (breaks rule 10; the spec lists this edge case).** imagePaste.ts:418 + consolidate :488-497. The paste event's inverse is "delete placeholder, re-insert S" (S = the selected text). After the out-of-history replacements it maps down to "insert S", which survives as its own history event. Repro: `hello SEL world` with SEL selected → paste → land → undo gives `hello  world`. The pre-paste text only comes back on the second undo. Fix: keep S on the group. When S is non-empty, put the placeholders in out of history and have `consolidate` swap the images for S (out of history) and then S back to the images (as the history step), or drop the stale event via `invertedEffects`. Add an e2e that pastes over a selection.
2. **Undo during a multi-image upload keeps the images that already landed, then re-records them.** start() :436-440, consolidate. Repro: 2 images, #1 lands, undo → `A\n![a](u1)`. #2 is then dropped and consolidate pushes #1 back as a new undo step, which also clears the redo stack. Rule 12 and the "undo mid-upload" edge case expect nothing to be inserted. Fix: in `trackedField.update`, when an `undo` transaction leaves a pending placeholder of a group no longer intact, mark the group cancelled. Then remove that group's done items out of history and skip consolidation for it.

## NIT
- files.cjs:94: non-string `content` returns 413 "Attachment too large". It should be a 400.
- DocView.vue:239-251: if `actions.handleShare()` ever throws, `resolve` is never called and the paste promise stays pending forever. Wrap it in try/catch and call resolve(null).
- Navigating away mid-upload (rule 13) leaves `![Uploading …]()` in the old doc's saved text. This matches the spec, but it is worth a DECISIONS line or a follow-up.
- The re-record design and the 3 s `waitForLiveEditor` budget are non-obvious product calls with no entry in DECISIONS.md. Add `- #10: …` lines.
- Remove + reinsert un-highlights the image text inside an existing comment mark until the decorations rebuild. This is visual only.
