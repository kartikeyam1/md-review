# #26 — Library page (FE) — implementer report (lib26)

Worktree `md-review-cap-library`, branch `lane/library`. Not committed.

## Files

### New
- `src/composables/libraryQuery.ts`: pure URL state (rule 2).
  - `parseLibraryQuery` / `serializeLibraryQuery`, with a fixed param order and invalid values dropped.
  - `searchTerm`: queries under 2 characters are ignored.
  - `hasActiveFilters`, `sortOptions`, `effectiveSort`.
  - `apiQuery`: `updated=7d|30d|90d` → `updated_after` ISO.
- `src/composables/useRecent.ts`: localStorage `md-review-recent`.
  - Pure `addRecent`, `removeRecent`, `parseRecent`.
  - Entries are `{id, slug, title, viewedAt}`, de-duplicated by id, max 20; the library shows 8.
- `src/composables/useLibrary.ts`: data and mutations.
  - Data: `/library/docs` paging, the pinned section via `?pinned=1` (srv26 added it at my request), collections and tags.
  - Mutations: pins, tags, collections, bulk with `editTokens`.
  - Pure helpers: `virtualRange`, `bulkOutcome`, `countLabel`, `rowCanEdit`.
  - Every mutation refetches what it changed.
- `src/components/LibraryView.vue`: the page.
  - Header: count, reviewer name, theme switcher, New document.
  - Search: 250 ms debounce, `replaceState`, Esc clears.
  - Sort and filters push history.
  - Sections: recent, then pinned.
  - Virtualised list: fixed row heights, a window ≤ 120 − pinned rows, and a sentinel at the end plus a `library-load-more` button.
  - Bulk bar (tag / move / delete), empty/error/loading states.
  - Phone filters sheet: focus trap, Esc closes.
- `LibraryRow.vue` (a row on desktop, a stacked card on phone; inline tags), `LibraryFilters.vue`, `LibraryCollections.vue` (AppMenu with rename/delete, inline create with error), `LibraryConfirmDialog.vue` (modal, focus trap, Esc).
- Tests:
  - `tests/e2e/items/26-library.test.mjs`: 16 tests covering AC-26.1–26.14.
  - `tests/e2e/items/26-library-lib.mjs`: private-backend helper, see below.
  - `tests/items/26-library.test.ts`: 16 unit tests.

### Changed
- `src/App.vue`:
  - Mounts `LibraryView`, async, as its own chunk. Without that, AC-06.8's entry budget failed: the entry was 632,957 B, over the 574,644 B budget; it is now 536,712 B.
  - Records recent docs: a watcher on `onScreen` + `pasteId` + `docTitle` + `slug` for `/d/:slug` only.
  - Calls `POST /library/pins/merge` when the reader name goes from empty to set.
  - `.app` uses `min-height` so the document scrolls.
  - The app bar now shows on not-found only.
- `src/components/FileUpload.vue`: landing `nav-library` link ("Browse the library →").
- `src/types/index.ts`: dropped `'dashboard'` from `AppMode` (unused).
- **Deleted** `src/components/DashboardView.vue`. The deletion is unstaged and only in the working tree.

## Test design notes
- The library lists every doc in a backend, so the e2e file starts private backends: `server/server.cjs` on a free port (never 3100/3200/58747) with a temp `DATA_DIR`.
  - `context.route` rewrites the app's calls to the shared API origin onto the private backend.
  - The counting tests (AC-26.1/5/13 and AC-26.12 with 600 docs) each get a fresh backend.
- AC-26.13 "API down" uses `page.route`: once with a 503 response, once with an aborted request.
- AC-26.12 scrolls the whole list, collecting ids. A MutationObserver records the maximum number of `library-row` elements ever in the DOM.

## Pre-existing test changes
- `tests/e2e/qa-gate-features.test.mjs`, dashboard block per 00 §11:
  - The session is created with `mode:"review"`.
  - The test asserts the `/library?mode=review` redirect, `library-page`, `library-row` and that only review badges show.
  - A row click navigates to `/d/…`.
