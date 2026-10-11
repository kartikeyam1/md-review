# 17 — Collapsible sections: `<details>` styling, fold-by-heading, collapse/expand all

## Goal
Long agent-written docs (evidence dumps, appendices) bury the summary. Readers should be able to fold sections by
heading, collapse a whole doc to its outline, and have authors' `<details>` blocks look deliberate — with fold state
remembered per reader and never hiding a section someone deep-linked to.

## Scope / Out of scope
- In scope: markdown preview (`.preview-pane`) in read/split/focus layouts; `<details>/<summary>` styling; fold
  toggles on H1–H4; collapse-all/expand-all; per-doc-per-reader persistence; deep-link/TOC/comment auto-expand;
  print expansion.
- Out of scope: HTML documents (iframe); the editor (code folding in CodeMirror); H5/H6 folding; server-side storage
  of fold state; author-set default folds.

## Current state
- `html: true` (`src/composables/useMarkdown.ts:168`) so `<details><summary>` already passes through unstyled; no
  sanitizer exists.
- Headings get slug ids from `headingAnchorPlugin` (`useMarkdown.ts:66-85`), deduplicated with `-1`, `-2` suffixes.
- Rendered output is a flat sequence of top-level block siblings inside `.preview-pane` (`PreviewPane.vue:402-409`),
  re-created on every content change via `v-html` — any fold state applied to DOM is lost on re-render unless
  re-applied.
- `scrollToLine()` (`PreviewPane.vue:376-395`) scrolls the sidebar's target into view via `data-line-*`.
- Routing today is hash-based (`App.vue:370-384`); #4 moves to `/d/:slugOrId#heading-id` where the fragment is only
  ever a heading id. TOC panel (`toc-panel`) is defined by #3.
- Reader prefs persist to localStorage (e.g. theme key `md-review-theme`, `src/composables/usePersistence.ts:9`).

