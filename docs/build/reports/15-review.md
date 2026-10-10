# #15 Zoom viewer — code review

Scope: `git diff a612c38` (enhancers.ts, preview.css, print.css) + untracked ZoomViewer.vue, useZoomPan.ts,
preview/zoom.ts, tests/items/15-*, tests/e2e/items/15-*. Read-only review; one browser probe run.

## Verdict: FAIL — 1 blocker

## BLOCKER
1. **Keyboard dies after any mouse interaction in the viewer (Esc stops closing).** `ZoomViewer.vue` handles keys
   only via `@keydown` on the root (`:279`), and the root and stage are not focusable. A mousedown on the stage
   (pan, click on the content, double-click) moves focus to `<body>`, so `+ - 0 arrows Esc` no longer reach the
   viewer and they leak to `useGlobalShortcuts`, TocPanel, CommentsLayer and other global listeners. That breaks rules 11 and 12 and the 00 §3.5 row "swallows
   everything else".
   Evidence: probe `scratchpad/r15/probe.mjs` run via `scripts/lib/browser-slot.sh scripts/lib/stack.sh run -- node …`:
   `active after open: zoom-close-btn` → `active after pan: BODY` → `level before/after +: 200% 200%` →
   `viewer visible after Esc: true`.
   Fix: (a) add `tabindex="-1"` to the root `.zoom-viewer`, so a click keeps focus inside the dialog. (b) Also
   move `onKeydown` onto a `document` capture listener while the viewer is mounted (it already stops propagation), so
   no global handler can see a key first. Add an e2e step: pan, then `+` and `Escape`.

## SHOULD-FIX
2. **The trigger keydown ignores modifiers and repeats** (`zoom.ts:139-145`). Mod+Shift+Enter (the #13 focus-mode shortcut,
   "any focus") on a focused diagram opens the viewer *and* reaches the window listener. A held Enter re-fires
   on `zoom-close-btn` and closes the viewer at once. Fix: `if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return`.
3. **Copy feedback contract (#14 rule 6) is incomplete**: no polite live region announces "Copied to clipboard"
   (`ZoomViewer.vue:290-297`). The pane's `code-copy-status` sits outside an `aria-modal` dialog, so screen readers
   will not hear it. Fix: add a visually-hidden `aria-live="polite"` span inside the dialog that is set on success.
4. **Focus return after a live re-render** (`zoom.ts:93`). Rule 16 lets the doc re-render while the viewer is open,
   which detaches `c.trigger`, so close leaves focus on `<body>`. Fix: record the trigger's index among
   `.preview-pane [data-testid=zoom-trigger]` at open and fall back to the same index on close.

## NIT
5. Stale double-tap close timer (`ZoomViewer.vue:173`) is never cleared on unmount. With a rapid close and reopen
   inside 320 ms it calls `closeViewer` on the *new* viewer. Keep the id and clear it in `onUnmounted`.
6. `scan()` re-adds a fresh `load` listener to every still-loading image on each mutation batch (`zoom.ts:119-121`).
   Duplicates pile up during mermaid rendering. Mark pending images (e.g. a WeakSet) once.
7. `aria-live="polite"` on `zoom-level` (`:283`) announces every wheel tick. Use `aria-live="off"` and announce only on
   button and key zoom, or debounce.
8. Locus-only diagram CSS (`preview.css:550` `.preview-pane .mermaid .slice {font-weight:600}`) does not apply to the
   clone, so Locus pie labels look lighter in the viewer. Scope that rule to `.zoom-content svg` too.

## Checked, OK
- Pure maths (fit/limits/initial/zoomAround/clamp/double-tap) match rule 6/8–10/14, with unit tests.
- Vector sizing via width/height, not `scale()` (rule 13). The clone is id-isolated, including `<style>` and `url(#…)` refs.
  The in-page SVG is untouched.
- The click guard (<5px, collapsed selection) and the linked/tiny/broken image exclusion are correct (rules 2–3).
- The viewer is lazy-loaded (no bundle hit on first paint). Print hides the host and viewer (rule 17).
- The focus trap uses a document capture listener, so Tab still cycles while the root stops propagation.
- The enhancer cleanup does not close an open viewer (rule 16 intent).
