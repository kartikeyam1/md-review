# #27 Templates: FE half and server review fixes (implementer report)

Verdict: **DONE**. Worktree `/home/ubuntu/locus-repos/md-review-cap-library-27`. Nothing is committed.

## Gate
Command:
`flock …/lane-browser.lock env VERIFY_ITEMS=26,27 E2E_FILES=27-templates,26-library,06-lazy-editor-build,04-routes-pages scripts/verify.sh --only typecheck,unit,build,e2e,server`

Result: **OVERALL: PASS** (`.verify/runs/20261011-024342-3282252`)

```
typecheck PASS 0 errors · unit PASS 498 passed (498) · build PASS 177 js chunks ·
e2e PASS 47/48 pass, 0 fail, 1 skip (4 files) · server PASS 483/484 pass, 0 fail, 1 skip
e2e/27-templates 16/17 (the skip is the screenshot test, gated on QA27_SHOTS=1) · 26-library 16/16 ·
06-lazy-editor-build 6/6 · 04-routes-pages 9/9 · server/27-templates 36/36 · server/27-template-vars 22/22
```

The landing page became lazy, so I also ran the suites that touch it:
- Command: `E2E_FILES=app,02-reading-mode,04-routes,05-mobile-layout,04-routes-extra,08-undo-redo,08-sync-bugs`
- Result: **PASS** 160/163, 0 fail (`.verify/runs/20261011-024614-3296258`).

The screenshot run was `QA27_SHOTS=1 … E2E_FILES=27-templates`: 17/17 (`.verify/runs/20261011-024252-3280178`).

AC-06.8 entry bytes, measured as the test measures them (NODE_ENV=test):
- before #27 FE: 574,147
- with the entry points but FileUpload still static: 574,891, which is over the 574,644 budget
- final: **569,895**

The `__file` paths in a test build make this number depend on the length of the worktree path, about 3 B per entry component for each extra character.

## Part A: server review fixes (27-review-server.md)
- **SHOULD-FIX 1:** `session-rows.cjs` `decodeMeta` now decodes `sessions.from_template_json` into `meta.from_template`. `from_template` is in `COLUMN_OWNED`, and instantiate no longer writes the meta key.
  - Test: a meta PUT that omits the key, and one that forges it, both leave provenance intact, and `POST /paste` cannot set it.
- **SHOULD-FIX 2:** `POST` and `PATCH /templates` with an unknown `collectionId` now return the same `unknownCollectionError` shape as render and instantiate: `{error, code, available}`. Tested.
- **NIT, builtin order:** builtins are listed in manifest order, from the manifest position recorded by `upsertSeeds`. Tested.
- **NIT, MCP 404:** `create_from_template` maps a 404 during instantiate to `Template "<name>" no longer exists…`. Tested with a stub fetch.
- **NIT, PATCH:** the builtin and existence checks now run before the body parse, so invalid JSON sent to a seed returns 403. Tested.
- **NIT, collection deleted mid-create:** instantiate re-reads the collection inside the transaction, and a vanished one means the doc is filed as unfiled. There is no test, because it is a race.
- **NIT, seed name clash:** the boot upsert warns when a user template holds a seed's name. Tested by booting on a data dir that has a clashing row.
- **POLISH:** the 4 items are recorded in `docs/build/POLISH.md` under `## #27` and not implemented.

## Part B: FE
New files:
- `src/composables/templateLogic.ts`, pure:
  - `applyTitleVar`: markdown first `# ` heading outside fences; html `<title>` and first `<h1>`.
  - `orderTemplates`, `filterTemplates`, `showTemplateFilter` (> 8), `collectionChoice`.
  - The 1 MB check, `apiErrorText`, `themeFromRoot`.
