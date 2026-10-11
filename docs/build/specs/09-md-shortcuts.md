# 09 — Markdown keyboard shortcuts

## Goal
Writers format markdown with the keystrokes they already know from Docs/Notion/GitHub (bold, italic, link,
code, lists that continue themselves, indent/outdent), without clashing with the browser, the OS or the
app's own shortcuts, and can discover the whole set from inside the editor.

## Scope / Out of scope
**In (final set):** Mod+B bold, Mod+I italic, Mod+K link, Mod+E inline code / code fence, Mod+Shift+X
strikethrough, Enter list/quote continuation, Backspace marker removal, Tab / Shift+Tab indent/outdent,
Alt+↑/↓ move line(s), Shift+Alt+↑/↓ duplicate line(s), Mod+/ toggle HTML comment, shortcut-help overlay.
("Mod" = Cmd on macOS, Ctrl elsewhere.)
**Out:** heading shortcuts (Mod+Alt+1…6 collide with OS/browser tab switching on several platforms),
list-type shortcuts (Mod+Shift+7/8 are keyboard-layout dependent), user-remappable keys, a formatting
toolbar with B/I buttons, rich-text WYSIWYG.

## Current state
- `src/components/EditorPane.vue:188` — keymap is `defaultKeymap` + `searchKeymap`. `defaultKeymap`
  (`@codemirror/commands` 6.10.3) already binds Alt+↑/↓ `moveLineUp/Down`, Shift+Alt+↑/↓ copy line,
  Mod+/ `toggleComment`, Mod+[ / Mod+] indent, **Mod+I `selectParentSyntax`** (collides with italic), Shift+Mod+K delete line.
- `markdown({ codeLanguages })` (`EditorPane.vue:24-26`, `@codemirror/lang-markdown` 6.5.0) already adds
  `markdownKeymap` at high precedence: Enter → `insertNewlineContinueMarkup`, Backspace → `deleteMarkupBackward`.
  With the default `nonTightLists: true`, Enter on an *empty second item of a tight list* turns the list
  loose instead of ending it — surprising for users.
- The markdown language's comment token is block `<!-- -->` (lang-markdown `commentTokens`), so Mod+/ already
  wraps lines in an HTML comment in markdown docs.
- No Mod+B/K/E/Shift+X bindings; Tab is not bound (focus leaves the editor).
- App-level shortcut: Mod+S save (`src/App.vue:239-244`), global `keydown` listener. CodeMirror search keys: Mod+F,
  Mod+G, Mod+D, Mod+Shift+L, Mod+Alt+G (`searchKeymap`).
- No shortcut documentation anywhere in the UI.

