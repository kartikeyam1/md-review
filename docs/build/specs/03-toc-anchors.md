# 03 — Sticky TOC + copy-link per heading

## Goal
Long agent-written docs become navigable: a sticky table of contents that tracks where you are, and a
one-click "copy link to this section" on every heading that produces a URL which opens the doc at that
section — on desktop and on a phone.

## Scope / Out of scope
**In:** heading id generation (incl. unicode, duplicates, empty), TOC contents and levels, desktop rail,
tablet/phone drawer, active-section highlight, collapse preference, heading copy-link buttons, scroll
offset under the sticky header, print/edit behaviour of these controls.
**Out:** routing and fragment handling on load/Back (#4); collapsible sections (#17, which will reuse these
ids); TOC for HTML (iframe) docs; custom `{#id}` heading syntax; agent-view filtering (#28 removes hidden
sections before the TOC is built).

## Current state
- `useMarkdown.ts:69-91` `headingAnchorPlugin` sets ids from the **raw** inline source:
  `[^\w\s-]` strips every non-ASCII letter (`Über café` → `ber-caf`, CJK → empty id `""`), link URLs leak into
  the slug (`[Docs](http://a.b)` → `docshttpab`), runs of spaces collapse, and duplicates get `-1`, `-2` without
  checking collisions with real `x-1` headings. Empty ids are emitted as `id=""`.
