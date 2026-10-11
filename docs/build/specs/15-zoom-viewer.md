# 15 — Full-screen zoom/pan viewer for mermaid diagrams and images

## Goal
Agent-written docs are full of wide mermaid diagrams that are unreadable when squeezed to column width,
especially on a 390px phone. Clicking (or keyboard-activating) a diagram or image opens it full screen with
zoom and pan so any diagram can be read at its authored size.

## Scope / Out of scope
- In scope: rendered mermaid diagrams (`.mermaid` with an `<svg>`) and `<img>` elements in the markdown preview,
  in every layout that shows the preview, all themes, desktop/tablet/phone.
- Out of scope: images/diagrams inside HTML documents (sandboxed iframe — we cannot reach its DOM,
  `src/components/PreviewPane.vue:52-57`); the editor; images used as link content (see Behaviour 2);
  URL/history integration (see Decisions).

## Current state
- Mermaid is lazily imported (`PreviewPane.vue:15-28`) and rendered in place by `renderMermaid()`
  (`PreviewPane.vue:226-245`), which replaces the `.mermaid` div content with an SVG and keeps the raw source in
  `node.dataset.source` (`:241-243`). Theme is `dark`/`neutral` via `mermaidTheme()` (`:30-32`); re-render on
  theme change (`:247-255`). #1 adds a Locus `base` theme.
- Diagram/image CSS: `.mermaid svg { max-width: 100% }` (`PreviewPane.vue:599-606`), `img { max-width: 100% }`
  (`:686-691`) — large diagrams are shrunk to column width with no way to enlarge.
- Preview DOM is replaced on each content change via `v-html` (`:408`); listeners must be delegated.
- Comment selection uses container `mouseup` (`:316-358`); a drag-select over diagram text must still work.
- No modal/overlay exists for content; existing modals (e.g. `ShareModal.vue`, `RevisionsModal.vue`) use
  `--overlay-bg` (`src/style.css:16`).

## Behaviour
1. After each render, every rendered mermaid container and every eligible `<img>` in `.preview-pane` gets
   `data-zoomable="mermaid"|"image"`, `data-testid="zoom-trigger"`, `tabindex="0"`, `role="button"`,
   `aria-label="Open diagram full screen"` or `aria-label="Open image full screen: <alt>"` (alt omitted if empty),
   and `cursor: zoom-in`. A mermaid block whose render failed is not zoomable.
2. Not eligible: an `<img>` inside an `<a href>` (the link wins); an image whose natural width and height are both
   < 48px (icons/badges); images that failed to load.
3. Opening: a primary-button click on a trigger opens the viewer **only if** the pointer moved < 5px between
   down and up and the resulting selection is collapsed (so drag-selecting diagram text for a comment does not
   open it). Enter or Space on a focused trigger opens it.
4. The viewer is a modal overlay `data-testid="zoom-viewer"` with `role="dialog"`, `aria-modal="true"`,
   `aria-label="Diagram viewer"`/`"Image viewer"`, covering the full viewport (`position: fixed; inset: 0`),
   above all app chrome. Background is the theme's opaque `--bg-surface`, so the diagram is shown on the same
   background colour it was rendered for. Page scroll is locked while open and restored exactly on close.
5. Content (`data-testid="zoom-content"`): for mermaid, a clone of the rendered SVG (same theme colours and fonts
   as in the page — the clone must not re-run mermaid and must not alter the in-page SVG); for images, an `<img>`
   with the same `src` and `alt`. Duplicate SVG ids from cloning must not change rendering of either copy.
6. Scale model: *natural size* = SVG viewBox size in CSS px (mermaid) or `naturalWidth/Height` (image);
   *fit* = largest scale at which the content fits the stage (viewport minus toolbar, minus 16px padding each side).
   Initial scale = `min(fit, 2)`, content centred. `minScale = min(fit, 1) / 2`; `maxScale = max(4, fit × 2)`.
   The zoom indicator `data-testid="zoom-level"` shows `round(scale × 100) + "%"` (100% = authored size).
