# #26 — multi-file sessions in the doc view (files26) — implementation report

Scope: spec 26 rules 19–27, AC-26.15–AC-26.19, edge cases on file names / back-forward / sandboxing / viewers / pinned / live updates.
Worktree `/home/ubuntu/locus-repos/md-review-cap-library` (lane/library). Not committed.

## Files changed
New
- `src/composables/sessionFiles.ts` (lazy chunk) — pure helpers (document-file vs attachment, sort, primary label, file kind + code
  language, safe code fence, path encoding, breadcrumb segments + phone collapse, upload encoding) and the store `createSessionFiles`:
  file list, collection, open-file content, uploads, add/remove/download.
- `src/composables/useSessionFiles.ts` (entry shim, ~1 KB) — `provideSessionFiles` (records the attached doc's latest payload from boot,
  loads the store chunk, queues file opens), `useSessionFilesStore` / `useSessionFiles`, `docKeyOfScreen`.
- `src/components/FileTabs.vue` — `file-tabs` strip: primary + document tabs (`file-tab`, `role=tab`, `aria-selected`, roving tabindex,
  arrow/Home/End), `file-tab-remove` (editors), `file-attachments-menu` (AppMenu; `file-attachment-item`, editors get a Remove group),
  `file-add-btn` + hidden multi-file input, "Uploading …" status.
- `src/components/DocBreadcrumb.vue` — `doc-breadcrumb` (`breadcrumb-library|collection|doc|file`, `aria-current="page"` on the last), one line,
  phone collapse.
- `src/components/FileView.vue` — rendering by type (markdown → PreviewPane, html → sandboxed PreviewPane iframe, txt/code → one fenced
  highlighted block, image → fitted `<img>`, other → `file-download-card`), `file-not-found` (link back), load-error retry.
- `tests/items/26-files.test.ts` (17 unit tests), `tests/e2e/items/26-files.test.mjs` (20 e2e tests).

Modified
- `src/composables/useDocLoader.ts` — file routes attach the doc (`loadSharedDoc(id, token, screenKey)`), fetch the file once via the store;
  same-doc doc↔file switches never reload; the leave guard treats the attached doc's file tabs as "not leaving"; old read-only/detached file loader removed.
- `src/composables/useDocState.ts` — `resolveDocAxes`: file route capability = the doc's; view always read and `reviewUI` false there.
- `src/composables/docState.ts` — `onServerPayload(fn)` listener hook called from `applyServerMeta` (first GET + every changed poll).
- `src/components/DocView.vue` — (FileTabs/DocBreadcrumb/FileView are async components, rendered once the store chunk loaded) §2.4 position 8 (`DocBreadcrumb`, then `FileTabs`, after DocBanners); FileView on file routes (also in embeds);
  editor slot survives a file-tab trip; doc-scroll + TOC follow the file for markdown/code files; old inline file-view block removed.
- `src/components/DocHeader.vue` — **not in my ownership list** (nobody's): one line hides `view-toggle` on file routes (an editor there must not
  get Edit). Flagging for the captain.

## Design notes
- The doc stays attached on its file routes. `markdown` in the doc state is always the primary doc; a file's content lives in the store, so
  autosave can never write a file into the doc, the poll keeps running (rule 27), capability is the doc's (00 §1.2), and the header title,
  breadcrumb doc segment and copy-link stay the doc's.
- File list: from the doc payload (`files`, omitted when empty) on the first GET and every 200 poll (file writes bump the session version,
  so the ETag changes), then `GET /paste/:id?fields=library` for the collection; `GET /paste/:id/files` after this browser adds/removes.
- AC-26.17: the file is fetched exactly once per route entry; 404 → `file-not-found` (never retried). A file removed elsewhere while open
  flips to `file-not-found` on the next poll.
- Tab URLs keep the route's own key (slug or id) so the attached doc is recognised (a slug/id mismatch would reload it).
- Visual check: 6 themes × desktop 1400 and phone 390, plus attachment menu / code / csv card / not-found shots in `.verify/qa/26/files/`
  (looked at all; fixed phone breadcrumb shrink priorities and card button styling after the first pass). `scrollWidth` = 390 on all phones.
  Script: `.verify/shots26.mjs`.

- Entry-chunk budget (#6 AC-06.8): HEAD had 558 bytes of headroom under the test's build (NODE_ENV=test), and the first version of
  this work added ~7.9 KB, so the store and components moved to lazy chunks. Measured with the test's build: HEAD 574,086 → this tree
  574,039 (limit 574,644). **Headroom is now ~600 bytes for everyone in the lane.**
- Known limitation: a heading's copy-link on a file route copies the doc's URL + `#id`, not the file URL (PreviewPane uses `docLink`);
  left alone to avoid touching PreviewPane.

## Pre-existing test changes (not frozen tests — there were none for this half)
- `tests/e2e/items/04-routes-extra.test.mjs` "a nested markdown file renders read-only": dropped the `no live-doc GET` assertion (file routes now
  keep the doc attached — 00 §1.2 capability, rule 27 poll); title adjusted.
- same file "a missing file shows doc-not-found" → waits for `file-not-found` (rule 23 / AC-26.17).
- `tests/composables/useDocState.test.ts`: file route now `capability: 'editor'`, `view: 'read'` (00 §1.2).

## Decisions appended (DECISIONS.md, `- #26:` lines)
Attached-doc file routes; axes on file routes; file-list sources; tab/remove DOM structure; viewer strip also for attachments-only;
confirm/progress/toast choices and txt/code/csv rendering; phone breadcrumb collapse.

## Gate
`VERIFY_ITEMS=26 E2E_FILES=26-files,04-routes,04-routes-extra,04-routes-pages,23-view-edit-links,02-reading-mode scripts/verify.sh --only typecheck,unit,build,e2e`
→ run 20261010-233555-2985098: typecheck PASS 0 errors · unit PASS 482/482 · build PASS 175 chunks · e2e PASS 101/101
(26-files 20/20, 04-routes 21/21, 04-routes-extra 23/23, 04-routes-pages 9/9, 23-view-edit-links 9/9, 02-reading-mode 19/19) · **OVERALL: PASS 141.5s**.

Earlier runs of the unit step failed while the box was overloaded (load average ~30): the in-test vite builds were killed without
stderr, and 5 s timeouts hit 05/09. One real failure was found and fixed along the way: the AC-06.8 entry-size budget (see Design notes).
