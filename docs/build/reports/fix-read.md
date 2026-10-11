# Fix captain — area "read" (persona-QA leader + engineer reader/shell/UI items)

Worktree `/home/ubuntu/locus-repos/md-review-fixread` (lane/fixread, base 8be2187). Patch:
`scratchpad/fix/read.patch` (base 8be2187; excludes node_modules, server/node_modules, docs/build/POLISH.md).

Scope changes from the orchestrator mid-task: the editor lane owns every RevisionsModal / History / "what changed"
diff item (leader M3, M4; engineer M2's History half, M6, c8; c1's History colours/emoji). RevisionsModal.vue and
ChangesBanner.vue were not touched. API lane owns engineer m3 (view-link reader can edit/delete others' comments and
approve) and m4 (approval survives content changes) — not touched here.

## Regression tests (red on 8be2187, green after)
- `tests/e2e/items/qa-read-leader.test.mjs` — 13 tests (M1, M2, M5, m1, m2, m3, m4, m6, m7, c1/c7, c2, c3, c4).
- `tests/e2e/items/qa-read-engineer.test.mjs` — 11 tests (M1, M2-Share, m8, M3, m6, m5/c5, m9, c1, c3, c4, m1/m2/m10).
- Red proof: both files copied into a clean worktree of 8be2187 → `E2E_FILES=qa-read-leader,qa-read-engineer
  STACK_MODE=dev scripts/verify.sh --only e2e` → `0/24 pass, 24 fail` (several base failures are timeouts on the
  missing UI, e.g. no `prompt-dialog`, no `empty-doc-hint`; the assertion ones: labels overflow their foreignObject,
  slides-prev overlaps the canvas, "card says L3, not L3-5", "focus moved into the dialog", bar left 0 vs text 325,
  app-home-link ring …). Log: `.verify/qa/fixread/base-red.log` in this worktree.

## Findings → fixes
Leader
- **M1 tap-to-zoom (major)** — root cause: on touch the compatibility `click` lands ~9px from the touch point
  (pointerdown y=422, click y=431), so #15 rule 3's "≥5px = drag" check rejected every tap. `src/preview/zoom.ts`
  now measures travel pointerdown → pointerup (10px slop for touch, 5px mouse).
