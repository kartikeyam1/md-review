# #27 Templates: fix round (implementer report)

Verdict: **DONE**. Worktree `/home/ubuntu/locus-repos/md-review-cap-library-27`. Nothing is committed.

Inputs: `27-review.md` (5 SHOULD-FIX, 10 NITs, 1 POLISH) and `27-qa.md` (D1, D2, D3). Every finding is fixed except the
POLISH item (logged) and D1 (a dependency, see below).

## Gate
Command (inside the lane flock):
`flock …/cap-library/lane-browser.lock env VERIFY_ITEMS=26,27 E2E_FILES=27-templates,26-library,06-lazy-editor-build,04-routes-pages,app scripts/verify.sh --only typecheck,unit,build,e2e,server`

Result: **OVERALL: PASS** in 258.6s (`.verify/runs/20261011-034941-3417656`).

```
typecheck PASS 0 errors · unit PASS 522 passed (522) · build PASS 178 js chunks ·
e2e PASS 98/99 pass, 0 fail, 1 skip (5 files) · server PASS 485/486 pass, 0 fail, 1 skip
e2e/27-templates 17/18 (the skip is the QA27_SHOTS screenshot test) · 26-library 16/16 ·
06-lazy-editor-build 6/6 (AC-06.8 entry budget holds) · 04-routes-pages 9/9 · app 50/50 ·
server/27-templates 38/38 · server/27-template-vars 22/22
```

No server timing test flaked, so nothing was re-run.

