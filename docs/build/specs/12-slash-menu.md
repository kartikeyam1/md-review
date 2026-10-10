# 12 — Slash menu

## Goal
Authors insert structure (headings, lists, tables, diagrams, callouts, RAG status, dividers, TOC, dates) by typing
`/` and picking from a filterable menu, without remembering markdown syntax.

## Scope / Out of scope
- In: trigger rules, menu UI (keyboard + mouse + filtering), the item catalogue and exact inserted text, the
  code-block language step, single-step undo, rendering of the `[[toc]]` placeholder.
- Out: rendering of callouts and RAG badges (owned by #16 — this item only emits its syntax), user-defined items,
  slash menu in HTML documents, mobile on-screen-keyboard toolbars, templates (#27).

## Current state
- `src/components/EditorPane.vue:182-221`: extensions are line numbers, selection, search, `defaultKeymap` +
  `searchKeymap` (`:188`), language compartment (`:21-27`, markdown with `codeLanguages`), comment field, theme,
  selection listener, paste handler (`:193-207`), update listener. No autocomplete, tooltip, or input handler; no
  history (#8). `@codemirror/autocomplete` is installed transitively (`node_modules/@codemirror/autocomplete`).
- The markdown language (`@codemirror/lang-markdown`) provides a syntax tree (FencedCode, CodeBlock, InlineCode,
  URL, HTMLBlock, Comment nodes) usable for context checks.
- `src/composables/useMarkdown.ts:57-67` registers the highlight.js languages (the language step's list);
  heading ids come from #3's `src/markdown/headingIds.ts` (replacing `headingAnchorPlugin`, `:66-85`); mermaid fences render as `<div class="mermaid">` (`:101-105`).
- `docs/build/specs/16-callouts.md` rules 1-2 (`> [!TYPE]`) and 10-15 (`:rag-<green|amber|red>[label]`) define the
  syntax emitted here. `docs/build/specs/08-undo-redo.md` rule 3 requires slash insertions to be one undo step.

## Behaviour
### Trigger
1. The menu opens when `/` is **typed** (keyboard input, not paste/drop/programmatic) into a markdown doc
   (`contentType !== 'html'`) with an empty selection, and the character before the `/` is line start, a space or
   a tab.
2. It does **not** open when the `/` lands inside: a fenced code block (including its fence/info lines), an indented
   code block, inline code (an odd number of unescaped backticks precedes it on the line — covers unclosed spans),
   front matter, an HTML block or `<!-- -->` comment, or an unclosed link destination `](…` on the same line.
   URLs are excluded by rule 1 (`https://a/b` — `/` follows a non-space).
3. The **query** is the text between the `/` and the caret. The `/query` text is ordinary document text while
   the menu is open (it autosaves like any typing).

### Menu
4. `slash-menu` (`role="listbox"`, `aria-label="Insert block"`) is anchored under the `/` (flips above when there
   is not enough room below), never overflows the viewport horizontally (phone: max-width `calc(100vw - 32px)`),
   max height 320 px with internal scroll. Each item shows label + a one-line hint (the syntax).
5. Filtering: case-insensitive. An item matches if its label, id, or any alias starts with the query, or any word in
   its label starts with it. Ranking: label-prefix, then alias/id-prefix, then word-prefix; ties keep catalogue
   order. Empty query = full catalogue in catalogue order. First match is highlighted after every query change.
6. No matches → menu shows `slash-menu-empty` "No matching blocks"; Enter then closes the menu and performs a normal
   Enter.
7. Keys while open (highest precedence, beat #9 list continuation / Tab indent): ↑/↓ move highlight (wrap);
   Enter or Tab commits the highlighted item; Esc closes. ←/→ move the caret normally.
8. Mouse: hover highlights; pressing an item commits it without the editor losing focus.
9. Close without change when: Esc; whitespace typed; query longer than 24 chars; the caret leaves
   `[slash+1, end of query]` (arrow, click elsewhere); the `/` is deleted; the selection becomes non-empty; the
   editor loses focus (not to the menu); a remote update (#8) changes the doc; the user switches view/doc.
   **Esc and every close leave the document exactly as typed.**
10. Highlighted item has `aria-selected="true"`; `.cm-content` has `aria-activedescendant` = its id while open.

### Commit
11. Committing replaces `/query` with the item's text in **one isolated history step**: one Ctrl/Cmd+Z restores the
    doc exactly as it was just before commit (`/query` present, menu closed); a further undo continues with typing
    history. Redo re-applies the insertion in one step.
12. **Inline items** (Status ×3, Date) replace `/query` in place.
13. **Line-prefix items** (headings, lists): if only whitespace precedes `/`, the prefix replaces `/query` (indent
    kept). If text precedes it, that text stays on its line (trailing whitespace trimmed) and the prefix starts a
    new line with the same indent; any text after the query follows the prefix on the new line.
14. **Block items** (table, code, mermaid, callouts, divider, TOC): same as 13, plus a blank line is ensured before
    the block (unless at doc start or the previous line is blank) and after it when non-blank text follows. Lines
    after the first are prefixed with the line's indent.
15. After commit the caret/selection is placed as marked in the catalogue (‸ = caret, «x» = x selected).

### Catalogue (default order; exact inserted text, `\n` = newline; `\|` in this table means a literal `|`)
| id | Label | Aliases | Inserted |
|---|---|---|---|
| `h1` `h2` `h3` | Heading 1 / 2 / 3 | heading, title, h | `# ‸` / `## ‸` / `### ‸` |
| `bullet` | Bulleted list | ul, list, bullet | `- ‸` |
| `numbered` | Numbered list | ol, number, ordered | `1. ‸` |
| `task` | Task list | todo, checkbox, check | `- [ ] ‸` |
| `table` | Table | grid | `\| «Column 1» \| Column 2 \| Column 3 \|\n\| -------- \| -------- \| -------- \|\n\|          \|          \|          \|\n\|          \|          \|          \|` (3 columns × header + 2 rows) |
| `code` | Code block | fence, pre, snippet | language step (rule 16), then ```` ```<lang>\n‸\n``` ```` |
| `mermaid` | Mermaid diagram | diagram, flowchart, chart, graph | ```` ```mermaid\nflowchart TD\n    A[«Start»] --> B{Decision}\n    B -->\|Yes\| C[Do this]\n    B -->\|No\| D[Do that]\n``` ```` |
| `callout-note` … `callout-caution` | Callout: Note / Tip / Important / Warning / Caution | callout, alert, note / tip / important / warning, warn / caution, danger | `> [!NOTE]\n> ‸` (`TIP`, `IMPORTANT`, `WARNING`, `CAUTION`) |
| `rag-green` `rag-amber` `rag-red` | Status: Green / Amber / Red | rag, status, green / amber, yellow / red | `:rag-green[«On track»]` / `:rag-amber[«At risk»]` / `:rag-red[«Off track»]` |
| `divider` | Divider | hr, rule, line, separator | `---\n‸` |
| `toc` | Table of contents | contents, index | `[[toc]]\n‸` |
| `date` | Today's date | today, now | `YYYY-MM-DD‸` (local date) |

16. **Code language step:** after committing `code`, the menu shows `slash-menu-lang-input` (focused, placeholder
    "Language") above `slash-menu-lang-option` items: "Plain text" (no language) first, then the registered
    highlight.js languages + aliases from `useMarkdown.ts` alphabetically, filtered by prefix. ↑/↓/Enter/mouse pick
    an option; Enter with no highlighted match uses the typed text (allowed chars `[A-Za-z0-9_+#.-]`, ≤ 30).
    Esc cancels the whole insertion (doc unchanged, `/query` remains, focus back in the editor at its caret). The
    document is not modified until the language is chosen; the result is still one undo step.
17. **RAG syntax** is exactly #16 rule 10 (`:rag-<green|amber|red>[label]`); this menu always emits lower-case
    colours and a non-empty default label so docs read well on GitHub/raw too.
18. **`[[toc]]` rendering** (preview + HTML export): a paragraph consisting solely of `[[toc]]` (case-insensitive,
    surrounding whitespace allowed) renders `<nav class="inline-toc" data-testid="inline-toc" aria-label="Table of
    contents">` containing a nested `<ul>` of the doc's H2 and H3 headings in order, each an
    `a[data-testid=inline-toc-link]` with `href="#<heading id>"` (ids from #3; link text = #3 rule 2 plain text). No H2/H3 →
    the nav contains "No headings yet". `[[toc]]` inside code or mid-paragraph renders literally.

## Decisions
- RAG: #16 already fixed the syntax; this spec adopts it unchanged (single source of truth = #16 rule 10) and only
  fixes the default labels On track / At risk / Off track.
- Esc never edits the doc; undo restores `/query` (not the pre-`/` text) so a mis-pick is one keystroke to retry.
- Five separate callout items (not a sub-menu) so `/warn` + Enter is two keystrokes.
- `/toc` inserts a static placeholder rendered at view time (always current) rather than a generated list.
- Disabled in HTML docs: the snippets are markdown and would corrupt HTML.

## Acceptance criteria
AC-12.1 Given an empty markdown doc in edit mode, When `/` is typed, Then `slash-menu` is visible with all catalogue items in order and the first item has `aria-selected="true"`.   [verify: e2e]
AC-12.2 Given text `see https:` , When `/` is typed (preceded by `:`), Then no menu opens; and given `foo /` (space before), Then it opens.   [verify: e2e]
AC-12.3 Given the caret inside a fenced code block, an inline code span `` `a / `` (unclosed), front matter, or an HTML-type doc, When `/` is typed after whitespace, Then no `slash-menu` appears.   [verify: e2e]
AC-12.4 Given the menu open, When `tab` is typed, Then `table` is the first and highlighted item; When `warn` is typed instead, Then `callout-warning` is first.   [verify: e2e]
AC-12.5 Given `/table` + Enter on an empty line, Then the doc contains exactly the catalogue table text, the selection is `Column 1`, and the preview renders a 3-column table with 2 body rows.   [verify: e2e]
AC-12.6 Given AC-12.5, When Ctrl/Cmd+Z is pressed once, Then the doc text is `/table` and no menu is open.   [verify: e2e]
AC-12.7 Given the menu open with query `xyz`, Then `slash-menu-empty` is shown; When Esc is pressed, Then the menu closes and the doc still contains `/xyz`.   [verify: e2e]
AC-12.8 Given the menu open, When ↓ is pressed past the last item, Then the first item is highlighted; When an item is clicked, Then it is inserted and the editor keeps focus (typing continues in the doc).   [verify: e2e]
AC-12.9 Given `/code` + Enter, then `py` typed in `slash-menu-lang-input` and Enter, Then the doc has ```` ```python ```` / empty line / ```` ``` ```` with the caret on the empty line; and with Esc instead, the doc still reads `/code`.   [verify: e2e]
AC-12.10 Given `/mermaid` + Enter, Then the preview shows a rendered mermaid diagram (an `svg` inside `.mermaid`) and `Start` is selected in the editor.   [verify: e2e]
AC-12.11 Given `/callout` filtered to each callout item and committed, Then the doc contains `> [!NOTE]`… `> [!CAUTION]` on the first line and the caret on the following `> ` line.   [verify: e2e]
AC-12.12 Given `Status: /rag` + Enter, Then the line reads `Status: :rag-green[On track]` with `On track` selected; typing `Done` yields `:rag-green[Done]`, which (with #16) renders a `rag-badge` with `data-rag="green"`.   [verify: e2e]
AC-12.13 Given `Intro text /h2` + Enter, Then line 1 is `Intro text` and line 2 is `## ` with the caret after it; given `Intro text /divider` + Enter, Then a blank line separates `Intro text` and `---` (preview shows a paragraph and an `hr`, not an H2).   [verify: e2e]
AC-12.14 Given `/date` + Enter, Then today's local date in `YYYY-MM-DD` replaces `/date`.   [verify: e2e]
AC-12.15 Given a doc with `## A`, `### B`, `## C` and a `[[toc]]` line, Then the preview has one `inline-toc` with 3 `inline-toc-link`s whose hrefs are `#a`, `#b`, `#c`, B nested under A; `` `[[toc]]` `` in code renders literally.   [verify: unit + e2e]
AC-12.16 Given the menu open at 390×844, Then its bounding box lies fully inside the viewport.   [verify: e2e]
AC-12.17 Given the menu open, Then it has `role="listbox"`, items have `role="option"`, and `.cm-content` `aria-activedescendant` equals the highlighted item's id.   [verify: a11y]
AC-12.18 Given the menu open inside a list item, When Enter is pressed, Then the item is inserted and no new list bullet is created (menu keys beat #9).   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
- `slash-menu`, `slash-menu-item` (with `data-command="<id>"`, `aria-selected`), `slash-menu-empty`,
  `slash-menu-lang-input`, `slash-menu-lang-option` (with `data-lang`, empty for Plain text), `inline-toc`,
  `inline-toc-link`. Rendering hooks for callouts/RAG are #16's (`callout`, `rag-badge`).
- No API changes. MCP doc-creation tool descriptions may mention `[[toc]]` (text-only).

## Edge cases the adversarial verifier must try
- `/` at doc start; `//`; `/` right after a tab; `a/b` (no menu); `/` typed with a selection active.
- IME composition; pasting `/table` (no menu); typing fast `/tab⏎` before the menu paints.
- Query with uppercase (`/TABLE`); backspace to empty query (full list again) then once more (menu closes).
- Commit when the `/` line is indented 4 spaces inside a list (indent applied to every block line).
- Remote update (#8) arriving while open; switching Read/Edit while open; clicking the scrollbar of the menu.
- Undo/redo straight after the language step; the menu near the bottom edge of the editor (flips above).

## Dependencies on other items (by number) and files likely touched
- #8 history (undo AC); #9 keymap precedence; #16 renders callouts/RAG — **this item lands after #16** (AC-12.10–12.12
  need the renderers); #6 slash code must live in the lazy editor chunk; #3/#4 heading ids used by `[[toc]]` links;
  #19 export renders `[[toc]]`. Undo contract summary: 00 §3.6.
- Files: new `src/editor/slashMenu.ts` (catalogue + trigger + CM view plugin; registered in `src/editor/extensions.ts`) and
  `src/components/SlashMenu.vue` (or CM tooltip), new `src/markdown/inlineToc.ts` (registered in `useMarkdown.ts`),
  `src/styles/preview.css` for `.inline-toc`.
