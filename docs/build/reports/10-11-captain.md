# Lane "input" — captain report: #10 paste/drop image, #11 table paste

Base fb3c2af. Work is uncommitted in /home/ubuntu/locus-repos/md-review-cap-input (branch lane/input).
Patches: `scratchpad/cap-input/10.patch`, then `11.patch` on top of it. Both were checked by applying them in order to a clean `git worktree add --detach fb3c2af`.

## #10 Paste / drop image → attachment
- **Tests written first** (none were frozen): `tests/items/10-paste-image.test.ts` (13 unit), `server/test-items/10-paste-image.test.mjs` (8), `tests/e2e/items/10-paste-image.test.mjs` (20 e2e: AC-10.1–10.13 and 10.16, plus undo edge cases).
  - Before implementation, the unit and server tests failed for the right reason (module missing, and 415/413/nosniff missing).
  - The e2e file was first run after implementation. It failed twice at that point, on a real drop-position bug and an HTML-doc selector, so it does discriminate.
- **ACs:** all 16 pass (e2e + server + unit).
- **Implementation:**
  - `src/editor/imagePaste.ts` (CM extension: paste and drop handlers, tracked-range state field, upload plugin).
  - `src/composables/attachments.ts` (pure helpers, upload with ≤3 concurrent and a 60 s timeout, X-Edit-Token, and the host bridge; no `@codemirror` import).
  - `src/components/ShareRequiredDialog.vue`, plus the DocView host and dialog wiring.
  - `server/routes/files.cjs`: `assets/` 415/413/400, and nosniff + CSP on svg.
  - Registered in `src/editor/extensions.ts`.
- **QA (blind):** FAIL → fixed. All ACs passed, but there were 3 majors:
  1. Undo during an upload, then redo, left an orphan placeholder.
  2. An undo/redo round trip lost the image.
  3. An image pasted over a selection needed 2 undos.
  Also 1 minor: Esc did not return focus.
- **Review:** no blockers. 2 should-fix items were the same as QA major 3 and the partial-landing undo case; 5 nits.
- **Fixes (one round):**
  - Undo model reworked. Placeholders stay until the whole paste settles, then they are swapped for the images as one history step. The swap goes back to the replaced text out of history, then forward to the images in history.
  - A replaced selection is taken out of history and comes back on undo or failure.
  - Undo mid-upload suspends the paste. Redo resumes it, with ranges taken from the redo's own inserted text.
  - Esc returns focus.
  - Non-string content → 400.
  - `handleShare` throw → the paste promise resolves null.
  - 6 new e2e tests cover all of the above.
  - DECISIONS lines added for every product call.
- **Follow-up (orchestrator, owner policy: fix every finding):**
  - Pending placeholders never persist. Autosave, the pagehide keepalive and the local draft all send `stripPendingPlaceholders(markdown)`: a registry in `attachments.ts` that `imagePaste` keeps in step.
  - The doc stays dirty while uploads run, so the leave guard and beforeunload ask before leaving.
  - An editor that opens on stale placeholders removes them outside the history, and autosave stores the clean doc.
  - Tests: `tests/items/10-placeholder-strip.test.ts` (5) and `tests/e2e/items/10-leave-placeholder.test.mjs` (3: autosave mid-upload, reload mid-upload, stale clean-up). With the fix disabled the e2e file goes 0/3; with it, 3/3.
- **Left open:**
  - A placeholder edited by hand is left as typed.
  - The QA re-run after the fix round was not done by a fresh verifier. The fixes are covered by the new e2e tests.
- **Frozen-test changes:** none.

## #11 Table paste, format table, plain-text paste
- **Tests written first:**
  - `tests/items/11-table-paste.test.ts`: 27 unit tests, red before implementation (module missing).
  - `tests/e2e/items/11-table-paste.test.mjs`: 22 e2e tests (AC-11.1–4, 7–9, 12–14, 16, plus edge cases: an Excel PNG+TSV clipboard, the chord skipping image/svg, a pipe in a table row, a selection replaced, the overlay rows).
  - `tests/e2e/items/11-ac08-table-paste.test.mjs`: #8's deferred AC-08.5 table-paste half as a real test. The frozen `08-undo-redo.test.mjs` is untouched and still has its `todo`.
