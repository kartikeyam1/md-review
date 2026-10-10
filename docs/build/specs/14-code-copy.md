# 14 — Copy button + language label on code blocks

## Goal
Readers of agent-written docs constantly lift commands, configs and snippets out of them. Every fenced
code block gets a one-click, keyboard-reachable "Copy" button that copies the exact source text, plus a
small label naming the language, so readers don't hand-select text or pick up highlight artefacts.

## Scope / Out of scope
- In scope: fenced (```` ``` ```` and `~~~`) and indented code blocks rendered in the markdown preview
  (`.preview-pane`), in every pane layout that shows the preview (read, split from #7, focus from #13) and
  in all six themes.
- Out of scope: inline `code` spans; code inside HTML documents (sandboxed iframe, `PreviewPane.vue:399-407`);
  the CodeMirror editor; mermaid diagrams (see Decisions — they get "Copy source" inside the #15 viewer).

## Current state
- Fences are rendered by markdown-it's default `fence` rule wrapped in `lineDataPlugin`
  (`src/composables/useMarkdown.ts:97-110`): mermaid short-circuits to `<div class="mermaid">` (`:101-104`),
  everything else is `<pre data-line-start data-line-end><code class="language-x">…hljs spans…</code></pre>`
  (`:106-108`). Indented blocks: `:113-119`.
- Highlighting: `highlight()` returns hljs HTML for registered languages, else `''` → escaped text
  (`useMarkdown.ts:170-179`). Language aliases at `:49-55`.
- Preview HTML is injected via `v-html` (`src/components/PreviewPane.vue:408`) and re-rendered on every content
  change (`renderedHtml` computed, `:50`), so any per-block UI must survive re-render (event delegation on the
  container, not per-node listeners).
- `<pre>` styles: `PreviewPane.vue:487-499` (non-GitHub themes); GitHub themes use `github-markdown-css` via
  `.markdown-body` (`PreviewPane.vue:406`, `src/composables/useTheme.ts:45-55`).
- Selection → comment flow is driven by `mouseup` on the container (`PreviewPane.vue:316-358`) and depends on
  `<pre>` carrying `data-line-start` (asserted by `tests/e2e/app.test.mjs:125-170`, which triple-clicks
  `.preview-pane pre code`).
- No copy affordance exists anywhere today; no `@media print` rules exist.

## Behaviour
1. Every non-mermaid code block in `.preview-pane` is wrapped in `<div class="code-block" data-testid="code-block">`
   containing a toolbar (`data-testid="code-toolbar"`) and the original `<pre>`. The `<pre>` keeps its
   `data-line-start`/`data-line-end` attributes and remains the element tests/commenting address; the wrapper
   carries **no** `data-line-*` attributes.
2. The toolbar contains, in this order: a language label (`data-testid="code-lang-label"`) and a copy button
   (`data-testid="code-copy-btn"`). The toolbar is outside the `<pre>` and has `user-select: none`, so
   selecting/triple-clicking code never includes "Copy" or the label text.
3. Language label text = the first whitespace-delimited word of the fence info string, lower-cased, with any
   `{…}` attribute suffix stripped (```` ```TypeScript title="x" ```` → `typescript`; ```` ```ts ```` → `ts`).
   It is shown even when hljs does not know the language (```` ```terraform ```` → `terraform`).
   No info string, or an indented block → no label element is rendered (the copy button still is).
   Label text is escaped (an info string of `<img>` shows the literal text `<img>`).
4. Clicking the copy button writes to the clipboard **the exact fenced content**: the source lines between the
   fences, joined with `\n`, with the single trailing newline removed. Tabs, leading spaces, trailing spaces on
   lines, blank lines inside the block, `<`, `&`, emoji and non-ASCII are preserved byte-for-byte. It never
   contains highlight markup, the label, or the word "Copy". (Implementation may read `code.textContent` minus
   the final `\n`, which equals the token content.) CRLF sources copy with `\n`.
5. Clipboard: use `navigator.clipboard.writeText`; if it is unavailable or rejects, fall back to a hidden
   `<textarea>` + `document.execCommand('copy')`. If both fail, the button shows "Copy failed" for 2 s.
6. Feedback: on success the button's visible text changes from "Copy" to "Copied" (icon swaps to a check) and
   it gains `data-state="copied"` for 2000 ms ± 250 ms, then reverts to `data-state="idle"`. A polite live
   region (`aria-live="polite"`, `data-testid="code-copy-status"`, one per preview pane) announces
   "Copied to clipboard". Clicking again during the copied state re-copies and restarts the timer.
7. Visibility: on devices with a hover-capable pointer the toolbar's copy button is visually shown while the
   code block is hovered **or** contains focus (`:focus-within`); the language label is always visible.
   On `(hover: none)` devices (phones/tablets) the copy button is always visible. Hidden-by-opacity is fine,
   but the button must remain in the tab order at all times.
8. Accessibility: the copy button is a native `<button type="button">` with `aria-label="Copy code"`
   (or `"Copy <lang> code"` when a label exists) and a visible focus ring; Enter and Space activate it.
   Minimum hit area 32×32 CSS px (44×44 on `(hover: none)`).
