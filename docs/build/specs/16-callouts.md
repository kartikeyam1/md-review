# 16 — Callouts (GitHub alerts) and RAG status badges

## Goal
Status docs and design docs need to flag "this is a risk", "decision needed", "on track". Support GitHub's
alert syntax so agent-written markdown renders the same as on GitHub, and an inline RAG badge for
red/amber/green status that leadership can scan at a glance.

## Scope / Out of scope
- In scope: markdown rendering (`useMarkdown`) of `> [!TYPE]` blockquotes and `:rag-<colour>[label]` inline
  syntax; styling in all six themes; inclusion in the #19 HTML export.
- Out of scope: inserting the syntax (slash menu, #12 — it must emit exactly the syntax defined here);
  foldable Obsidian callouts (`[!NOTE]-`/`+`); HTML documents; RAG roll-ups/dashboards.

## Current state
- markdown-it is configured in `src/composables/useMarkdown.ts:166-182` (`html: true`, `typographer: true`)
  with only `headingAnchorPlugin`, `lineDataPlugin`, `taskLists`. Blockquotes render as plain `<blockquote>`
  with `data-line-start/end` added by `renderToken` (`useMarkdown.ts:87-95`); `[!NOTE]` shows as literal text today.
- Non-GitHub blockquote style: `PreviewPane.vue:510-515` (3px left border, muted text). GitHub themes use
  `github-markdown-css` (`useTheme.ts:2-3`), which **already ships** `.markdown-alert`, `.markdown-alert-{note,tip,
  important,warning,caution}` and `.markdown-alert-title` rules (verified in
  `node_modules/github-markdown-css/github-markdown-light.css`).
- Comment highlighting uses leaf elements with `data-line-*` (`PreviewPane.vue:200-224`).

## Behaviour
### Callouts
1. A blockquote whose **first line** matches `^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$`
   (type case-insensitive, optional leading spaces inside the quote) is a callout. The rest of the blockquote
   (following lines and paragraphs) is its body, rendered as normal markdown (lists, code, tables, nested quotes,
   links, RAG badges).
2. Optional custom title: any text after the marker on the same line becomes the title (inline markdown allowed,
   e.g. `> [!WARNING] **Data loss** risk`). Without it the title is the default: Note, Tip, Important, Warning,
   Caution.
3. Markup (GitHub-compatible, so GitHub themes are styled by `github-markdown-css` with no extra CSS):
   ```html
   <div class="markdown-alert markdown-alert-warning callout" data-callout="warning"
        data-testid="callout" data-line-start="…" data-line-end="…">
     <p class="markdown-alert-title" data-testid="callout-title"><svg class="octicon" aria-hidden="true" …></svg>Warning</p>
     …body…
   </div>
   ```
   The wrapper carries the blockquote's line range; body paragraphs keep their own line ranges. The marker text
   `[!WARNING]` never appears in the rendered text. Icons are GitHub's octicons (info, light-bulb, report, alert,
   stop) inlined as SVG, `fill="currentColor"`.
4. Not a callout (render as an ordinary blockquote, text unchanged): unknown type (`[!DANGER]`, `[!FOO]`),
   marker not on the first line, marker missing the `!`, marker inside a code span, or the blockquote is lazy-
   continuation text of a paragraph. Nested `> > [!TIP]` makes the inner quote a callout.