## Behaviour
### `<details>`
1. `details` in the preview renders as a bordered box (1px `--border`, radius 6px; Locus 8px+, no edge stripe),
   `summary` is a full-width clickable row with a chevron that rotates 90° when open, `cursor: pointer`, visible
   focus ring, `font-weight: 600`. The native disclosure marker is replaced by the chevron. Nested details indent.
   Styled in all six themes (GitHub themes may keep github-markdown-css's base and add the box).
2. `<details open>` starts open. Native keyboard behaviour (Enter/Space on summary) is preserved.

### Fold by heading
3. Every **top-level** H1–H4 in `.preview-pane` (direct child; not inside a list, blockquote, callout, table or
   `<details>`) that has at least one following block before the next heading of the same or higher level gets a
   fold toggle button `data-testid="heading-fold-toggle"` placed before the heading text (in the left gutter on
   desktop). It has `aria-expanded="true|false"`, `aria-controls` / an accessible name "Fold section <heading text>"
   / "Unfold section <heading text>".
4. Folding heading *H* (level *n*) hides every subsequent top-level block up to (not including) the next heading of
   level ≤ *n* (or end of doc). Hidden blocks get `hidden="until-found"` (so browser find-in-page can reveal them,
   handled by the `beforematch` event unfolding the section). The heading gets `data-folded="true"`; an ellipsis
   affordance `data-testid="heading-fold-ellipsis"` ("⋯") appears after the heading text and unfolds on click.
   The folded section takes no vertical space: the next visible block's top is ≤ 48px below the folded heading's
   bottom.
5. Nested folds are independent: unfolding a parent restores children to their own remembered state.
6. Visibility of the toggle: shown on heading hover or when the toggle/heading has focus; always shown (at reduced
   opacity) on `(hover: none)` devices and whenever the heading is folded. Toggle is a `<button>` in tab order;
   Enter/Space toggles. Hit area ≥ 24×24 (≥ 44×44 on `(hover: none)`). It must not shift heading text horizontally
   between states (reserve the gutter).
7. Clicking the heading text itself does **not** fold (avoids accidental folds and keeps text selectable for
   comments and #3 copy-link).

### Collapse all / Expand all
8. Two buttons `data-testid="fold-collapse-all"` and `data-testid="fold-expand-all"` live in the TOC panel header
   (#3) on desktop/tablet and inside the TOC drawer/menu on phone; they are reachable at all three viewports and are
   absent when the doc has no foldable heading, when no TOC exists (#3 rule 9: fewer than 2 entries), and for HTML docs.
9. Collapse all: let *L* = the smallest heading level (1–4) occurring ≥ 2 times among foldable headings (if none,
   the smallest level present). Every foldable heading with level ≥ *L* is folded. Result for a typical doc with one
   H1 and many H2s: title, intro and the list of H2s are visible.
10. Expand all: every fold is removed (all `hidden` cleared). Neither affects `<details>` elements.

### Persistence
11. Fold state = the set of folded heading ids, stored in localStorage under `md-review-fold:<docKey>` as a JSON
    array; docKey = the backend doc id (not slug) for shared docs, `<id>/<fileName>` for a file inside a multi-file
    session, and `local:<filename>` for unshared/local docs. Pinned revisions (`@rev`) share the doc's key. All access wrapped in try/catch; storage failure means folds just don't persist.
12. On every render (initial load, live sync update, split-view typing) the stored set is re-applied; ids that no
    longer exist are ignored (and pruned on next write). Expand-all writes an empty array.

### Auto-expand
13. Navigating to `#heading-id` (initial load, Back/Forward or manual fragment edit per #4 rules 13–14 — there is no
    `hashchange` listener after #4 —, TOC link click, in-doc `[x](#id)` link, #3 copy-link URL)
    whose target is hidden by one or more folds unfolds every ancestor fold so the target is visible, persists that,
    then scrolls to it. Same if the target id is inside a closed `<details>`: that details gets `open`.
14. Sidebar "scroll to comment" (`scrollToLine`) into a folded region unfolds it first.

### Print
15. Under `@media print`, every folded block and the content of every closed `<details>` is printed (visible), fold
    toggles and ellipses are hidden. Printing does not change the stored fold state.

## Decisions
- Toggle on a dedicated button, not on heading click — headings are selection/comment targets in review mode.
- Collapse-all uses the "first repeated level" rule so single-H1 docs collapse to an outline, not to just the title.
- `hidden="until-found"` so Ctrl+F still finds folded text (Chromium/Firefox; Safari falls back to normal `hidden`
  semantics if unsupported — acceptable).
- Fold state is per reader, local only; no backend.

## Acceptance criteria
AC-17.1 Given a doc `# T`, intro, `## A` (2 paras, `### A1` + para), `## B` (para) Then toggles exist on T, A, A1, B
  and none on headings inside a blockquote or list.   [verify: e2e]
AC-17.2 Given the reader clicks A's toggle Then A's paras, A1 and its para have `hidden="until-found"` and are not
  visible, B is visible, A's toggle has `aria-expanded="false"` and `heading-fold-ellipsis` is shown.   [verify: e2e]
AC-17.3 Given A folded Then B's top is ≤ 48px below A's bottom.   [verify: e2e]
AC-17.4 Given A1 folded, then A folded and A unfolded Then A1 is still folded.   [verify: e2e]
AC-17.5 Given `fold-collapse-all` on the AC-17.1 doc Then T and intro are visible, A and B are visible and folded,
  A1 is hidden; `fold-expand-all` then shows everything.   [verify: e2e]
AC-17.6 Given A folded When the page is reloaded (same doc, same browser) Then A is still folded; in a fresh browser
  context it is not.   [verify: e2e]
AC-17.7 Given A folded When the doc content changes (live sync or split-view edit adds a paragraph to B) Then A stays
  folded after re-render.   [verify: e2e]
AC-17.8 Given A folded When the reader opens `/d/<slug>#a1` (or clicks the A1 TOC link) Then A unfolds, A1 is in the
  viewport, and the stored set no longer contains `a`.   [verify: e2e]
AC-17.9 Given a heading inside a closed `<details>` and a deep link to it Then the details is opened and the heading
  is in view.   [verify: e2e]
AC-17.10 Given keyboard only Then Tab reaches each fold toggle, Enter folds, Space unfolds, focus ring is visible, and
  toggles are always visible at 390×844 touch.   [verify: e2e, a11y]
AC-17.11 Given A folded and a closed `<details>` When print media is emulated Then A's content and the details body
  have non-zero height and no `heading-fold-toggle` is displayed; after returning to screen media A is still folded.   [verify: e2e]
AC-17.12 Given `<details><summary>More</summary>\n\nmarkdown *body*\n\n</details>` Then it renders as a styled box with
  a chevron, closed; clicking the summary opens it and rotates the chevron.   [verify: e2e, visual]
AC-17.13 Given localStorage throws on access Then folding still works for the session and no error is shown.   [verify: e2e]
AC-17.14 Given an HTML document Then no fold controls or toggles exist.   [verify: e2e]

## Test hooks (data-testid list) and API/MCP contract changes
`heading-fold-toggle`, `heading-fold-ellipsis`, `fold-collapse-all`, `fold-expand-all`; attributes `data-folded`,
`aria-expanded`, `hidden="until-found"`. localStorage key `md-review-fold:<docKey>`. No API/MCP changes.

## Edge cases the adversarial verifier must try
- Duplicate heading texts (`## Notes` twice → ids `notes`, `notes-1`): folding one must not fold the other; after
  removing the first, persisted `notes-1` maps to nothing rather than the wrong section.
- Heading that is the last element (no body → no toggle); H4 directly followed by H2.
- Comment-highlighted block inside a folded section; selection spanning a fold boundary.
- Fold a section containing an un-rendered mermaid diagram, then unfold — diagram renders correctly (#15 trigger works).
- Collapse-all on a doc with no headings (buttons absent), only H5s (absent), 500 headings (< 200 ms).
- Deep link to a non-existent id (no crash, nothing unfolds); deep link while another section is folded (others stay).

## Dependencies on other items (by number) and files likely touched
- #3 (TOC panel hosts collapse/expand all; TOC links trigger auto-expand), #4 (fragment = heading id), #5 (print CSS,
  phone TOC drawer), #1 (Locus styling), #15/#14 (content inside folds), #19 (export expands everything).
- Files: new `src/preview/folding.ts` enhancer (post-render fold pass, delegated handlers; 00 §4.5), new
  `src/composables/useFolding.ts` (pure range computation + persistence, unit-testable), `src/components/TocPanel.vue` (#3),
  `src/styles/preview.css` / `src/style.css` (styles, print rules).
