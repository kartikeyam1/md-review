# Lane captain report — lane/controls: #18 reader font size + width, #19 downloads

Worktree `/home/ubuntu/locus-repos/md-review-cap-controls`, base `f5d2850`. Work left uncommitted.
Patches (19 applies on 18, 18 on base), verified by applying in order to a clean `git worktree add --detach f5d2850`:
`…/scratchpad/cap-controls/18.patch`, `…/scratchpad/cap-controls/19.patch`.

## #18 Reader font size + content width

- **Tests written first** (no frozen tests existed): `tests/items/18-font-width-control.test.ts` (10 unit: AC-18.15 + storage/root application),
  `tests/e2e/items/18-font-width-control.test.mjs` (16 e2e: AC-18.1–18.14, #13 focus-mode width, rapid-click/carry-over edge).
  At base they fail for the right reason (unit: `useReaderPrefs` missing; e2e 0/16, the testids/controls do not exist).
- **ACs:** 18.1–18.15 all pass (e2e 16/16, unit 10/10).
- **QA (blind):** PASS, all ACs. Minors: theme toggle closed the panel → fixed (toggle restyles the open panel in place, test added);
  AC-18.9 literal "iframe box = main pane" is untrue because of #24's reaction bar → test checks width span + box unchanged by prefs (decision logged);
  phone Esc focus → overflow button (decision logged).
- **Review:** PASS, no blockers. Should-fix: Esc swallowed by the closed button → fixed (+test); `--rpx` vs em → decision logged.
- **Fix found by the gate:** the #6 entry budget (AC-06.8, measured under NODE_ENV=test; the worktree path length changes the byte count) was blown
  by the first implementation (+2.5 KB). Redesigned: prefs act through `<html>` (`--reader-scale`, `data-reader-width`, set before first paint by a
  second inline script in index.html), pane attributes mirrored by a lazy enhancer (`src/preview/readerState.ts`), panel + composable + overflow item lazy.
  #18 now costs ~0.6 KB of entry.
- **Frozen-test change:** `tests/e2e/items/17-collapsible.test.mjs` AC-17.2 text walker rejected text under any `[data-testid]` ancestor; #18 rule 6
  mandates `data-testid="preview-pane"` on the pane → excluded that testid (one selector). Logged in DECISIONS.md.
- **Decisions:** calc(N × `--rpx`) sizing (exact 100% sizes), GitHub base 16px per spec, prefs on `<html>`, print resets scale, toggle keeps panel open, AC-18.9 reading.

## #19 Downloads

- **Tests written first:** `tests/items/19-downloads.test.ts` (15 unit: AC-19.3 filenames + edge cases, export DOM clean-up, document assembly,
  chrome-CSS stripping, image inlining incl. cap/Content-Length, theme-aware diagram wait), `tests/e2e/items/19-downloads.test.mjs`
  (18 e2e: AC-19.1, 19.2, 19.4–19.16, busy/double-click, theme switched just before export, edit/split unsaved content, PDF from edit view, all 6 themes).
  At base: unit fails (module missing), e2e 0/17.
- **ACs:** 19.1–19.16 all pass.
- **QA (blind):** PASS, no blocker/major. Minors fixed: tablet overflow rows 31px → 44px; `dot.` → `dot.md`; export task-list checkboxes disabled.
  Export ignoring #18 settings → product call: export/print are 100% (logged). Out-of-scope security finding (live preview runs raw-HTML `onerror`) → `docs/build/POLISH.md`.
- **Review:** PASS, no blockers. Fixed all: theme switch just before export now waits for diagrams drawn for the current theme (`data-rendered-key`);
  off-screen render host removed on failure; PDF from edit view returns to the edit view; Content-Length checked before downloading past the 15 MB cap;
  `inlineImages` unit tests; AppMenu `triggerAttrs` prop replaces the querySelector hack; one shared mermaid render queue (`mermaidJob`) removes the
  global-initialize race.
- **Frozen-test changes:** none.
- **Decisions:** icon-only desktop trigger; inert-document copy of the live preview (no image refetch) or off-screen render in edit view; all scripts/handlers stripped;
  chrome CSS rules dropped from the inlined CSS; page background = reading surface; pinned names from `docMeta.filename`; busy semantics; 44px sheet rows; mermaidTheme.ts extracted.

## Entry budget
`NODE_ENV=test vite build` entry: base 572,976 B, now 574,148 B in this worktree (cap 574,644; ~100 B less in the shorter main-worktree path).

## Gate
`VERIFY_ITEMS=18,19 E2E_FILES=18,19,app,mermaid,table-highlight,qa-gate-features,01,02,03,04-routes,05-mobile-layout,05-print-title,07,13,14,15,16,17,23,24,25 scripts/verify.sh --only typecheck,unit,build,e2e` → OVERALL PASS (402 s): typecheck 0 errors, unit 535/535 (incl. AC-06.8), build OK, e2e 425/425 across 22 files (18: 16/16, 19: 18/18). Logs `.verify/runs/20261011-003734-3089629/logs/`. Server untouched (no server step).
