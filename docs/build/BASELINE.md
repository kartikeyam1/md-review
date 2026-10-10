# Verification baseline (Phase 0)

Recorded 2026-10-10 on `feat/view-share` @ `65d5a29` plus the Phase 0 harness changes
(the feature itself is unchanged). Host: 4 CPU, ~4.7 GB free RAM, Node v26.8.2, Playwright 1.58.2 (Chromium 1208).

## How to run

```bash
scripts/verify.sh                       # everything, run-all-and-report
scripts/verify.sh --fail-fast           # stop after the first failing step (or VERIFY_FAIL_FAST=1)
scripts/verify.sh --only unit,e2e       # subset (or VERIFY_ONLY=unit,e2e); steps: typecheck unit build e2e server
E2E_FILES=app,shared-mode scripts/verify.sh --only e2e   # subset of e2e files
node scripts/screens.mjs                # screenshot matrix -> .verify/screens/
```

The summary goes to stdout and `.verify/last-summary.txt`, and per-step logs go to `.verify/logs/`. The exit code is non-zero if any step fails.
e2e runs against a throwaway backend and vite dev server on free ports, with the backend on a fresh temp data dir. The server tests get a second throwaway backend with `REVISIONS_MAX=5`, so the retention test runs instead of skipping.
Browser steps hold `flock /tmp/md-review-viewshare-browser.lock`.

## Results: two consecutive full runs, both green

| Step | Run 1 | Run 2 |
|---|---|---|
| typecheck (`vue-tsc -b --noEmit`) | PASS, 0 errors, 0.3 s | PASS, 0 errors, 0.2 s |
| unit (`vitest run`) | PASS, 108/108, 3.6 s | PASS, 108/108, 2.9 s |
| build (`vite build`) | PASS, 167 js chunks, 8.1 s | PASS, 167 js chunks, 8.4 s |
| e2e/app | 50/50, 181.1 s | 50/50, 180.2 s |
| e2e/durable-sync | 11/11, 55.6 s | 11/11, 55.5 s |
| e2e/harness-smoke (new) | 5/5, 5.3 s | 5/5, 5.5 s |
| e2e/mermaid | 4/4, 13.0 s | 4/4, 13.1 s |
| e2e/qa-gate-features | 16/16, 22.0 s | 16/16, 22.0 s |
| e2e/selection-preservation | 3/3, 12.3 s | 3/3, 12.3 s |
| e2e/shared-mode | 2/2, 10.9 s | 2/2, 11.0 s |
| e2e/table-highlight | 1/1, 5.0 s | 1/1, 4.9 s |
| e2e/tripleclick-selection | 3/3, 9.5 s | 3/3, 9.4 s |
| **e2e total** | **95/95, 0 skip, 315.6 s** | **95/95, 0 skip, 314.9 s** |
| server/test-mcp-sessions | 4/4 | 4/4 |
| server/test-mcp | 16/16 | 16/16 |
| server/test | 46/46 (0 skipped) | 46/46 (0 skipped) |
| **server total** | **66/66, 4.3 s** | **66/66, 4.1 s** |
| teardown | 0 stray processes | 0 stray processes |
| **Overall** | **PASS, 331.8 s** | **PASS, 330.4 s** |

Without `harness-smoke`, the pre-existing e2e suite is 90/90.

## Known-failing tests

None. Every existing e2e and server test passed on both runs, with no retries.

## Fixed during Phase 0 (harness/environment, not app code)

- **Unit baseline was red (9 failures in `useReviewer`/`usePersistence`).** Node ≥ 25 defines
  `localStorage`/`sessionStorage` accessors on `globalThis`. Without `--localstorage-file`, they return
  `undefined` and emit a warning. Vitest 3.2's jsdom environment copies a window key onto the global
  only when that key is not already `in global`, unless the key is on its allow-list, and Storage is not on it. So Node's
  empty getters shadowed jsdom's Storage. Fix: `tests/setup/jsdom-storage.ts`, wired in through
  `test.setupFiles`, re-points both globals at the jsdom window's Storage. The fix is harmless on Node 20 (CI).
- **vite dev crashed with `EMFILE` on `fs.watch` on this host.** About 120 leaked `dbus-daemon` processes hold
  inotify instances against the 128 limit. `vite.config.ts` now honours `VITE_NO_WATCH=1`
  (`server.watch: null`), and `scripts/lib/stack.sh` sets it. A one-shot test server needs no HMR, and the default behaviour is unchanged.

## Observations for later phases (not failures)

- At phone width (390 px), the local editor view squeezes the document column to about 80 px next to the
  comments sidebar (`.verify/screens/local/*-phone.png`).
- Typecheck is incremental (`-b` uses `*.tsbuildinfo`). A deliberately introduced type error was caught
  (step FAIL, exit 1).
- e2e runs on vite **dev**, because the `?filePath=` loader is dev-only. `tests/e2e/lib/network.mjs` therefore sees
  per-module URLs (`/node_modules/.vite/deps/@codemirror_*.js`) rather than build chunks. The build in
  `.verify/dist` is available for chunk-size checks.
