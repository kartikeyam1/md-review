# #8 + #9 landing on feat/view-share (after #1a, #6, #23)

## Result
- `#8` committed as **b53434c** "#8 Undo/redo, editor toolbar and safe remote updates" (cherry-pick of lane d616736, plus one #6 interaction fix amended in; subject verified).
- `#9` applied with `git apply -3` from md-review-vs-editor, all files applied cleanly, **left uncommitted** (unstaged/untracked).
- Gate: `VERIFY_ITEMS=6,8,9,23 E2E_FILES=08-undo-redo,08-sync-bugs,08-fixes,09-md-shortcuts,09-fixes,06-lazy-editor,06-fixes,23-fixes,23-view-edit-links,02-reading-mode,durable-sync,app scripts/verify.sh --only typecheck,unit,build,e2e` → **OVERALL: PASS** (run `20261010-193923-2479271`): typecheck 0 errors, unit 301/301, build OK, e2e 188/191 pass, 0 fail. The 3 non-passing tests are 08-undo-redo's todo cases (they wait on #7, #11 and #12).
- Not touched: `docs/build/PROGRESS.md` (already modified, unstaged), untracked 01/03/05 test files and `POLISH.md`. Plain `vitest run` fails only those ungated 01/03/05 item files.

## Cherry-pick conflict resolution (both sides kept)
| File | Resolution |
|---|---|
| `EditorPane.vue` | #6's `focus()` and #8's `runHistory` both kept; `defineExpose({ scrollToLine, focus })`. |
| `docState.ts` | `useAutosave({ …, canWrite: () => capability === 'editor', flushDraft: persistence.flushDraft })`. |
| `useAutosave.ts` | Options `canWrite` (#23) and `flushDraft` (#8). The single leave path is `onPageHide`: `flushDraft()` always (synchronous local draft), then the keepalive save only if shared + dirty + no conflict + `canWrite()`, so viewers never write. |
| `useDocLoader.ts` | #23's viewer branch kept: a viewer's draft goes to `setLocalCopy`. The editor branch uses #8's `restoreDraft(…, { baseHash, conflict })`. |
| `DECISIONS.md` | Union of both sides. |

## #6 interaction found by the gate, fixed in #8
`08-fixes` "opening a different local file with identical text … starts with empty history" failed after the cherry-pick. #6 keeps one editor instance on the `landing` key across a file-picker replacement. Text identical to what is in the editor never reaches EditorPane's content watcher, so `historyBarrier()`, which only bumped the epoch for kept-across-unmount history, left Undo enabled.

Fix: `historyBarrier()` now also notifies mounted editors (`onHistoryBarrier` in `useExternalChange.ts`). EditorPane subscribes and calls the new `clearHistory(view)` (`history.ts`), then unsubscribes on unmount. Only these code hunks were amended into the #8 commit; the matching DECISIONS line is uncommitted alongside #9.

On "simplify the kept-history save/restore": I left it in. It still matters when #6's keyed instance is destroyed and re-created for the same doc. It is gated by text + epoch, so it cannot leak across docs. It is redundant only for plain Read↔Edit switches, so removing it is a safe follow-up but was not needed to land.

## #9 contents (uncommitted)
`src/editor/markdownCommands.ts`, `src/editor/shortcutList.ts`, `src/composables/useShortcutsOverlay.ts`, `src/components/ShortcutsOverlay.vue`; edits to `extensions.ts`, `EditorToolbar.vue` (shortcuts button, shared titles), `EditorPane.vue` (selection-report clamp), `App.vue` (one `shortcutsHelpShortcut` line in `useGlobalShortcuts`), `DECISIONS.md`. Tests: `tests/items/09-md-shortcuts.test.ts`, `tests/e2e/items/09-md-shortcuts.test.mjs` (frozen), `tests/e2e/items/09-fixes.test.mjs`, `tests/editor/markdownCommands.test.ts`, `tests/composables/useShortcutsOverlay.test.ts`. The `?` gate checks that the toolbar is actually visible, so it already works with #6's kept-alive hidden editor. Nothing in #9 reachable from `main.ts` imports `@codemirror/*`; build and 06-lazy-editor are green.

## Frozen-test changes carried in #8 (unchanged from the lane report)
- `08-undo-redo` AC-08.9 and AC-08.10 accept a quiet save-state (#2 rule 5).
- `08-fixes`: the reviewer-input test creates its doc with `mode:'review'`; the native-undo and identical-file tests switch to Edit before looking for `header .filename` (#2, 00 §2.2 / §11).
