# Lane "reader" — captain report (#5, then #3)

Base: main fb3c2af. Work is uncommitted. Hand-off patches (in the cap-reader scratchpad):
- `05.patch`: applies on fb3c2af.
- `03.patch`: applies on top of 05.
- `05-frozen-tests.patch`: a one-line change to the frozen `tests/e2e/items/05-print-title.test.mjs`. It applies to main's untracked copy, since frozen test files are not in git. Details below.

Both patches were verified by applying them in order to a clean `git worktree add --detach fb3c2af` (see the end of this report).

QA and review for #5 ran in a separate snapshot worktree, `md-review-cap-reader-qa05` (#5 only). This let #3 be built in parallel. The #5 fixes were applied to both trees.

## #5 Mobile layout, print CSS, document.title, front-matter lines
- **ACs:** AC-05.1 to AC-05.20 all pass. Frozen e2e: 05-mobile-layout 24/24, 05-print-title 17/17. Frozen unit tests: 25/25.
- **QA (blind):** FAIL on first pass, with 1 major and 1 minor defect (`reports/05-qa.md`). Every AC was PASS on its own terms. Both defects are fixed:
  - **major:** in print, a table cell holding a long unbroken word widened the page and was cut off in the PDF. Fix: on paper, tables are `width: 100%` and cells use `overflow-wrap: anywhere`. Re-check: print `scrollWidth` 390 = innerWidth.
  - **minor:** the comment action bar ran 6px past the right edge at 390px. Fix: it is now clamped using its measured width. Re-check: the bar spans 282 to 384 at 390.
- **Review:** no blockers (`reports/05-review.md`).
  - SF1 (comments drawer had `aria-modal` but no focus trap): fixed. `useFocusTrap` now lands with #5, because #5 has the first drawer.
  - SF2 (two anchor-offset mechanisms): fixed in #3 (see below).
  - NIT3: the title debounce now applies whenever an editor pane shows.
  - NIT5: `plainText` now trims only at the top level.
  - NIT6: a print diagram left on screen without an `afterprint` event is restored on the next screen render.
  - NIT4: fixed in #3. docTitle now reads the H1 from the shared heading list.
  - NIT7 (idle-time light rendering of mermaid in dark themes): kept, because the synchronous `beforeprint` swap needs it. This is logged in DECISIONS.
- **Phone layout issues reported earlier are fixed:**
  - The 80px doc squeeze from the comments sidebar: below 1100px the comments are a bottom-sheet drawer (`comments-toggle` / `comments-drawer`).
  - Editor overflow on phone: no horizontal scroll in edit view at 390, 320 or 844×390 (QA checked).
  - The editor header on phone uses a status dot and an icon Save button.
- **Decisions:** the `#5:` lines in DECISIONS.md. They cover:
  - cells use `break-word` on screen and `anywhere` in print;
  - document scroll applies to markdown read view only (HTML and file views stay fixed);
  - front-matter lines are kept by blanking them;
  - `print.css` is imported last;
  - mermaid print copy;
  - comments-toggle count;
  - title debounce;
  - `useFocusTrap` lands with #5.
- **Frozen-test change (1):** `tests/e2e/items/05-print-title.test.mjs`, test "rule 18". The `putMarkdown` call now passes `{ author: 'poller' }`. The server folds writes by the same author/client within `REVISION_COALESCE_MS` into one revision. Without this, `listRevisions` has no older revision to pin and the test can never pass. The reviewer judged it justified, and no assertion is weakened.
- **Pre-existing test change:** `tests/e2e/app.test.mjs` lines 51, 407 and 427 asserted that `doc-title` contains the filename (`fixture.md`, `untitled.md`, `pasted.md`). Under 00 §5 / AC-05.12, `doc-title` is now the H1, or the filename without its extension. The assertions now expect `Test Document`, `untitled` and `Pasted Title`.

## #3 Sticky TOC, GitHub heading ids, copy-link, active section, phone drawer
- **ACs:** AC-03.1 to AC-03.16 all pass. Frozen e2e 23/23; frozen unit 19/19.
  - New unit tests: `tests/composables/useActiveHeading.test.ts` (5) and `tests/markdown/headingIds.extra.test.ts` (5, covering typographer slugs).
- **Structure:** follows 00 §4.4 and §4.5:
  - `src/markdown/headingIds.ts` (`slugify`, `assignIds`, `extractHeadings`, `buildToc`, plugin);
  - `src/preview/enhancers.ts` with `headingAnchors.ts` (a single `runEnhancers` call site in PreviewPane);
  - `useToc.ts`, `useActiveHeading.ts`, `TocPanel.vue`;
  - `toc-toggle` first in the header.
  - #9's inline overlay focus trap is replaced by `useFocusTrap`.
- **QA (blind):** FAIL on first pass, with 1 major and 2 minor defects (`reports/03-qa.md`). All are fixed and re-checked with QA's own repro scripts (all PASS):
  - **major (AC-03.16 variant):** a poll that inserted text above the active heading pushed the reading position and flipped the active entry. Fix: a rebuild that keeps the active id now pins it and scrolls by the shift.
  - **minor:** a TOC click made before diagrams finished rendering never re-aligned. Fix: later jumps now re-align while layout is pending.
  - **minor:** a heading named `app` collided with `#app`, and same-document `#app` navigation landed wrong. Fix: Back/Forward and fragment navigation now align after the browser's own fragment scroll, and app element ids are prefixed.
- **Review:** 1 blocker, fixed (`reports/03-review.md`). The blocker: inserting the drawer `TocPanel` broke DocView's `v-if`/`v-else-if` chain, so a busy `doc-loading` div rendered next to the doc. Should-fix and nit items, all addressed:
  - SF2: `extractHeadings` uses the preview's own markdown-it instance.
  - SF3: ids are slugged before typographer replacements (`foo--bar`, `(c) note` → `c-note`).
  - SF4: hidden headings are ignored by the active-section logic.
  - SF5: Back/Forward unpins the active entry.
  - SF6: generic `EnhancerContext` services (`docState`, `router`, `toast`, `copyText`).
  - The SF2 carried over from #5: in document scroll, `scrollToAnchorElement` uses `scrollIntoView` plus `scroll-margin-top` on `.preview-pane [id]`.
  - N7: heading elements are cached per render.
  - N8: `useFocusTrap` uses a stack and returns focus on unmount.
  - N9: logged in DECISIONS.
  - N10: `aria-controls` is set only in drawer mode.
  - N11: `touch-action: none` on the backdrops.
- **Decisions:** the `#3:` lines in DECISIONS.md.
- **Frozen-test changes:** none.

## Gate (lane-wide, run once at the end, in this worktree)
`VERIFY_ITEMS=3,5 scripts/verify.sh --only typecheck,unit,build,e2e`. This runs every e2e file (all landed items plus 03 and 05).

`OVERALL: PASS`:
- typecheck: 0 errors
- unit: 377/377
- build: 170 chunks
- e2e: 408/411 pass, 0 fail, 0 skip (27 files); 08-undo-redo reports 18/21 with 0 fail
- 900.6 s

Earlier, the #5-only snapshot passed `VERIFY_ITEMS=5 E2E_FILES=05-mobile-layout,05-print-title,app`: typecheck and unit (348) PASS, e2e 91/91.

## Open items
None.

Not covered here:
- Printing from edit view prints nothing, because rule 11 hides editor panes.
- The CodeMirror editor does not wrap lines on phone. It scrolls inside itself, and the spec does not ask for wrapping.