- **ACs:** all 16 pass. AC-11.5/6/10/11/15 are unit tests; AC-11.4/7 are unit + e2e.
- **Implementation:**
  - `src/editor/tableFormat.ts` (pure: parseDelimited, detectTable, toMarkdownTable, formatMarkdownTable/formatTableLines).
  - `src/editor/tablePaste.ts`:
    - re-exports the pure functions;
    - `plainPasteChord` is registered first and the table handler last (00 §4.7 order);
    - two-step undo: the raw insert, then an `ownUndoStep` format;
    - Shift+Alt+F `formatTable`.
  - `EditorPane.formatTable()` exposed.
  - Shortcuts overlay rows added: "Format table" (Shift+Alt+F) and "Paste as plain text" (Mod+Shift+V).
- **QA (blind):** PASS. 1 minor spec gap: pasting the same table twice glued the second paste onto the last row.
- **Review:** no blockers.
  - 1 should-fix: the chord stayed armed through a plain Ctrl+V.
  - 6 nits: non-Latin layouts, the syntax-tree timeout fallback, formatting inside fenced code, the html doc message, the AC-08.5 copy header, and test placement.
- **Fixes (one round):**
  - A plain Mod+V disarms the chord, and the chord is also matched on `event.code`.
  - `syntaxTree` is the fallback when the parse times out.
  - The format command treats code blocks as "No table at cursor".
  - The end of a table row counts as outside the table, so a repeated paste makes a second table.
  - Header comment added to the AC-08.5 copy.
  - 3 new e2e tests; DECISIONS lines.
  - Kept as is: html "No table at cursor" (now logged), and test placement (repo convention).
- **Frozen-test changes:** none.

## Found along the way, not in this lane
- In Playwright, repeated `Control+Shift+z` presses can arrive with `key: "z"`, which CodeMirror treats as Mod+Z (undo). This is a test-driver artefact, not a product bug. My tests use Mod+Y for redo.
- At 390 px, the comments panel squeezes the editor on a local review doc. This was seen by both QAs and is pre-existing (#5/#2 layout).

## Gate
- **Targeted gate** while 2 QA agents were driving browsers:
  `VERIFY_ITEMS=10,11 E2E_FILES=10-paste-image,11-table-paste,11-ac08-table-paste,08-undo-redo,08-fixes,08-sync-bugs,09-md-shortcuts,09-fixes,06-lazy-editor,06-lazy-editor-build,06-fixes,23-view-edit-links,23-fixes,app,durable-sync,shared-mode scripts/verify.sh --only typecheck,unit,build,e2e,server`
  - typecheck, unit 363/363, build, server 329/332 (3 skips): all PASS.
  - Every e2e suite passed except 10-paste-image (18/20). The two failures were load timing: the editor did not appear within 20 s, and the 8 s toast took 13.5 s while the box ran 3 browsers. 08-undo-redo shows 18/21 with its 3 expected `todo`s.
  - The 11-* results in that run predate the #11 fix round.
- **Re-run on an idle box, after all fixes:** `VERIFY_ITEMS=10,11 E2E_FILES=10-paste-image,11-table-paste,11-ac08-table-paste scripts/verify.sh --only typecheck,unit,e2e`
  - typecheck PASS, unit 363/363, e2e 10-paste-image 20/20, 11-table-paste 22/22, 11-ac08-table-paste 1/1.
  - **OVERALL PASS** (`.verify/runs/20261010-203627-2619719`).
- **After the #11 fix round:** `--only build,e2e` with `08-undo-redo,09-md-shortcuts,09-fixes,06-lazy-editor-build`: build PASS, 18/21 (3 todo), 36/36, 10/10, 6/6. **OVERALL PASS** (`.verify/runs/20261010-203852-2627707`).
- The broader suites and the server ran in the first gate. That gate ran after the #10 fix round and before the #11 fix round.
- The #11 fix round touched only `tablePaste.ts`. The #10 fix round touched `imagePaste.ts`, `ShareRequiredDialog.vue`, `DocView.vue` and `files.cjs`; server tests passed after it.

### Gate after the follow-up
`VERIFY_ITEMS=10,11 E2E_FILES=10-paste-image,10-leave-placeholder,11-table-paste,11-ac08-table-paste,durable-sync,08-sync-bugs scripts/verify.sh --only typecheck,unit,build,e2e,server`
- typecheck PASS, unit 368/368, build PASS.
- e2e 62/62: 20, 3, 22, 1, 11 and 5 pass across the six files.
- server 329/332 (3 skips).
- **OVERALL PASS** (`.verify/runs/20261010-205253-2662388`).
