# Entry budget — move rarer highlight.js languages out of the entry chunk

Verdict: DONE. AC-06.8 passes again with ~91 KB headroom.

## Finding: why main measured 575,493 bytes
`tests/items/06-lazy-editor.test.ts` runs `vite build` as a child of vitest with `env: { ...process.env }`.
Vitest sets `NODE_ENV=test`, so the child build replaces `process.env.NODE_ENV` with `"test"` and ships
Vue's development code paths (warnings, devtools hooks). That inflates the entry by ~52.6 KB vs a real
production build (`vite build` / `npm run build`). At 265756a:
- `NODE_ENV=test vite build` (what AC-06.8 measures): **575,493** bytes
- `vite build` (what users download): **522,877** bytes
The frozen test was left untouched; the orchestrator may want to know the cap is effectively ~52 KB stricter than
it reads (or set `NODE_ENV=production` for build in vite.config — a product/test-owner call, NOT done here).

## Analysis (source-map attribution of the production entry, 511 KB mapped)
highlight.js 143.9 KB (core 21.6 KB + 36 languages ~122 KB: scss 14.3, css 13.2, swift 8.2, ts 7.8, js 6.5, sql 6.5,
php 6.3, cpp 5.9, perl 4.6, c 4.0, csharp 4.0, ruby 3.9, ...), markdown-it 49.9, @vue/runtime-core 42.0,
entities 21.2, PreviewPane.vue 16.3, @vue/reactivity 16.1, useDocLoader 9.7, linkify-it 9.1, ...
Languages were by far the largest movable item, so this change only touches that.

## Change
- New `src/markdown/highlight.ts` (was inline in useMarkdown.ts): hljs core + 11 eager languages
  (javascript, typescript, json, bash, shell, python, yaml, xml/html, markdown, diff, plaintext); the other 25
  (java, kotlin, go, rust, css, scss, sql, dockerfile, ini, c, cpp, csharp, ruby, php, swift, groovy, makefile, http,
  graphql, properties, protobuf, lua, perl, r, scala) are `() => import(...)` — one chunk each, 0.5–14 KB.
- Static alias table for lazy languages (so `rs`, `golang`, `hpp`, `toml`, `gradle`… resolve before load); a unit
  test asserts it equals each definition's `aliases`. `FENCE_LANGUAGES` (#12 slash menu) is unchanged in content.
- `highlightCode` (markdown-it `highlight`): unloaded lazy language → request its chunk, return '' (escaped);
  all requests from one render pass are batched and bump `highlightRevision` once; `renderHtml` reads it, so
  PreviewPane's computed re-renders with colours. Failed chunk → stays plain, retried on next render (no loop).
- Embedded sublanguages: an html fence with `<style>` or js/ts with css`/gql` template tags requests css/graphql.
- `useDocLoader`: shared and pinned docs `await withTimeout(loadFenceLanguages(markdown), 300ms)` before the first
  render → no flash for those docs on a normal network.
- `useDownload.buildHtmlExport`: awaits `loadFenceLanguages` (and a macrotask for the live preview to re-render).
- DECISIONS.md: one line under Implementation decisions.

## Trade-off (UX)
Eager languages: identical to before. Lazy languages: on shared/pinned doc open, first paint waits ≤300 ms for
their chunks (typically one parallel round trip for a few KB); beyond 300 ms the doc paints with plain code and
re-renders with colours when the chunks land (one re-render, scroll position unaffected since code text/height
is identical). Typing a fence for a not-yet-loaded language in the editor shows plain text for one fetch.
Other loaders (session files, ?filePath=, GitHub hash, local drafts) take the re-render path without the wait.

## Sizes (entry `<script type=module src>` bytes)
| build | before (265756a) | after | delta |
|---|---|---|---|
| `NODE_ENV=test vite build` (AC-06.8 measurement) | 575,493 | 484,158 | −91,335 |
| `vite build` production (with sourcemap comment) | 522,877 (no map) | 431,581 | ~−91,296 |
| `.verify/dist` (verify.sh build) | — | 468,355 | — |
Cap 574,644 → headroom now 90,486 bytes on the AC-06.8 measurement.

## Verification
- `npx vitest run tests/markdown/highlight.test.ts tests/composables/useMarkdown.test.ts tests/items/14-code-copy.test.ts tests/items/12-slash-menu.test.ts` → 52/52.
- `scripts/verify.sh --only typecheck,unit,build` → typecheck PASS, unit 572/572 (incl. AC-06.8), build PASS 213 js chunks (run 20261011-011119-3149838).
- `node scripts/check-lazy-editor.mjs --dist .verify/dist` → PASS, entry 468,355 bytes.
- `E2E_FILES=app,mermaid,shared-mode,harness-smoke,01-locus-theme,03-toc-anchors,04-routes,05-print-title,06-lazy-editor,06-lazy-editor-build,14-code-copy,16-callouts,17-collapsible,18-font-width-control,19-downloads,12-slash-menu scripts/verify.sh --only e2e` → 314/314, 16 files, OVERALL PASS (run 20261011-011201-3151419).
- Not done: a browser check of a lazy-language doc (covered by the unit test with real dynamic imports; no e2e fixture uses a lazy language).

## Further headroom if needed later (not done)
markdown-it typographer/linkify (entities decode-data-html 15.5 KB is pulled by markdown-it's entity decoding, not
removable), review-only UI (CommentsSidebar 6.6, CommentsLayer 5.2, ReactionOverlays 4.4, ReadersPanel 2.3,
CommentPopover 2.2, ApprovalBanner 1.6 ≈ 22 KB) via defineAsyncComponent when mode=review, useShare 6.8 KB.