9. Clicking the button does not start a text selection, does not open the selection action bar / comment
   popover, and does not clear an existing comment highlight.
10. Themes: toolbar colours come from theme tokens (`--bg-code`, `--border`, `--text-muted`, `--accent`) so it
    is legible in `light`, `dark`, `github-light`, `github-dark`, `locus-light`, `locus-dark`; label and button
    text contrast against their background ≥ 4.5:1 in every theme.
11. Print (`@media print`): the toolbar (label and button) is not displayed; the code itself prints, wrapping
    long lines (`white-space: pre-wrap`) instead of being clipped.
12. Long lines still scroll horizontally inside the `<pre>`; the toolbar does not scroll with the code and never
    overlaps the first line of code (it sits above the code or reserves space).
13. Self-contained HTML export (#19) must not include the toolbar.

## Decisions
- Mermaid blocks get no hover copy button: a click on a diagram opens the #15 viewer, whose toolbar has
  "Copy source" (`zoom-copy-source`). Avoids two competing click targets on diagrams.
- Copy drops the final trailing newline (matches GitHub's behaviour; pasting into a terminal won't auto-run).
- Label shows the author's word, not a prettified name: zero mapping table to maintain, and agents use
  idiosyncratic fence names.

## Acceptance criteria
AC-14.1 Given a doc with ```` ```bash\necho "a <b> & c"\n\tindented\n``` ```` When the reader clicks `code-copy-btn`
  Then the clipboard text is exactly `echo "a <b> & c"\n\tindented` (no trailing newline).   [verify: e2e]
AC-14.2 Given a ```` ```typescript ```` block that hljs highlights into spans When copied Then the clipboard contains
  no `<span`, `hljs`, "Copy" or "typescript" text that was not in the source.   [verify: e2e]
AC-14.3 Given fences ```` ```ts ````, ```` ```Terraform ````, ```` ```json {linenos} ```` and one with no info string
  Then the `code-lang-label` texts are `ts`, `terraform`, `json` and the fourth block has no label but has a copy
  button.   [verify: unit (renderHtml) + e2e]
AC-14.4 Given a copy succeeds Then the button text is "Copied" and `data-state="copied"` within 100 ms, the live
  region text is "Copied to clipboard", and after ~2 s it reverts to "Copy" / `idle`.   [verify: e2e]
AC-14.5 Given clipboard permission is denied and `execCommand` returns false Then the button shows "Copy failed".   [verify: e2e]
AC-14.6 Given keyboard-only use When the reader Tabs into a code block's copy button and presses Enter (and,
  separately, Space) Then the content is copied and focus stays on the button.   [verify: e2e, a11y]
AC-14.7 Given desktop 1400×900 Then the copy button has opacity 0 (or is visually hidden) while the block is not
  hovered/focused, and visible on hover. Given phone 390×844 with `hasTouch`/`(hover: none)` Then it is visible
  without hover.   [verify: e2e]
AC-14.8 Given the existing e2e `code block commenting in preview` tests Then they still pass: `.preview-pane pre`
  has `data-line-start`, and triple-clicking `pre code` opens the comment action without "Copy" in the
  selected text.   [verify: e2e]
AC-14.9 Given each of the six themes Then label and button text contrast ≥ 4.5:1 against the toolbar background.   [verify: visual]
AC-14.10 Given print media emulation Then no `code-toolbar` is displayed and a 300-char line wraps within the page width.   [verify: e2e]
AC-14.11 Given a ```` ```mermaid ```` block Then it has no `code-copy-btn`.   [verify: e2e]
AC-14.12 Given an indented (4-space) code block Then it has a copy button that copies its content without the
  4-space indentation markdown strips.   [verify: e2e]
AC-14.13 Given the doc content changes (live sync / editor in split view) Then newly rendered blocks have
  working copy buttons and no listeners leak (clicking an old button reference does nothing harmful).   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
`code-block`, `code-toolbar`, `code-lang-label`, `code-copy-btn` (`data-state="idle|copied|failed"`),
`code-copy-status`. No API/MCP changes.

## Edge cases the adversarial verifier must try
- Code containing `</code></pre>`, `<script>`, `&amp;` literally; an info string containing `"><script>`.
- Empty fenced block (copies empty string, shows "Copied"); a 5,000-line block (copy completes < 500 ms).
- Fence inside a list item, a blockquote, a callout (#16) and inside `<details>` (#17).
- Unicode: emoji, RTL text, zero-width joiners, NBSP must round-trip.
- Rapid double-click; copy while a comment popover is open; copy in split view while typing.
- Code block that is also comment-highlighted (`.comment-highlight` adds a negative margin) — toolbar must not overlap.
- Theme switch while "Copied" is showing.

## Dependencies on other items (by number) and files likely touched
- #1 (Locus tokens), #5 (print CSS), #7/#13 (other layouts), #15 (mermaid "Copy source"), #19 (export strips toolbar).
- Files (00 §4): new `src/markdown/codeBlock.ts` (fence/code_block wrapper, registered in `useMarkdown.ts`), new
  `src/preview/codeCopy.ts` enhancer (delegated click handler, live region), `src/styles/preview.css`,
  `tests/composables/useMarkdown.test.ts`.