5. A callout containing only the marker renders a box with just the title.
6. Colours per type (title + icon + accent): note blue, tip green, important purple, warning amber/yellow,
   caution red. In GitHub themes use GitHub's exact palette (via the stylesheet). In Default `light`/`dark`:
   4px left accent border in the type colour, subtle tinted background, title in type colour.
   In `locus-light`/`locus-dark`: **card style — no edge stripe**: all four borders the same width (1px),
   border-radius ≥ 8px, tinted background, coloured icon + title; colours from Locus tokens (#1).
7. Contrast: title text and body text ≥ 4.5:1 against the callout background in all six themes.
8. Accessibility: the wrapper has `role="note"`; the icon is `aria-hidden="true"`; the type is conveyed by the
   title text (never by colour alone).
9. Print: callouts print with their border and title (backgrounds may drop); no box is split mid-line awkwardly
   (`break-inside: avoid` for callouts shorter than a page).

### RAG badges
10. Inline syntax `:rag-<colour>[<label>]` where colour ∈ {green, amber, red}, case-insensitive (`:RAG-Green[x]` ok).
    Label is plain text up to the first unescaped `]`, max 80 chars, no newline; HTML in it is escaped, markdown in
    it is not parsed. Empty label (`:rag-red[]`) uses the colour name capitalised ("Red").
11. Renders as
    `<span class="rag rag-green" data-rag="green" data-testid="rag-badge"><span class="rag-dot" aria-hidden="true"></span><span class="sr-only">Green: </span>On track</span>`
    — a pill (border-radius ≥ 999px or 50% of height), dot + text, inline with surrounding text, not wrapping
    internally (`white-space: nowrap`).
12. Unknown colours (`:rag-blue[x]`, `:rag-[x]`), a missing `]`, a label > 80 chars, or syntax inside code
    spans/fenced code render as the literal source text, unchanged. `\:rag-green[x]` renders literally as
    `:rag-green[x]`.
13. Works inside paragraphs, headings, table cells, list items and callouts. Inside a link text it
    renders as a badge inside the link.
14. Colours: green / amber / red, readable in all six themes (badge text vs badge background ≥ 4.5:1); amber must
    be distinguishable from red for deuteranopia (the label text carries the meaning, plus distinct lightness).
15. Heading slugs (#3's `headingIds` plugin) are computed from the visible label, not the syntax and not the sr-only
    prefix: `## Status :rag-green[On track]` → id `status-on-track` (and TOC text / `docTitle` "Status On track",
    per #3 rule 2). **This RAG syntax is the single definition** used by #12 (slash menu) and #27 (seed templates).

## Decisions
- Custom titles supported (Obsidian-style) even though GitHub ignores them — agents write them, and on GitHub they
  degrade to the title text appearing in the first body line, which is acceptable.
- Reuse GitHub's `markdown-alert` classes so GitHub themes match github.com exactly for free; `callout` class added
  for our own themes.
- RAG label is plain text (not inline markdown) to keep the parser rule simple and the pill compact.
- Visually-hidden "Green: " prefix gives screen readers the colour; it is part of `textContent` by design.

## Acceptance criteria
AC-16.1 Given `> [!NOTE]\n> Body text` Then output has one `[data-testid=callout][data-callout=note]` with title
  "Note", a `<p>` "Body text", and no literal "[!NOTE]".   [verify: unit]
AC-16.2 Given each of `[!tip]`, `[!Important]`, `[!WARNING]`, `[!caution]` Then `data-callout` is tip/important/
  warning/caution with default titles Tip/Important/Warning/Caution.   [verify: unit]
AC-16.3 Given `> [!WARNING] Data **loss** risk` Then the title text is "Data loss risk" with a `<strong>`.   [verify: unit]
AC-16.4 Given `> [!DANGER]\n> x` and `> Note: [!NOTE]` Then both render as plain `<blockquote>` with the text kept.   [verify: unit]
AC-16.5 Given a callout with a list, a fenced code block and a table Then all render inside the callout and the
  code block has the #14 copy button.   [verify: e2e]
AC-16.6 Given the callout wrapper Then it has `data-line-start`/`data-line-end` equal to the blockquote's source
  range, and commenting on a body line highlights that body element.   [verify: e2e]
AC-16.7 Given theme `locus-light` and `locus-dark` Then a callout's computed `border-left-width` equals
  `border-top-width` (no stripe) and `border-radius` ≥ 8px; given `light` Then `border-left-width` ≥ 3px.   [verify: e2e]
AC-16.8 Given each of the six themes and each of the five types Then title and body contrast ≥ 4.5:1 and the five
  title colours are pairwise distinct.   [verify: visual]
AC-16.9 Given `:rag-green[On track] :rag-AMBER[At risk] :rag-red[]` Then three `rag-badge` spans with `data-rag`
  green/amber/red and visible labels "On track", "At risk", "Red".   [verify: unit]
AC-16.10 Given `:rag-blue[x]`, `` `:rag-green[x]` ``, `\:rag-green[x]` and `:rag-green[unclosed` Then no badge is
  rendered and the visible text is the literal source (minus the escape backslash / code formatting).   [verify: unit]
AC-16.11 Given `:rag-red[<img src=x onerror=alert(1)>]` Then no `<img>` element exists; the text is shown escaped.   [verify: unit]
AC-16.12 Given a badge in a table cell at phone 390×844 Then it does not wrap inside the pill and its computed
  border-radius makes it a pill.   [verify: e2e]
AC-16.13 Given `## Status :rag-green[On track]` Then the heading id is `status-on-track`.   [verify: unit]
AC-16.14 Given the callout Then it has `role="note"` and its svg has `aria-hidden="true"`.   [verify: a11y]

## Test hooks (data-testid list) and API/MCP contract changes
`callout` (+ `data-callout`), `callout-title`, `rag-badge` (+ `data-rag`). No API changes. MCP tool descriptions
for creating docs (`server/mcp-server*.js`) should mention both syntaxes so agents use them (text-only change).

## Edge cases the adversarial verifier must try
- `>[!NOTE]` (no space), `> [!NOTE]   ` (trailing spaces), CRLF line endings, a callout as the very first line of the
  doc and right after frontmatter.
- Callout inside a list item and inside `<details>`; callout containing a mermaid diagram.
- Two consecutive callouts separated by a blank line (two boxes) vs. no blank line (one quote — markdown merges).
- RAG with `]` escaped inside label (`:rag-green[a \] b]`), 80 vs 81 chars, adjacent badges with no space, badge at
  line start (must not be eaten as a definition list / emoji shortcode), in a heading used by the TOC (#3).
- Theme switch with callouts visible; print preview.

## Dependencies on other items (by number) and files likely touched
- #1 (Locus tokens), #12 (slash menu emits `> [!NOTE]` and `:rag-green[On track]` syntax — must match), #3 (TOC text
  for headings containing badges), #14 (code inside callouts), #19 (export inlines callout/badge CSS).
- Files: new `src/markdown/alerts.ts` (core rule) and `src/markdown/rag.ts` (inline rule), registered in
  `useMarkdown.ts` (00 §4.4); `src/styles/preview.css`; `tests/composables/useMarkdown.test.ts`. Lands before #12.
