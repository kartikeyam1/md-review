# 11 — Format a pasted table (+ "format table" command)

## Goal
Pasting cells from Google Sheets / Excel (TSV) or CSV-looking text produces a readable, column-aligned GFM table
instead of a tab-mangled blob; an existing ragged markdown table can be re-aligned with one keystroke.

## Scope / Out of scope
- In: TSV/CSV detection on paste, conversion to GFM, pipe escaping, column padding, numeric right-alignment,
  plain-text paste override (Ctrl/Cmd+Shift+V), single undo step, "format table" command for the table under the
  cursor.
- Out: HTML-table clipboard parsing (`text/html` `<table>` is ignored; text/plain is used), merged cells,
  a visual table editor, Tab-to-next-cell navigation, sorting, East-Asian wide-character width.

## Current state
- `src/components/EditorPane.vue:193-207`: the only paste handler; inserts raw `<svg>` text, otherwise returns
  `false` so CodeMirror inserts `text/plain` verbatim (tabs kept, no table).
- `EditorPane.vue:188`: keymap is `defaultKeymap` + `searchKeymap`; no history (item #8) and no
  format/markdown commands (item #9).
- `src/composables/useMarkdown.ts:167-171`: markdown-it with default GFM tables; tables render with
  `data-line-start/end` (`:118-125`), so a correctly formed table shows as `<table>` in preview.
- No existing table formatting utility anywhere in `src/`.

## Behaviour
### Paste conversion
1. Applies only when `contentType` is markdown and the cursor (selection head) is **not** inside a fenced or
   indented code block, inline code, front matter, or an existing table row (line starting with optional spaces
   then `|`). Otherwise text/plain is inserted verbatim.
2. Parse text/plain (strip one trailing newline; normalise `\r\n` → `\n`). Quoting follows RFC 4180 for both
   formats: a field wrapped in `"` may contain the delimiter, newlines, and `""` for a literal quote.
3. **TSV detected** iff ≥2 records, every record has the same number of fields, that number ≥2, and the
   delimiter is a tab. **CSV detected** (only if not TSV) iff ≥2 records, same field count ≥2 per record, the
   delimiter is `,`, AND (field count ≥3 OR record count ≥3), AND no record starts with a markdown block marker
   (`#`, `>`, `- `, `* `, `+ `, `|`, ``` ` ```, `<digits>. `). Anything else is not a table.
4. Conversion: first record = header. Each cell: trim; `\` before `|` is kept, every unescaped `|` becomes `\|`;
   embedded newlines become `<br>`; empty stays empty.
5. **Column width** = max code-point length of any cell in the column (after escaping), min 3, capped at 40;
   cells shorter than the width are right-padded with spaces (left-padded for right-aligned columns); longer cells
   overflow unpadded.
6. **Numeric columns** — every non-empty body cell matches `^[-+]?[$€£₹]?\d[\d,]*(\.\d+)?%?$` and at least one
   body cell is non-empty — get delimiter `---…:` (right-aligned) and left-padded cells. All other columns use
   plain `---…` (no colons).
7. Row format: `| c1 | c2 | … |` — one space each side of every cell. Each delimiter cell is exactly the column width long, colons included (e.g. width 3 right-aligned → `--:`, width 5 plain → `-----`).
8. **Block isolation:** the table is inserted on its own lines. If text precedes the cursor on its line, insert
   `\n\n` first; if the previous line is non-blank, insert `\n` first; if text follows the cursor (or the next
   line is non-blank) append `\n\n`/`\n` so a blank line follows. Selection is replaced. Cursor ends at the end of
   the table's last row.
9. Undo (aligned with #8 rule 3): the paste is two isolated history steps — the raw text insertion, then the
   formatting. One Ctrl/Cmd+Z yields the *raw pasted* text (tabs/commas, at the same position, cursor at its end);
   a second yields the exact pre-paste doc. Redo re-applies each in one step. Neither step merges with typing.
10. An info toast (`app-toast`, 00 §3.1) "Pasted as table · Ctrl+Shift+V to paste as plain text" (`Cmd` on mac)
    appears on conversion.

### Plain-text paste
11. Ctrl+Shift+V (Cmd+Shift+V on mac) pastes `text/plain` verbatim: no table conversion, no image upload (#10),
    no svg special-case. Implementation must detect the chord on keydown and apply to the immediately following
    `paste` event only (flag cleared after that paste or 1 s).

### Format table command
12. **Shift+Alt+F** (and exposed `formatTable()` on `EditorPane`, used by the slash menu if wanted) re-aligns the
    GFM table containing the cursor. A table = maximal run of consecutive lines starting (after optional indent)
    with `|`, whose 2nd line is a delimiter row (`^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$`). Lines without a
    leading `|` are not recognised (out of scope).
13. Split cells on unescaped `|` (`\|` stays escaped). Column count = max cells over all rows; short rows (and
    header/delimiter) are padded with empty cells. Existing alignment markers (`:---`, `:---:`, `---:`) are
    preserved; new columns get `---`. Padding per rules 5/7, but alignment comes from the markers (left/none:
    right-pad; right: left-pad; centre: split padding, extra space on the right). Cell content is trimmed and
    otherwise unchanged (no re-escaping, no numeric detection).
14. Cursor stays in the same row and cell index, placed at the start of that cell's content.
15. Cursor not in a table → no change, info toast "No table at cursor". Already formatted → no change, no
    history entry. Formatting is one undo step.

## Decisions
- Header = first row always (spreadsheets almost always copy a header; a wrong header is a one-line fix).
- Width cap 40: one long description cell must not pad every other row to hundreds of spaces.
- Numeric right-alignment on paste only: makes metric tables (the common agent/PM case) readable; the format
  command never changes alignment intent.
- CSV is gated harder than TSV (≥3 cols or ≥3 rows, no markdown markers) because prose lines contain commas;
  Ctrl+Shift+V is the escape hatch.
- "Single undo step" is read as: the formatting is one atomic step that undo peels off, leaving the raw paste (the
  #8 contract) — so undo doubles as "I didn't want a table".
- Shift+Alt+F mirrors VS Code "Format Document"; avoids #9's Ctrl+B/I/K and Alt+↑/↓.

## Acceptance criteria
AC-11.1 Given an empty markdown doc, When text/plain `Name\tQty\nApple\t3\nPear\t12` is pasted, Then the doc is exactly `| Name  | Qty |\n| ----- | --: |\n| Apple |   3 |\n| Pear  |  12 |` (plus at most a trailing newline) and the preview shows a `table` with 2 `th` and 2 body rows.   [verify: e2e]
AC-11.2 Given the paste of AC-11.1, When Ctrl/Cmd+Z is pressed once, Then the doc equals the raw TSV text `Name\tQty\nApple\t3\nPear\t12`; When pressed again, Then the doc is empty.   [verify: e2e]
AC-11.3 Given the same clipboard, When pasted with Ctrl/Cmd+Shift+V, Then the doc equals the raw text including tab characters and no toast says "Pasted as table".   [verify: e2e]
AC-11.4 Given CSV `id,name,note\n1,"Smith, J","said ""hi"""\n2,Lee,a|b`, When pasted, Then the body rows contain cells `Smith, J`, `said "hi"`, and `a\|b`, and the preview renders 3 columns with `a|b` visible.   [verify: unit + e2e]
AC-11.5 Given the sentence pair `Hello, world\nGoodbye, moon` (2×2 CSV-like), When pasted, Then it is inserted verbatim (not a table).   [verify: unit]
AC-11.6 Given TSV whose 2nd record has a different field count, When pasted, Then it is inserted verbatim.   [verify: unit]
AC-11.7 Given a TSV cell `"line1\nline2"` (quoted, with newline), When pasted, Then the cell becomes `line1<br>line2` and the preview shows a line break inside one cell.   [verify: unit + e2e]
AC-11.8 Given the cursor inside a ```` ``` ```` fenced block or an inline code span, When TSV is pasted, Then it is inserted verbatim.   [verify: e2e]
AC-11.9 Given the cursor mid-line in `Intro text|more` (| = cursor), When TSV is pasted, Then the result has a blank line between `Intro text` and the table and between the table and `more`, and preview shows paragraph, table, paragraph.   [verify: e2e]
AC-11.10 Given a column whose body is `$1,200`, `15%`, `-3.5`, `` (empty), Then its delimiter ends with `:`; a column containing `12a` does not.   [verify: unit]
AC-11.11 Given a cell longer than 40 characters, Then that column's width is 40 and other rows in the column are padded to 40, the long cell unpadded.   [verify: unit]
AC-11.12 Given the ragged table `|a|b|\n|:-|-:|\n|long cell|1|2|` with the cursor in `long cell`, When Shift+Alt+F is pressed, Then the doc becomes `| a         |   b |     |\n| :-------- | --: | --- |\n| long cell |   1 | 2   |` and the cursor is at the start of `long cell`.   [verify: e2e]
AC-11.13 Given a formatted table, When Shift+Alt+F is pressed, Then the doc is unchanged and Ctrl/Cmd+Z does not undo anything from that press.   [verify: e2e]
AC-11.14 Given the cursor on a paragraph, When Shift+Alt+F is pressed, Then the doc is unchanged and an info `app-toast` contains `No table at cursor`.   [verify: e2e]
AC-11.15 Given a table cell containing `` `x\|y` `` (escaped pipe in code), When formatted, Then the cell content is preserved byte-for-byte and the column count does not change.   [verify: unit]
AC-11.16 Given an `html` content-type doc, When TSV is pasted, Then it is inserted verbatim.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
- `app-toast` (00 §3.1). Editor via `.cm-content`; preview via `.preview-pane table`. #9's shortcuts overlay gains a
  "Format table" row (Shift+Alt+F).
- Pure functions to unit-test (suggested module `src/editor/tablePaste.ts`): `parseDelimited(text)`,
  `detectTable(text) → {rows} | null`, `toMarkdownTable(rows) → string`, `formatMarkdownTable(lines) → string`.
- No API/MCP changes.

## Edge cases the adversarial verifier must try
- Trailing tab on every row (Sheets copies of trailing empty columns); a fully empty column; a single-column copy
  (1 field → not a table); a single row (not a table).
- Windows `\r\n`; a cell that is just `|`; a cell with a backslash before `|`; unicode/emoji cells.
- Pasting over a multi-line selection; pasting at doc start and doc end.
- Cursor on the delimiter row / on the last row / in the indentation before `|` when formatting.
- Ctrl+Shift+V followed by a normal Ctrl+V (second paste must convert again).
- Excel clipboard carrying PNG + TSV (must convert, not upload — see #10 rule 1).

## Dependencies on other items (by number) and files likely touched
- #8 history (undo ACs); #10 shares the paste handler and owns the toast; #9 keymap must not bind Shift+Alt+F;
  #12 may expose "Format table" — not required.
- Files: new `src/editor/tablePaste.ts` (registered in `src/editor/extensions.ts`, 00 §4.7; + `tests/editor/tablePaste.test.ts`),
  `src/components/EditorPane.vue` (expose `formatTable()` only).