- `tests/e2e/items/04-routes-extra.test.mjs` lines 342/353/362/366. These are item #4 tests not listed in 00 §11, but they used `.session-card` / `.dashboard`, which no longer exist.
  - I widened the selectors to `[data-testid="library-row"], .session-card` and `[data-testid="library-page"], .dashboard`, the same form AC-04.9 already uses. No assertion changed.

## FROZEN TEST CHANGES
None. No frozen tests existed for the FE half.

## AC-26.3
- First pass: the server stripped inline HTML from markdown snippets, so the real path could not show the markup.
- The captain had srv26 change that: `snippetText` now keeps raw inline HTML as text.
- The real-path test now asserts:
  - the literal `<img src=x onerror=alert(1)>kumquat`;
  - no `img` element;
  - the hit is `kumquat`.
- It also keeps the stubbed-response case.

## Decisions appended (DECISIONS.md, `- #26: …`)
Five lines:
- fixed row heights and the cap;
- clear-filters keeps a chosen sort, and a one-character q is ignored;
- the reviewer name in the library header, with the merge running on any page;
- row click semantics, and bulk `not_found` counting as done;
- when the recent list records.

## Screenshots
`.verify/qa/26/`:
- `{light,dark,github-light,github-dark,locus-light,locus-dark}-{desktop,phone,phone-sheet}.png`
- `{light,locus-dark}-{search,bulk}.png`

I looked at light desktop and phone, dark desktop, locus-dark search, github-dark phone sheet and light bulk. Tokens only, no horizontal overflow, and the cards stack title, then badges + updated, then tags.

## Gate (final)

Command:
`VERIFY_ITEMS=26 E2E_FILES=26-library,qa-gate-features,04-routes,04-routes-pages,04-routes-extra,05-mobile-layout,05-print-title,25-view-analytics scripts/verify.sh --only typecheck,unit,build,e2e`

Result (`.verify/runs/20261010-231637-2958667`):

```
typecheck PASS · build PASS 174 chunks
e2e PASS 137/137 (8 files): 26-library 16/16, qa-gate-features 16/16, 04-routes 21/21, 04-routes-pages 9/9,
  04-routes-extra 23/23, 05-mobile-layout 24/24, 05-print-title 17/17, 25-view-analytics 11/11
unit FAIL: load timeouts in that run
```

Re-run of unit alone at low load (`.verify/runs/20261010-232829-2977200`): `1 failed | 481 passed`.

The one failure is AC-06.8, entry 580,767 B against a 574,644 B budget. It is **not from #26 library code**. Measured on a clean HEAD copy with the test's env (`NODE_ENV=test`):
- HEAD alone: 570,793 B.
- HEAD + every lib26 file (App.vue, FileUpload, types, useRecent, libraryQuery, useLibrary, Library*.vue; DashboardView deleted): **571,938 B** (+1,145 B), within budget.
- The remaining ~8.8 KB comes from files26's static entry imports (`useSessionFiles` in DocView, plus the DocView/useDocLoader/docState changes).

I told files26, with a repro command and the suggestion to move the file helpers into their async chunks.

Note: plain `vite build` under-reports this test's number (528 KB vs 581 KB), because the test builds with NODE_ENV=test.

## Update: unit green after the files26 fix
files26 moved the session-file helpers into a lazy chunk. The entry is now 574,039 B, against a 574,644 B budget.
Re-run `VERIFY_ITEMS=26 scripts/verify.sh --only typecheck,unit` (`.verify/runs/20261010-233907-2990231`):
- typecheck: PASS
- unit: PASS, 482/482

Combined with the e2e run above (137/137), every step of the targeted gate is green, but across two runs: e2e was not repeated after the files26 change.
The entry has only ~600 B of headroom left; anything new in the entry graph must be async.
