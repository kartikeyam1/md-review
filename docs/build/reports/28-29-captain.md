# Lane captain report: #28 agent view and #29 slides (lane/agent)

**Base:** 265756a (main, "#19 Downloads", the re-landed commit).

**Patches:** both are written against that base and apply in order.
- `28.patch` is #28 only.
- `29.patch` applies on top of 28 and contains #29 and this report.

Both were checked by applying them in order onto a clean `git worktree add --detach 265756a`.

**Commits:** none were made in `lane/agent`. All work is uncommitted.

**Gate**, run once at the end of the lane:
`VERIFY_ITEMS=28,29 E2E_FILES=<28, 29 + 15 affected suites> scripts/verify.sh --only typecheck,unit,build,e2e,server`

| Step | Result |
|---|---|
| typecheck | PASS |
| unit | 632/633. The only failure is AC-06.8 entry size. |
| build | PASS |
| e2e | 342/342 across 17 files: 28, 29, 03, 19, 17, 07, 05-print, 05-mobile, 04, 04-extra, 02, 15, 14, 16, app, mermaid, shared-mode |
| server | 437/438, 1 skip |

Run log: `.verify/runs/20261011-014944-3200535`.

## Entry chunk (#6 AC-06.8)

The base is already over the cap. In the test's own build mode (`NODE_ENV=test`), 265756a measures 575,493 bytes against a cap of 574,644. The orchestrator confirmed this, and a separate perf commit is cutting at least 30 KB.

| | Entry size |
|---|---|
| 265756a | 575,493 |
| with #28 | 583,340 (+7.8 KB) |
| with #28 and #29 | 586,487 (+3.1 KB more) |

What is in the entry:
- **#28 eager parts:** `shared/agentSections.mjs` (3.6 KB minified) and the markdown-it plugin (1.4 KB). Loading them later would briefly flash the hidden content. The rest is wiring.
- **Lazy:** the notice, the banner, `SlidesView`, `useSlides` and the Present button.

A plain `vite build` measures about 53 KB smaller than the test-mode build: about 530 KB with #28, against a 522.9 KB base.

## #28 human view vs agent view

**ACs:** AC-28.1 to AC-28.19 are all automated and passing.
- e2e: `tests/e2e/items/28-agent-view.test.mjs`, 15 tests.
- unit: `tests/items/28-agent-view.test.ts`, 54 tests. One fixture table is shared with the server.
- server: `server/test-items/28-agent-view.test.mjs`, 47 tests, covering REST, raw, `llms.txt` and MCP over stdio and HTTP.

**QA** (`28-qa.md`): FAIL on one major.
- **D1:** the Show button contrast in `dark` was 4.21:1.
- **Fix:** the button now uses the body text colour with an accent border. AC-28.18 now asserts the button's contrast in all 6 themes.
- **N1:** `fields=meta&view=human` added extra fields. Fixed on the server.

**Review** (`28-review.md`): no blockers. All findings were fixed.
- **ReDoS:** the original marker regex was cubic. srv28 caught it, and the marker matcher was rewritten to be linear.
- **HTML blocks:** the shared scanner now tracks all CommonMark HTML block types 1–7. Without this, a marker line after a one-tag HTML line was handled differently by the FE and the server. New fixtures cover it, plus a differential test asserting the FE human render equals the server strip for every fixture.
- **Pinned revisions:** they no longer get a raw link.
- **Precheck:** a `<!-- agent` precheck now runs before the full scan (shared and server).
- **ETags:**
  - the raw ETag now includes the content type;
  - `?view=agent` has its own `-a` ETag.
- **#29 notes:** #29 reuses `findNotesSections` and the human token stream, so no token-walk extraction was needed.

**Implementation:** the server and MCP half was delegated to a sub-agent (`28-server-impl.md`, including its fix round).

**Decisions:** recorded in DECISIONS.md under "#28".
- From the edit view, the `.html` export and the PDF are the human view, which keeps #19's frozen test.
- The view toggle shows Read pressed while in agent view.
- The TOC follows the view.
- There is no raw link on pinned revisions.
- The other server decisions are listed in DECISIONS.md.

**Frozen test changes:** none.

**Pre-existing tests changed:**
- `tests/composables/useRouter.test.ts`: "agent not shipped" is no longer true.
- `server/test-items/lib/20-golden.mjs`: `ADDITIVE` gains `view` and `agentSections`, as sanctioned by 00 §10.5.

## #29 slides

**ACs:** AC-29.1 to AC-29.19 are all automated and passing.
- e2e: `tests/e2e/items/29-slides.test.mjs`, 25 tests including fix-round regressions.
- unit: `tests/items/29-slides.test.ts`, 12 tests.
- AC-29.12's Esc-in-fullscreen is browser-owned, so the test emulates it with `exitFullscreen()`.

**QA** (`29-qa.md`): FAIL on one major (UX). All 19 ACs passed.
- **Major:** mermaid diagrams rendered huge on a slide. They are now sized to fit: no wider than the body, no taller than the space left, never upscaled.
- **Minor and cosmetic, all fixed:**
  - `<details>` could still be folded;
  - a blank print page appeared with diagrams (mermaid's tooltip);
  - the URL was not normalised after a clamp;
  - the canvas did not fill the height on a landscape phone (the controls now float over it and auto-hide).
- **Not changed:** body text is small on a portrait phone. That follows from the spec's scaled-canvas model, and the rotate hint covers it. This is logged in DECISIONS.md.

**Review** (`29-review.md`): one blocker, all findings fixed.
- **Blocker:** a TDZ crash in DocView (`slidesShown` was read before its declaration) after going to the library and pressing Back. Fixed, with an e2e regression test.
- **Should-fix:**
  - the zoom viewer now mounts inside the fullscreen element (a #15 file, `zoom.ts`, one line);
  - a swipe that starts inside sideways-scrolling content is ignored;
  - #5's printed link URLs are suppressed on slides;
  - `contain: strict` is set on slides, and a slide is refitted only when its content or the theme changes;
  - slides are keyed by heading id, so a live edit no longer remounts every slide;
  - `<details>` cannot be folded.
- **Nits:**
  - the URL is normalised after a clamp;
  - comment UI is dismissed when entering slides;
  - focus returns to Present on exit;
  - the e2e "nothing happens" checks poll instead of using fixed sleeps;
  - a misleading unit test name was corrected;
  - the notes-heading behaviour is documented.

**Decisions:** recorded in DECISIONS.md under "#29".
- **Spec deviation, AC-29.16:** the last slide has `break-after: auto`, because Chromium prints a blank extra page after a forced final break. Every other slide has `page`. The spec or AC text needs reconciling.
- Slides print with #5's light palette, except the title slide, which keeps its colours.
- An in-deck `#heading` link goes to that heading's slide.
- All slides render (only the current one is visible and exposed to assistive technology). Type scales via `--rpx`.

**Frozen test changes:** none.

**Pre-existing tests changed:** `useRouter.test.ts` "not shipped" now passes an explicit `shipped` set.

## Notes for landing

- `src/preview/zoom.ts` (#15) gains one line: the viewer host goes into `document.fullscreenElement` when there is one.
- I developed #29 in a scratch worktree, `/home/ubuntu/locus-repos/md-review-cap-agent-29`, with a local scratch commit that was never pushed, then ported it back. That worktree has been removed.
