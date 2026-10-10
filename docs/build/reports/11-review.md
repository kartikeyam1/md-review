# #11 table paste: code review

**Verdict: PASS, no blockers.** Scope: tableFormat.ts, tablePaste.ts, the #11 lines in extensions.ts, shortcutList.ts and EditorPane.vue, the three #11 test files, and the #11 lines in DECISIONS.md.

Evidence: `npx vitest run tests/items/11-table-paste.test.ts` gave 27/27 passed. `npx vue-tsc --noEmit -p tsconfig.app.json` came back clean. I did not run e2e (QA owns that). `git status` shows the frozen `tests/e2e/items/08-undo-redo.test.mjs` is untouched.

## What checks out against the spec
- **§4.7 paste order.** The list order is plainPasteChord → imagePaste → svgPaste → tablePaste. Handlers in the same precedence run in list order. imagePaste steps aside when text/plain is non-empty (imagePaste.ts:368), so an Excel PNG+TSV clipboard converts to a table.
- **§3.6 two-step undo.**
  - Step 1 is `insertVerbatim` with `input.paste`. The history transactionExtender isolates it.
  - Step 2 carries `ownUndoStep` (isolateHistory 'full'), so neither step merges with the other or with typing.
  - Undo 1 puts the cursor back at the raw text's end, because history restores the selection that step 2 started from.
- **Rule 8 block isolation.** I traced it with and without a trailing newline in the clipboard, mid-line, and with a non-blank next line. Each case gives exactly one blank line on each side.
- **AC-11.12.** I worked the output and cursor offsets by hand and they match.
- **Cursor offsets.** These use UTF-16 lengths, while widths use code points. That is correct, and it is commented at tableFormat.ts:186.
- **Formatting a table that is already formatted** dispatches nothing (tablePaste.ts:188).
- **Shortcut rows** render as Shift+Alt+F and Ctrl+Shift+V on Windows/Linux, and ⌥⇧F and ⇧⌘V on mac.

## SHOULD-FIX
1. **The chord stays armed after an empty paste, so it can swallow the user's next real paste.** Location: tablePaste.ts:50-56, plus the DECISIONS line "#11: the plain-text chord stays armed through a paste event that carries no text".
   - **Why the decision exists.** The "Chromium fires an empty paste first" rationale comes from the e2e harness. In `plainPaste()` (11-table-paste.test.mjs:151), the real `Mod+Shift+V` keypress makes headless Chromium paste its own empty system clipboard. The synthetic paste is dispatched after that.
   - **What happens in a real browser.** The chord fires a single paste. If the clipboard holds only an image, text is empty: the handler calls `preventDefault`, returns true and leaves the flag armed. A normal Ctrl+V within the next 1 s then also has no text, so it is silently swallowed. The image upload never happens and nothing is inserted.
   - **Fix.** In the `keydown` handler, set `chordAt = 0` when Mod+V is pressed without Shift. Better still, match `event.code === 'KeyV'` rather than `event.key`, which also fixes non-Latin layouts (see NIT 1).
   - The existing tests keep passing, because the harness sends no plain keydown between the chord and its synthetic paste.
   - Then reword the DECISIONS line: the tolerance is for the harness and for browsers that fire twice, and a plain Mod+V disarms the chord.

## NIT
1. **The chord check reads `event.key`** (tablePaste.ts:47). On non-Latin layouts (for example Russian, where the key reads 'м'), the chord never arms. Also accept `event.code === 'KeyV'`.
2. **When the syntax tree isn't ready, `inCode` assumes "not code".** If `ensureSyntaxTree(..., 200)` times out, it returns null and `inCode` returns false (tablePaste.ts:76). A paste into a code block in a very large doc could then become a table. Fall back to `syntaxTree(state)`, which is partial but safe.
3. **Shift+Alt+F formats a `|` run inside a fenced code block.** `formatTable` doesn't check `inCode` (tablePaste.ts:177-180). The spec is silent on this, and reusing `inCode(state, pos)` would be a one-line guard.
4. **In an html doc, Shift+Alt+F still shows "No table at cursor"**, and the binding is swallowed. That is harmless and arguably right, but it isn't stated in the spec or DECISIONS.
5. **The new AC-08.5 copy (`11-ac08-table-paste.test.mjs`) diverges slightly from the frozen original.** It opens the doc through `?filePath=` and a tmp file, where the original uses its `openLocal(localDocUrl)` helper. The assertions are identical, so this is acceptable. A header comment line says so explicitly.
6. **The spec suggested `tests/editor/tablePaste.test.ts`, but the tests live at `tests/items/11-table-paste.test.ts`.** That follows the repo's item-test convention, so it is fine.
