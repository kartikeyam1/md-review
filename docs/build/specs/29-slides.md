# 29 — Slides view (`?view=slides`)

## Goal
Present any markdown doc as a deck without reformatting it: each H2 becomes a slide, with keyboard/tap navigation, fullscreen,
a scaled 16:9 canvas and one-slide-per-page printing. Agent-written status docs become meeting-ready from the share link.

## Scope / Out of scope
In scope: slide splitting rules, the slides viewer (canvas, navigation, counter, progress, fullscreen, notes panel, exit),
deep link to a slide, theme-aware styling (branded Locus title slide), rendering of mermaid/code/tables/callouts inside slides,
print one slide per page, entry button.
Out of scope: transitions/animations, slide overview grid, incremental bullet reveals, presenter-remote sync across devices,
slides for HTML docs, editing in slides view, per-slide layouts/backgrounds from markup.

## Current state
- Rendering is a single continuous `v-html` of `renderHtml(content)` (`src/components/PreviewPane.vue:51,404-410`); there is no
  view concept and no slide splitting (`src/composables/useMarkdown.ts:186-192`).
- Headings get ids in a core rule over the full token stream (`useMarkdown.ts:70-91`); block tokens carry `data-line-start/end`
  (`useMarkdown.ts:95-131`), so token `level`/`map` are available to split at top-level `heading_open h1/h2` and `hr`.
- Front matter is turned into a table before rendering (`useMarkdown.ts:134-160,186-190`).
- Mermaid is lazy-loaded and run over `.mermaid` nodes in the container, theme `dark|neutral` (`PreviewPane.vue:17-32,221-240`);
  it re-renders on theme change (`PreviewPane.vue:242-250`). Mermaid cannot lay out inside `display:none` elements.
- The app shell renders `PreviewPane` only when `paneMode === 'preview'` (`src/App.vue:716-717`); view routing (`?view=`) comes from #4.
- No `@media print`, no fullscreen code, no global keydown handler except Ctrl/Cmd+S (`App.vue:247-252`).

## Behaviour
1. **Entry.** For markdown docs a `Present` button `slides-enter-btn` sits in the reader header right group (after the view toggle,
   before `share-btn`; in the overflow menu below 1100px — 00 §2.2), for viewers and editors; it sets `view=slides` with
   `replaceState` (00 §1.3; other params kept, fragment dropped). Visiting a URL with `view=slides` opens the viewer directly. HTML docs: no button, and
   `view=slides` falls back to `read` (URL rewritten via `replaceState`).
