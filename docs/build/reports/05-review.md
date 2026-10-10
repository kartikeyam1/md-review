# #5 code review (mobile / print / docTitle): reviewer

Scope: `git diff` at fb3c2af plus the untracked `src/composables/useDocTitle.ts`, `src/markdown/*` and `src/styles/print.css`. Reviewed against spec 05, 00 §2/§4.4/§5 and the #3 dependency. Time-boxed to 15 min. I ran no tests (I only read the code). I did not look closely at the banner and modal CSS (rules 9 and 10).

**Verdict: no blockers.**

## BLOCKER
None.

## SHOULD-FIX
1. **The comments drawer says it is modal but does not act modal.** `src/components/CommentsLayer.vue` (drawer template, `role="dialog" aria-modal="true"`): there is no focus trap, and the page behind stays focusable and scrollable. Screen readers are told it is modal, but Tab leaves it. Fix: when #3 adds `src/composables/useFocusTrap.ts`, use it here; until then, drop `aria-modal` or add a small inline trap. Note this in the #3 hand-off so the retrofit actually happens.
2. **Anchor scrolling has two offset mechanisms, and #3 is about to depend on both.** `src/composables/useRouter.ts:445-455` (`scrollToAnchorElement`, doc-scroll branch) uses `window.scrollTo(top - headerHeight)` and ignores `scroll-margin-top`. #3 rule 19 adds `scroll-margin-top: header + 12px` for native navigation, so JS-driven and native jumps will land 12px apart. The header lookup also falls back to `document.querySelector('header')`, which can match a raw `<header>` inside doc content if `doc-header` is not mounted. Fix (in #3 or now): in the doc-scroll branch, use `el.scrollIntoView({block:'start', behavior})`, set `scroll-margin-top: calc(var(--header-h) + 12px)` on headings, and drop the `header` fallback.

## NIT
3. **Title debounce only covers edit mode.** `src/composables/docState.ts:194` debounces only when `paneMode === 'edit'`. In any other pane mode (#7 split), every keystroke triggers a full second markdown-it parse. Change the condition to `paneMode !== 'preview'` or key it off `editorShown`.
4. **The title is computed with a full second parse.** `useDocTitle.ts` `markdownTitles` runs a whole-document `parse` on every load or poll, even though the preview has already parsed the same text. This is fine for now. #28 must also apply its agent-section stripping to this second parser instance (00 §5 "human view"), or the title and TOC will disagree.
5. **`plainText` trims inside the recursion.** `src/markdown/plainText.ts:17` trims the image-alt result, so `![a ](x)b` gives `ab`. Trim only at the top level; #3's slugs are sensitive to spaces (rule 3 says no collapsing).
6. **A light diagram can get stuck if `afterprint` never fires.** `PreviewPane.vue` `renderMermaid('print')`: while printing, the swapped-in light SVG keeps the screen `data-rendered-key`. If `afterprint` never fires (some PDF paths), the next screen render skips the node and the light diagram stays. Fix: delete `renderedKey` when swapping, or restore from `svgCache` on the next screen run.
7. **Extra mermaid work in dark themes.** Every dark screen render schedules an idle-time light render, which doubles mermaid work for dark readers who never print. This is acceptable because the spec needs a synchronous swap. Optionally gate it behind the first `matchMedia('print')` listener or a print-shortcut hover.

## Frozen-test change (tests/e2e/items/05-print-title.test.mjs:492)
**Justified.** The rule-18 test needs two revisions: it pins the older revision and expects "Before poll". `server/config.cjs:20` folds writes by the same author/client within `REVISION_COALESCE_MS` (5 min) into one revision. That is behaviour that existed before #5 (golden test 20 covers it). Without a distinct author, `createDoc` plus the PUT produce one revision, and `list.revisions.find(hash !== current)` finds nothing. Adding `{ author: 'poller' }` uses the existing `putMarkdown` option and does not weaken any assertion. The test author should still be told.

## Coupling with #3
- **plainText semantics:** suitable for #3 rule 2. It works on tokens, takes link text but not the URL, uses image alt, drops inline HTML, and decodes entities (`text_special`). See NIT 5. The RAG-badge clause is #16's job.
- **Scroll model:** read view uses document scroll (`.app.doc-scroll`); edit view, HTML docs and file views stay fixed. #3's active-heading logic can assume `window` scroll, because the TOC only exists in read view of markdown docs. The sticky `.doc-aside` (top `var(--header-h)`, height `100dvh - header`) is a pattern the TOC rail can reuse.
- **Sticky header:** height is a single token, `--header-h` (52px) on `:root`, the same at every breakpoint. `doc-meta-row` and the banners are not sticky. #3 should key `scroll-margin-top` and the "reading-area top" (rule 13) off `var(--header-h)`, not measure `doc-meta-row`. See SHOULD-FIX 2.
- **Print stylesheet:** `src/styles/print.css` already hides `toc-panel`, `toc-toggle`, `toc-drawer`, `toc-backdrop` and `heading-anchor`, plus `.preview-pane button`. #3 rule 20 is effectively done; #3 only needs to keep the rail inside `.doc-rail` or use those testids.
- **Breakpoints:** `useBreakpoint` (JS, `<1100`) and the CSS `max-width: 1099.98px` match. #3 should reuse both rather than add a third threshold.

## Checked and fine
- Front-matter absolute lines (blanked prefix; `endLine` matches AC-05.19 for both LF and CRLF).
- `getLineMap` has no outside callers.
- The `table-scroll` wrapper carries no `data-line-*`.
- `autolink` covers linkify, `<…>` autolinks, and links whose text equals the href.
- HTML `<title>` is read with `DOMParser`, so scripts are inert; `head > title` skips a `<title>` inside SVG.
- Truncation counts code points.
- `document.title` covers landing, library, not-found and the missing-doc case.
- The selection action bar is `position: fixed` with viewport coordinates, so it is correct under document scroll.
- Breakpoint CSS for `.doc-aside` (`display: contents`) matches the JS drawer switch.
