# #3 TOC + heading anchors — code review

Scope: `03-wip.diff` (qa05 → cap-reader), plus useFocusTrap's adoption in ShortcutsOverlay (#9) and CommentsLayer (#5). Frozen 03 tests not reviewed. I did not run any tests; this is a static read, plus one node check of markdown-it typographer output.

**Verdict: FAIL, 1 blocker.**

## BLOCKER
1. **`src/components/DocView.vue:159-160`: the new `<TocPanel v-if>` breaks the `v-if/v-else-if` chain.** `<div class="doc-loading" v-else-if="isDocRoute && !docMissing">` used to belong to `<div v-if="onScreen" class="doc-body">`. It now belongs to the drawer TocPanel's `v-if`. So whenever a doc is on screen and the drawer TOC isn't mounted (desktop, edit view, HTML docs, docs with fewer than 2 headings), an `aria-busy="true"` `.doc-loading { flex: 1 }` div renders next to `.doc-body`. In edit view `.app` is fixed height, so doc-body and doc-loading split it and the editor and preview get about half the height. Readers of the doc also get a permanent busy region. **Fix:** move the drawer TocPanel after the `doc-loading` div, or wrap it in its own `<template>`, so `v-else-if` follows `doc-body` again.

## SHOULD-FIX
2. **`src/markdown/headingIds.ts:63-80`: the TOC uses its own parser, separate from the preview's (decision line 150).** Any later core or inline plugin will make TOC text and ids drift from the rendered headings unless it is also registered here: #16 rag (rule 2: badge label only), #28 agentSections, #12 inlineToc. The preview already returns `env.headings` from the same parse. **Fix:** have `extractHeadings` use useMarkdown's `md` instance (`md.parse`), or a shared `PLUGINS` list. Better still, feed the TOC from PreviewPane's `rendered.headings` so there is one parse and one truth for #17/#28.
3. **Slugs aren't GitHub-compatible once typographer runs.** headingIds runs after `replacements`, so (verified with node):
   - `## foo--bar` → `foobar` (GitHub: `foo--bar`)
   - `## a -- b` → `a--b` (GitHub: `a----b`)
   - `## (c) note` → `-note` (GitHub: `c-note`)

   This breaks the spec's stated reason for GitHub slugs. **Fix:** slug from the text before typographer. Options: build the text from `inline.content` stripped through a non-typographer parse, or register the rule `.before('replacements')` and keep only the label text post-typographer. Add these three to the unit table.
4. **`src/composables/useActiveHeading.ts:53`: hidden headings count as above the line.** `getBoundingClientRect()` of a `display:none` heading returns `top: 0`, which is treated as above the line. Once #17 folds a section, its nested h3s become "active". **Fix:** treat `height === 0 && top === 0` as `null`.
5. **Pinned active entry is cleared only by wheel/touch/key/mouse input.** A toolbar Back/Forward (popstate) or any programmatic scroll (#4 fragment, comment `scroll-to`) leaves a stale active entry. **Fix:** also unpin on `popstate`/`hashchange`, or on `scrollend` after the jump settles.
6. **`src/preview/enhancers.ts:10-15`: `EnhancerContext` is #3-specific (`copySectionLink`).** #14 needs copy+toast, #15 a viewer opener, #17 router plus persisted fold state, #24 doc id and reader. **Fix:** pass generic services now (`docState`, `router`, `toast`, `copyText`, `headings`) and keep `copySectionLink` as a helper, so later items each add one line instead of editing PreviewPane's ctx.

## NIT
7. **Active-heading perf.** Each frame does one `querySelector('#id')` plus one rect read per entry, and `headerBottom()` re-queries the header. At 300 headings it is probably fine, but it hasn't been measured against the < 4 ms target. **Fix:** cache the heading elements once per render (or entries change) and binary-search the tops.
8. **useFocusTrap has no stack.** Two active traps both act on Tab in capture phase; that works today only by registration order. **Fix:** keep a module-level stack so only the top trap handles Tab, before #15/#13 nest dialogs. Also, unmounting while active never returns focus (TOC drawer at resize to desktop → focus lands on body).
9. **CommentsLayer change.** Tapping a comment in the sheet now returns focus to `comments-toggle`; before, focus deliberately stayed put. It's harmless (`preventScroll`), but it is a behaviour change for #5. Note it in DECISIONS or skip `returnFocus` on that path.
10. **`DocHeader.vue:71`: `aria-controls` points at an element not in the DOM** (`toc-panel` while collapsed, `toc-drawer` while closed). axe tolerates this with `aria-expanded="false"`, but it is semantically empty.
11. **The `overflow: hidden` scroll lock on `<html>` doesn't stop iOS Safari's rubber-band scroll.** Acceptable per decision line 152.

## Good
- Pure `slugify`/`assignIds`/`buildToc`/`activeIndex` with unit tests.
- Scroll handling is rAF-throttled and passive, with no writes in the read pass.
- The rail scrolls itself only.
- Collapsed preference uses try/catch.
- Heading-anchor click uses delegation, sets `user-select: none`, and is idempotent per render.
- `copyText` gets the `ta.focus()` fix.
- ShortcutsOverlay's inline trap is cleanly removed.
- Heading ids are stable over the full source, as #17/#28 require, but see 2.
