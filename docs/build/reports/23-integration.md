# #23 integration onto feat/view-share (196a4b3 = #1a + #6)

Worktree `md-review-viewshare`, #23 uncommitted. Untracked 01/03/05 test files untouched.

## Failure 1 — 23-fixes F1 "editor gone" (product fix)
#6 keeps the lazy editor mounted (v-show) after the first edit. `src/components/DocView.vue`:
- `editorShown` now also requires `capability === 'editor'`;
- `watch(capability, c => { if (c !== 'editor') editorMounted.value = false })` — losing edit access unmounts the kept
  editor slot, so a viewer never keeps a hidden editor. The test stays as written.

## Failure 2 — 06-lazy-editor AC-06.10 (shared mechanism)
The test creates its review doc with a raw `POST /paste`, which is now protected → opens as viewer. Fixed with the same
mechanism as the other pre-#23 suites: `await asLegacyDoc(id)` (`tests/e2e/lib/legacy-docs.mjs`) right after the POST
(2 lines + import). Intent unchanged (a link-editable review doc).

## Other suites' doc creation (audited)
- 01-locus-theme, 03-toc-anchors, 05-mobile-layout, 05-print-title, 06-fixes, 06-lazy-editor-build, and the rest of
  06-lazy-editor create docs through `tests/e2e/lib/docs.mjs` `createDoc`, which is legacy (link-editable → editor) by
  default. No other raw `POST /paste` in tests/e2e/items except #23's own. No change needed.

## Run
`VERIFY_ITEMS=23,6 E2E_FILES=06-lazy-editor,06-lazy-editor-build,06-fixes,23-fixes,23-view-edit-links,02-reading-mode,app,durable-sync scripts/verify.sh --only typecheck,unit,e2e`
(run 20261010-191756-2436767): typecheck PASS · unit 219/219 · 06-lazy-editor 13/13 · 06-lazy-editor-build 6/6 ·
06-fixes 2/2 · 23-fixes 9/9 · 23-view-edit-links 9/9 · 02-reading-mode 19/19 · app 50/50 · durable-sync 11/11 ·
**OVERALL: PASS** (119/119 e2e).