- **M2 / engineer M4 mermaid labels clipped in slides (major)** — mermaid measures label boxes off-screen, but its
  labels are `<p>` inside foreignObject and picked up `html.locus-theme .preview-pane p` (15 × --rpx; 24px in
  slides, also the #18 text size and phone 16px). `preview.css`: labels inherit font-size/line-height/colour/
  letter-spacing from mermaid's own SVG styles.
- **M5 landscape slide controls (major)** — `SlidesView.vue`: on a short viewport with ≥56px letterbox beside the
  full-height canvas, controls move into side rails (grid; exit/prev/notes left, fullscreen/next/counter right), no
  auto-hide; otherwise the old floating bar. Canvas still 390px tall (frozen landscape test unchanged).
- **m1 front matter** — decision: hidden for a view-link reader in publish mode (read/agent/embed + their
  print/export); kept for editors and in review mode (comment line anchors). `useMarkdown.renderWithHeadings({frontMatter})`,
  `PreviewPane` prop, DocView wiring. Logged in DECISIONS.md.
- **m2 rotate hint** — could not reproduce in dev (visible on slide 1 after Present via the sheet menu); covered by a
  regression test that runs in prod mode in the gate (green). It was red on base too.
- **m3 tap targets** — `(pointer: coarse)`: header controls 44px at every width (overrides the phone 40px), `.btn`
  min-height 44 (banners incl. changes-banner, dialogs, approval), slide buttons + rotate-hint close 44, reaction
  buttons 44, agent-notice Show 44, section-reaction chips/trigger get a 44px `::after` hit area without growing the
  heading line, TOC drawer buttons 44.
- **m4 Open file…** — only when no doc is open or for editors (`HeaderOverflowMenu.vue`).
- **m5 zoom opens at 32%** — kept: #15 rule 6 / AC-15.4 mandate fit as the initial scale; with M1 fixed, double-tap
  and pinch now reach it. "Copy source" kept for every reader (decision logged).
- **m6 author fills in dark** — `mermaidTheme.fixAuthorFillContrast()` after every render (preview, print copy,
  slides, offscreen HTML export): a label under 3:1 on its node's author fill switches to dark/white text.
- **m7 wide tables** — new lazy enhancer `src/preview/tableScrollHint.ts` sets `data-overflow=l|r|lr` on each
  `.table-scroll`; CSS fades that edge (screen only).
- **c1 / c7 heading chrome + collapse-all gap** — the "gap" was the link icon wrapping onto its own line under
  "Incidents this week". On touch the heading-anchor is now absolutely placed at the right end of the first line
  (44px box kept, DOM order and "last element child" unchanged). The trigger stays fully opaque (AC-24.8 requires opacity 1 on touch).
- **c2 hanging indent** — touch/narrow: the fold toggle sits in a 32px heading indent centred on the first line.
- **c3** — TOC drawer Collapse / Expand buttons show their word (aria-label unchanged).
- **c4** — no `-webkit-tap-highlight-color` flash; open menu triggers outlined in the accent; unseen dots use
  `--unseen-dot` (= accent) instead of #2563eb.
- **c5 letter-spacing** — not an app defect: the box has a locally installed variable `Montserrat[wght].ttf`
  (~/.fonts) that headless Chromium falls back to when Google Fonts doesn't arrive; renders correctly with the web
  font. Self-hosting fonts would remove the dependency (not done).
- **c6 print mid-word breaks** — kept #5's print rule (cells wrap anywhere) — break-word lets a 12-column table
  overflow A4 (AC-05.11 last-column check). Logged.

Engineer
- **M1 title vanishes at 1400px** — `DocHeader.vue` measures the bar (ResizeObserver + MutationObserver, synchronous
  before paint): level 1 moves doc-updated / badges / view-stats into doc-meta-row, level 2 shows Home, Library,
  Copy link as icons; the title keeps ≥160px (or its full width).
- **M2 Share focus** — `ShareModal.vue` uses `useFocusTrap` (opens on the first Copy, Tab cycles inside, focus back
  to Share or to the overflow button). History half → editor lane.
- **M3 triple-click range** — `PreviewPane.textExtent()` narrows the selection to the text it really selects (the
  triple-click range ended at offset 0 of the next heading), so card, highlight, prompt and "Needs attention" all say L3.
- **m1** — an empty doc in the read view shows "This document is empty. Start writing" (opens the editor). Start
  blank still lands in the read view (app.test asserts doc-title there).
- **m2** — a blank local doc (untitled.md) is renamed after its title (`capacity-plan.md`) until the user renames it.
- **m5** — the approval banner only asks for a name while the header has none ("as <name>" otherwise); the name
  used there becomes the header name.
- **m6** — one 2px accent focus ring for `.btn`, header controls and dialog controls.
- **m8** — PromptModal: role=dialog, aria-modal, labelled, focus trap, Esc closes, focus back to the overflow button.
- **m9** — the comments badge counts open comments, a ✓ when all are resolved.
- **m10** — paste flow button "Open document" (app.test selector updated — a pre-existing suite, not a frozen item test).
- **c1** — new `--status-*` tokens (Locus: brand green #00D273 / text #00703D, amber text #8A5300) used by the
  approval badge/buttons, resolved stripe, resolve/unresolve, notice warn; must-fix reds use `--cat-must-fix`. No
  existing token renamed. RevisionsModal left to the editor lane.
- **c2** — "Share to add images" dialog gets the header bar + ×, body and footer bar of the other dialogs.
- **c3** — Share-dialog copies use the clipboard fallback and the same "Link copied"/"Prompt copied" toast.
- **c4** — reaction bar aligned to the 50em reading column (its rule spans the column).
- **c5** — approval time is relative ("just now", "3 min ago"), exact time on hover.
- **c6** — the Review Summary's collapsed state is remembered per browser (default still expanded: qa-gate tests).
- **c7** — focus-mode cluster separated from the bar it floats over (same change as the editor lane; theirs kept on landing).

## Security (not fixed, for POLISH.md)
None found in this area.

## Blind re-check
Fresh general-purpose verifier (verifier.md, blind, prod stack, 20 min): 17/18 PASS, 0 regressions; reopened #6 —
the section-reaction trigger's extended hit area was 38×42. Fixed (`::after` is now a centred max(100%, 44px)
square) and the qa test tightened to probe ±21px around the centre. Report: `.verify/qa/recheck-read/REPORT.md`.

## Gate (prod mode, this worktree)
- `E2E_FILES=<qa-read-leader, qa-read-engineer, app, qa-gate-features, durable-sync, mermaid, tripleclick-selection,
  shared-mode, 01, 02, 03, 04-routes-pages, 05-mobile-layout, 05-print-title, 07, 10, 13, 14, 15, 16, 17, 18, 19, 23,
  24, 25, 28, 29> scripts/verify.sh --only typecheck,unit,build,e2e` → typecheck PASS, build PASS (218 chunks),
  e2e 511/512 (24-reactions AC-24.8: the trigger must be opacity 1 on touch — my 0.55 resting opacity reverted);
  unit 5 failed = `vite build failed` with empty stderr in 04-routes / 06-lazy-editor (box at ~0.9 GB free; a direct
  `NODE_ENV=test vite build` passed; re-run below green).
- `E2E_FILES=24-reactions, 06-lazy-editor, 06-fixes, 08-fixes, 08-sync-bugs, 08-undo-redo, 09-fixes, 13-fixes,
  23-fixes, 04-routes, 04-routes-extra, 21-upsert-by-key, selection-preservation, table-highlight, 12-slash-menu,
  11-table-paste, harness-smoke scripts/verify.sh --only unit,e2e` → **OVERALL PASS** (unit 639/639, e2e 176/179
  pass 0 fail).
- After the re-check fix: `E2E_FILES=qa-read-leader,qa-read-engineer,24-reactions,03-toc-anchors --only
  typecheck,e2e` → **OVERALL PASS** (58/58).
- Entry chunk (AC-06.8 measure, `NODE_ENV=test vite build`): 500,708 bytes vs the 574,644 cap (~74 KB headroom; was ~79 KB).
- Server untouched (no server step).

## Not done / handed off
- Editor lane: leader M3/M4, engineer History focus (M2 half), M5, M6, m7, c8, History parts of c1.
- API lane: engineer m3, m4.
- Leader m5 (initial 32% zoom) and c6 (print mid-word) kept by spec/decision; c5 is an environment font artifact.
