# 05 — Mobile layout, print CSS, `document.title` from the doc

## Goal
Docs are comfortable to read on a 390px phone (no sideways page scrolling, wide content scrolls in its own
box, header fits), print cleanly to paper/PDF without app chrome or dark backgrounds, and browser tabs,
history and bookmarks show the doc's real title.

## Scope / Out of scope
**In:** responsive breakpoints and layout of read view, header collapse into the overflow menu, comments
drawer on phone, content overflow containment, read-view scroll model, print stylesheet, `docTitle` rule
and `document.title`.
**Out:** TOC drawer details (#3), split-view tabs (#7), reader font size/width controls (#18), PDF/HTML export
(#19), zoom viewer (#15), library phone layout (#26), printing of HTML (iframe) docs beyond hiding chrome.

## Current state
- No `@media` rule exists in `src/` (grep). `.app` is `height: 100vh` flex column (`App.vue:798-803`); the reading
  surface `.preview-pane` scrolls internally (`PreviewPane.vue:410-422`, padding 24px 32px).
- Header is a fixed 52px row with up to ~12 controls and `gap:16px` (`HeaderBar.vue:103-212`, `:217-231`) — it
  overflows at 390px. Comments sidebar has `min-width: 260px` beside the content (`App.vue:892-896`) → horizontal
  page scroll on phones.
- Tables are `width:100%` with no wrapper (`PreviewPane.vue:519-524`) — wide tables push the page; `pre` already
  has `overflow-x:auto` (`:479-486`); images `max-width:100%` only in non-GitHub themes (`:665-670`).
- `index.html:6` `<title>MD Review</title>`; nothing ever sets `document.title`.
- Front matter is parsed into a table (`useMarkdown.ts:135-165`), not exposed as data.
- No print styles (`#14` notes the same); the 100vh + internal scroll layout would print only one screen.

## Behaviour
### Breakpoints and scroll model
1. Breakpoints by viewport width: **phone** < 641px, **tablet** 641–1099px, **desktop** ≥ 1100px.
2. **Read view uses document scroll** at every width: the page (`document.scrollingElement`) scrolls; the header
   is `position: sticky; top: 0`. App height uses `min-height: 100dvh` (fallback `100vh`). Edit/split views keep
   the fixed-viewport layout with internal panes.
3. **No horizontal page scroll**: at 390×844, 820×1180 and 1400×900, for every fixture in rule 5,
   `document.documentElement.scrollWidth <= window.innerWidth`.
4. Read content column: centred, `max-width: 50em` of the preview font size (= #18's default `narrow` width; #18
   later adds the Narrow/Wide control and owns the value), side padding 16px on phone, 24px tablet, 32px desktop.
   Body text ≥ 16px on phone. **e2e impact:** this replaces today's full-width preview at desktop (00 §11).
5. **Overflow containment** (markdown):
   - Every rendered `<table>` is wrapped in `<div class="table-scroll" data-testid="table-scroll" tabindex="0"
     role="region" aria-label="Table">` with `overflow-x: auto`; the wrapper carries no `data-line-*`.
   - `pre` scrolls horizontally inside itself (unchanged); `code` inside paragraphs may break anywhere.
   - Paragraphs, list items, headings, table cells, blockquotes: `overflow-wrap: anywhere` (long URLs/hashes wrap).
   - `img`, `video`, mermaid `svg`: `max-width: 100%; height: auto` in all themes.
   - Front-matter table behaves like any table (wrapped).
   - HTML docs: the iframe is `width: 100%` of the viewport and fills the remaining height.
6. **Header** never wraps to a second line and never overflows its width. The per-width placement of every control
   (desktop / tablet / phone, bar vs overflow menu) is the canonical table in **00 §2.2–2.3**; this item implements the
   tablet and phone columns. Summary:
   - Tablet: `nav-library` and `app-home-link` collapse to icons; `copy-link-btn` icon-only; `slides-enter-btn`,
     `download-menu-btn` and `reviewer-name` move to the overflow menu.
   - Phone: visible, left→right: `toc-toggle` (when #3 shows a TOC), `doc-title` (flex: 1, ellipsis),
     view toggle (editors; icon-only segments with `aria-label`s), `theme-toggle`, `theme-style-menu` (#1 requires
     both visible), `header-overflow-btn`. Everything else moves into `header-overflow-menu` as items with the same
     testids (00 §2.3).
   - Below 1100px (tablet **and** phone) `doc-updated`, `doc-local-badge`, `doc-mode-badge` (and #25's `view-stats`)
     render on a slim second row **below** the header bar (`doc-meta-row`), not in it.
   - All header controls on phone have a ≥ 40×40px hit area.
7. **Overflow menu on phone** opens as a full-width sheet anchored under the header (`header-overflow-menu`),
   max-height 70dvh with internal scroll; closes on item click, Esc, outside tap.
8. **Comments on phone/tablet** (review mode): no side rail and no 16px toggle strip below 1100px. A
   `comments-toggle` button ("Comments · N") is fixed at bottom-right; it opens `comments-drawer`, a bottom sheet
   (max-height 80dvh) containing the existing sidebar content; Esc/backdrop/close button `comments-drawer-close`
   closes it. Selecting text still raises the comment action bar, positioned inside the viewport.
9. Banners (approval, summary, changes, conflict, notice) wrap their text and stack their buttons below the
   text on phone; none exceeds the viewport width.
10. Modals (share, history, prompt) fit at 390px: `width: min(100vw - 32px, <desktop width>)`, internal scroll.

### Print (`@media print`)
11. Hidden (`display: none`): header, `doc-meta-row`, TOC (rail/toggle/drawer), comments sidebar/toggle/drawer,
    selection bar, popover, approval/summary/changes/conflict/notice banners, toasts, modals, `heading-anchor`,
    code toolbars (#14), editor panes, `embed-open-link`, any `button` inside the content area.
12. Layout: content column full width of the page box, no max-height/overflow anywhere (the whole doc prints,
    not one screen); `.table-scroll` and `pre` get `overflow: visible`; `pre` wraps (`white-space: pre-wrap`).
13. **Light palette forced** regardless of theme (all 6): page and content background `#fff`, body text
    `#1a1a1a` (or darker), links `#0645ad`-ish dark blue (any colour with ≥ 4.5:1 on white), code background a
    light grey, borders light grey; `html.dark`, GitHub-dark `.markdown-body` and Locus-dark tokens are overridden.
    Mermaid diagrams are re-rendered with the light theme on `beforeprint` (and restored on `afterprint`) when the
    current theme is dark.
14. Page breaks: `break-inside: avoid` on `pre`, `tr`, `img`, `.mermaid`, `blockquote`, `.table-scroll thead`;
    `break-after: avoid` on `h1–h6`; `thead { display: table-header-group }` (header repeats per page).
15. Links show their target: `a[href]` whose href is absolute `http(s):` gets `::after { content: " (" attr(href) ")" }`
    in a smaller muted style — except in-doc `#` links, `mailto:`, and links whose visible text equals the href
    (markdown autolinks; the renderer marks them with class `autolink`).
16. HTML docs: chrome hidden per rule 11; the iframe prints as the browser allows (known limitation; #19 owns
    proper export).

### Document title
17. **`docTitle`** — the single FE+server rule is **00 §5** (this item owns the FE implementation
    `src/composables/useDocTitle.ts`; also used by #2's `doc-title`, #19, #22, #26, #27):
    `sessionName` > markdown front-matter `title:` (quotes stripped) / HTML `<title>` (parsed with `DOMParser`, never
    executed) > plain text of the first **human-visible** H1 (#3 rule 2 semantics, implemented here as
    `src/markdown/plainText.ts`; agent sections excluded per #28) / HTML first `<h1>` > filename without a trailing
    `.md|.markdown|.txt|.html|.htm` > `Untitled`. Whitespace collapsed to single spaces; for `document.title` and
    `doc-title` truncated to 80 characters with a trailing `…`.
18. `document.title` = `${docTitle} · md-review` whenever a doc is open (read, edit, split, pinned revision — pinned
    adds nothing extra). Landing page: `md-review`. Library: `Library · md-review`. Not found: `Not found · md-review`.
    It updates within 1 s of the H1/front-matter changing (edit or poll) and when navigating between docs (#4).
19. `index.html` (and therefore `404.html`) static `<title>` is `md-review`.

### Absolute source line numbers (moved here from #7 rule 12 — this item owns the fix)
20. Preview `data-line-start`/`data-line-end` refer to lines of the **full** source including any front matter: the
    front-matter table spans `0..endLine`; every body block is offset by `endLine` (fixes `useMarkdown.ts:186-192`,
    where `fm.body` is rendered with body-relative lines). Comment highlighting, scroll-to-line, #7 sync, #16 callout
    ranges and #28 line fidelity all rely on this.
21. **Structure** (00 §4.4): this item creates `src/markdown/` (one file per plugin, registered from one list in
    `useMarkdown.ts`) with `tableScroll.ts` (rule 5 wrapper), `autolink.ts` (rule 15 class), `plainText.ts` and the
    front-matter title/offset handling.

## Acceptance criteria
AC-05.1 Given a fixture with a 12-column table, a 400-char code line, a 300-char unbroken URL, a 2000px-wide image and a wide mermaid flowchart, at 390×844, 820×1180 and 1400×900 Then `document.documentElement.scrollWidth <= innerWidth` in read view.   [verify: e2e]
AC-05.2 Given that fixture at 390×844 Then the table is inside a `table-scroll` whose `scrollWidth > clientWidth`, and scrolling it horizontally does not move the page (`scrollX` stays 0).   [verify: e2e]
AC-05.3 Given a shared doc opened by an editor at 390×844 Then the header bar height ≤ 56px, all its visible children are inside the viewport, `theme-toggle`, `theme-style-menu` and `header-overflow-btn` are visible, and `copy-link-btn` is reachable only inside `header-overflow-menu`.   [verify: e2e]
AC-05.4 Given 390×844 Then every visible header control's bounding box is ≥ 40×40.   [verify: e2e]
AC-05.5 Given a review doc at 390×844 Then no `.sidebar` is visible beside the content; `comments-toggle` shows the count; tapping it opens `comments-drawer` listing the comments; Esc closes it.   [verify: e2e]
AC-05.6 Given read view at 1400×900 and a long doc When scrolled Then `window.scrollY > 0` (document scroll) and the header's `getBoundingClientRect().top` is 0.   [verify: e2e]
AC-05.7 Given print emulation (`page.emulateMedia({media:'print'})`) on a review doc with TOC, comments and a code block Then header, `toc-panel`, `.sidebar`, `.approval-banner`, `.summary-panel`, `heading-anchor` and `code-toolbar` have computed `display: none`.   [verify: e2e]
AC-05.8 Given print emulation with theme `dark`, `github-dark` and `locus-dark` Then the content background computes to rgb(255,255,255), paragraph text luminance contrast vs white ≥ 7:1, and a mermaid diagram's svg background is light.   [verify: e2e]
AC-05.9 Given print emulation and a link `[spec](https://ex.com/a)` Then its `::after` content is ` (https://ex.com/a)`; an autolink `https://ex.com/b` and a `#intro` link have `::after` content `none`/empty.   [verify: e2e]
AC-05.10 Given print emulation Then `pre`, `tr`, `img` compute `break-inside: avoid`, headings `break-after: avoid`, `pre` computes `white-space: pre-wrap`, and no ancestor of the content has a computed `overflow` other than `visible` or a fixed `height`.   [verify: e2e]
AC-05.11 Given `page.pdf()` of a 5-page fixture in dark theme Then the PDF has ≥ 5 pages (whole doc printed) and contains the text of the last paragraph.   [verify: e2e]
AC-05.12 Given markdown with no `sessionName` (e.g. a `?filePath=` fixture or local file), front matter `title: "Q3 Plan"` and `# Something else` Then `document.title` is `Q3 Plan · md-review`; without front matter it is `Something else · md-review`; with no H1 and filename `notes.md` it is `notes · md-review`.   [verify: e2e]
AC-05.13 Given an H1 `# **Launch** [plan](http://x) 🚀` Then `document.title` is `Launch plan 🚀 · md-review` and `doc-title` text is `Launch plan 🚀`.   [verify: unit]
AC-05.14 Given an HTML doc with `<title>Board deck</title>` Then `document.title` is `Board deck · md-review`; the HTML's scripts are not executed by the title parser (a `<script>` that sets `window.parent.x` leaves no trace).   [verify: e2e]
AC-05.15 Given the landing page, `/library` and `/nope` Then titles are `md-review`, `Library · md-review`, `Not found · md-review`; navigating doc A → doc B updates the title to B's.   [verify: e2e]
AC-05.16 Given a doc without `sessionName` or front-matter title When an editor changes the H1 in edit view Then within 1 s `document.title` reflects the new text; given a shared doc with `sessionName` "Q3 review" Then `document.title` is `Q3 review · md-review` regardless of its H1.   [verify: e2e]
AC-05.17 Given a 120-char H1 Then `document.title` starts with its first 80 chars followed by `… · md-review`.   [verify: unit]
AC-05.18 Given 390×844 Then axe reports no `target-size`/reflow violations in the header and the overflow menu is keyboard operable.   [verify: a11y]
AC-05.19 Given a doc beginning with a 4-line front-matter block (`---`,`a: 1`,`b: 2`,`---`) followed by `# Title` on source line 4 Then the rendered `h1` has `data-line-start="4"`, a paragraph on source line 6 has `data-line-start="6"`, and a comment anchored to line 4 highlights the `h1`.   [verify: unit + e2e]
AC-05.20 Given 820×1180 Then `doc-meta-row` is visible below the header bar containing `doc-updated`, and `download-menu-btn` (when #19 has landed) is reachable only via `header-overflow-menu`.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
`table-scroll`, `doc-meta-row`, `comments-toggle`, `comments-drawer`, `comments-drawer-close`; reuses `header-overflow-btn`,
`header-overflow-menu`, `copy-link-btn`, `share-btn`, `nav-library`, `app-home-link`, `doc-title`, `doc-updated` (#2),
`toc-toggle` (#3), `theme-toggle`, `theme-style-menu` (#1), `code-toolbar` (#14). Class `autolink` on linkified URLs.
No API/MCP changes (`sessionName` is already in the payload).

## Edge cases the adversarial verifier must try
- Landscape phone 844×390; 320px width; browser zoom 200% at 1400px (reflow, no horizontal scroll).
- Nested table inside a list inside a blockquote; table with a 500-char cell and no spaces.
- Long filename / title with no spaces in the phone header (ellipsis, no overflow).
- Comment action bar near the right edge at 390px stays fully on screen.
- Print while the overflow menu, TOC drawer or a modal is open (none of them print).
- Print in each of the 6 themes, and print of a doc with an open `<details>`.
- Front matter with `title:` empty, `title: 'single quoted'`, `title: a: b` (value `a: b`); H1 consisting only of an image (`alt` used).
- HTML doc with `<title>` inside an SVG or a comment only; HTML with no `<head>`.

## Dependencies on other items (by number) and files likely touched
Builds on #2 (header contents, `docTitle` consumer) and #1 (theme switcher must stay visible on phone). Lands **before**
#3: #3 adds its own TOC drawer/print rules and `toc-toggle` slot on top of this item's scroll model and header height.
Print ACs here assert only elements that exist when this item lands; #3/#14/#17 add print ACs for their own controls.
#18 (content width control), #19 (export reuses print CSS), #22/#26 (same `docTitle` rule, 00 §5). Moving read view to document scroll affects `scrollToLine` in `PreviewPane.vue` and the
comment action bar coordinates (fixed vs absolute).
Files: `src/style.css` (breakpoints, print), `src/styles/preview.css`, `src/components/DocView.vue`, `src/components/DocHeader.vue` +
`HeaderOverflowMenu.vue` (tablet/phone placement, `doc-meta-row`), `src/components/PreviewPane.vue` (scroll model),
`src/components/CommentsSidebar.vue`, `src/composables/useMarkdown.ts` (register plugins; front-matter offset + title), new
`src/markdown/` (`tableScroll.ts`, `autolink.ts`, `plainText.ts`), new `src/composables/useDocTitle.ts`, modal components, `index.html`.

## Decisions
- Read view switches to document scroll: native anchor offsets, mobile browser-bar collapse, find-in-page and printing all
  work without per-feature hacks; editing views keep the fixed layout they need.
- `sessionName` wins over front matter and H1 (reconciled in 00 §5 with #22/#26): it is the deliberate human name set
  by agents/templates, and the tab, library row and unfurl must agree.
- Extension stripped from filename titles: `notes` reads better in a tab than `notes.md`.
- Mermaid re-rendered light for print instead of inverted with filters: filters distort brand colours.
- Theme switcher stays visible on phone (required by #01's AC-01.14); copy-link moves to the menu.
