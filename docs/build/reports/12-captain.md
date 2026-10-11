# #12 Slash menu: captain report

Lane `lane/slash`, worktree `/home/ubuntu/locus-repos/md-review-cap-slash`, base `f5d2850`. The work is uncommitted.
Hand-off patch: `scratchpad/cap-slash/12.patch`. It applies cleanly onto a detached `f5d2850` worktree (checked).

**Verdict: DONE.** All 18 ACs pass. The #8 deferred AC-08.5 `/table` half now passes as a real test. The targeted gate is green.

## What was built
- `src/editor/slashCatalogue.ts` holds the pure parts:
  - the 20-item catalogue, with exact inserted text and ‸/«» markers;
  - rule-5 filtering and ranking;
  - the local date;
  - language-step filtering and validation.
- `src/editor/slashMenu.ts` is the CodeMirror side:
  - a state field for the open menu (slash position, typed extent, highlight, items or language step), which closes itself under rule 9;
  - an input handler, so only a typed `/` opens the menu;
  - `canOpenSlashMenu`, which applies rule 1 plus the code, inline-code, front-matter, HTML, comment, URL and link-destination exclusions. It checks the syntax tree as it will be once the `/` is in;
  - `slashInsertion` for rules 12–15;
  - a `Prec.highest` keymap for ↑ ↓ Enter Tab Esc, so it beats #9;
  - the menu view: a fixed layer on the body at z-index 200, which flips above and clamps to the viewport, plus the code-language step.

  It is registered in `src/editor/extensions.ts`. It ships in the lazy `EditorPane` chunk with `slashMenu.css`. The entry chunk is 521,517 bytes against a 574,644 cap.
- A commit is one isolated undo step: `ownUndoStep` with `input.complete`. Undo gives back `/query` with the menu closed. Esc and every other close leave the doc as typed.
- `src/markdown/inlineToc.ts` renders `[[toc]]`: H2 and H3 headings with #3 ids and #3 plain-text labels, H3 nested under H2, "No headings yet" when there are none, and `data-line-*` carried over from the paragraph. It is registered in `useMarkdown.ts`, and `.inline-toc` styles are in `preview.css`. `useMarkdown.ts` also exports `FENCE_LANGUAGES` for the language step.
- Two rows were added to the shortcuts overlay (`shortcutList.ts`): "Insert block (slash menu)" (`/`) and "Slash menu: pick an item" (↑ ↓).

## Tests (written first; red before the implementation)
- `tests/items/12-slash-menu.test.ts`: 31 unit tests covering the catalogue, ranking, inserted text, language filter, trigger contexts, insertion and caret placement, and `[[toc]]` rendering (AC-12.15 unit half).
- `tests/e2e/items/12-slash-menu.test.mjs`: 19 browser tests covering AC-12.1–12.18, the rule-9 closes and paste.
- `tests/e2e/items/12-ac08-slash-undo.test.mjs`: AC-08.5 `/table` as a real test. The frozen `08-undo-redo.test.mjs` is untouched and still carries the `todo`.
- **Frozen-test changes: none.**

## QA (blind verifier): PASS, no blockers or majors
Full report: `docs/build/reports/12-qa.md`. All ACs and the spec's edge cases pass across phone, tablet, desktop, 4 themes, focus-mode Esc layering and a remote PUT while the menu is open. Findings:
1. **minor:** axe `scrollable-region-focusable` fires on the open menu.
2. **cosmetic:** `abc /h2| tail` gives a double space.
3. **note:** `- /table` leaves an empty bullet.
4. **note:** `js` picks `json`.

## Review: PASS, no blockers
Full report: `docs/build/reports/12-review.md`.
- **should-fix 1:** with text after the query plus a non-blank next line, callout, divider and toc pushed that text off the caret line.
- **should-fix 2:** a remote update during the language step dropped focus to `<body>`.
- **nits:** a 50 ms parse budget, the `- /table` bullet, ↑/↓ swallowed when the list is empty, and shared item/lang-option classes.

## Fix round (one round, all findings fixed)
- **Review 1:** text after the query is put on the caret line before the separating blank line. Unit cases added.
- **Review 2:** closing while focus is inside the menu hands focus back to the editor.
- **Nit:** the parse budget is now 20 ms, with a comment.
- **Nit:** ↑/↓ with no matches fall through, so the caret moves and the menu closes.
- **Nit:** language options have their own class.
- **QA 1:** the listbox is `tabindex=0` and hands any focus straight back to the editor. The editor also gets `aria-haspopup`/`aria-autocomplete`, as CodeMirror's autocomplete does. The full axe scan in AC-12.17 now passes with no rule disabled.
- **QA 2:** leading whitespace of text after the query is dropped on its new line.
- **QA 3 / review nit:** after only list or quote markers, a prefix or block item becomes that item's content (`- /table` gives a table inside the list item), so no empty bullet is left.
- **QA 4:** highlight.js's own aliases (`py`, `js`, `ts`) also match and find the canonical name, with an exact alias match listed first, so `js` gives `javascript`.
- **Still open:** nothing. No security findings, so nothing went to POLISH.md.

## Decisions (appended to docs/build/DECISIONS.md, `#12:` lines)
- Query and caret semantics.
- Where text after the query goes for blocks.
- Container markers are not "text before".
- Commit on click, with mousedown prevented.
- Language option set and alias matching.
- The a11y pattern and the tabindex/focus hand-back.
- Fixed body layer.
- Front-matter detection in the editor.
- A test note: Playwright `Shift+z` sends "z", which CodeMirror reads as undo while undo can run. #12 presses `Shift+Z`. #8's frozen AC-08.1 only passes because nothing is left to undo at that point. Real keyboards are unaffected.

## Gate (targeted, final)
`VERIFY_ITEMS=12 E2E_FILES=12-slash-menu,12-ac08-slash-undo,08-undo-redo,09-md-shortcuts,09-fixes,13-focus-mode,16-callouts,03-toc-anchors,06-lazy-editor,11-table-paste,app scripts/verify.sh --only typecheck,unit,build,e2e`

Result: OVERALL PASS. Typecheck 0 errors; unit 541/541; build PASS; e2e 225/228 with 0 failures. The 3 not counted as passes are #8's frozen `todo` tests.
