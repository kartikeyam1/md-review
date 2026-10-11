# #29 Slides view — code review

Scope: `git diff` (working tree vs index) + untracked `SlidesView.vue`, `SlidesEnterButton.vue`, `useSlides.ts`, `tests/items/29-slides.test.ts`, `tests/e2e/items/29-slides.test.mjs`. Read-only review, nothing run (no build or e2e evidence for #29 exists in `.verify/`; the last summary is a server-only run).

The splitter is correct against rules 2–5: it splits on top-level tokens only and handles setext headings. A `---` in a fence or a blockquote never splits. It drops empty and notes-only slides. Notes use `findNotesSections` on the body with absolute lines, so the line numbers match `token.map`. Agent sections are already stripped by the #28 human core rule, and heading ids come from the same `heading_list` pass. The zoom viewer's document-capture `stopPropagation` correctly keeps keys from reaching the slides listener.

## BLOCKER
1. **TDZ crash in DocView.** `src/components/DocView.vue:204` reads `slidesShown` inside the `docScroll` computed, but `slidesShown` is only declared at `:212`. `useActiveHeading` evaluates the chain immediately during setup: `watch(o.enabled, …, { immediate: true })` (`useActiveHeading.ts:113`), then `toc.visible`, then `docScroll`. Going to the library leaves `appMode`/`screenKey` untouched (`useDocLoader.ts:66-68`, `374-376`). So opening doc A, going to the library, then pressing Back (or reopening A) mounts DocView with `onScreen === true`. The short-circuit then reaches `slidesShown.value`, throws a ReferenceError, and DocView fails to set up. **Fix:** move the `slidesShown` computed above `docScroll`, then re-run the library/back e2e suites (#20/#26).

## SHOULD-FIX
2. **Zoom viewer is invisible in fullscreen.** `src/preview/zoom.ts:115` appends the host to `document.body`. While `.slides-root` is the fullscreen element, only its subtree renders. A click on a diagram opens a viewer you can't see, yet it captures every key. **Fix:** append to `document.fullscreenElement ?? document.body`.
3. **Swipe hijacks horizontal scrolling.** In `SlidesView.vue` `onTouchStart`/`onTouchEnd` (~L208-226), a sideways drag over a wide table or code block (which rule 7 says scrolls horizontally) also changes the slide. **Fix:** ignore touches that start inside `pre, .table-scroll, [data-testid="code-block"]` or any element with `scrollWidth > clientWidth`.
4. **#5's print rules still reach slides.** 00 §10.2 says #5 excludes the `.app[data-view=slides]` scope, but `src/styles/print.css` is unchanged. For example, `print.css:276-277` appends the URL after every external link. Each slide prints with `overflow: hidden`, so that added text clips content. **Fix:** add `:not(.app[data-view=slides] *)` scoping to the #5 rules that touch `.preview-pane`, or at minimum reset `a::after { content: none }` in the slides print block.
5. **Fit/reflow cost.** `fit()` (~L247) forces up to 7 synchronous layouts per slide across all slides. It runs on every `slides` recompute (each poll), on theme change, on `fonts.ready` and after every mermaid pass. Slides are absolutely positioned with no containment. **Fix:** give the slide `contain: strict` (its size is a fixed 1280×720), and only refit slides whose `html` changed.
6. **Keys cause remounts.** `:key="\`${i}:${s.startLine}\`"` (~L414) means a one-line edit near the top of a live doc remounts every later slide, which re-renders every mermaid diagram and re-runs codeCopy/zoom. **Fix:** key by `headingId ?? hash(html)`, plus `i` only to break ties.
7. **Collapsible sections still fold.** Rule 8 says no fold controls, but `<summary>` still toggles on click (and it is in `NO_NAV`). **Fix:** `.slides-root .slide summary { pointer-events: none; list-style: none }`, or `preventDefault` on `toggle`/`click`.

## NIT
8. The URL is not normalised when `slide=99`/`abc`/`0` is clamped, nor when `watch(total)` clamps the index (L46). Call `writeSlideParam` in both cases.
9. A comment popover or action bar left over from the read view makes the first Esc a no-op, because `onFocusEscapeCapture` (DocView) swallows it. Call `doc.dismissAll()` when entering slides.
10. The unit test "…`<details>` are expanded" (`tests/items/29-slides.test.ts:~86`) never asserts that `<details>` are expanded. That happens in `enhance()`, so either drop the claim from the name or cover it in e2e.
11. A heading inside a notes block is in neither `headingIds` nor the canvas, so `#that-id` opens slide 1. That is acceptable, but document it.
12. The e2e negative checks use fixed `waitForTimeout(150–200)` (L93, L197, L209). This is fine for "no change", but they could flake on a loaded box. Consider polling for 300 ms.
13. Exit leaves focus on `<body>`. Focus the heading or the `slides-enter-btn` after exiting.
14. Entry-chunk budget: SlidesView, SlidesEnterButton and useSlides are only reached through `defineAsyncComponent` (DocHeader, DocView), and HeaderOverflowMenu adds no import. The entry budget looks intact, but no build was run to confirm AC-06.8.
