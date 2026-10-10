# #1 Locus theme — implementation report

Lane: `/home/ubuntu/locus-repos/md-review-vs-theme`, branch `lane/theme` at f337dd6 (uncommitted).
Patches (scratchpad `s01/`): `01a-extract.patch` (no-behaviour-change CSS extraction) then
`01-feature.patch`, both against f337dd6, verified by applying in order to a clean f337dd6 worktree
(31 files, byte-identical to the lane). Frozen tests `tests/e2e/items/01-locus-theme.test.mjs`
and `tests/items/01-locus-theme.test.ts` are untouched and not part of the patches.

## Gate
`VERIFY_ITEMS=1 scripts/verify.sh` (run 20261010-192023-2443975): **PASS** — typecheck 0 errors, unit 198,
build 167 chunks, e2e 230/230 (14 files; 01-locus-theme 63/63, durable-sync 11/11), server 244/245 (1 skip).
01a alone on f337dd6: typecheck / unit (176) / build PASS. Before/after screenshots of the extraction
(4 Default/GitHub themes × desktop/phone, full page) were byte-identical.

## What #1 adds
- `ThemeMode` + `ThemeStyle`; `useTheme.ts` pure helpers (`ALL_THEMES`, `isDark/isGithub/isLocus/themeStyle/themeFor/toggleDark`,
  `applyTheme` sets `locus-theme` + `data-theme-style`); `THEME_CYCLE`/`nextTheme`/`THEME_META` removed.
- Persistence: all theme storage access in try/catch; inline `<head>` boot script in `index.html` applies the stored
  theme before first paint (`tests/composables/themeBoot.test.ts` runs it against `applyTheme()` for every value).
- `ThemeSwitcher.vue` (toggle + Style AppMenu) in the doc header and in a slim `app-bar` on library / not-found.
- Locus tokens + chrome in `src/style.css`; Locus preview rules in `src/styles/preview.css` (tokens only, no hex);
  new tokens `--accent-text`, `--text-meta`, `--table-head-bg/fg`, comment-category pairs `--cat-*` / `--cat-*-on`.
- Mermaid: Locus `base` theme with series colours, bold deep-purple pie labels, branded notes and xy charts.
- Iframe bridge: `__mdreview_style` → `data-theme-style` on the frame `<html>`; no CSS injected.
- Fix round: CodeMirror caret follows `--text-primary` (was black in dark themes); review-mode contrast tokens;
  nested quotes; library heading/Refresh layout; Locus selection colour.

## This round: the two main-worktree failures
1. **AC-01.9 / rule 12 "0 legend swatches" — root cause is gate infrastructure, not the theme.** Every worktree's
   `node_modules` is a symlink to the main worktree's, so all concurrent vite dev servers (one per verify run, across
   agents) shared `node_modules/.vite/deps`. When another server re-optimised it, the running server's lazy mermaid
   chunks 404'd: my own failing run rendered `Failed to fetch dynamically imported module …/pieDiagram-….js?v=…`
   in place of the pie and xy chart (old mermaid.run draws an error SVG there — hence "SVG present, 0 swatches").
   Fix: `vite.config.ts` `cacheDir: process.env.VITE_CACHE_DIR`, and `scripts/lib/stack.sh` sets it to
   `<worktree>/.verify/vite-cache`. Verified: the next full gate passed with the per-worktree cache in use.
   Also hardened rendering: diagrams are drawn off-DOM (`mermaid.render`) and swapped in with one assignment, skipped
   when source + theme config are unchanged, so a re-render never empties a diagram; renders stay serialised.
2. **durable-sync "changes since you last looked … clears it" — a real, pre-existing (#2) race, load-dependent.**
   Passed 3/3 under a browser slot in this worktree. Root cause: `RevisionsModal` is a lazy chunk
   (`defineAsyncComponent`); if the reader clicks View changes before the chunk has loaded, the modal mounts
   already visible and its non-immediate `visible` watcher never runs, so no diff is loaded. Reproduced
   deterministically by holding the chunk request (diff-table never appears); after making the watcher
   `immediate` (plus a load-sequence guard so only the latest overlapping load writes) the same repro passes.
3. A one-off `server/test-meta-units` 50 ms perf assertion failed once (59.2 ms) during a loaded run; it passed in
   the final gate. Not touched.

## Pre-existing tests changed (spec-listed)
`tests/composables/useTheme.test.ts` (new helpers); `tests/e2e/app.test.mjs` (2nd toggle → light; cycle test →
toggle + Style menu; GitHub reload / github-dark mermaid via the Style menu). Frozen-test changes: none.

## Decisions
All appended to `docs/build/DECISIONS.md` under "Implementation decisions" (#1 lines), including the token scheme,
category colours, boot script, AppMenu additions (CSS radio dot, per-entry `attrs`, `menuLabel`), Style-menu hit
area, mermaid rendering, `:root .preview-pane` specificity in 01a, Montserrat 300 kept (frozen test asserts the axes),
RevisionsModal race and the per-worktree vite cache.

## Screenshots checked
`.verify/screens/01/doc/` (locus-light/dark top, quote-code, diagrams, menu-open), `landing/locus-dark-desktop`,
`html-doc/locus-light-tablet`, and review-mode / library / not-found captures in scratchpad `s01/shots2/`.
Open nit for the visual verifier: Default light/dark comment-category fills changed to tokens (dark themes now use
light hues with dark text).
