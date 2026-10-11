# #12 Slash menu — code review

Reviewer pass on `lane/slash` @ f5d2850 + uncommitted work (diff + untracked files listed in the task).
Read: spec 12, 00 §3.4/§3.6/§3.7/§4.7, the #12 DECISIONS lines, all new/modified source + tests.

Evidence run:
- `npx vitest run tests/items/12-slash-menu.test.ts` → 28 passed.
- Probe script (scratchpad, `npx vite-node`) driving `slashInsertion` / `canOpenSlashMenu` on edge inputs (outputs quoted below).
- Existing `.verify/last-summary.txt` (implementer's): typecheck PASS, unit 538/538 PASS. No e2e was run by me (reviewer, time-boxed).

**Verdict: PASS. No blockers.**

## SHOULD-FIX

1. **When text follows the query and the next line has text, a block that ends at the caret pushes that text off the caret line.** `src/editor/slashMenu.ts:212-213`.
   When `end === head`, the text after the query (`rest`) stays in the doc *after* `insert`. The trailing `'\n'` is
   appended to `insert`, so it lands between the caret and `rest`. Probe:
   - `/callout|foo\nbar` → `> [!NOTE]\n> ‸\nfoo\nbar` (expected `> [!NOTE]\n> ‸foo\n\nbar`)
   - `/divider|foo\nbar` → `---\n‸\nfoo\nbar`; `/toc|foo\nbar` → `[[toc]]\n‸\nfoo\nbar`

   This breaks the DECISIONS #12 rule-14 line ("text after the query follows the caret"). It also leaves `foo`/`bar` as
   one paragraph, and under a callout `foo` becomes a lazy continuation line.
   **Fix:** when `end === head && rest`, set `end = line.to` and append `rest` to `insert` before the conditional
   `'\n'`. Add unit cases for these three inputs.

2. **A remote update during the language step drops focus to `<body>`.** `slashMenu.ts:350` (`remove`) via `sync(null)`.
   Any doc change in `lang` mode, a remote update for example, closes the field and removes the focused input. Nothing
   refocuses the editor, so the user's next keystrokes go nowhere. Esc and blur already handle focus (`:532`, `:467`).
   **Fix:** in `remove()` (or `sync(null)` when `prev?.mode === 'lang'`), if `this.dom.contains(document.activeElement)`,
   call `this.view.focus()` before removing.

## NIT

3. `slashMenu.ts:148`: `canOpenSlashMenu` builds a full throwaway state (`state.update(...)`, so every StateField runs)
   and then calls `ensureSyntaxTree(…, 50)`. In a large doc this can cost up to 50 ms of main thread for each qualifying
   `/`. It only runs after the cheap checks and is acceptable as is. A comment noting the budget, or a lower one
   (e.g. 20 ms), would help.
4. `slashMenu.ts:192` / DECISIONS rule-13 line: `- /table` leaves an empty `-` item (`- a\n-\n\n| …`), and `> /table`
   leaves a bare `>`. This is documented as literal rule 13, so it is fine. It is still worth a product follow-up,
   because the result looks broken.
5. `slashMenu.ts:254`: ↑/↓ are swallowed (return true) when the list is empty. That is harmless, but returning `false`
   when `n === 0` would let the caret move and close the menu per rule 9.
6. The `lang` step renders options with class `slash-menu-item slash-menu-lang-option`. `highlight()` only runs in
   items mode, so nothing breaks. A distinct class for language options would make the code easier to read.
7. `src/editor/slashMenu.ts` imports `FENCE_LANGUAGES` from `useMarkdown`. That is fine, because `useMarkdown` is
   already in the entry chunk (PreviewPane imports it), so the lazy editor chunk does not grow. The `EXTRA_ALIASES`
   refactor in useMarkdown does not change behaviour.

## Checked, no issue
- Trigger rules 1–2: typed-only via `inputHandler` (paste/drop/programmatic excluded, `view.composing` respected).
  Exclusions cover fenced, indented and inline code, front matter, HTML, comments, URLs and unclosed link
  destinations. Probe: `[a](http://x /` → false, `<div>\n/` → false, `text \`a\` /` → true.
- Rule 9 closes: Esc, whitespace, >24 chars, caret outside `[from+1, to]`, `/` deleted (TrackDel + char check),
  non-empty or multi-selection, focus loss (deferred check that excludes the menu), `externalWrite`/`Transaction.remote`
  changes, plugin destroy on view/doc switch. Esc calls `preventDefault` (CodeMirror keymap / explicit in the language
  step), so the #13 Esc contract holds.
- Rule 11 undo: `isolateHistory 'full'` + `userEvent 'input.complete'`. Undo restores `/query` with the menu closed;
  the language step adds no extra history step.
- a11y: listbox/option roles, `aria-selected`, `.cm-content` `aria-activedescendant`/`aria-controls`/`aria-haspopup`
  only while items show. The language input is a combobox with its own activedescendant.
- Placement: fixed layer on body/fullscreen element, z-index 200 (00 §3.7), flips above, clamps 16 px from the sides,
  CSS `max-width: calc(100vw - 32px)`, 320 px max height. The theme tokens it uses all exist.
- `inlineToc`: escapes text and ids, uses the same `encodeURIComponent` href as TocPanel, keeps `data-line-*`, and
  only renders for a standalone paragraph (code or mid-paragraph stays literal). Nesting logic is correct for an H3
  before any H2.
- Shortcut overlay: two rows added; #9's `≥ 14 rows` and label checks are unaffected. No frozen tests edited.
