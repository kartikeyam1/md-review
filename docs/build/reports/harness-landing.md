# Harness-speed landing onto feat/view-share

**Verdict: DONE.** The full gate is green on `fb3c2af` plus the patch: OVERALL PASS in 558 s.
- e2e: 344/347 pass, 0 fail, 3 todo (24 files). The 3 todo are pre-existing, in `08-undo-redo`.
- server: 321/324 pass, 3 skip.
- unit: 323/323. typecheck: 0 errors. teardown: 0 stray processes.
- Logs: `.verify/runs/20261010-203114-2606215/logs/`.
- Nothing is committed and nothing is staged. `git apply -3` had staged the files; I unstaged only my paths with `git restore --staged`.
- The untracked 03-*, 05-* and `POLISH.md` files were left alone. `src/composables/pasteApi.ts` is a new untracked file and belongs to this change.

The patch's design and its measurements are in `md-review-hspeed/docs/build/reports/harness-speed.md`: e2e against a production build via `vite preview` with the backend URL injected at serve time, and fixed sleeps replaced by condition waits.

## How it was applied
`git apply -3 scratchpad/harness-speed.patch`: 10 files merged cleanly and 6 conflicted. All 6 were resolved by keeping everything that landed in the meantime:
- **`scripts/verify.sh`**
  - #6's `check-lazy-editor.mjs` stays in the build step and now runs on `--dist "$DIST_DIR"`, the per-run build.
  - A failed lazy-editor check also marks the dist unusable, so e2e rebuilds instead of serving it.
  - #23's `MCP_TOKEN_STORE` export is kept (it merged cleanly). The help line range is updated.
- **`vite.config.ts`:** #1's `cacheDir: process.env.VITE_CACHE_DIR` is kept, next to the new `runtimeApiInjection()` plugin.
- **`scripts/lib/stack.sh`** (merged cleanly)
  - #1's per-worktree `VITE_CACHE_DIR` is kept on the dev server (`STACK_MODE=dev`). Preview doesn't use the dep optimizer, so it doesn't need it.
  - The preview server's log is now `vite-preview.log`, so it no longer shares `vite.log` with a dev server running in the same run (see below).
- **`src/composables/useShare.ts`:** #23's `useEditToken` import and the `pasteApi` import both stay. A grep confirms every API-URL read (`useShare.ts`, `DashboardView.vue`, `FileUpload.vue`) now goes through `PASTE_API` from `src/composables/pasteApi.ts`. Nothing else reads `VITE_PASTE_API_URL`. #23 added no new direct env reads.
- **`tests/e2e/app.test.mjs`**
  - #6: `switchToEdit` keeps its 20 s wait for the lazy editor to mount. The fixed 500 ms after it is replaced by waiting for a visible `.cm-line`.
  - #1: the theme semantics are kept (the toggle flips light/dark within a style, and the Style menu switches style). All `.btn-icon` click + sleep pairs became `cycleTheme()`.
  - #1's `chooseThemeStyle()` lost its 300 ms sleep. It now waits for the `<html>` class that style produces (`github-theme` / `locus-theme` / neither, from `useTheme.ts`) plus transitions.
  - The mermaid github-dark test keeps #1's Style-menu route and polls for the re-themed SVG.
  - The 3 bounded waits for negative assertions remain, as before.
- **`tests/e2e/harness-smoke.test.mjs`:** #6's assertions (the read view loads no CodeMirror, and Edit loads it) are kept and made to work in both modes:
  - URL pattern `/codemirror|EditorPane/i` (the item-06 AC pattern), plus a check for `@codemirror/view`'s base-theme string `&light .cm-content` in the loaded scripts' source.
  - That check is negative before Edit and positive after it. The negative check is therefore real on a build, where chunk names don't say "codemirror".
- **`tests/e2e/selection-preservation.test.mjs`:** #6's 20 s lazy-mount wait is kept. The sleep after it is replaced by waiting for `.cm-line:nth(2)`.
- **#23's test helpers** (`legacy-docs.mjs`, the edit-token jar) were not affected.

## What the full gate turned up, and the fixes
1. **`06-lazy-editor`, 2 failures on the production build.**
   - AC-06.5 counted `EditorPane-<hash>.css` as a second "EditorPane chunk". The test filters only dev's `?type=style`.
   - AC-06.6 blocks the editor by its dev module URLs, so blocking never matched on a build and the retry never mounted.
   - **Diagnosis:** this file is written against the dev server by design. Its build-mode twin is `06-lazy-editor-build`, which passes on the build. Both are frozen item tests.
   - **Fix (harness, test untouched):** verify.sh gained `E2E_DEV_FILES`, default `06-lazy-editor`. Listed files run against a vite dev server on the same backend, started lazily and only if such a file is in the run. The summary marks them `(dev)`. Documented in `--help` and `BASELINE.md`.
   - Result: 13/13 (dev) and `06-lazy-editor-build` 6/6.
2. **`durable-sync`, "changes since you last looked": 1 failure in 1 run.** It timed out after 5 s waiting for `diff-table`, while the box's load average was 10.5 from other agents.
   - This test and that timeout predate this patch and were not changed by it.
   - It passed in every other run: 2 standalone reruns, and both later full gates.
   - **Read:** a load-sensitive 5 s timeout around the lazy RevisionsModal chunk, its two revision fetches and the async diff. Not fixed; flagged as a possible flake.
3. **Server timing tests: 2 failures in 1 run, at load average 30.**
   - `test-meta-units` "pathological 1 MB inputs under 50 ms" measured 100.8 ms.
   - `23-mcp-tokens` AC-23.12 hit "fetch failed: other side closed".
   - The server code is not touched by this patch. Both passed on the rerun once load fell below 5. Flagged as load-sensitive.

## Gate runs (all with `VERIFY_ITEMS=`, i.e. LANDED = 4,20,22,2,6,23,8,9,1)
| Run | Result | Total | 1-min load average, mean / max | Notes |
|---|---|---|---|---|
| landing1 | FAIL | 498 s | 1.5 / 4.3 | `06-lazy-editor` 11/13 (fixed: `E2E_DEV_FILES`) |
| landing2 | FAIL | 566 s | 5.1 / 10.6 | `durable-sync` 10/11 (flake, see above) |
| landing3 | FAIL | 728 s | 7.7 / 31.4 | e2e 344/347 green; 2 server timing tests failed at load 30 |
| **landing4** | **PASS** | **558 s** | 5.8 / 9.5 | full gate green |

For comparison: on `f337dd6` with 13 e2e files, the gate took 538 s. With 24 e2e files now, e2e takes about 490 s.