7. Zoom controls in a toolbar `data-testid="zoom-toolbar"`: zoom in `zoom-in-btn` (×1.25), zoom out `zoom-out-btn`
   (÷1.25), reset `zoom-reset-btn` (back to initial scale + centred), close `zoom-close-btn`; for mermaid also
   "Copy source" `zoom-copy-source` (copies `dataset.source`, decoded, exactly as in the fence; same "Copied"
   feedback contract as #14 rule 6). Buttons disable at min/max. All buttons ≥ 44×44 CSS px on `(hover: none)`.
8. Wheel / trackpad: wheel (and ctrl+wheel pinch on trackpads) zooms around the cursor point — the content point
   under the cursor stays under the cursor (±2px). Scroll wheel never scrolls the page behind the viewer.
9. Touch: two-finger pinch zooms around the pinch midpoint; one-finger drag pans; double-tap toggles between
   initial scale and `min(maxScale, max(1, initial × 2.5))` centred on the tap. Mouse: drag pans; double-click
   behaves like double-tap. The browser's native page zoom must not trigger inside the viewer
   (`touch-action: none` on the stage).
10. Pan is clamped so at least 48px of the content stays inside the stage on each axis; when content is smaller
    than the stage on an axis it is centred on that axis.
11. Keyboard (focus is inside the dialog): `+`/`=` zoom in, `-` zoom out, `0` reset, arrow keys pan by 48px
    (Shift+arrow 240px), `Esc` closes, Tab cycles within the dialog only (focus trap). On open, focus moves to the
    close button; on close, focus returns to the trigger that opened it.
    Key and pointer events handled by the viewer must not reach other global handlers (e.g. #29 slide navigation:
    arrows/Esc while the viewer is open act on the viewer only). The viewer is the innermost Esc layer (00 §3.4) and
    uses `useFocusTrap` (built by #3).
12. Close: `Esc`, `zoom-close-btn`, or a click on the stage background that was not the end of a pan drag.
    Closing restores the page scroll position and leaves the in-page diagram untouched.
13. Rendering quality: at scale *s* the content's on-screen bounding width = natural width × *s* (±1px), and SVG
    text stays vector-sharp at 400% (size the SVG via width/height or a non-rasterising transform; no bitmap blur).
14. Readability guarantee: for any diagram, at phone 390×844 the reader can reach 100% (authored size) and pan to
    every corner of it.
15. Viewer UI uses theme tokens and is legible in all six themes; Locus theme uses Locus button styling from #1.
16. While open, live content updates (sync polling, split-view typing) do not close or alter the viewer; it shows
    the snapshot taken at open time.
17. Print: triggers print normally (no zoom cursor/affordances visible); the viewer itself is never printed open
    (`@media print` hides it).

## Decisions
- No URL/history entry for the viewer: the routing contract reserves the fragment for heading ids (#4) and
  pushing state would interfere with revision/route navigation. Back does not close the viewer; Esc/✕ do.
- Linked images keep link behaviour — authors who link an image intend navigation.
- Mermaid copy-source lives here instead of a hover button on the diagram (#14 Decisions).
- Opaque `--bg-surface` backdrop instead of a translucent dark overlay so light-theme diagrams stay readable.

## Acceptance criteria
AC-15.1 Given a doc with one mermaid diagram and one 800×600 image When rendered Then each has
  `data-testid="zoom-trigger"`, `tabindex="0"`, `role="button"`, and the correct `data-zoomable`.   [verify: e2e]
AC-15.2 Given a click (no movement) on the diagram Then `zoom-viewer` is visible with `role="dialog"`,
  `aria-modal="true"`, and contains an `<svg>` whose fill colour of the first node equals the in-page one.   [verify: e2e]
AC-15.3 Given a mouse drag selecting text across the diagram in review mode Then the viewer does not open and the
  comment action bar can appear.   [verify: e2e]
AC-15.4 Given a 3000px-wide flowchart at phone 390×844 Then the initial `zoom-level` is < 20%, pressing `zoom-in-btn`
  repeatedly reaches ≥ 100%, and at 100% the SVG's bounding width is 3000 ± 2px.   [verify: e2e]
AC-15.5 Given the viewer is open When the wheel is scrolled up with the cursor over point P Then scale increases
  and the content point under P moves ≤ 2px; the page behind does not scroll.   [verify: e2e]
AC-15.6 Given zoom > fit When the user drags 100px right Then the content's left edge moves 100 ± 2px right;
  dragging far beyond leaves ≥ 48px of content visible.   [verify: e2e]
AC-15.7 Given a touch context (390×844, hasTouch) When a two-finger pinch-out is dispatched Then `zoom-level`
  increases; one-finger drag pans.   [verify: e2e]
AC-15.8 Given keyboard only When focus is on a trigger and Enter is pressed Then the viewer opens with focus on
  `zoom-close-btn`; `+` raises zoom, `0` resets to the initial %, Tab never leaves the dialog, `Esc` closes and
  focus returns to the trigger.   [verify: e2e, a11y]
AC-15.9 Given `zoom-reset-btn` after zooming and panning Then scale and position equal those at open.   [verify: e2e]
AC-15.10 Given at `maxScale` Then `zoom-in-btn` is disabled; at `minScale` `zoom-out-btn` is disabled.   [verify: e2e]
AC-15.11 Given a mermaid viewer When `zoom-copy-source` is clicked Then the clipboard equals the fence content
  (with `-->` not `--&gt;`).   [verify: e2e]
AC-15.12 Given an `<img>` inside `<a href>` and a 16×16 icon image Then neither is a `zoom-trigger`.   [verify: e2e]
AC-15.13 Given each of the six themes Then the viewer background equals the theme's `--bg-surface` and the toolbar
  is legible (contrast ≥ 4.5:1).   [verify: visual]
AC-15.14 Given the page was scrolled to Y before opening Then after closing `scrollY` equals Y and the in-page SVG is
  still present and unmodified.   [verify: e2e]
AC-15.15 Given a 400% zoom on a diagram Then a screenshot shows crisp vector text (no blur).   [verify: visual]

## Test hooks (data-testid list) and API/MCP contract changes
`zoom-trigger` (with `data-zoomable`), `zoom-viewer`, `zoom-content`, `zoom-toolbar`, `zoom-level`, `zoom-in-btn`,
`zoom-out-btn`, `zoom-reset-btn`, `zoom-close-btn`, `zoom-copy-source`. No API/MCP changes.

## Edge cases the adversarial verifier must try
- Diagram still rendering (mermaid not yet loaded) — trigger must not exist until the SVG exists.
- Mermaid syntax error output; a gantt / sequence / pie diagram; a diagram with `%%{init: {theme: …}}%%`.
- Theme toggled after render, then open (viewer must show the new theme's colours).
- Very tall narrow sequence diagram on desktop; a tiny 2-node diagram (initial 200%).
- SVG image (`.svg` src), broken image, data: URI image, image with no alt.
- Open, rotate phone (resize to 844×390) — content stays within clamps, fit recomputed for reset.
- Rapid open/close; open via keyboard then close by background click; Esc while a copy toast shows.
- Diagram inside a folded section (#17) or `<details>` — trigger must work once expanded.

## Dependencies on other items (by number) and files likely touched
- #1 (Locus mermaid theme/tokens), #5 (mobile/print CSS), #14 (copy feedback contract), #17 (fold), #19 (export
  must strip `zoom-trigger` attributes/cursors).
- Files: new `src/components/ZoomViewer.vue` (+ maybe `src/composables/useZoomPan.ts` with unit-testable math),
  new `src/preview/zoom.ts` enhancer (trigger marking after render, delegated click/keydown; 00 §4.5), styles.