Note: because the standalone preview runs no enhancers, future enhancers (#14 code copy, #15 zoom) will not attach inside the picker preview either. That also removes the Esc-layering conflict the review describes, and Esc is now handled on the dialog in any case.

## SHOULD-FIX
1. **The picker preview drove the main router: fixed.**
   - `PreviewPane.vue` has a new `standalone` prop, and the picker passes it. With it set:
     - every link click is `preventDefault`ed; an in-page `#anchor` scrolls to its target inside the preview
     - no enhancers run (no section-link button, no reactions)
     - no URL-fragment alignment (markdown or html), and the frame's `anchor-changed` is ignored
   - Tests:
     - unit: `PreviewPane standalone …` (no heading-anchor; 3 link kinds prevented; URL unchanged), a control without `standalone`, and the html `anchor-changed` case (ignored when standalone, applied otherwise)
     - e2e: `the preview is inert: clicking an in-page anchor or a link in it leaves the picker open and the URL unchanged; no heading-anchor icons`
2. **Esc via a window capture listener: fixed.**
   - Both dialogs handle Esc with `@keydown` on the dialog element (preventDefault + stopPropagation, skipped when already defaultPrevented), as `LibraryConfirmDialog` does. The window listeners are gone.
   - Focus stays in the dialog: while busy, Create / Save / Replace use `aria-disabled` instead of `disabled`, the dialog has `aria-busy`, and it has `tabindex="-1"`, so a click on plain content keeps focus inside. Create / Save stay natively `disabled` only for an empty title or name, as AC-27.7 requires.
   - The Replace row stays on screen while a replace is in flight, so its focused button is not removed.
   - Tests (unit):
     - picker and save dialog: an Esc dispatched on `<body>` is not taken; Esc inside the dialog closes and stops at the dialog; an Esc that is already defaultPrevented is ignored
     - busy: Create is `aria-disabled`, keeps focus and sends no second request; Replace keeps focus
     - e2e: the existing Esc tests still pass
3. **Esc or Cancel during a create still navigated: fixed.**
   - A `closed` flag is set on unmount. If it is set, the create skips navigation and shows `toast.success('Created “X”', {action: Open → pushRoute(…, 'view=edit')})`. The edit token is already saved.
   - Test (unit): `closed while creating: no navigation; a success toast offers Open`.
4. **Library tablist without the ARIA tabs pattern: fixed.**
   - It is now `<nav aria-label="Library sections">` with two `<a href>` links. The current one has `aria-current="page"`. A plain click uses `router.push`; a modified click opens normally. The testid is kept.
   - Test (e2e): the AC-27.11 test now checks `aria-current="page"` and `href="/library?tab=templates"` on `library-tab-templates`, and no `aria-current` on Documents. It replaces the old `aria-selected` assertion in this #27 file.
5. **The save dialog did not close on navigation: fixed.**
   - It closes when the route identity changes (`current.key`) or on any Back/Forward (`source: 'pop'`).
   - A `?view=` rewrite on the same doc keeps it open. Watching `href`, as the picker does, would close it on `docState`'s automatic `view=read` rewrite.
   - Test (unit): `closes when the reader navigates to another page or presses Back; a query rewrite on the same doc keeps it`.

## NIT
- **Lazy landing page: fixed.**
  - New `src/components/lazyLanding.ts`. `lazyFileUpload()` starts the chunk when DocView sets up on the landing route, in parallel with boot.
  - `defineAsyncComponent` gets an `errorComponent` (`landing-load-error`: "This page could not be loaded." plus Reload).
  - The DocView hunk is now one import line plus one changed line.
  - Test (unit): `lazy landing`, which renders the error prompt.
- **Success toast link: fixed.**
  - The action keeps `href`, for middle-click and new tab, and adds `onClick: router.push`.
  - `AppToast.vue` now runs `onClick` on a plain click of a link action that has one. Modified clicks follow the href.
  - The DECISIONS line that justified `href` is corrected.
  - Tests (unit): `AppToast link action with onClick` and `success toast: a link to the Templates tab that navigates in-app`. The e2e AC-27.8 href assertion still holds.
- **Chunk-load failures: fixed.**
  - `templateEntry.ts` goes through `withTemplateHost(use, load)`. A rejected load shows `toast.error('Could not open templates. Reload the page.')`.
  - Tests (unit): `withTemplateHost` covers both the rejected and the resolved load.
- **Library chunk size: fixed.**
  - `LibraryView.vue` and `LibraryTemplates.vue` import `newFromTemplate()` / `newFromTemplateId(id)` from `templateEntry`. Nothing imports `templateHost` statically any more.
  - The build passes (see the gate).
- **Rename and delete: fixed.**
  - Blur no longer cancels a rename while its request is in flight. A failed rename keeps the box open and refocuses it.
  - Focus that fell to `<body>` after a rename, an Esc in the rename box, or a delete goes to the row's Use button. After a delete it goes to the next row, else the previous one. Focus the reader put elsewhere is left alone.
  - Tests (unit): 4 `LibraryTemplates` tests.
- **`applyTitleVar` edge cases: fixed.**
  - A fence line with an info string no longer closes a fence.
  - For html, comments, `<script>`, `<style>`, `<template>`, `<textarea>` and `<svg>` are blanked to spaces of the same length before the `<title>` / `<h1>` search, so offsets still index the original.
  - Tests (unit): 3 tests under `applyTitleVar edge cases`.
- **Preview a11y: fixed.**
  - The preview error uses `aria-live="polite"`, not `role="alert"`.
  - The variable chips are preceded by a visually hidden "Variables:" label.
  - Tests (unit): one for the error and one for the label.
- **Server performance: fixed.**
  - `variables` is computed on write and stored in `data_json`.
  - The list and the boot cleanup read rows with `json_remove(data_json,'$.content')`, guarded by `json_valid`, so content is never loaded for a list.
  - `byName` selects only `id, name` and loads just the matching row.
  - Rows written before this change fall back to scanning their content.
  - Tests (server, `#27 fix round`):
    - the stored list is checked in the DB
    - a legacy row and a corrupt row both list
    - the list carries no content
    - name checks still see a legacy row
- **e2e `waitForTimeout(300)`: fixed.** The test now waits for the route's own readiness: `pinned-revision-banner`, or the selected `file-tab[data-file="notes.md"]`.

## QA defects
- **D1, seeds render unstyled: not implemented (dependency).**
  - Callouts and `:rag-*` badges belong to #16, which the captain says is already on main. They will render once #27 is rebased onto main, because the preview and the doc both use the normal renderer.
  - The standalone preview still renders markdown-it plugins. It only skips the DOM enhancers, and #16 is a markdown-it plugin (00 §4.4), not an enhancer.
  - Nothing to change in #27. Re-check after the rebase.
- **D2, the clash message quoted the typed name: fixed.**
  - The 409 body now carries `name`, the existing template's name, and the dialog quotes it.
  - Replace keeps the existing name, so only content and fields change. Renaming is PATCH's job.
  - Tests:
    - server: `a 409 clash names the existing template; replace keeps its name …`
    - unit: `a clash quotes the existing template name …`
- **D3, heading-anchor icons in the preview: fixed** by `standalone`, which runs no enhancers. Tested in unit and e2e (see SHOULD-FIX 1).

## POLISH (logged, not implemented)
- Html template previews run the author's scripts. The fix is `sandbox=""` for template previews. This is appended to `docs/build/POLISH.md` under `## #27`.

## Files
- **#27-owned:**
  - `TemplatePicker.vue`, `SaveTemplateDialog.vue`, `LibraryTemplates.vue`
  - `templateEntry.ts`, `templateLogic.ts`, `useTemplates.ts`
  - new `lazyLanding.ts`
  - `server/routes/templates.cjs`
  - tests: `tests/items/27-templates-fix.test.ts` (new, 24 tests), `tests/e2e/items/27-templates.test.mjs`, `server/test-items/27-templates.test.mjs` (2 new tests)
- **Shared, not owned by #26:**
  - `PreviewPane.vue`: the `standalone` prop, 5 guarded spots
  - `AppToast.vue` + `useToast.ts`: a link action with `onClick`
- **#26-owned files, #27 hunks only:**
  - `LibraryView.vue`: the import line, the From template click, and the sections nav with its 2 CSS lines
  - `DocView.vue`: 1 import line plus the `const FileUpload` line
- **Not touched this round:** `HeaderOverflowMenu.vue`, `LibraryConfirmDialog.vue`, `FileUpload.vue`.

## Test changes
- **FROZEN TEST CHANGES:** none. The #27 e2e file was written by the #27 implementer, not frozen ahead of time.
- **Changes to the existing #27 e2e file:**
  - AC-27.11 now checks `aria-current` in place of `aria-selected`, because the tablist became a nav (SHOULD-FIX 4).
  - The `waitForTimeout(300)` is replaced by a readiness wait.
  - One new test for the inert preview.

## Decisions
- Three existing `- #27:` lines were corrected:
  - the 409 shape and replace keeping the name
  - Esc on the dialog
  - the sections nav and the toast link
- Eight new `- #27:` lines were appended:
  - the standalone preview
  - no navigation after the picker closed
  - when the save dialog closes
  - stored variables
  - templateEntry for the library, plus the load-error toast
  - the lazy landing preload and error component
  - Templates tab focus
  - the `applyTitleVar` edge cases