- `src/composables/useTemplates.ts`:
  - The `/templates*` API with `{ok, status, data}` results; status 0 means offline.
  - Instantiate stores the returned edit token through `saveToken` (#23).
  - The IANA timezone is sent with render and instantiate.
- `src/components/TemplatePicker.vue`:
  - List view: badge, type, mode, variable chips, and a filter box when there are more than 8 templates.
  - Form view: title, collection, author, and a 300 ms debounced dry-run preview rendered by PreviewPane.
  - Create navigates to `/d/<slug>?view=edit`. Any failure shows a toast, and the picker keeps its inputs.
  - Focus trap. Esc closes it. Enter in the title submits. Phone is full-screen.
- `src/components/SaveTemplateDialog.vue`:
  - Fields are prefilled: name = doc title, collection = the doc's collection fetched with `?fields=meta,library`, mode = doc mode, `{{title}}` checkbox on.
  - The content is the on-screen editor model.
  - A 409 from a user template shows the error plus `template-save-replace`. A 409 from a builtin shows the error only.
  - Content over 1 MB gets a clear error before any request.
  - Success shows a toast linking `/library?tab=templates`.
- `src/components/LibraryTemplates.vue`:
  - The Templates tab lists `template-item`s. Use opens the picker with that template preselected.
  - User templates get `template-menu`: inline rename with the server's 409/400 messages, and delete through `template-delete-confirm`.
- `src/components/templateHost.ts` mounts each dialog as its own small Vue app under `<body>`.
- `src/composables/templateEntry.ts` holds the only code the entry chunk carries: two one-line dynamic imports.

Minimal insertions in existing files:
- `FileUpload.vue`: the `landing-new-from-template` button, plus `flex-wrap` on `.alt-actions`.
- `HeaderOverflowMenu.vue`: one item at 00 §2.3 position 5, hidden on file routes and pinned revisions.
- `LibraryView.vue`: the `library-new-from-template` header button, the Documents/Templates tablist (`library-tab-templates`), and the existing toolbar and layout wrapped in `<template v-else>`.
- `LibraryConfirmDialog.vue`: an optional `testid` prop.
- `DocView.vue`: FileUpload is now a `defineAsyncComponent`. Without this the entry was 247 B over budget.

Tests:
- `tests/items/27-templates.test.ts`: 16 unit tests.
- `tests/e2e/items/27-templates.test.mjs`: 17 tests, all on private backends. They cover AC-27.6–27.11 and 27.15, plus these edge cases:
  - offline create
  - Esc and Enter in the picker
  - an html doc
  - a doc with no heading
  - a 1 MB+ doc
  - a deleted default collection
  - the filter box above 8 templates
  - the item hidden on pinned revision and file routes
  - rename refused for a builtin's name

The unit tests failed (missing module) before the implementation. Under the browser rule, the e2e tests were first run after the implementation. The first run failed on one real bug: a busy, disabled Save button dropped focus, so Esc was lost. Esc is now handled by a window capture listener.

## Screenshots
`.verify/qa/27/{light,dark,github-light,github-dark,locus-light,locus-dark}-{phone,desktop}-{picker-list,picker-form,save}.png` (36 files).

I looked at light desktop form, dark desktop list, locus-dark phone form and github-dark phone save. All use tokens only, have no horizontal overflow, keep Create/Save reachable at the bottom on phone, and use 16px inputs on phone.

Callouts and `:rag-*` render as plain text in the preview, because #16 is not in this worktree.

## Frozen-test changes / pre-existing test changes
- FROZEN TEST CHANGES: none.
- Pre-existing tests: I added a `#27 review fixes` describe block to `server/test-items/27-templates.test.mjs`, a #27 file. No other test was changed.

## Decisions
7 new `- #27:` lines in `docs/build/DECISIONS.md`. I also updated the earlier `from_template` storage line, which the review fix supersedes.

## For the captain
- **#26 files touched:** `LibraryView.vue`, `FileUpload.vue`, `LibraryConfirmDialog.vue`, `DocView.vue`, `session-rows.cjs`. All are insertions, no reformatting.
- **Server-side:** `templates.cjs`, `mcp-server.js` and the 27 test file.