- No TOC, no heading link affordance, no toast component (`app-toast` is built by #2, 00 §3.1).
- Reading surface is `.preview-pane` (`PreviewPane.vue:410-422`), an internally scrolling box inside a
  `100vh` app (`App.vue:798-803`); #5 moves read view to document scroll — this spec assumes #5's model.
- In-doc `#anchor` clicks currently clobber the `#shared=` fragment (see #4).

## Behaviour
### Heading ids
1. Every markdown heading token (`heading_open`, levels 1–6, including headings inside blockquotes/lists)
   gets an `id`. Raw-HTML headings (`<h2 id="x">` in html blocks) keep their own attributes and are not ids
   managed here and not TOC entries.
2. **Source text** = the heading's rendered plain text, computed from **tokens** (never DOM `textContent`, 00 §2.5):
   text and `code_inline` content; link *text* (never the URL); image `alt`; inline HTML tags removed; entities
   decoded (`&amp;` → `&`); a RAG badge (#16) contributes its visible label only (never the sr-only "Green: ");
   then trimmed. This helper (`src/markdown/plainText.ts`) is implemented by #5, which lands first and uses it
   for `docTitle`; these semantics are normative for it.
3. **Slug** (GitHub-compatible, equals `github-slugger` v2 output): lower-case; remove every character that is
   not a Unicode letter, mark, number, connector punctuation (`_`), hyphen `-` or space; then replace **each**
   space with `-` (no collapsing, no trimming of hyphens).
4. **Empty** slug → `section`.
5. **Duplicates**: the first occurrence keeps the slug; later ones get `-1`, `-2`, … choosing the first suffix
   not already used by any earlier id in the doc (so `Dup`, `Dup-1`, `Dup` → `dup`, `dup-1`, `dup-2`).
6. Ids are deterministic for a given source (re-render, poll update and reload give the same ids). They are
   assigned over the **full** source, agent-only sections included (#28 rule 8), so an id never differs between
   human and agent view. Implemented as the `src/markdown/headingIds.ts` plugin (00 §4.4).
7. Examples (unit-tested, exported as `slugify`/`assignIds` or equivalent):

   | Heading source | id |
   |---|---|
   | `Hello World` | `hello-world` |
   | `Über café` | `über-café` |
   | `日本語の見出し` | `日本語の見出し` |
   | `What's new?` | `whats-new` |
   | `C++ & Rust` | `c--rust` |
   | `**Bold** and *em*` | `bold-and-em` |
   | `` `npm run` it `` | `npm-run-it` |
   | `[Docs](https://x.io/a) here` | `docs-here` |
   | `🚀 Launch` | `-launch` |
   | `!!!` | `section` |
   | `Dup` / `Dup` / `Dup` | `dup` / `dup-1` / `dup-2` |

### TOC
8. **Entries**: headings of level 1–3 in document order, except that when the doc has exactly one H1 and it is
   the first heading, that H1 is omitted (it is the title). Text = rule-2 plain text. Indentation by level
   relative to the shallowest listed level (max 3 levels).
9. **Visibility**: rendered only in **read view** of **markdown** docs with **≥ 2 entries**. Never in edit view,
   for HTML docs, on the landing/library pages, or in `?embed=1`. With < 2 entries no TOC element and no
   `toc-toggle` exist in the DOM.
10. **Desktop rail (viewport ≥ 1100px)**: `toc-panel` (`<nav aria-label="Table of contents">`) in a left column
    (240px), `position: sticky` below the header, max-height = viewport − header, scrolling independently.
    Heading "Contents" + `toc-collapse-btn`. Collapsing hides the rail (content re-centres) and shows
    `toc-toggle` in the header to reopen it. Collapsed state is a reader preference in localStorage
    `md-review-toc-collapsed` (`"1"`/absent, try/catch). It coexists with the comments sidebar (review mode).
11. **Drawer (viewport < 1100px)**: no rail. `toc-toggle` (header, `aria-expanded`, `aria-controls`) opens
    `toc-drawer` from the left (width `min(85vw, 320px)`) over a `toc-backdrop`. It closes on: link click
    (after navigating), Esc, backdrop click, `toc-drawer-close`. On open, focus moves to the active link (or
    the first); focus is trapped inside; on close it returns to `toc-toggle`; the page behind does not scroll.
12. **Links**: each entry is `<a data-testid="toc-link" href="#<id>">` (real href; modified/middle clicks open a
    new tab with the full doc URL). Plain click → same behaviour as an in-doc anchor (#4 rule 12: `pushState`,
    scroll target to just below the sticky header) and the clicked entry becomes active immediately.
    Long entries are truncated with ellipsis on one line, full text in `title`.
13. **Active section**: exactly one `toc-link` has `aria-current="location"` (and class `active`): the last
    heading (among TOC entries) whose top is at or above the reading-area top + 80px; before the first heading
    → the first entry; when the page is scrolled to the very bottom → the last entry whose heading is visible.
    Updates within 150 ms of scroll end, throttled (no layout thrash: one rect read pass per frame max). The
    active link is kept visible inside the rail/drawer by scrolling **the rail only** (the page never jumps).
14. TOC rebuilds when the content changes (edit, poll, restore), preserving collapsed state and the current
    active entry if its id still exists.

### Heading copy-link
15. Every markdown heading (h1–h6) contains a trailing `heading-anchor` button: `<button type="button"
    aria-label="Copy link to section: <text>">` with an icon only (`aria-hidden` svg). It contributes no text to
    the heading's `textContent`-derived TOC text, to selections/comments, to `docTitle` (#5) or to copied code.
16. Visible on hover or keyboard focus of the heading (hover devices); always visible at reduced opacity on
    `(hover: none)`. Always in tab order. Min hit area 32×32 (44×44 on `(hover: none)`).
17. Click → copies `<origin><BASE_URL>d/<slug||id>#<encodeURIComponent(id)>` (for an unshared local doc: the
    current URL without `edit` param + `#<id>`), updates the address bar fragment with `replaceState`, and shows
    `app-toast` "Link copied". Clipboard API missing/denied → textarea `execCommand` fallback (as #14); if both
    fail → error toast "Couldn't copy — the link is in the address bar".
18. Never includes `?edit=`, `?view=` or other query params in the copied link.
19. **Offset**: headings have `scroll-margin-top` ≥ sticky header height + 12px so any anchor navigation lands
    the heading fully visible below the header.
20. **Print**: `toc-panel`, `toc-toggle`, `toc-drawer` and `heading-anchor` are `display: none` (this item adds
    these rules to #5's print stylesheet).
21. **Structure** (00 §4.5, §3.4): this item creates the preview enhancer pipeline (`src/preview/enhancers.ts`,
    `runEnhancers` called by PreviewPane after every render) with `src/preview/headingAnchors.ts` as its first
    enhancer, and `src/composables/useFocusTrap.ts` (used by the drawer, reused by later dialogs). `toc-toggle`
    sits first in the header left group (00 §2.2).

## Acceptance criteria
AC-03.1 Given the table in rule 7 as headings of one doc Then the rendered `h1..h6` ids equal the table, in order, and no element has `id=""`.   [verify: unit]
AC-03.2 Given headings `Dup`, `Dup-1`, `Dup` Then ids are `dup`, `dup-1`, `dup-2` and all ids in the doc are unique.   [verify: unit]
AC-03.3 Given a doc `# Title` + 4 `##` + 2 `###` at 1400×900 Then `toc-panel` is visible, has 6 `toc-link`s (no "Title"), the `###` entries are indented more than `##`, and the panel stays at the same viewport top after scrolling 3000px.   [verify: e2e]
AC-03.4 Given a doc with only one `##` (or only an H1) Then neither `toc-panel` nor `toc-toggle` exists in the DOM.   [verify: e2e]
AC-03.5 Given the AC-03.3 doc When scrolled so the 3rd `##` heading is 20px below the header Then that heading's `toc-link` has `aria-current="location"` and it is the only one; scrolling to the very bottom makes the last entry active.   [verify: e2e]
AC-03.6 Given a TOC link is clicked Then the URL fragment equals the link's href, the heading's top is between the header bottom and header bottom + 48px, and that link is active.   [verify: e2e]
AC-03.7 Given `toc-collapse-btn` is clicked and the page reloaded Then `toc-panel` is hidden, `toc-toggle` is visible, and clicking it shows the rail again (and clears the preference).   [verify: e2e]
AC-03.8 Given 820×1180 and 390×844 Then no rail is visible; `toc-toggle` opens `toc-drawer`, focus is inside it, Esc closes it and focus returns to `toc-toggle`; clicking a `toc-link` closes the drawer and scrolls to the heading.   [verify: e2e]
AC-03.9 Given a heading `## Über café` in shared doc `weekly` When its `heading-anchor` is clicked Then the clipboard holds `<origin><base>d/weekly#%C3%BCber-caf%C3%A9`, an `app-toast` "Link copied" appears, and `location.hash` decodes to `#über-café`.   [verify: e2e]
AC-03.10 Given the copied link from AC-03.9 opened in a fresh context Then the doc renders scrolled so `über-café` is just below the header.   [verify: e2e]
AC-03.11 Given clipboard permission denied Then an error `app-toast` appears and the address bar fragment is still updated.   [verify: e2e]
AC-03.12 Given a heading containing a `heading-anchor` Then the TOC entry text, `document.title` (#5) and a triple-click selection of the heading contain no button text/label.   [verify: e2e]
AC-03.13 Given an HTML doc, or edit view of a markdown doc Then `toc-panel`/`toc-toggle` do not exist.   [verify: e2e]
AC-03.14 Given a review-mode doc at 1400×900 Then TOC rail, content and comments sidebar are all visible with no horizontal page scroll.   [verify: visual]
AC-03.15 Given heading-anchor and toc-link controls Then axe reports no violations for them, each anchor has an accessible name starting "Copy link to section:", and the nav has `aria-label="Table of contents"`.   [verify: a11y]
AC-03.16 Given a poll update that inserts a new `##` before the current active one Then the TOC shows the new entry and the previously active heading (same id) is still active.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
`toc-panel`, `toc-link` (`aria-current` on active), `toc-collapse-btn`, `toc-toggle`, `toc-drawer`, `toc-drawer-close`,
`toc-backdrop`, `heading-anchor`; reuses `app-toast` (00 §3.1, built by #2). localStorage key `md-review-toc-collapsed`.
No API/MCP changes.

## Edge cases the adversarial verifier must try
- 300 headings (rail scrolls itself; active entry stays visible; scroll handler stays < 4 ms/frame).
- Two headings 10px apart; a final heading shorter than the viewport (bottom rule).
- Heading text that is only an emoji or only punctuation; headings named `app`, `toc-panel`, `shared=x`.
- Heading containing inline HTML `<span>` and an image; headings inside a blockquote and a list item.
- Front-matter doc (`---` block) — TOC ignores the front-matter table.
- Resize from 1400 → 820 with the drawer closed/open (rail ↔ drawer switch, no stuck scroll lock).
- `prefers-reduced-motion: reduce` → anchor scrolls are instant.
- Mermaid diagrams above a heading finishing render after a TOC click (heading still ends up visible; see #4 rule 14).

## Dependencies on other items (by number) and files likely touched
Needs #4 (pushState anchors, fragment on load), #5 (document-scroll read view, sticky header height, print rules,
`plainText` helper — #5 lands **before** this item), `app-toast` (00 §3.1, built by #2), #2 (read view only). #17 and #28 reuse/filter the heading ids; #7 split view has no TOC (width budget).
Files: `src/composables/useMarkdown.ts` (register plugin), new `src/markdown/headingIds.ts`, new `src/components/TocPanel.vue`,
`src/composables/useActiveHeading.ts`, `src/composables/useFocusTrap.ts`, new `src/preview/enhancers.ts` + `headingAnchors.ts`,
`src/components/PreviewPane.vue` (one `runEnhancers` call), `src/components/DocHeader.vue` (`toc-toggle`), `src/components/DocView.vue`.

## Decisions
- GitHub-compatible slugs (incl. `-launch` for emoji headings): links authored against GitHub copies of a doc keep working.
- Empty slug → `section` instead of GitHub's `""`/`-1`: never emit an empty id.
- Lone leading H1 omitted from TOC: it duplicates the doc title shown in the header.
- No TOC for HTML docs: the parent cannot read the sandboxed iframe's DOM, and such docs ship their own nav.
- Copy-link uses `replaceState`, not `pushState`: copying should not add Back steps, but the address bar should show the link.
- Rail breakpoint 1100px: below it rail + 760px content + comments sidebar don't fit.