2. **Splitting** (on the #28 human-view token stream, top-level tokens only, i.e. `level === 0`): a new slide starts at every `#` H1,
   every `##` H2, and every thematic break (`---`, `***`, `___`). H3–H6, and H1/H2/`---` nested in lists/blockquotes, never split.
   Setext headings count as headings (a `Text` line underlined with `---` is an H2, not a break). The `hr` itself is not rendered.
3. Content before the first boundary forms the first slide. Slides with no visible content (only whitespace, an `hr`, or removed
   agent/notes sections) are **dropped**, so `---` placed right before `## X` does not create blank slides.
4. A slide that starts with an H1 is a **title slide** (`data-slide-kind="title"`): content vertically and horizontally centred, H1 large.
   All other slides are `data-slide-kind="content"`: heading at top-left, body below. Front matter is not shown in slides.
5. Agent-only sections (#28) never appear in slides. **Speaker notes**: lines between `<!-- notes -->` and `<!-- /notes -->` (same marker
   grammar/rules as #28 rules 1–3) are removed from the slide canvas and attached to the slide that contains them. In read/agent views,
   notes render as ordinary content.
6. **Canvas.** Each slide is a 1280×720 logical canvas scaled uniformly (`transform: scale(k)`, k = min(vw/1280, vh_available/720))
   and centred; the remaining area is letterbox using `--bg-page`. Text, code, tables and diagrams scale with the canvas.
7. **Fit.** If a slide's content exceeds the canvas, its font size steps down to no less than 70% of base; if it still overflows, the
   slide body scrolls vertically inside the canvas (canvas size is never exceeded). Wide tables/code scroll horizontally inside the slide.
8. **Rendering parity.** Inside slides: code blocks are highlighted and keep the copy button (#14); tables, task lists, images, callouts (#16)
   render as in read view; collapsible sections (#17) are rendered expanded with no fold controls; mermaid renders as an SVG whenever its
   slide is shown (never raw source or an error) and re-renders on theme change; a click on a zoom trigger (#15) opens the zoom viewer.
9. **Navigation keys** (ignored when focus is in an input/textarea/contenteditable — and `Space`/`Enter` also when focus is on a link or button, which activate it instead — when Ctrl/Meta/Alt is held, or while the zoom
   viewer #15 is open): next = `→`, `↓`, `Space`, `PageDown`, `Enter`; previous = `←`, `↑`, `Shift+Space`, `PageUp`, `Backspace`;
   `Home` = first, `End` = last. Navigation clamps at the ends (no wrap). Default browser scrolling for these keys is prevented.
10. **Pointer.** Click/tap in the right half of the canvas = next, left half = previous — except on links, buttons, inputs, zoom triggers,
    code blocks, or when the click ended a text selection. Horizontal swipe (|dx| ≥ 50px and |dx| > 1.5·|dy|) left = next, right = previous.
    Visible buttons `slides-prev` / `slides-next` (disabled at the ends) with `aria-label`s.
11. **Chrome.** Counter `slides-counter` shows `current / total` (1-based). Progress bar `slides-progress` has width = current/total of the
    viewport width and `aria-valuenow/aria-valuemax`. App header, sidebars, banners and comment UI are hidden in slides view. Chrome
    auto-hides after 3s without pointer movement in fullscreen and reappears on movement.
12. **Deep link.** The current slide is `?view=slides&slide=N` (1-based). Every navigation updates `slide` with `history.replaceState`
    (no history entries). Missing/invalid/non-integer `slide` → 1; out of range → clamped. If no `slide` param but a fragment `#id`
    names a heading, the viewer opens on the slide containing it; the fragment is then dropped on the first navigation.
    The fragment is never used for slide numbers (conventions: fragment = heading id).
13. **Fullscreen.** `F` (or button `slides-fullscreen-btn`) toggles fullscreen on the slides root. `Esc` while fullscreen only exits
    fullscreen (browser behaviour). When fullscreen is unavailable the button is hidden and `F` does nothing.
14. **Exit.** `Esc` when not fullscreen, or button `slides-exit`, leaves slides view: `view` is removed (back to read), `slide` removed,
    and the read view scrolls to the current slide's heading (URL fragment set to its id when the slide has a heading).
15. **Notes panel.** `N` or button `slides-notes-btn` toggles `slides-notes` (below the canvas, outside the 16:9 area, shrinking the
    available height; hidden by default; state remembered in localStorage key `md-review-slides-notes` = `"1"`/absent, try/catch). It shows the current slide's notes rendered as
    markdown, or `No notes for this slide.`
16. **Theme.** Slides use the active theme's tokens. Title slides use `--slide-title-bg` / `--slide-title-fg`: in `locus-light` and
    `locus-dark` these are `#280A38` / `#FFFFFF` (title H1 in Montserrat); default and GitHub themes use `--bg-surface` / `--text-primary`.
    Locus content slides use the #1 Locus tokens (light: white canvas on `#F3F0EB` letterbox).
17. **Phone.** At 390×844 (portrait) the canvas fills the width, letterboxed vertically, and a dismissible hint `slides-rotate-hint`
    ("Rotate for a larger slide") shows on the first slide only for coarse pointers. Landscape phones fill the height.
18. **Print** (rules scoped under `.app[data-view=slides]`; #5's read-view print rules exclude that scope — 00 §10.2). Printing from slides view outputs every slide, one per page (`@page { size: 13.333in 7.5in; margin: 0 }`,
    `break-after: page` on every slide but the last), canvas unscaled to the page, no chrome, no notes, no hint, backgrounds printed (`print-color-adjust: exact`).
19. **Live updates.** If the doc changes (polling sync) while presenting, slides recompute; the current index is kept (clamped).
20. **A11y.** The visible slide is `role="group"` `aria-roledescription="slide"` `aria-label="Slide N of T"`; a polite live region
    announces `Slide N of T: <heading>` on change. Only the current slide is in the accessibility tree / tab order.

## Acceptance criteria
AC-29.1 Given a doc `# T` + intro, `## A`, `## B`, `## C` When opened with `?view=slides` Then 4 slides exist, slide 1 has `data-slide-kind="title"` and `slides-counter` reads `1 / 4`.   [verify: e2e]
AC-29.2 Given `## A … --- … ## B` and a `---` directly before `## B` with nothing between Then `## A` content splits into 2 slides at the first `---` and no empty slide exists; a setext `B\n---` heading is a slide title, not a break.   [verify: unit]
AC-29.3 Given a `---` inside a blockquote and `## X` inside a list item Then neither creates a slide.   [verify: unit]
AC-29.4 Given slide 1 When pressing `→`, `Space`, `PageDown`, `↓`, `Enter` in turn Then the counter advances each time and clamps at `T / T`; `Home` → `1 / T`, `End` → `T / T`; `←`/`PageUp`/`Shift+Space`/`Backspace` go back; `Ctrl+→` does nothing.   [verify: e2e]
AC-29.5 Given navigation to slide 3 Then the URL has `view=slides&slide=3` and `history.length` is unchanged; reloading opens slide 3; `slide=99` opens the last; `slide=abc` opens 1.   [verify: e2e]
AC-29.6 Given `?view=slides#b` where `b` is `## B`'s id Then the viewer opens on B's slide.   [verify: e2e]
AC-29.7 Given desktop 1400×900 and phone 390×844 Then the visible canvas bounding box has aspect 16:9 (±1%), is centred, and fits inside the viewport; at phone width `slides-rotate-hint` is visible on slide 1 (coarse pointer).   [verify: e2e]
AC-29.8 Given a slide with 60 bullet lines Then the canvas size is unchanged and its body is scrollable (`scrollHeight > clientHeight`); a 5-line slide is not scrollable.   [verify: e2e]
AC-29.9 Given slides containing a mermaid diagram (not on slide 1), a highlighted code block, a table and a `> [!WARNING]` callout When each slide is shown Then the mermaid is an `<svg>`, code has hljs spans and `code-copy-btn`, the table is a `<table>`, the callout has the #16 callout markup.   [verify: e2e]
AC-29.10 Given a tap at 75% of canvas width Then next slide; at 25% Then previous; a click on a link or `zoom-trigger` does not change slide; a 100px left swipe on phone advances.   [verify: e2e]
AC-29.11 Given slides view When `Esc` is pressed (not fullscreen) Then the URL has no `view`/`slide`, the read view is shown and the current slide's heading is in the viewport. `slides-exit` does the same.   [verify: e2e]
AC-29.12 Given `F` Then `document.fullscreenElement` is the slides root; `F` again exits; while fullscreen, `Esc` exits fullscreen but stays in slides view.   [verify: e2e]
AC-29.13 Given a slide containing the three lines `<!-- notes -->`, `Say hi`, `<!-- /notes -->` Then "Say hi" is not in the canvas; `N` shows `slides-notes` containing "Say hi"; a slide without notes shows `No notes for this slide.`; in read view "Say hi" is visible.   [verify: e2e]
AC-29.14 Given a doc with an agent-only section (#28) inside `## A` Then its text appears on no slide and in no notes panel.   [verify: e2e]
AC-29.15 Given `locus-light` and `locus-dark` Then the title slide's computed background is `rgb(40, 10, 56)` and H1 colour `rgb(255, 255, 255)`; in `light` the title slide background equals `--bg-surface`.   [verify: visual]
AC-29.16 Given print emulation in slides view of a 4-slide doc Then 4 slide elements are displayed, each but the last with `break-after: page` (the last `auto`: a forced break after the final slide prints a blank extra page in Chromium — DECISIONS #29), the PDF has exactly 4 pages, and `slides-counter`, `slides-progress`, `slides-notes`, header are `display: none`.   [verify: e2e]
AC-29.17 Given an HTML doc with `?view=slides` Then the URL is rewritten without `view=slides`, the iframe preview shows, and `slides-enter-btn` is absent.   [verify: e2e]
AC-29.18 Given a doc with no headings Then exactly 1 slide is shown with counter `1 / 1` and `slides-prev`/`slides-next` disabled.   [verify: e2e]
AC-29.19 Given slides view at desktop Then axe reports no serious violations and the current slide has `aria-label="Slide 1 of T"`.   [verify: a11y]

## Test hooks (data-testid list) and API/MCP contract changes
Testids: `slides-enter-btn`, `slides-root`, `slides-slide` (with `data-slide-index` 0-based, `data-slide-kind`), `slides-canvas`,
`slides-counter`, `slides-progress`, `slides-prev`, `slides-next`, `slides-fullscreen-btn`, `slides-notes-btn`, `slides-notes`,
`slides-exit`, `slides-rotate-hint`. Reused: `code-copy-btn` (#14), `zoom-trigger` (#15). URL params: `view=slides`, `slide=N`.
Exported pure splitter (e.g. `splitSlides(src) -> {kind, startLine, headingId, html, notesHtml}[]`) for unit tests. No API/MCP changes.

## Edge cases the adversarial verifier must try
Doc that is only front matter; doc starting with `## A` (no H1); two H1s (two title slides); H1 not at the top (preceding content is its own
slide); `***`/`___` breaks; `---` inside a fenced code block; consecutive `---`; a slide whose only content is a notes block (dropped);
very long code line; 20-column table; mermaid on the last slide reached via `End`; theme toggle while on a mermaid slide; resize window mid-deck;
rapid key repeat (holding `→`); `Space` while a link is focused; zoom viewer open then `→` (no slide change) then `Esc` (closes zoom only);
`?view=slides&slide=0` and `slide=-2`; text selection drag on a slide (no navigation); live doc update removing the current slide; `?embed=1&view=slides`;
review-mode doc (no comment UI in slides); browser Back after entering slides leaves the doc entirely (view changes use `replaceState`,
00 §1.3 — Esc/`slides-exit` is the way back to read view); Esc while the zoom viewer is open (00 §3.4 layering).

## Dependencies on other items (by number) and files likely touched
Depends on #4 (`view` param/routing), #28 (human-view stream, marker grammar for `notes`), #1 (Locus tokens/fonts), #14, #15, #16, #17
(rendering inside slides), #5 (print CSS must not fight slides print). Files: new `src/components/SlidesView.vue`, new
`src/composables/useSlides.ts`, `src/composables/useMarkdown.ts` (token-level split), `src/App.vue` (view switch, entry button,
hide chrome), `src/style.css` (`--slide-title-*` tokens, print), tests in `tests/composables/useSlides.test.ts`, `tests/e2e/`.

## Decisions
- `---` also splits (reveal.js/Marp habit), but empty slides are dropped so decorative rules before H2s are harmless.
- H1 = title slide; every H1 starts one (multi-part decks work).
- Slide deep link uses `?slide=N` with `replaceState`, keeping the fragment reserved for heading ids per conventions.
- Speaker notes use an explicit `<!-- notes -->` marker (reusing #28's grammar) rather than reveal's `Note:` prefix, which would silently
  swallow ordinary "Note: …" paragraphs in agent-written docs; agent-only sections are not notes (they are evidence, often huge).
- Fixed 1280×720 logical canvas scaled by transform gives identical layout on every screen and makes print deterministic.
- Overflow shrinks to 70% then scrolls, rather than clipping — no content is ever lost in a presentation.
- Esc exits fullscreen first (browser-owned), then exits slides; back-button history is not polluted by slide steps.
