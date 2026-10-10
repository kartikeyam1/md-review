# 08 — Undo / redo that works

## Goal
Ctrl/Cmd+Z and redo behave like any editor: local edits undo in sensible chunks, and background syncs
from the server never wipe the undo stack's meaning, move the caret, jump the scroll, or let an undo
resurrect text someone else replaced.

## Scope / Out of scope
**In:** CodeMirror history + keymap; typing grouping; external updates applied as minimal, non-history
changes that preserve selection and scroll; history lifetime rules (pane switches, remote updates, doc
switches); single-step undo for programmatic edits (paste, slash insert #12, table format #11, shortcut
formatting #9, revision restore); toolbar Undo/Redo buttons.
**Out:** collaborative/OT merge of concurrent edits (conflicts keep the existing conflict bar), undo of
comment operations, undo persisted across reloads, undo in Read view.

## Current state
- `src/components/EditorPane.vue:182-214` — `EditorState.create` extensions: `lineNumbers, drawSelection, search,
  keymap.of([...defaultKeymap, ...searchKeymap])`, language, comment field, theme, listeners. **No `history()` and no
  `historyKeymap`** ⇒ Ctrl/Cmd+Z / redo do nothing (browser native undo is also not usable in CM6).
- `EditorPane.vue:266-284` — `modelValue` watcher replaces the **whole** document (`from: 0, to: doc.length`) on any
  external change. With history added naïvely this would push a giant step onto the undo stack, and it
  already collapses the selection/caret to the document start or end and can jump the scroll.
- `EditorPane.vue:40, 207-213` — `ignoreNextUpdate` echo guard: one-shot flag reset on the next update.
- External writers of `markdown` (all funnel through the watcher): server poll adopting a remote copy while
  clean `src/composables/useSync.ts:524-526`; conflict "Use server version" `useSync.ts:487`; draft restore
  `useSync.ts:177`; revision restore `src/App.vue:154`; file load / new doc `App.vue:455, 467`; persisted draft
  `src/composables/usePersistence.ts:62`.
- `EditorPane` is mounted only in Edit view (`App.vue:707-708`, `v-if`), so any history would be destroyed by a
  switch to Preview and back.
- A minimal prefix/suffix diff already exists: `src/composables/useDelta.ts:18-33` (`computeDelta`).
- Poll interval is 5 s (`useSync.ts:580-588`; e2e `durable-sync.test.mjs:86`).

## Behaviour
1. **Keys.** Undo: Ctrl+Z (Win/Linux), Cmd+Z (mac). Redo: Ctrl+Y **and** Ctrl+Shift+Z (Win/Linux),
   Cmd+Shift+Z **and** Cmd+Y (mac). Keys work whenever the editor has focus; they `preventDefault`.
   Outside the editor (Read view, inputs elsewhere) these keys do nothing to the document.
2. **Grouping.** Consecutive typing/deleting at adjacent positions with gaps < 500ms is one undo step
   (CodeMirror default `newGroupDelay`). A pause ≥ 500ms, moving the caret elsewhere, or switching between
   inserting and deleting starts a new step. Undo restores the selection that existed before the step.
3. **Single-step programmatic edits.** Each of these is exactly one undo step, and redo re-applies it in
   one step: a paste (including the SVG-paste path, `EditorPane.vue:193-205`); a markdown shortcut (#9);
   slash-menu insertion (#12, including its replacement of the typed `/command`); pasted-table formatting
   (#11 — undo once returns to the *raw pasted* text, undo twice to before the paste); revision restore
   (see 6). Such edits never merge with adjacent typing (isolate history before and after).
4. **Remote updates** = any change of the editor content that originates from the server (poll adopting a
   remote copy, conflict "Use server version", draft-vs-server reconciliation on load). They are:
   a. applied as a **minimal change** (common prefix/suffix kept, only the differing span replaced);
   b. **not** added to the undo history and **not** echoed as a local edit (no `update:modelValue`, no
      save/PUT is triggered, save-state stays "Saved");
   c. **selection-preserving**: carets/selections are mapped through the change (text inserted above the
      caret shifts it down; text replaced around it collapses it to the replacement's end);
   d. **scroll-preserving**: the first visible line before the update is still within the first two
      visible lines after it (no jump to top/bottom, no scroll-into-view of the caret);
   e. a **history barrier**: the undo and redo stacks are cleared. Local undo never steps back across a
      remote update, so it can never revert or resurrect text another writer changed.
5. **Document switch** (load a different file/session, New doc, `?filePath=` reload, Refresh) starts with
   an empty history.
6. **Revision restore** (History → Restore) is a *local* action: applied as a minimal change, added to
   history as one step (Ctrl/Cmd+Z returns to the pre-restore text, which then autosaves as usual).
7. **History lifetime across views.** Within one open document, history survives switching between Read,
   Edit and Split views and between split tabs (#7). The editor instance (or its `EditorState`) is kept
   rather than recreated.
8. **Toolbar.** This item builds the shared `EditorToolbar` (contract and button order: 00 §3.3; #9 adds
   `editor-shortcuts-btn`, #13 adds `focus-mode-btn`). It shows Undo (`editor-undo-btn`) and Redo
   (`editor-redo-btn`) icon buttons with `aria-label` "Undo"/"Redo" and titles including the platform
   shortcut. Each button is `disabled` exactly when its stack is empty; clicking performs the action and
   returns focus to the editor. Visible at all viewports (phones have no keyboard shortcut).
9. Undo/redo of local edits marks the doc dirty and autosaves exactly like typing.
10. **Structure** (00 §4.7): this item creates `src/editor/extensions.ts`, the single list EditorPane assembles its
    CodeMirror extensions from, with `src/editor/history.ts` as the first module; #9–#12 add modules there instead of
    editing EditorPane's extension array. The summary of undo semantics across items is 00 §3.6.

## Decisions
- Remote updates **clear** history instead of rebasing it: rebasing a local deletion onto collaborator text can re-insert stale text; a clean barrier is predictable and matches the "never resurrect" requirement.
- Revision restore is undoable (user action, cheap safety net); "Use server version" is not (the user explicitly chose to discard, and it is a server adoption).
- Origin is passed explicitly (e.g. an `applyExternal(text, { origin: 'remote' | 'local' })` path or an origin ref from App/useSync) rather than guessed from timing; the bare `modelValue` watcher must not be the only signal.
- Toolbar buttons are in scope (not optional) because they give phone users undo and give tests an observable `disabled` state.

## Acceptance criteria
AC-08.1 Given Edit view of a local doc When the user types `hello` and presses Ctrl/Cmd+Z Then `hello` is gone and the text equals the original; When Ctrl+Shift+Z (mac: Cmd+Shift+Z) is pressed Then `hello` is back; Ctrl+Y (mac: Cmd+Y) also redoes.   [verify: e2e]
AC-08.2 Given the user types `alpha`, waits 1000ms, types ` beta` When Ctrl/Cmd+Z is pressed once Then the text ends with `alpha` (not `alpha beta`); pressing again removes `alpha`.   [verify: e2e]
AC-08.3 Given clipboard text `PASTED BLOCK\nline 2` is pasted at the end after typing `x` (typing then paste within 200ms) When Ctrl/Cmd+Z is pressed once Then the pasted text is gone and `x` remains.   [verify: e2e]
AC-08.4 Given an SVG string is pasted (SVG path) When undone once Then the document equals its pre-paste text.   [verify: e2e]
AC-08.5 Given a slash-menu insertion of `/table` (#12) or a pasted-table format (#11) When Ctrl/Cmd+Z is pressed once Then for `/table` the doc returns to exactly the pre-commit text — `/table` as typed, menu closed (#12 rule 11; the inserted table is removed in one step); for table format one undo yields the raw pasted TSV and a second yields the pre-paste text.   [verify: e2e]
AC-08.6 Given a fresh doc load Then `editor-undo-btn` and `editor-redo-btn` are `disabled`; after typing, Undo is enabled; after undoing everything, Undo is disabled and Redo enabled; clicking `editor-redo-btn` re-applies and focus is in `.cm-content`.   [verify: e2e]
AC-08.7 Given a shared session open in Edit view, clean (saved), caret placed at line 10 column 3 When another client PUTs the document with one new line inserted at the top (server API, as `durable-sync.test.mjs`) and the next poll applies it Then the editor shows the new line, and typing `Q` inserts it at what is now line 11 column 3.   [verify: e2e]
AC-08.8 Given the same setup with the editor scrolled so line 120 is the first visible line When a remote update inserts 3 lines at the top Then after the poll the first visible line's text equals the pre-update first visible line's text or the one directly above/below it.   [verify: e2e]
AC-08.9 Given the user typed `LOCAL1`, it autosaved, and then a remote PUT replaced paragraph 2 When the poll applies it Then `editor-undo-btn` is disabled, Ctrl/Cmd+Z leaves the editor text exactly equal to the server text (neither `LOCAL1` removed nor the old paragraph 2 restored), and no PUT request is sent.   [verify: e2e]
AC-08.10 Given a remote update was applied When observing the network for 3s Then no PUT/PATCH to `/paste/:id/markdown` is sent and `save-state` shows "Saved".   [verify: e2e]
AC-08.11 Given the user types `KEEPME` in Edit view, switches to Read view, then back to Edit (and separately: to Split) When Ctrl/Cmd+Z is pressed Then `KEEPME` is removed.   [verify: e2e]
AC-08.12 Given a shared doc with ≥2 revisions When the user restores an older revision from History and then presses Ctrl/Cmd+Z in the editor Then the editor text equals the pre-restore text.   [verify: e2e]
AC-08.13 Given a doc with unsaved local edits and a remote change arrives (conflict bar shown) When the user clicks "Use server version" Then the editor shows the server text, the caret is inside the document (not thrown to an error), and Undo is disabled.   [verify: e2e]
AC-08.14 Given doc A with edits When the user opens doc B (file open or New) Then Undo is disabled and Ctrl/Cmd+Z does not bring back any of doc A's text.   [verify: e2e]
AC-08.15 Given the pure helper that turns (oldText, newText) into a change set When called with texts differing only in the middle Then it returns one change covering only the differing span; for identical texts it returns no change.   [verify: unit]

## Test hooks (data-testid list) and API/MCP contract changes
`editor-toolbar`, `editor-undo-btn`, `editor-redo-btn` (plus `.cm-content` for typing). No server/MCP changes.

## Edge cases the adversarial verifier must try
- Undo immediately after load (nothing happens, no error, text unchanged).
- Remote update arriving while the user is mid-word but already "clean"? (A keystroke makes it dirty ⇒ conflict path, not apply — verify text is never clobbered.)
- Remote update that deletes the line containing the caret; remote update that is a no-op (same text) — must not clear history.
- Multi-cursor edit (Ctrl/Cmd+Alt+↓ then type) undone in one step.
- Ctrl+Z inside the filename input or comment textarea must not touch the document.
- Mac vs Linux key labels in button titles; Cmd+Y on mac.
- Undo after a search-and-replace (CM search panel replace-all) is one step.
- HTML doc in the editor — same behaviour.

## Dependencies on other items (by number) and files likely touched
Interacts with #6 (lazy editor must still keep state across views), #7 (split tabs keep editor mounted), #9/#11/#12 (their edits
must be single dispatches with isolated history), #13 (toolbar visibility in focus mode).
This item lands before #7/#11/#12 (BUILD-ORDER): the `/table` and table-format halves of AC-08.5 and the Split half of
AC-08.11 are verified when #12 / #11 / #7 land (each repeats them as its own AC).
Files: `src/components/EditorPane.vue`, new `src/components/EditorToolbar.vue`, new `src/editor/extensions.ts` + `history.ts`,
`src/components/DocView.vue` (origin signalling only — keep-alive is already done by #6), `src/composables/useSync.ts` (mark remote-origin writes), new pure helper (e.g. `src/composables/useExternalChange.ts`)
built on `useDelta.ts`.
