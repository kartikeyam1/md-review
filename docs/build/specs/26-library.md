# 26 — Library (collections, tags, pins, search) + multi-file sessions in the UI

## Goal
Readers find any doc in seconds: a `/library` page with full-text search, filters, per-reader pins, collections and tags,
usable on a phone and fast with 500+ docs. Multi-file sessions (already in the backend and MCP) become visible and navigable
in the doc view, so an agent's "report + appendix + data" bundle reads as one thing.

## Scope / Out of scope
In: `/library` page (list, search, filters, sort, pins, collections, tags, bulk actions, recently viewed, empty states,
paging, phone layout); the library API (below, **needs #20**); file tabs + breadcrumb + `/d/:slug/:fileName` + add/remove file
in the doc view.
Out: editing the content of non-primary files in the UI (they are read-only views; change them with MCP `add_file` or
remove + re-add), comments/approval on non-primary files, versioning of files, collection-level sharing or permissions,
nested collections, templates (#27, which adds a "New from template" entry and a Templates tab to this page).

## Current state
- `src/components/DashboardView.vue:28` fetches `GET /paste/list?status=pending` (pending-review sessions only); `:39-42`
  navigates via `#shared=`; `:67` heading "Pending Reviews". No search, filter, sort, paging, tags or pins.
- `src/App.vue:381-387` `#dashboard` sets `appMode='dashboard'`; `:625-626` hides the header there; `:655` mounts the dashboard.
  `src/types/index.ts:54` `AppMode = 'upload' | 'review' | 'dashboard'`.
- `server/server.cjs:1028-1066` `/paste/list` reads every meta JSON on each call, filters by `status` / `name` regex, sorts by
  `created_at`, `limit` only (no cursor). Returns `file_count`, `updated_at`, but no title, author, mode or type.
- `server/server.cjs:625-628` the creator's `author` is used only as the first revision's `by`; it is not stored as metadata.
  `contentType` is stored in meta because the POST body is spread into it (`:644`).
- Files: `server/server.cjs:427-443` `listSessionFiles` returns `{name, size, type}` (name may contain `/`);
  routes `:1320-1391` (`GET /paste/:id/files`, `GET|DELETE /paste/:id/files/:name`, `POST /paste/:id/files {name, content, encoding}`).
  MCP `add_file` / `list_files` / `remove_file` / `get_file` at `server/mcp-server.js:649-701` (mirrored in `mcp-server-http.js:286-335`).
  `GET /paste/:id` includes `files` when non-empty (`server/server.cjs:1206-1211`). No UI uses any of this.
- Reader identity: self-declared name in localStorage `md-review-reviewer` (`src/composables/useReviewer.ts:3`).

## Behaviour
### Library page
1. `/library` renders `library-page`. A header link `nav-library` (app header and landing page) navigates to it. Legacy
   `#dashboard` redirects to `/library?mode=review` (closest equivalent of the old "pending reviews" list).
2. All list state lives in the URL query: `q`, `collection` (id or `none`), `tag`, `mode` (`publish|review`), `type`
   (`md|html`), `updated` (`7d|30d|90d`; absent = any time), `sort`. Changing a control updates the URL with
   `history.replaceState` for typing in search and `pushState` for everything else; loading a URL restores the controls.
3. Each row (`library-row`, attribute `data-doc-id`) shows: title (link to `/d/<slug or id>`), type badge `md`/`html`,
   mode badge `publish`/`review`, author (`created_by`, "—" when unknown), relative updated time with the absolute time in
   `title=`, reaction and view counts (each hidden when the API returns `null`, i.e. #24/#25 not shipped), tag chips,
   collection name, file-count badge when `file_count > 0`, and for `review` docs with `must_fix_unresolved > 0` a must-fix chip.
4. Title is the server-computed `title` (00 §5: `sessionName` → front-matter title / `<title>` → first human-visible `# `
   heading / first `<h1>` → filename without extension → `Untitled`).
5. **Search** (`library-search`): debounced 250 ms; queries of 1 character are ignored (no request). With `q` present the
   default sort becomes `relevance` and each row shows a snippet (`library-row-snippet`) built from the API's
   `match.snippet` segment list (00 §8); hit segments render as `<mark>` (`library-snippet-hit`); when `match.field` is
   `file` the snippet is prefixed with the file name. Snippets are rendered as text, never HTML. `Esc` in the box clears it.
6. **Filters** (`library-filter-collection`, `-tag`, `-mode`, `-type`, `-updated`) combine with AND. `library-clear-filters`
   resets `q` and all filters. Clicking a tag chip on a row sets `tag=` to it.
7. **Sort** (`library-sort`): `updated` (newest first, default without `q`), `created` (newest first), `title` (A→Z, case-insensitive),
   `views` (most first; option hidden when view counts are unavailable), `relevance` (only offered when `q` is set).
8. **Pins** are per reader and stored on the server keyed by `reader_key` (**00 §7**): `name:` + the reviewer name
   lower-cased and trimmed, or, when no name is set, the per-browser `reader_id` (`anon-<uuid>`, localStorage
   `md-review-reader-id`, from `useReader.ts`). The FE sends it as header `X-MdReview-Reader` (percent-encoded). When the
   reader sets a name for the first time, the FE copies the anonymous pins to the name key (`POST /library/pins/merge`).
   `library-pin-toggle` on each row toggles; pinned rows show `aria-pressed="true"`. Max 50 pins (51st → toast, no change).
9. When no `q` and no filter is active, a `library-pinned` section lists the reader's pinned docs (most recently pinned first)
   above the main list, and those docs are not repeated in the main list. With any `q`/filter active the section is hidden and
   pinned docs appear in normal order with their pin toggle pressed.
10. **Recently viewed** (`library-recent`, items `library-recent-item`): opening `/d/:slug` records `{id, slug, title, viewedAt}`
    in localStorage `md-review-recent` (most recent first, de-duplicated by id, max 20). The section shows the latest 8, only when
    no `q`/filter is active, and is omitted when empty. Deleting a doc from the library removes it from this list.
11. **Collections**: a doc is in at most one collection. The sidebar (`library-collections`, items `library-collection-item`)
    lists "All documents", each collection with its doc count, and "Unfiled" (`collection=none`). `library-collection-new`
    creates (name 1–60 chars, unique case-insensitive; duplicate → inline error `library-collection-error`). Each collection has
    rename and delete in a menu (`library-collection-menu`); delete confirms and leaves its docs unfiled — never deletes docs.
12. **Tags**: editors add a tag inline with `library-row-tag-add` (input + Enter) and remove with `library-tag-remove` on a chip.
    Tags are normalised: trimmed, lower-cased, spaces → `-`, only `[a-z0-9._-]`, 1–32 chars; max 20 per doc. Invalid input shows
    `library-tag-error` and is not saved. Viewers see chips without add/remove controls.
13. **Bulk**: each row has `library-row-select`; `library-select-all` selects all loaded rows. With ≥1 selected, `library-bulk-bar`
    shows the count and actions `library-bulk-tag` (add tag), `library-bulk-move` (choose collection or "Unfiled") and
    `library-bulk-delete`. Delete opens `library-confirm-dialog` reading "Delete N documents? This cannot be undone." with
    `library-confirm-cancel` / `library-confirm-ok`. Results are per doc; docs the reader cannot edit are skipped and reported
    in a toast "N skipped — no edit access". The list refreshes after any bulk action and the selection clears.
14. **Edit capability** (from #23): tag/move/delete need edit capability on that doc. The FE sends the edit tokens it holds for
    the selected docs; legacy link-editable docs need none. Pins, collection create/rename/delete need no capability.
15. **Paging**: the API returns 50 rows per page with an opaque cursor. A sentinel at the end of the list (and a visible
    `library-load-more` button as fallback) loads the next page. The list is virtualised: at any time no more than 120
    `library-row` elements exist in the DOM, however many are loaded. `library-count` shows "N documents" (the API `total`).
16. **Empty / error states** (`library-empty`, with `data-state`): `no-docs` (library empty: "No documents yet" + `library-new-doc`),
    `no-results` (q/filters match nothing: "No documents match" + clear-filters button), `empty-collection`, and
    `library-error` (API unreachable / 5xx) with `library-retry`. A loading skeleton `library-loading` shows while the first page loads.
17. **Phone (< 641 px, 00 §12)**: rows become stacked cards (title, then badges + updated, then tags); the collections sidebar and filters
    move into a sheet opened by `library-filters-toggle`; search and sort stay visible; no horizontal page scroll.
18. Expired docs are never listed. Every count and list reflects writes immediately (no stale cache after a mutation).

### Multi-file sessions in the doc view
19. "Document files" are files whose extension is `.md`, `.markdown`, `.html`, `.htm` or `.txt`; all other files are attachments.
20. `file-tabs` shows a first tab for the primary doc (label = filename, else "Document") and one `file-tab` per document file,
    sorted by name. Viewers see the strip only when ≥1 document file exists; editors always see it (it carries `file-add-btn`).
    The active tab has `aria-selected="true"`. Attachments are listed in `file-attachments-menu` (`file-attachment-item`) with name
    and size; images and text open at their file route, others download.
21. Route `/d/:slug/:fileName` opens that file; `fileName` is the file's path with each segment URI-encoded, so `src/a b.md` is
    `/d/x/src/a%20b.md`. Selecting a tab pushes that URL; the primary tab is `/d/:slug`. Back/forward switch tabs. Heading fragments
    work within a file (`/d/x/notes.md#setup`).
22. Rendering by type: `.md/.markdown` → same markdown renderer as the primary doc; `.html/.htm` → the sandboxed HTML preview;
    `.txt` and code/text types → a highlighted code block; images → `<img>` fitted to width; others → a download card
    (`file-download-card`). Files are fetched from `GET /paste/:id/files/:name`. On file routes the editor, comments, approval and
    `?view=edit|split` are not available; the view is read-only.
23. Unknown file name → `file-not-found` with a link back to the primary doc; no request loop.
24. Breadcrumb `doc-breadcrumb` shows `Library › <Collection> › <Doc title> › <file>` (collection segment omitted when unfiled,
    file segment only on file routes); segments `breadcrumb-library`, `breadcrumb-collection` (→ `/library?collection=<id>`),
    `breadcrumb-doc`, `breadcrumb-file` (`aria-current="page"`). Shown when the doc is in a collection or has file tabs.
    On phone it truncates middle segments with `…` and never wraps beyond one line.
25. **Add file** (editors): `file-add-btn` opens a file picker (multiple allowed). Text files upload as utf-8, others as base64,
    via `POST /paste/:id/files`. If the name exists, a confirm asks to replace. Progress shows in the tab strip; failure shows a
    toast and adds no tab. **Remove** (editors): `file-tab-remove` on a non-primary tab (or in the attachments menu) confirms,
    then `DELETE`s; removing the open file navigates to `/d/:slug`. The primary tab has no remove control.
26. Pinned-revision routes (`/d/:slug@rev`) hide file tabs and attachments (files are not versioned).
27. Files added by another client appear after the doc's normal poll/refresh without a reload.

## Acceptance criteria
AC-26.1 Given 3 docs, When `/library` loads, Then 3 `library-row` render with title, type, mode, author and updated time, and `library-count` reads "3 documents".   [verify: e2e]
AC-26.2 Given a doc containing "kumquat" in its body only, When typing "kumquat" in `library-search`, Then within 1 s the URL has `q=kumquat`, only that row remains and its `library-row-snippet` contains a `library-snippet-hit` with text "kumquat".   [verify: e2e]
AC-26.3 Given a doc whose body contains `<img src=x onerror=alert(1)>kumquat`, When searched, Then the snippet shows that text literally and no `img` element exists inside the snippet.   [verify: e2e]
AC-26.4 Given docs in two collections with different tags/modes/types, When loading `/library?collection=<A>&tag=ops&mode=review&type=md`, Then the controls show those values and only docs matching all four render; `library-clear-filters` restores all docs and a bare `/library` URL.   [verify: e2e]
AC-26.5 Given sort `title`, Then row titles are in case-insensitive A→Z order; Given no `q`, Then the default sort is `updated` newest first; `relevance` is not an option without `q`.   [verify: e2e]
AC-26.6 Given reader name "Asha", When pinning doc X, Then X appears in `library-pinned` and not in the main list; after reload it is still pinned; with reader name "Ben" in a fresh context it is not pinned.   [verify: e2e]
AC-26.7 Given no reader name and 2 pinned docs, When the reader sets name "Asha", Then `GET /library/pins` with header `X-MdReview-Reader: name%3Aasha` returns both docs.   [verify: e2e]
AC-26.8 Given the reader opened docs A then B, When visiting `/library`, Then `library-recent-item`s are B, A in that order; with `q` set the section is absent.   [verify: e2e]
AC-26.9 Given collection "Ops" containing doc X, When "Ops" is deleted via `library-collection-menu` and confirmed, Then X still exists and appears under "Unfiled"; creating a second collection named "ops" shows `library-collection-error`.   [verify: e2e]
AC-26.10 Given an editor, When adding tag " Q4 Plan " inline, Then the chip reads `q4-plan` and `GET /library/docs?tag=q4-plan` includes the doc; a 33-char tag shows `library-tag-error` and is not saved.   [verify: e2e]
AC-26.11 Given 3 selected docs of which 1 is token-protected and not editable by this reader, When bulk delete is confirmed, Then 2 docs are deleted (404 on `GET /paste/:id`), 1 remains, and a toast says "1 skipped — no edit access"; cancelling the dialog deletes nothing.   [verify: e2e]
AC-26.12 Given 600 docs, When scrolling the library to the end, Then all 600 become reachable via repeated page loads, `library-count` reads "600 documents", and at no point do more than 120 `library-row` elements exist in the DOM.   [verify: e2e]
AC-26.13 Given an empty data dir, Then `library-empty[data-state=no-docs]` shows; given a query matching nothing, `data-state=no-results`; given the API down, `library-error` with `library-retry` that reloads on success.   [verify: e2e]
AC-26.14 Given phone 390×844, Then rows render as cards, `library-filters-toggle` opens the filters sheet, and `document.documentElement.scrollWidth <= 390`.   [verify: visual]
AC-26.15 Given a session with files `appendix.md`, `data/report.html`, `chart.png`, When opening `/d/<slug>`, Then `file-tabs` has 3 tabs (primary, appendix.md, data/report.html) and `chart.png` is in `file-attachments-menu`; clicking `appendix.md` changes the URL to `/d/<slug>/appendix.md` and renders its markdown.   [verify: e2e]
AC-26.16 Given a direct load of `/d/<slug>/data/report.html`, Then the HTML renders in the sandboxed preview with that tab selected, and browser Back from there after navigating to the primary tab returns to the file tab.   [verify: e2e]
AC-26.17 Given `/d/<slug>/nope.md`, Then `file-not-found` shows with a link to `/d/<slug>`, and at most one request to `/files/nope.md` is made.   [verify: e2e]
AC-26.18 Given an editor, When adding `notes.md` via `file-add-btn`, Then `GET /paste/:id/files` lists it and a tab appears; When removing it via `file-tab-remove` while it is open, Then the URL becomes `/d/<slug>` and the file is gone. Given a viewer, Then neither `file-add-btn` nor `file-tab-remove` exists.   [verify: e2e]
AC-26.19 Given a doc in collection "Ops" opened at a file route, Then `doc-breadcrumb` reads Library › Ops › <title> › <file> and `breadcrumb-collection` links to `/library?collection=<id>`.   [verify: e2e]
AC-26.20 Given library API calls, Then `GET /library/docs` responds per 00 §8 (shape, paging, `total`, `pinned` for the `X-MdReview-Reader` reader), and tag/collection/pin endpoints reject invalid input with 400 and duplicates with 409.   [verify: server]
AC-26.21 Given a session whose only match for "zanzibar" is inside its file `appendix.md`, When `GET /library/docs?q=zanzibar`, Then that session is returned once with `match.field:"file"`, `match.file:"appendix.md"`; after the file is deleted it no longer matches.   [verify: server]

## Test hooks (data-testid list) and API/MCP contract changes
Testids: `nav-library`, `library-page`, `library-search`, `library-filter-collection`, `library-filter-tag`, `library-filter-mode`,
`library-filter-type`, `library-filter-updated`, `library-clear-filters`, `library-sort`, `library-count`, `library-row`,
`library-row-snippet`, `library-snippet-hit`, `library-pin-toggle`, `library-pinned`, `library-recent`, `library-recent-item`,
`library-collections`, `library-collection-item`, `library-collection-new`, `library-collection-menu`, `library-collection-error`,
`library-row-tag-add`, `library-tag-remove`, `library-tag-error`, `library-row-select`, `library-select-all`, `library-bulk-bar`,
`library-bulk-tag`, `library-bulk-move`, `library-bulk-delete`, `library-confirm-dialog`, `library-confirm-ok`,
`library-confirm-cancel`, `library-load-more`, `library-empty`, `library-error`, `library-retry`, `library-loading`,
`library-new-doc`, `library-filters-toggle`, `file-tabs`, `file-tab`, `file-tab-remove`, `file-add-btn`,
`file-attachments-menu`, `file-attachment-item`, `file-download-card`, `file-not-found`, `doc-breadcrumb`,
`breadcrumb-library`, `breadcrumb-collection`, `breadcrumb-doc`, `breadcrumb-file`.

API (needs #20's tables and FTS index; reader key in header `X-MdReview-Reader` per 00 §7; edit tokens per #23; CORS per 00 §9):
- `GET /library/docs` — **contract in 00 §8** (single list + search endpoint, shipped by #20). This item adds: `pinned` for the
  requesting reader, `collection`/`tags` population, and `doc_fts` rows for document files (`file_name` set) kept in sync on
  every file write/delete, so `match.field:"file"` results appear.
- `GET /library/collections` → `[{id, name, doc_count}]`; `POST {name}` → 201 / 409; `PATCH /library/collections/:id {name}`; `DELETE` → 204 (docs unfiled).
- `GET /library/tags` → `[{tag, count}]`; `PUT /paste/:id/tags {tags}` (replace, normalised server-side; returns tags) — needs edit capability.
- `PUT /paste/:id/collection {collectionId|null}` — needs edit capability.
- `GET /library/pins` → `[{docId, pinnedAt}]`; `PUT /library/pins/:docId`; `DELETE /library/pins/:docId`; `POST /library/pins/merge {from}`.
- `POST /library/bulk {action: 'add-tag'|'move'|'delete', ids, tag?, collectionId?, editTokens: {id: token}}` → `{results: [{id, ok, error?}]}`.
- `POST /paste` and `GET /paste/:id` store/return `created_by` (the creator's `author`); deleting a doc removes its pins, tags and membership.
- `GET /paste/list` keeps its current shape (MCP `list_sessions` depends on it).
MCP: none required. (`create_session` share URLs move to `/d/:slug` under #4.)

## Edge cases the adversarial verifier must try
- Search terms with FTS syntax (`"`, `*`, `-`, `OR`, `NEAR(`, unbalanced quotes) — must not 500; treat as literal text.
- Unicode/emoji titles and tags with accents (`café` is rejected per rule 12 — identically by UI and API).
- Rename a collection to an existing name differing only by case; delete the collection currently filtered on (URL falls back to all).
- Pin then delete the doc elsewhere; pinned section must not show a dead row. Recent entry for a deleted doc opens the doc view's not-found state.
- Bulk select across pages after loading more, then change filter — selection clears.
- File names with spaces, `#`, `?`, `%`, unicode and nested dirs in the URL; a file literally named `@x.md`; a file named like a view (`edit.md`).
- Back/forward rapidly between tabs; removing a file another tab shows; an HTML file with scripts (must stay sandboxed).
- 500+ docs on a phone viewport: scrolling stays smooth and the row cap holds.

## Dependencies on other items (by number) and files likely touched
Needs #20 (SQLite tables + FTS + `created_by` + `GET /library/docs`), #4 (routes, `#dashboard` redirect), #2 (`mode`), #23
(edit tokens / capability), #24 (`useReader.ts`, 00 §7). Uses counts from #24/#25 (both land earlier). #27 adds "New from
template" + Templates tab here. Same `title` rule as #22 (00 §5). e2e: `qa-gate-features.test.mjs:189-218` must create its
session with `mode:"review"` and assert `library-page`/`library-row` (00 §11).
Files: new `src/components/LibraryView.vue` (+ small row/filters/collections components), `src/composables/useLibrary.ts`,
`src/composables/useRecent.ts`, new `src/components/FileTabs.vue`, `DocBreadcrumb.vue`, `src/App.vue` (route), `src/components/DocView.vue` (breadcrumb + file-tab slots), `src/components/DocHeader.vue` (`nav-library` target),
`src/components/FileUpload.vue` (nav link), `src/types/index.ts`, new `server/routes/library.cjs` (00 §4.9) + file-route FTS sync; `DashboardView.vue` removed.

## Decisions
- One collection per doc (folder semantics); tags are the many-to-many axis — keeps the breadcrumb unambiguous and makes "move" literal.
- Pins live on the server keyed by reader name (falls back to an anonymous browser id) so they follow a named reader across devices; recently viewed stays local.
- Collections are global and need no edit capability (no auth exists); tag/move/delete do, because they change what everyone sees.
- Only `.md/.html/.txt` files get tabs; images and other files are attachments, so pasted images (#10) don't flood the tab strip.
- Non-primary files are read-only in the UI; editing them would need per-file sync/revisions, which do not exist.
- `#dashboard` → `/library?mode=review`, the nearest equivalent of the old pending-reviews list.