## Behaviour
Formatting commands (rules 1-6) apply to **markdown docs only**, act on **every selection range**
(multi-cursor), are each **one undo step** (#8), and `preventDefault` so the browser action never fires.
1. **Wrap/unwrap (Mod+B `**`, Mod+I `*`, Mod+Shift+X `~~`).**
   a. Non-empty selection, not already wrapped → insert the marker on both sides; the original text stays
      selected (inside the markers). Leading/trailing whitespace in the selection is kept *outside* the markers
      (`" word "` → `" **word** "`).
   b. Selection already wrapped — markers immediately inside the selection ends **or** immediately outside
      them → remove that marker pair; the bare text stays selected. For italic, a `*` that is part of `**`
      does not count (`**x**` + Mod+I → `***x***`); `_x_` also counts as italic for unwrapping.
   c. Empty selection inside a word → wrap that word; cursor keeps its offset within the word.
   d. Empty selection elsewhere → insert `****` / `**` / `~~~~` and put the cursor between the markers.
   e. A selection spanning several lines wraps each non-empty line separately (markdown emphasis cannot span blocks).
2. **Mod+K link.** Selection `text` → `[text]()` with the cursor between `()`. Selection that is a URL
   (`^https?://\S+$`) → `[](url)` with the cursor between `[]`. Empty selection → `[]()` with the cursor
   between `[]`. If the selection is already exactly `[x](y)` → unwrap to `x`.
3. **Mod+E code.** Single-line selection → wrap in one backtick each side; if the text itself contains a
   backtick, wrap in two backticks plus a space each side. Unwrap when already wrapped (rule 1b semantics).
   Empty selection → a backtick pair with the cursor between. Multi-line selection → wrap the selected
   whole lines in a fenced block (a line of three backticks before and after); cursor placed at the end of
   the opening fence line (to type a language).
4. **Enter (continuation)** — via `insertNewlineContinueMarkup` configured with `nonTightLists: false`:
   `- `/`* `/`+ ` items continue with the same marker and indent; ordered items `N.`/`N)` continue with N+1
   and following siblings are renumbered; task items continue as unchecked `- [ ] ` (also after `- [x]`);
   `> ` quotes continue. **Enter on an empty item always ends that list level**: a top-level empty item's
   marker is removed (line becomes empty); a nested empty item is outdented one level (gets the parent
   list's marker). Enter inside fenced code inserts a plain newline keeping indentation.
5. **Backspace** directly after a list/quote marker with nothing typed removes the marker (keeps existing CM behaviour).
6. **Tab / Shift+Tab.** On lines that are list items: Tab indents each selected item so it nests under the
   previous sibling — indent width = the content column of the previous sibling (2 for `- `, 3 for `1. `,
   4 for `10. `); a first item with no previous sibling is left unchanged (key still consumed). Shift+Tab
   outdents to the parent item's marker column (top-level item: no change). On non-list lines: Tab inserts
   two spaces at the cursor (or indents all selected lines by two), Shift+Tab removes up to two leading
   spaces. **Escape then Tab** (within 2 s) moves focus out of the editor (CodeMirror tab-focus mode) —
   documented in the overlay for keyboard users.
7. **Line moves.** Alt+↑/↓ move the current line or all selected lines up/down; Shift+Alt+↑/↓ duplicate
   them. Works in markdown and HTML docs (existing bindings, kept).
8. **Mod+/** toggles an HTML comment `<!-- … -->` around the selected lines (markdown and HTML docs). The
   commented text is not rendered in the preview.
9. **HTML docs:** Mod+B/K/E/Shift+X are consumed and do nothing (no browser bookmarks sidebar / search bar);
   Mod+I keeps CodeMirror's select-parent-syntax. Rules 4-6's markdown-specific parts do not apply (Tab =
   two spaces/indent; Enter keeps indentation).
10. **No conflicts.** Mod+S still saves from inside the editor; Mod+F still opens search; Mod+Z/Y/Shift+Z
    belong to #8; Mod+Shift+Enter belongs to #13 (focus mode); none of the above is bound outside the editor.
11. **Discoverability.**
    a. Editor toolbar button `editor-shortcuts-btn` (keyboard icon, `aria-label="Keyboard shortcuts"`; position in the
       shared `EditorToolbar`, 00 §3.3) opens the overlay; so does `?` **in edit/split views** when focus is **not** in an
       editable element (typing `?` in the editor inserts `?`; `?` does nothing in read/slides views — 00 §3.5).
    b. Overlay `shortcuts-overlay` is a modal dialog (`role="dialog"`, `aria-modal="true"`, labelled
       "Keyboard shortcuts"), lists every binding in this spec plus Save (Mod+S), Find (Mod+F), Undo/Redo (#8),
       Format table (#11, once landed), Esc-then-Tab; the rows are data (one array) so later items append theirs —
       #13 adds "Focus mode"; one `shortcuts-row` per action with the key combo rendered with
       platform labels (⌘ ⌥ ⇧ on macOS; Ctrl Alt Shift elsewhere). Esc, the close button
       (`shortcuts-close-btn`) or a backdrop click closes it and returns focus to where it was.
    c. Toolbar buttons' `title` attributes include their shortcut (e.g. "Undo (Ctrl+Z)").

## Decisions
- Italic uses `*` (works intra-word, unlike `_`); `_x_` is still recognised for unwrapping.
- `nonTightLists: false` so Enter on an empty item always exits — matches Docs/Notion/GitHub; CM's loosening behaviour reads as a bug.
- Strikethrough on Mod+Shift+X (Docs-adjacent, no Chrome/Safari default; Firefox's text-direction toggle is suppressed by preventDefault).
- Heading/list-type shortcuts left out: no conflict-free cross-platform choice.
- `?` opens help only outside editable elements, so it never steals a typed character.

## Acceptance criteria
AC-09.1 Given `hello world` with `world` selected When Mod+B Then the line is `hello **world**` and the selection is `world`; When Mod+B again Then the line is `hello world`.   [verify: e2e + unit]
AC-09.2 Given the cursor inside `planning` with no selection When Mod+I Then the text is `*planning*` and typing `X` inserts it at the same offset inside the word.   [verify: unit]
AC-09.3 Given an empty line When Mod+Shift+X then typing `gone` Then the line is `~~gone~~`.   [verify: e2e]
AC-09.4 Given `**bold**` selected (markers included) When Mod+I Then the result is `***bold***`; Given `_it_` selected When Mod+I Then the result is `it`.   [verify: unit]
AC-09.5 Given `docs` selected When Mod+K then typing `https://x.io` Then the line is `[docs](https://x.io)`; Given `https://x.io` selected When Mod+K then typing `site` Then `[site](https://x.io)`.   [verify: e2e]
AC-09.6 Given the text `a<BT>b` (where <BT> is one backtick) selected When Mod+E Then the result is two backticks, a space, `a<BT>b`, a space, two backticks; Given three whole lines selected When Mod+E Then a line consisting of exactly three backticks is inserted before and after them and the cursor is at the end of the opening fence line.   [verify: unit]
AC-09.7 Given the line `- [x] done` with the cursor at its end When Enter Then a new line `- [ ] ` is created with the cursor after it; Given `3. three` followed by `4. four` and the cursor at the end of `3. three` When Enter Then the new line is `4. ` and the old `4. four` becomes `5. four`.   [verify: e2e]
AC-09.8 Given `- a` / `- ` (empty second item of a tight list) with cursor on the empty item When Enter Then the empty line has no marker, no blank line was inserted before it, and the preview shows a one-item list; Given an empty nested item `  - ` under `- a` When Enter Then it becomes a top-level `- ` item.   [verify: e2e]
AC-09.9 Given `- a` / `- b` with the cursor on `b` When Tab Then the text is `- a` / `  - b` and the preview shows `b` in a nested `ul` inside the `a` item; When Shift+Tab Then it is `- b` again. Given `1. a` / `2. b` When Tab on `b` Then `b`'s line starts with 3 spaces and the preview shows a nested `ol`.   [verify: e2e]
AC-09.10 Given focus in the editor When Esc then Tab is pressed Then `document.activeElement` is outside `.cm-editor`; Given Tab alone on a non-list line Then two spaces are inserted and focus stays.   [verify: e2e, a11y]
AC-09.11 Given lines `one`/`two`/`three` with the cursor on `two` When Alt+↑ Then the order is `two`/`one`/`three`; When Shift+Alt+↓ Then `two` is duplicated below itself.   [verify: e2e]
AC-09.12 Given `secret` selected When Mod+/ Then the line is `<!-- secret -->` and the preview contains no `secret` text; Mod+/ again restores `secret`.   [verify: e2e]
AC-09.13 Given each of Mod+B, Mod+K, Mod+E, Mod+I, Mod+Shift+X is applied to a selection When Mod+Z is pressed once Then the document equals the pre-shortcut text.   [verify: e2e]
AC-09.14 Given the editor focused with unsaved edits in a shared doc When Mod+S Then a save request is sent (existing behaviour intact); When Mod+F Then the CodeMirror search panel opens.   [verify: e2e]
AC-09.15 Given an HTML doc with `<b>x</b>` selected When Mod+B, Mod+K, Mod+E Then the document text is unchanged and no browser UI opened (page still focused, `document.hasFocus()`).   [verify: e2e]
AC-09.16 Given Edit view When `editor-shortcuts-btn` is clicked Then `shortcuts-overlay` is visible with ≥ 14 `shortcuts-row` items including "Bold", "Link", "Undo", "Find" ("Focus mode" is asserted by #13 AC-13.15); on Linux/Windows the Bold row shows `Ctrl` and `B`, on macOS `⌘`; When Esc Then the overlay closes and focus returns to the button.   [verify: e2e, a11y]
AC-09.17 Given Edit view with focus on the page body (not in an input or the editor) When `?` is typed Then the overlay opens; Given focus in the editor When `?` is typed Then a `?` is inserted and no overlay opens; Given Read view When `?` is typed Then no overlay opens.   [verify: e2e]
AC-09.18 Given two cursors (Mod+click) each inside a different word When Mod+B Then both words are wrapped in `**`.   [verify: unit]

## Test hooks (data-testid list) and API/MCP contract changes
`editor-toolbar`, `editor-shortcuts-btn`, `shortcuts-overlay`, `shortcuts-row`, `shortcuts-close-btn`. No server/MCP changes.
Commands should live in a pure module (e.g. `src/editor/markdownCommands.ts`) taking `{state, dispatch}` so unit tests can run them on an `EditorState` in jsdom.

## Edge cases the adversarial verifier must try
- Selection that includes the markers vs. selection just inside them (both unwrap).
- Selection spanning a blank line; selection ending at a line start (triple-click style).
- Bold inside a list item / table cell / heading; Mod+K on text that already contains `]`.
- Enter in a list inside a blockquote (`> - a`); Enter in a fenced code block that contains `- ` lines.
- Tab on a list item inside a fenced code block (must behave as plain indent, not list nesting).
- `10.` / `99.` ordered items (marker width 4); `1)` style markers.
- Mod+B with a CJK IME composition active (must not break composition).
- macOS (Cmd) vs Linux (Ctrl) — Ctrl+B on macOS must NOT bold (Mod is Cmd there).

## Dependencies on other items (by number) and files likely touched
Depends on #8 (history; each command one step) and shares the editor toolbar with #8/#13. Interacts with #12 (slash menu must
not hijack Enter/Tab while its menu is closed; when open, menu keys win), #6 (lazy editor — overlay may live in the editor chunk),
#13 (Esc layering, 00 §3.4). Files: new `src/editor/markdownCommands.ts` (registered in `src/editor/extensions.ts`, 00 §4.7), new
`src/components/ShortcutsOverlay.vue` (uses `useFocusTrap`), `src/components/EditorToolbar.vue`, `src/composables/useGlobalShortcuts.ts` (`?`).
