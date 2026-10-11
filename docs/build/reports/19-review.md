# #19 Downloads — code review

Scope: item-19 delta only (`git diff b7aa339…` for DocHeader.vue, HeaderOverflowMenu.vue, PreviewPane.vue, DECISIONS.md;
headerMenuExtras.ts vs its T18 version; untracked useDownload.ts, downloadActions.ts, DownloadMenu.vue,
mermaidTheme.ts, tests/items/19-downloads.test.ts, tests/e2e/items/19-downloads.test.mjs).

## Verdict: PASS, no blockers

Gate (reviewer run, no e2e):
`VERIFY_ITEMS=6,19 scripts/verify.sh --only typecheck,unit,build` gave typecheck PASS (0 errors), unit PASS 522/522
(`tests/items/19-downloads.test.ts` 12 tests, `tests/items/06-lazy-editor.test.ts` 14 tests incl. AC-06.8 entry budget),
build PASS (188 chunks), OVERALL PASS. Logs: `.verify/runs/20261011-002228-3069123/logs/`.

Entry budget: every new module is lazy. DocHeader uses `defineAsyncComponent` for DownloadMenu, headerMenuExtras is
dynamically imported, and downloadActions imports `useDownload` dynamically. The CSS `?inline` strings and mermaid
load only inside the export. The only static entry-path change is PreviewPane → mermaidTheme.ts, which is code moved
out of PreviewPane, so the size is roughly neutral. The PreviewPane refactor keeps behaviour: `mermaidConfigFor(t, true)`
returns the same configs `printMermaidConfig` did.

## SHOULD-FIX

1. **A theme switch just before export captures diagrams in the old theme** (a spec edge case).
   `useDownload.ts:256-258` `diagramsPending` treats a node as settled as soon as it has a `> svg`. On a theme change,
   PreviewPane (`PreviewPane.vue:530-539`) keeps the old SVG until the re-render swaps it in. So an export clicked
   within the re-render window gets the new theme's CSS with diagrams from the old theme. Fix: for the live pane, count a node as
   pending while `m.dataset.renderedKey !== JSON.stringify(mermaidConfigFor(theme))` and it has no `.mermaid-error`.
   Pass `theme` into `diagramsSettled`. This is the same key PreviewPane writes.
2. **`renderOffscreen` leaks its host on failure.** In `useDownload.ts:263-290`, the host is appended to `<body>` before
   `import('mermaid')` and render run. If either throws, `buildHtmlExport`'s `finally` has no `off` to call `done()` on.
   The hidden div then stays in the page with duplicate heading ids, which can capture `#id` lookups that are not
   scoped to the pane. Fix: `try { … } catch (e) { host.remove(); throw e }` inside `renderOffscreen`.

## NIT

3. `downloadActions.ts:52-57`: running PDF from the edit view switches to the read view and stays there, so an editor
   loses their view after printing. Consider restoring the previous view on `afterprint`. The decision is logged, so
   either way is acceptable.
4. `useDownload.ts:316-321`: a 20 MB image is fully downloaded before the 15 MB cap rejects it. Check
   `Content-Length` first when it is present. Images are fetched one after another, so 20 attachments run serially.
   `Promise.all` with a running total would be faster, and is fine to leave for now.
5. No unit test covers `inlineImages` (same-origin vs external, the cap, non-image MIME). It is mostly pure, and a
   test with a stubbed `fetch` would lock rule 7g's cap down. Today only e2e AC-19.9 covers the happy path.
6. `DownloadMenu.vue:17-23` sets `aria-busy` on the trigger imperatively through `querySelector` on AppMenu's `$el`. A
   `triggerAttrs` prop on AppMenu would be declarative and reusable by #26's collection menu. It works today because
   AppMenu's root is a `<div>`.
7. `renderOffscreen` calls the global `mermaid.initialize` while a hidden PreviewPane (narrow split, editor tab) may be
   in the middle of a render. The config is the same theme, so this is harmless except in one window: a dark theme's
   print-copy render could be cached with dark colours. It is a low-probability race. Serialising through one shared
   mermaid queue would remove it.

## Checked and fine

- Filenames (rule 4 and edge cases): forbidden/control chars, trim, `document` fallback, `.txt` stripped,
  `.md`/`.markdown` kept, 200 code-point cap plus the extension, leading-dot names. Covered by unit tests.
- `.md` / HTML-source bytes: the `doc.markdown` string goes straight into a Blob, UTF-8, no BOM, no normalisation.
  Pinned revisions are named from `docMeta.filename`.
- Chrome stripping:
  - `[data-export-strip]` covers the #14 toolbar.
  - Fold toggles, anchors, reactions and code-block wrappers are removed or unwrapped.
  - Zoom attributes are dropped via `data-zoomable` (matches `zoom.ts` marking).
  - `comment-highlight` class, `hidden`, scripts (SVG too), `on*` and `javascript:` URLs are removed.
  - Selection highlight uses the CSS Highlights API, so nothing is in the DOM.
- CSS: the inlined CSS has no `url()` other than `data:` and no `@import` in the sources. print.css is wholly
  `@media print`. `--reader-scale` falls back to 1, so the export renders at 100%. `</style` is escaped.
- Overflow group placement (`download: !desktop`) and the 44px sheet rows match 00 §2.2.
- The menu reuses AppMenu, so roles, arrow keys and Esc focus return come from it.
- Error toast "Download failed" on throw; the `running` guard stops a double-click from downloading twice.
- The e2e file has a test for every e2e AC (19.1, 19.2, 19.4–19.16). I did not run it.
